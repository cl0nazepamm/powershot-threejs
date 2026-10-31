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
  NV_LAMBDA_MAX, NV_LAMBDA_MIN, classifyNir, createJhEvaluator, loadSpectralLut,
  photocathodeResponseJS,
} from "./nir_spectral.js";

const L0 = NV_LAMBDA_MIN;
const L1 = NV_LAMBDA_MAX;
const STEPS = 1400;
const DL = (L1 - L0) / STEPS;

export const NIR_BAND_RANGES = Object.freeze([
  Object.freeze([L0, 650]),
  Object.freeze([650, 800]),
  Object.freeze([800, L1]),
]);

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

// ── per-light collapse (the spectral emitter classes) ──────────────
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

// Resolves once the JH coefficient LUT has loaded (loadSpectralLut); if it
// cannot load, reflectance falls back to the 3-bin tent.
export async function createNirBand() {
  const jh = createJhEvaluator(await loadSpectralLut().catch(() => null));

  const collapse = (values) => values.reduce(
    (sum, value, i) => sum + value * NIR_BAND_WEIGHTS[i], 0,
  );

  return {
    ranges: NIR_BAND_RANGES,
    weights: NIR_BAND_WEIGHTS,
    collapse,

    // Per-band reflectance. Authored/classified NIR truth is blended across
    // 700..740 nm exactly like createJhUpsampler's reflectance; visible-red
    // response below that edge remains the JH reconstruction.
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

    // Per-band relative radiance, including light intensity. No absolute
    // radiometric units are implied by Three's light intensity.
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
