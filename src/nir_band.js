// nir_band.js — band-collapse of the spectral NIR domain for REALTIME render.
//
// The spectral tracer exists because materials and lights need NIR values that
// RGB doesn't carry. But once integrated against the photocathode response,
// every material and light collapses to ONE exact scalar:
//
//   lightFlux    = ∫ e(λ)·S(λ) dλ / ∫S      (per light, per emitter class)
//   reflectance  = ∫ R(λ)·S(λ) dλ / ∫S      (per material: authored nirAlbedo
//                                            or JH-extrapolated spectrum)
//
// Rendering that single band with a plain rasterizer (monochrome albedos,
// white lights at the collapsed intensity, shadow maps) reproduces the
// tracer's DIRECT term exactly — three's punctual-light model is the same
// albedo/π·n·l·atten the tracer's NEE uses. What's lost vs the path tracer:
// indirect bounces and dispersion. What's gained: zero Monte Carlo noise at
// full framerate — and the tube re-noises the image with CORRECT statistics
// anyway. Authenticity lives in the spectra; they are integrated exactly here.

import {
  photocathodeResponseJS, NV_LAMBDA_MIN, NV_LAMBDA_MAX,
} from "speedball-gi/spectral-traverse";
import { classifyNir } from "speedball-gi/spectral-scene";
import { decodeSpectralLut, SPECTRAL_LUT_RES } from "speedball-gi/srgb-lut";

const L0 = NV_LAMBDA_MIN;
const L1 = NV_LAMBDA_MAX;
const STEPS = 1400;
const DL = (L1 - L0) / STEPS;

// visible anchor for JH normalization (matches spectral_traverse jhEval)
const JH_MIN = 380.0;
const JH_RANGE = 340.0;

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ∫f(λ)S(λ)dλ / ∫S(λ)dλ over the NV domain
function weighted(f) {
  let num = 0, den = 0;
  for (let i = 0; i < STEPS; i += 1) {
    const l = L0 + (i + 0.5) * DL;
    const s = photocathodeResponseJS(l);
    num += f(l) * s;
    den += s;
  }
  return den > 0 ? num / den : 0;
}

// ── CPU mirror of the GPU Jakob–Hanika evaluation ───────────────────
// Same LUT the kernel samples (decodeSpectralLut: 3 argmax slabs packed in
// depth, RGBA float, coeffs in xyz), same trilinear fetch, same unclamped-Ln
// sigmoid so the CPU scalar matches the converged GPU spectrum.
function makeJh() {
  let data = null;
  const res = SPECTRAL_LUT_RES;
  try { data = decodeSpectralLut(); } catch { data = null; }

  const fetchTri = (slab, x, y, z) => {
    // x,y,z in [0,1] grid space → trilinear over res³ within the slab
    const c = [x, y, z].map((v) => Math.min(1, Math.max(0, v)) * (res - 1));
    const i0 = c.map(Math.floor);
    const fr = c.map((v, k) => v - i0[k]);
    const i1 = i0.map((v) => Math.min(v + 1, res - 1));
    const at = (xi, yi, zi) => (((slab * res + zi) * res + yi) * res + xi) * 4;
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k += 1) {
      const c00 = data[at(i0[0], i0[1], i0[2]) + k] * (1 - fr[0]) + data[at(i1[0], i0[1], i0[2]) + k] * fr[0];
      const c10 = data[at(i0[0], i1[1], i0[2]) + k] * (1 - fr[0]) + data[at(i1[0], i1[1], i0[2]) + k] * fr[0];
      const c01 = data[at(i0[0], i0[1], i1[2]) + k] * (1 - fr[0]) + data[at(i1[0], i0[1], i1[2]) + k] * fr[0];
      const c11 = data[at(i0[0], i1[1], i1[2]) + k] * (1 - fr[0]) + data[at(i1[0], i1[1], i1[2]) + k] * fr[0];
      const c0 = c00 * (1 - fr[1]) + c10 * fr[1];
      const c1 = c01 * (1 - fr[1]) + c11 * fr[1];
      out[k] = c0 * (1 - fr[2]) + c1 * fr[2];
    }
    return out;
  };

  const coeffs = (r, g, b) => {
    // slab/axis selection mirrors jhCoeffs in spectral_traverse.js
    let slab, a, c, z;
    if (b >= g && b >= r) { slab = 2; a = r; c = g; z = b; }
    else if (g >= r) { slab = 1; a = b; c = r; z = g; }
    else { slab = 0; a = g; c = b; z = r; }
    const zc = Math.max(z, 1e-4);
    return fetchTri(slab, a / zc, c / zc, Math.min(1, Math.max(0, z)));
  };

  const evalAt = (co, l) => {
    const Ln = Math.max((l - JH_MIN) / JH_RANGE, 0); // unclamped above 1 → NIR extrapolation
    const x = (co[0] * Ln + co[1]) * Ln + co[2];
    return Math.min(1, Math.max(0, 0.5 + (0.5 * x) / Math.sqrt(x * x + 1)));
  };

  // no-LUT fallback: 3-bin tent (rgbToSpectral) — past 720 it holds the red value
  const tent = (r, g, b, l) => {
    const t = Math.min(1, Math.max(0, (l - JH_MIN) / JH_RANGE));
    return t < 0.5 ? b + (g - b) * Math.min(1, t * 2) : g + (r - g) * Math.min(1, (t - 0.5) * 2);
  };

  return {
    // photocathode-weighted reflectance of an sRGB-linear color
    reflectance(r, g, b) {
      const rc = Math.min(1, Math.max(0, r));
      const gc = Math.min(1, Math.max(0, g));
      const bc = Math.min(1, Math.max(0, b));
      if (!data) return weighted((l) => tent(rc, gc, bc, l));
      const co = coeffs(rc, gc, bc);
      return weighted((l) => evalAt(co, l));
    },
    // photocathode-weighted emission of an unbounded linear color (JH shape × max)
    emission(r, g, b, shape = null) {
      const m = Math.max(r, g, b);
      if (m <= 0) return 0;
      const f = !data
        ? (l) => tent(r / m, g / m, b / m, l)
        : ((co) => (l) => evalAt(co, l))(coeffs(r / m, g / m, b / m));
      return m * weighted(shape ? (l) => f(l) * shape(l) : f);
    },
  };
}

// ── per-light collapse (mirrors emitterAtLambda classes exactly) ────
const C2 = 1.4388e7; // nm·K
const SODIUM_Y_SCALE = 13.77;

function planckRatio(l, T) {
  return ((560 / l) ** 5) * (Math.exp(C2 / (560 * T)) - 1) / (Math.exp(C2 / (l * T)) - 1);
}
const gauss = (mu, sigma) => (l) => Math.exp(-0.5 * ((l - mu) / sigma) ** 2);

function emitterClassOf(light) {
  const raw = light.userData?.emitterClass;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s.startsWith("incan") || s === "halogen" || s === "tungsten") return 1;
    if (s === "led") return 2;
    if (s.startsWith("sodium") || s === "lps") return 3;
    if (s === "ir" || s.startsWith("ir_") || s.startsWith("ir ") || s.includes("illuminator")) return 4;
    return 0;
  }
  if (Number.isFinite(raw)) return Math.min(4, Math.max(0, Math.trunc(raw)));
  return 0;
}

export function createNirBand() {
  const jh = makeJh();
  const SINT_IR = weighted(gauss(850, 15));    // IR band: peak = intensity (matches GPU)
  const SINT_NA = weighted(gauss(589, 4));

  return {
    // scalar NIR reflectance of a material: authored > classifier > JH prior
    reflectance(material) {
      const ud = material.userData?.nirAlbedo;
      if (Number.isFinite(ud)) return Math.min(1, Math.max(0, ud));
      const c = material.color;
      const r = c?.isColor ? c.r : 1, g = c?.isColor ? c.g : 1, b = c?.isColor ? c.b : 1;
      const rough = Number.isFinite(material.roughness) ? material.roughness : 1;
      const metal = Number.isFinite(material.metalness) ? material.metalness : 0;
      const trans = Number.isFinite(material.transmission) ? material.transmission : 0;
      const tagged = classifyNir(material.name, r, g, b, rough, metal, trans);
      if (tagged >= 0) return tagged;
      return jh.reflectance(r, g, b);
    },

    // scalar NIR emissive of a material (linear emissive × intensity, JH prior)
    emissiveFlux(material) {
      const e = material.emissive;
      if (!e?.isColor) return 0;
      const k = Number.isFinite(material.emissiveIntensity) ? material.emissiveIntensity : 1;
      return jh.emission(e.r * k, e.g * k, e.b * k);
    },

    // absolute NIR flux of a light (includes color × intensity), per class —
    // integrates the exact same spectra emitterAtLambda emits on the GPU
    lightFlux(light) {
      const k = Number.isFinite(light.intensity) ? light.intensity : 1;
      if (k <= 0) return 0;
      const c = light.color;
      const r = (c?.isColor ? c.r : 1) * k;
      const g = (c?.isColor ? c.g : 1) * k;
      const b = (c?.isColor ? c.b : 1) * k;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      switch (emitterClassOf(light)) {
        case 1: {
          const T = Math.min(20000, Math.max(500,
            Number.isFinite(light.userData?.colorTemp) ? light.userData.colorTemp : 2856));
          return lum * weighted((l) => planckRatio(l, T));
        }
        case 2:
          return jh.emission(r, g, b, (l) => 1 - smoothstep(690, 725, l));
        case 3:
          return lum * SODIUM_Y_SCALE * SINT_NA;
        case 4:
          // RGB is meaningless for an IR illuminator; intensity = band peak.
          return Math.max(Math.max(r, g, b), k) * SINT_IR;
        default:
          return jh.emission(r, g, b);
      }
    },
  };
}
