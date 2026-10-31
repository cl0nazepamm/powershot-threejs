// nir_spectral.js - the spectral model behind PowerShot's NIR band.
//
// The Gen-3 GaAs photocathode response that defines the NV band, the
// name/colour NIR reflectance classifier, and the Jakob-Hanika sRGB ->
// reflectance upsampler: a sigmoid-of-quadratic coefficient LUT
// (srgb_lut.js, built by tools/gen-spectral-lut.mjs) evaluated on the CPU for
// per-material band integrals, or in TSL by a spectral renderer. No spectral
// renderer is required: nir_band.js integrates this into three raster bands.

import * as THREE from "three/webgpu";
import {
  clamp, exp, float, max, mix, select, smoothstep, sqrt, texture3D, vec3,
} from "three/tsl";

// --- NV band: Gen-3 GaAs photocathode response S(l) ------------------------
// Analytic fit (measured curves are out of scope): a window rising from
// ~550 nm, broad peak around 780-830 nm, steep cutoff to ~900 nm. The CPU fit
// and the TSL emitter below MUST stay in exact sync - the CPU side builds the
// l inverse-CDF and the integral(S) normalization a spectral kernel divides by.
export const NV_LAMBDA_MIN = 550.0;
export const NV_LAMBDA_MAX = 900.0;

function smoothstepJS(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function photocathodeResponseJS(l) {
  const rise = smoothstepJS(540, 620, l);
  const cut = 1 - smoothstepJS(860, 900, l);
  const peakShape = 0.75 + 0.25 * Math.exp(-(((l - 805) / 70) ** 2));
  return rise * cut * peakShape;
}

// TSL emitter - same fit as photocathodeResponseJS.
export function photocathodeS(lambda) {
  const rise = smoothstep(float(540.0), float(620.0), lambda);
  const cut = float(1.0).sub(smoothstep(float(860.0), float(900.0), lambda));
  const dn = lambda.sub(805.0).div(70.0);
  const peakShape = float(0.75).add(exp(dn.mul(dn).mul(-1.0)).mul(0.25));
  return rise.mul(cut).mul(peakShape);
}

// NV l sampler: a small inverse-CDF LUT mapping u in [0,1) -> l (64 entries,
// linear interp - plenty for a curve this smooth), plus the response integral
// over the domain. pdf(l) = S(l) / integral.
export function buildPhotocathodeSampler(entries = 64, lambdaMin = NV_LAMBDA_MIN, lambdaMax = NV_LAMBDA_MAX) {
  const STEPS = 2048;
  const dl = (lambdaMax - lambdaMin) / STEPS;
  const cdf = new Float64Array(STEPS + 1);
  for (let i = 0; i < STEPS; i++) {
    const l = lambdaMin + (i + 0.5) * dl;
    cdf[i + 1] = cdf[i] + photocathodeResponseJS(l) * dl;
  }
  const integral = cdf[STEPS];
  const lut = new Float32Array(entries);
  let cursor = 0;
  for (let e = 0; e < entries; e++) {
    const target = (e / (entries - 1)) * integral;
    while (cursor < STEPS && cdf[cursor + 1] < target) cursor++;
    const c0 = cdf[cursor];
    const c1 = cdf[Math.min(cursor + 1, STEPS)];
    const f = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
    lut[e] = lambdaMin + (cursor + f) * dl;
  }
  lut[entries - 1] = lambdaMax;
  return { lut, integral };
}

// --- NIR reflectance classifier ---------------------------------------------
// RGB carries zero information about NIR (metamerism): two identical greens
// can differ 10x at 850 nm (chlorophyll red edge vs green paint). Truth is
// injected as DATA - one scalar NIR reflectance per material - with cheap
// name/colour heuristics providing defaults for the big classes. -1 leaves
// the material on the JH-extrapolation prior. Colour inputs are LINEAR.
export function classifyNir(name, r, g, b, roughness, metalness, transmission) {
  const n = String(name || "");
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc > 1e-6 ? (maxc - minc) / maxc : 0;
  // chlorophyll red edge: foliage is DARK green visibly, ~0.5 in NIR
  if (/leaf|foliage|grass|tree|plant|veg/i.test(n)) return 0.55;
  if (g > 1.15 * Math.max(r, b) && roughness > 0.5 && metalness < 0.2) return 0.55;
  // water absorbs strongly past ~750 nm -> near-black through a tube
  if (/water|ocean|pool/i.test(n)) return 0.04;
  if (transmission > 0.5 && b > r) return 0.04;
  // asphalt / very dark low-saturation dielectric
  if (/asphalt|tarmac|road/i.test(n)) return 0.06;
  if (maxc < 0.08 && sat < 0.15 && metalness < 0.2 && transmission < 0.5) return 0.06;
  // skin: waxy NIR lift (sub-surface scattering)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (r > g && g > b && b > 1e-6 && r / b >= 1.3 && r / b <= 2.5
    && lum > 0.12 && lum < 0.7 && metalness < 0.2) return 0.62;
  return -1; // untagged -> JH extrapolation prior
}

// --- Jakob-Hanika RGB -> reflectance upsampling -----------------------------
// The LUT was fitted over the visible band; past 720 nm the sigmoid-quadratic
// extrapolates smoothly into NIR (the normalization is anchored here but NOT
// clamped above 1).
const JH_LAMBDA_MIN = 380.0;
const JH_LAMBDA_RANGE = 340.0;

// The coefficient LUT is ~0.9 MB of source, so it loads on first use: an
// infrared pipeline that never builds a NIR band never downloads it.
let spectralLut = null;
export function loadSpectralLut() {
  spectralLut ??= import("./srgb_lut.js").then(({ decodeSpectralLut, SPECTRAL_LUT_RES }) => ({
    data: decodeSpectralLut(), // Float32Array, RGBA, 3 argmax slabs packed in depth
    res: SPECTRAL_LUT_RES,
  }));
  return spectralLut;
}

// CPU evaluator over a loaded LUT ({ data, res }), the same trilinear fetch and
// unclamped-Ln sigmoid as the TSL upsampler so per-material scalars match the
// converged spectrum. `null` falls back to a 3-bin tent that holds the red
// value past 720 nm.
export function createJhEvaluator(lut) {
  const data = lut?.data ?? null;
  const res = lut?.res ?? 0;

  const fetchTri = (slab, x, y, z) => {
    // x,y,z in [0,1] grid space -> trilinear over res^3 within the slab
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
    // slab/axis selection mirrors the TSL jhCoeffs below
    let slab, a, c, z;
    if (b >= g && b >= r) { slab = 2; a = r; c = g; z = b; }
    else if (g >= r) { slab = 1; a = b; c = r; z = g; }
    else { slab = 0; a = g; c = b; z = r; }
    const zc = Math.max(z, 1e-4);
    return fetchTri(slab, a / zc, c / zc, Math.min(1, Math.max(0, z)));
  };

  const evalAt = (co, l) => {
    const Ln = Math.max((l - JH_LAMBDA_MIN) / JH_LAMBDA_RANGE, 0); // unclamped above 1 -> NIR extrapolation
    const x = (co[0] * Ln + co[1]) * Ln + co[2];
    return Math.min(1, Math.max(0, 0.5 + (0.5 * x) / Math.sqrt(x * x + 1)));
  };

  const tent = (r, g, b, l) => {
    const t = Math.min(1, Math.max(0, (l - JH_LAMBDA_MIN) / JH_LAMBDA_RANGE));
    return t < 0.5 ? b + (g - b) * Math.min(1, t * 2) : g + (r - g) * Math.min(1, (t - 0.5) * 2);
  };

  return {
    reflectanceAt(r, g, b, l) {
      const rc = Math.min(1, Math.max(0, r));
      const gc = Math.min(1, Math.max(0, g));
      const bc = Math.min(1, Math.max(0, b));
      if (!data) return tent(rc, gc, bc, l);
      return evalAt(coeffs(rc, gc, bc), l);
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

// The loaded LUT as 3 Data3DTextures, one per argmax slab, for the TSL
// upsampler. The packed data stores depth = slab * res + zi, so slab s is a
// contiguous res^3 RGBA-float slice.
export function createSpectralLutTextures({ data, res }) {
  const sliceLen = res * res * res * 4;
  const out = [];
  for (let s = 0; s < 3; s++) {
    const tex = new THREE.Data3DTexture(data.slice(s * sliceLen, (s + 1) * sliceLen), res, res, res);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace; // raw coefficients, not colour
    tex.needsUpdate = true;
    out.push(tex);
  }
  return out;
}

// TSL upsampler over the LUT textures, for spectral renderers sampling a hero
// wavelength `lambda` (nm).
//
// reflectance(rgb, lambda, nirAlbedo?, rgbFlat?): nirAlbedo < 0 (untagged)
// keeps the JH extrapolation as the NIR prior; >= 0 is an authored NIR
// reflectance blended in across the red edge. The tag is the material's NIR
// LEVEL, not a flat paint-over: when rgbFlat (the scalar colour BEFORE the
// albedo-map multiply) is passed, per-texel variation survives as the JH ratio
// texel/flat. emission(rgb, lambda): JH shape times the RGB magnitude.
export function createJhUpsampler(lutTextures, res) {
  const LUTN = float(res);
  const lutUV = (g) => clamp(g, 0.0, 1.0).mul(LUTN.sub(1)).add(0.5).div(LUTN);
  const jhCoeffs = (rgb) => {
    const r = rgb.x, g = rgb.y, b = rgb.z;
    const fetch = (lt, zc, a, c) => {
      const z = max(zc, float(1e-4));
      return texture3D(lt, vec3(lutUV(a.div(z)), lutUV(c.div(z)), lutUV(clamp(zc, 0.0, 1.0)))).xyz;
    };
    const c0 = fetch(lutTextures[0], r, g, b); // r is max: x=g/z, y=b/z
    const c1 = fetch(lutTextures[1], g, b, r); // g is max: x=b/z, y=r/z
    const c2 = fetch(lutTextures[2], b, r, g); // b is max: x=r/z, y=g/z
    const isB = b.greaterThanEqual(g).and(b.greaterThanEqual(r));
    const isG = g.greaterThanEqual(r);
    return select(isB, c2, select(isG, c1, c0));
  };
  const jhEval = (c, lambda) => {
    // The sigmoid is in [0,1] by construction; the outer clamp is only an fp guard.
    const Ln = max(lambda.sub(JH_LAMBDA_MIN).div(JH_LAMBDA_RANGE), 0.0);
    const x = c.x.mul(Ln).add(c.y).mul(Ln).add(c.z);
    return clamp(float(0.5).add(x.mul(0.5).div(sqrt(x.mul(x).add(1.0)))), 0.0, 1.0);
  };
  const reflectanceBase = (rgb, lambda) => jhEval(jhCoeffs(clamp(rgb, 0.0, 1.0)), lambda);

  return {
    reflectance(rgb, lambda, nirAlbedo = null, rgbFlat = null) {
      const base = reflectanceBase(rgb, lambda);
      if (!nirAlbedo) return base;
      const blend = smoothstep(float(700.0), float(740.0), lambda);
      let authored = clamp(nirAlbedo, 0.0, 1.0);
      if (rgbFlat) {
        const flat = max(reflectanceBase(rgbFlat, lambda), float(1e-3));
        authored = clamp(authored.mul(base.div(flat)), 0.0, 1.0);
      }
      return select(nirAlbedo.lessThan(float(0.0)), base, mix(base, authored, blend));
    },
    emission(rgb, lambda) {
      const m = max(max(rgb.x, rgb.y), rgb.z);
      return reflectanceBase(rgb.div(max(m, float(1e-6))), lambda).mul(m);
    },
  };
}
