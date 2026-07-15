// nir_band.js — three-band approximation of the spectral NIR domain.
//
// Materials and emitters cannot be collapsed independently before lighting:
//
//   average(E) * average(R) != average(E * R)
//
// Instead, RGB temporarily carries three NIR bands. Three's regular lighting
// multiplies material and emitter values within each band, then a fullscreen
// pass collapses the lit result through the photocathode band weights. This is
// still an approximation (three broad bands, raster BRDF, no indirect bounce),
// but it preserves the material/emitter spectral correlation that the old
// single-scalar path discarded.

import {
  photocathodeResponseJS, NV_LAMBDA_MIN, NV_LAMBDA_MAX,
} from "speedball-gi/spectral-traverse";
import { classifyNir } from "speedball-gi/spectral-scene";
import { decodeSpectralLut, SPECTRAL_LUT_RES } from "speedball-gi/srgb-lut";

const L0 = NV_LAMBDA_MIN;
const L1 = NV_LAMBDA_MAX;
const STEPS = 1400;
const DL = (L1 - L0) / STEPS;

export const NIR_BAND_RANGES = Object.freeze([
  Object.freeze([L0, 650]),
  Object.freeze([650, 800]),
  Object.freeze([800, L1]),
]);

// visible anchor for JH normalization (matches spectral_traverse jhEval)
const JH_MIN = 380.0;
const JH_RANGE = 340.0;

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ∫f(λ)S(λ)dλ / ∫S(λ)dλ over one band.
function weightedRange(f, from, to) {
  let num = 0, den = 0;
  const steps = Math.max(1, Math.round((to - from) / DL));
  const dl = (to - from) / steps;
  for (let i = 0; i < steps; i += 1) {
    const l = from + (i + 0.5) * dl;
    const s = photocathodeResponseJS(l);
    num += f(l) * s * dl;
    den += s * dl;
  }
  return den > 0 ? num / den : 0;
}

function responseIntegral(from, to) {
  let sum = 0;
  const steps = Math.max(1, Math.round((to - from) / DL));
  const dl = (to - from) / steps;
  for (let i = 0; i < steps; i += 1) {
    sum += photocathodeResponseJS(from + (i + 0.5) * dl) * dl;
  }
  return sum;
}

const totalResponse = responseIntegral(L0, L1);
export const NIR_BAND_WEIGHTS = Object.freeze(NIR_BAND_RANGES.map(
  ([from, to]) => responseIntegral(from, to) / totalResponse,
));

function integrateBands(f) {
  return NIR_BAND_RANGES.map(([from, to]) => weightedRange(f, from, to));
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
    reflectanceAt(r, g, b, l) {
      const rc = Math.min(1, Math.max(0, r));
      const gc = Math.min(1, Math.max(0, g));
      const bc = Math.min(1, Math.max(0, b));
      if (!data) return tent(rc, gc, bc, l);
      const co = coeffs(rc, gc, bc);
      return evalAt(co, l);
    },
    // JH shape times the unbounded linear RGB magnitude.
    emissionAt(r, g, b, l) {
      const m = Math.max(r, g, b);
      if (m <= 0) return 0;
      if (!data) return m * tent(r / m, g / m, b / m, l);
      return m * evalAt(coeffs(r / m, g / m, b / m), l);
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
const sodiumSpectrum = gauss(589, 4);
const irSpectrum = gauss(850, 15);

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

  const collapse = (values) => values.reduce(
    (sum, value, i) => sum + value * NIR_BAND_WEIGHTS[i], 0,
  );

  return {
    ranges: NIR_BAND_RANGES,
    weights: NIR_BAND_WEIGHTS,
    collapse,

    // Per-band reflectance. Authored/classified NIR truth is blended across
    // 700..740 nm exactly like speedball's path tracer; visible-red response
    // below that edge remains the JH reconstruction.
    reflectanceBands(material) {
      const ud = material.userData?.nirAlbedo;
      const c = material.color;
      const r = c?.isColor ? c.r : 1, g = c?.isColor ? c.g : 1, b = c?.isColor ? c.b : 1;
      const rough = Number.isFinite(material.roughness) ? material.roughness : 1;
      const metal = Number.isFinite(material.metalness) ? material.metalness : 0;
      const trans = Number.isFinite(material.transmission) ? material.transmission : 0;
      const tagged = Number.isFinite(ud)
        ? Math.min(1, Math.max(0, ud))
        : classifyNir(material.name, r, g, b, rough, metal, trans);
      return integrateBands((l) => {
        const base = jh.reflectanceAt(r, g, b, l);
        if (tagged < 0) return base;
        const blend = smoothstep(700, 740, l);
        return base + (tagged - base) * blend;
      });
    },

    emissiveBands(material) {
      const e = material.emissive;
      if (!e?.isColor) return [0, 0, 0];
      const k = Number.isFinite(material.emissiveIntensity) ? material.emissiveIntensity : 1;
      return integrateBands((l) => jh.emissionAt(e.r * k, e.g * k, e.b * k, l));
    },

    // Per-band relative radiance, including light intensity. The emitter
    // functions mirror speedball's GPU path; no absolute radiometric units are
    // implied by Three's light intensity.
    lightBands(light) {
      const k = Number.isFinite(light.intensity) ? light.intensity : 1;
      if (k <= 0) return [0, 0, 0];
      const c = light.color;
      const r = (c?.isColor ? c.r : 1) * k;
      const g = (c?.isColor ? c.g : 1) * k;
      const b = (c?.isColor ? c.b : 1) * k;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let spectrum;
      switch (emitterClassOf(light)) {
        case 1: {
          const T = Math.min(20000, Math.max(500,
            Number.isFinite(light.userData?.colorTemp) ? light.userData.colorTemp : 2856));
          spectrum = (l) => lum * planckRatio(l, T);
          break;
        }
        case 2:
          spectrum = (l) => jh.emissionAt(r, g, b, l) * (1 - smoothstep(690, 725, l));
          break;
        case 3:
          spectrum = (l) => lum * SODIUM_Y_SCALE * sodiumSpectrum(l);
          break;
        case 4:
          spectrum = (l) => Math.max(Math.max(r, g, b), k) * irSpectrum(l);
          break;
        default:
          spectrum = (l) => jh.emissionAt(r, g, b, l);
      }
      return integrateBands(spectrum);
    },
  };
}
