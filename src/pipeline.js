// PowerSHOT realtime ISP — TSL stage library + ping-pong runner (three.js WebGPU).
//
// Each stage is a pure function (inputTexture, ctx) -> colorNode. The runner
// renders every enabled stage into its own half-float render target, feeding the
// previous target's texture into the next stage. Everything runs on the GPU; the
// only global statistics we need (white balance) are frozen to the preset's
// nominal gains for now (gray-world-on-GPU can replace that later).
//
// Domain convention: pixel values live in a 0..255 "signal"
// space. We sample textures in 0..1 and multiply up to 255 at the first stage so
// every constant (highlight_clip, shadow_crush, noise*255, thresholds) matches the
// Python reference 1:1, then divide back to 0..1 at the final stage.

import * as THREE from "three/webgpu";
import {
  vec2, vec3, vec4, float, uniform, texture, screenUV,
  mix, clamp, max, min, dot, abs, floor, fract, sin, cos, sqrt, log, mod, step,
} from "three/tsl";

const LEVELS = 255.0;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// sample input texture at a uv offset given in *pixels*
function tapPx(tex, uvN, texel, dx, dy) {
  return texture(tex, uvN.add(texel.mul(vec2(dx, dy))));
}

// Dave Hoskins hashes — good distribution with NO large-argument sin (the
// classic fract(sin(dot)) hash degenerates into grid/diagonal patterns once
// pixel coordinates get into the hundreds, which reads as "horrible" grain).
function hash12(p) {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const d = dot(a, vec3(a.y, a.z, a.x).add(33.33));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
}

function hash13(p) {
  const a = fract(p.mul(0.1031));
  const d = dot(a, vec3(a.z, a.y, a.x).add(31.32));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
}

// unit-variance gaussian via Box-Muller from two independent uniform hashes.
// `gaussFixed` is time-invariant (fixed-pattern noise); `gaussTemporal` folds
// the frame counter in as a third hash dimension so grain shimmers each frame.
function gaussFixed(p, salt) {
  const q = p.add(salt);
  const u1 = hash12(q).max(1e-6);
  const u2 = hash12(q.add(vec2(19.19, 7.41))).max(1e-6);
  return sqrt(log(u1).mul(-2.0)).mul(cos(u2.mul(6.2831853)));
}

function gaussTemporal(p, t, salt) {
  const u1 = hash13(vec3(p.x, p.y, t.add(salt))).max(1e-6);
  const u2 = hash13(vec3(p.x.add(11.0), p.y.add(3.0), t.add(salt).add(1.7))).max(1e-6);
  return sqrt(log(u1).mul(-2.0)).mul(cos(u2.mul(6.2831853)));
}

// RGGB Bayer phase masks for the current fragment. Returns floats {isR,isGr,isGb,isB}.
function bayerPhase(uvN, ctx) {
  const p = floor(uvN.mul(ctx.resolution));
  const px = mod(p.x, 2.0); // 0 or 1
  const py = mod(p.y, 2.0);
  const xEven = px.oneMinus();
  const yEven = py.oneMinus();
  return {
    isR: yEven.mul(xEven),
    isGr: yEven.mul(px),
    isGb: py.mul(xEven),
    isB: py.mul(px),
  };
}

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------

// Stage 1 also handles the implicit downsample: sampling the (larger) source
// image into the sensor-resolution target IS the downsample.
function stInput(tex, ctx) {
  return texture(tex, screenUV).rgb.mul(LEVELS);
}

function stCopy(tex, ctx) {
  return texture(tex, screenUV).rgb;
}

function stBarrel(tex, ctx) {
  const k = ctx.P.barrel;
  const c = screenUV.sub(0.5).mul(vec2(2.0, 2.0)); // -1..1, aspect-naive (matches py)
  const r2 = dot(c, c);
  const factor = float(1.0).add(k.mul(r2));
  // invert: r_distorted = r*(1+k r^2); sample source along r/r_distorted
  const srcUv = c.div(factor).mul(0.5).add(0.5);
  return texture(tex, srcUv).rgb;
}

function stChromatic(tex, ctx) {
  const ca = ctx.P.ca; // pixels
  const maxDim = max(ctx.resolution.x, ctx.resolution.y);
  const rScale = float(1.0).add(ca.div(maxDim));
  const bScale = float(1.0).sub(ca.mul(0.7).div(maxDim));
  const c = screenUV.sub(0.5);
  const rUv = c.div(rScale).add(0.5);
  const bUv = c.div(bScale).add(0.5);
  const r = texture(tex, rUv).r;
  const g = texture(tex, screenUV).g;
  const b = texture(tex, bUv).b;
  return vec3(r, g, b);
}

// Cheap lens point-spread function. This lives before the sensor path so edges
// get softened before Bayer sampling and sharpening, like small compact optics.
function stLensPsf(tex, ctx) {
  const t = ctx.texel;
  const c = texture(tex, screenUV).rgb;
  let blur = c.mul(0.28);
  blur = blur.add(tapPx(tex, screenUV, t, -1, 0).rgb.mul(0.15));
  blur = blur.add(tapPx(tex, screenUV, t, 1, 0).rgb.mul(0.15));
  blur = blur.add(tapPx(tex, screenUV, t, 0, -1).rgb.mul(0.15));
  blur = blur.add(tapPx(tex, screenUV, t, 0, 1).rgb.mul(0.15));
  blur = blur.add(tapPx(tex, screenUV, t, -1, -1).rgb.mul(0.03));
  blur = blur.add(tapPx(tex, screenUV, t, 1, -1).rgb.mul(0.03));
  blur = blur.add(tapPx(tex, screenUV, t, -1, 1).rgb.mul(0.03));
  blur = blur.add(tapPx(tex, screenUV, t, 1, 1).rgb.mul(0.03));
  return mix(c, blur, ctx.P.lensSoftness).clamp(0.0, LEVELS);
}

function bloomSource(c, ctx) {
  const lum = max(max(c.r, c.g), c.b);
  const denom = max(float(1.0), float(LEVELS).sub(ctx.P.ccdBloomThreshold));
  const mask = lum.sub(ctx.P.ccdBloomThreshold).div(denom).clamp(0.0, 1.0).pow(0.5);
  return c.mul(mask);
}

// CCD column bleed: bright saturated charge smears vertically before CFA
// sampling. Use dense column integration; sparse far taps create repeated
// highlight ghosts instead of a continuous readout smear.
function stCcdBloom(tex, ctx) {
  const t = ctx.texel;
  const c = texture(tex, screenUV).rgb;
  let smear = vec3(0.0);
  let wsum = float(0.0);

  for (let dy = -64; dy <= 64; dy += 2) {
    const ady = Math.abs(dy);
    const w = Math.exp(-ady / 24.0) * (1.0 - ady / 96.0);
    smear = smear.add(bloomSource(tapPx(tex, screenUV, t, 0, dy).rgb, ctx).mul(w));
    wsum = wsum.add(w);
  }

  return c.add(smear.div(wsum).mul(ctx.P.ccdBloom)).clamp(0.0, LEVELS);
}

// --- Bayer domain ---

function stMosaic(tex, ctx) {
  const c = texture(tex, screenUV).rgb;
  const ph = bayerPhase(screenUV, ctx);
  const bayer = c.r.mul(ph.isR)
    .add(c.g.mul(ph.isGr.add(ph.isGb)))
    .add(c.b.mul(ph.isB));
  return vec3(bayer);
}

function stWhiteBalance(tex, ctx) {
  const b = texture(tex, screenUV).r;
  const ph = bayerPhase(screenUV, ctx);
  const gain = ctx.P.wbR.mul(ph.isR)
    .add(ctx.P.wbG.mul(ph.isGr.add(ph.isGb)))
    .add(ctx.P.wbB.mul(ph.isB));
  return vec3(b.mul(gain).clamp(0.0, LEVELS));
}

function stBlackLevel(tex, ctx) {
  const b = texture(tex, screenUV).r;
  const ph = bayerPhase(screenUV, ctx);
  const off = ctx.P.blR.mul(ph.isR)
    .add(ctx.P.blGr.mul(ph.isGr))
    .add(ctx.P.blGb.mul(ph.isGb))
    .add(ctx.P.blB.mul(ph.isB));
  return vec3(b.add(off).clamp(0.0, LEVELS));
}

function samePhase3x3(tex, ctx) {
  const t = ctx.texel;
  const c = texture(tex, screenUV).r;
  let sum = float(0.0);
  sum = sum.add(tapPx(tex, screenUV, t, -2, -2).r);
  sum = sum.add(tapPx(tex, screenUV, t, 0, -2).r);
  sum = sum.add(tapPx(tex, screenUV, t, 2, -2).r);
  sum = sum.add(tapPx(tex, screenUV, t, -2, 0).r);
  sum = sum.add(tapPx(tex, screenUV, t, 2, 0).r);
  sum = sum.add(tapPx(tex, screenUV, t, -2, 2).r);
  sum = sum.add(tapPx(tex, screenUV, t, 0, 2).r);
  sum = sum.add(tapPx(tex, screenUV, t, 2, 2).r);
  return { c, sum, avg: sum.div(8.0) };
}

function stBayerNoise(tex, ctx) {
  const b = texture(tex, screenUV).r;
  const p = floor(screenUV.mul(ctx.resolution));
  const t = ctx.frame;
  const ns = ctx.noiseScale;

  // fixed-pattern noise (time-invariant): per-column, per-row, per-pixel offsets + gain
  const colFpn = gaussFixed(vec2(p.x, 0.0), vec2(2.70, 0.0)).mul(ctx.P.colFpn.mul(LEVELS)).mul(ns);
  const rowFpn = gaussFixed(vec2(0.0, p.y), vec2(0.0, 5.10)).mul(ctx.P.rowFpn.mul(LEVELS)).mul(ns);
  const dsnu = gaussFixed(p, vec2(0.50, 0.50)).mul(ctx.P.dsnu.mul(LEVELS)).mul(ns);
  const prnuGain = float(1.0).add(gaussFixed(p, vec2(3.30, 7.70)).mul(ctx.P.prnu).mul(ns));

  let sig = b.add(colFpn).add(rowFpn).add(dsnu).mul(prnuGain);

  // signal-dependent read + shot noise (temporal — shimmers each frame).
  // Keep the shadow boost mild: a steep dark-area multiplier is what turns
  // shadows into colored static once demosaiced.
  const sl = sig.div(LEVELS).clamp(0.0, 1.0);
  const readStd = ctx.P.noise.mul(LEVELS).mul(float(0.8).add(sl.oneMinus().mul(0.7)));
  const read = gaussTemporal(p, t, 0.0).mul(readStd).mul(ns);
  const shotStd = sqrt(sl.add(1e-4)).mul(ctx.P.colorNoise.mul(LEVELS));
  const shot = gaussTemporal(p, t, 37.0).mul(shotStd).mul(ns);

  sig = sig.add(read).add(shot);

  // hot pixels: rare stuck-bright defects (fixed). Bilinear demosaic spreads a
  // single hot Bayer sample into a colored "+", so keep them genuinely sparse.
  const hp = hash12(p.add(vec2(91.7, 43.1)));
  const hot = step(hp, ctx.P.hotRate.mul(0.15)).mul(45.0);
  sig = sig.add(hot);

  return vec3(sig.clamp(0.0, LEVELS));
}

// Remove isolated Bayer-domain hot/dead samples before they demosaic into
// colored plus-shaped dots. This is deliberately same-phase only.
function stDeadPixelCorrection(tex, ctx) {
  const n = samePhase3x3(tex, ctx);
  const isolated = step(ctx.P.dpcThreshold, abs(n.c.sub(n.avg)));
  return vec3(mix(n.c, n.avg, isolated).clamp(0.0, LEVELS));
}

// Optical low-pass filter: phase-aware diamond blur on same-color neighbors.
function stAAF(tex, ctx) {
  const s = ctx.P.aaf;
  const n = samePhase3x3(tex, ctx);
  const filtered = n.c.mul(8.0).add(n.sum).div(16.0);
  return vec3(mix(n.c, filtered, s));
}

function bnrTap(tex, ctx, center, dx, dy, spatialW) {
  const n = tapPx(tex, screenUV, ctx.texel, dx, dy).r;
  const close = float(1.0).sub(step(ctx.P.bnrRange, abs(n.sub(center))));
  const w = close.mul(spatialW);
  return { sum: n.mul(w), w };
}

// Compact realtime stand-in for the Python joint bilateral Bayer NR. It filters
// same-color Bayer samples before demosaic, which prevents chroma speckles from
// becoming stable red/blue dots in the RGB image.
function stBayerDenoise(tex, ctx) {
  const strength = ctx.P.bayerNR;
  const c = texture(tex, screenUV).r;
  let sum = c;
  let wsum = float(1.0);

  for (const [dx, dy, w] of [
    [-2, -2, 0.50], [0, -2, 0.75], [2, -2, 0.50],
    [-2, 0, 0.75],                  [2, 0, 0.75],
    [-2, 2, 0.50],  [0, 2, 0.75],  [2, 2, 0.50],
  ]) {
    const tap = bnrTap(tex, ctx, c, dx, dy, w);
    sum = sum.add(tap.sum);
    wsum = wsum.add(tap.w);
  }

  const filtered = sum.div(max(wsum, float(1e-5)));
  return vec3(mix(c, filtered, strength).clamp(0.0, LEVELS));
}

function demosaicBilinear(tex, ctx) {
  const t = ctx.texel;
  const c = texture(tex, screenUV).r;
  const N = tapPx(tex, screenUV, t, 0, -1).r;
  const S = tapPx(tex, screenUV, t, 0, 1).r;
  const E = tapPx(tex, screenUV, t, 1, 0).r;
  const W = tapPx(tex, screenUV, t, -1, 0).r;
  const NE = tapPx(tex, screenUV, t, 1, -1).r;
  const NW = tapPx(tex, screenUV, t, -1, -1).r;
  const SE = tapPx(tex, screenUV, t, 1, 1).r;
  const SW = tapPx(tex, screenUV, t, -1, 1).r;

  const ortho4 = N.add(S).add(E).add(W).mul(0.25);
  const diag4 = NE.add(NW).add(SE).add(SW).mul(0.25);
  const horiz2 = E.add(W).mul(0.5);
  const vert2 = N.add(S).mul(0.5);

  const ph = bayerPhase(screenUV, ctx);
  const r = c.mul(ph.isR).add(horiz2.mul(ph.isGr)).add(vert2.mul(ph.isGb)).add(diag4.mul(ph.isB));
  const g = ortho4.mul(ph.isR.add(ph.isB)).add(c.mul(ph.isGr.add(ph.isGb)));
  const b = diag4.mul(ph.isR).add(vert2.mul(ph.isGr)).add(horiz2.mul(ph.isGb)).add(c.mul(ph.isB));
  return vec3(r, g, b);
}

function demosaicEdgeAware(tex, ctx) {
  const t = ctx.texel;
  const c = texture(tex, screenUV).r;
  const N = tapPx(tex, screenUV, t, 0, -1).r;
  const S = tapPx(tex, screenUV, t, 0, 1).r;
  const E = tapPx(tex, screenUV, t, 1, 0).r;
  const W = tapPx(tex, screenUV, t, -1, 0).r;
  const NE = tapPx(tex, screenUV, t, 1, -1).r;
  const NW = tapPx(tex, screenUV, t, -1, -1).r;
  const SE = tapPx(tex, screenUV, t, 1, 1).r;
  const SW = tapPx(tex, screenUV, t, -1, 1).r;

  const horiz2 = E.add(W).mul(0.5);
  const vert2 = N.add(S).mul(0.5);
  const diag4 = NE.add(NW).add(SE).add(SW).mul(0.25);
  const gradH = abs(E.sub(W));
  const gradV = abs(N.sub(S));
  const edgeGreen = mix(horiz2, vert2, step(gradH, gradV));

  const ph = bayerPhase(screenUV, ctx);
  const r = c.mul(ph.isR).add(horiz2.mul(ph.isGr)).add(vert2.mul(ph.isGb)).add(diag4.mul(ph.isB));
  const g = edgeGreen.mul(ph.isR.add(ph.isB)).add(c.mul(ph.isGr.add(ph.isGb)));
  const b = diag4.mul(ph.isR).add(vert2.mul(ph.isGr)).add(horiz2.mul(ph.isGb)).add(c.mul(ph.isB));
  return vec3(r, g, b);
}

function stDemosaic(tex, ctx) {
  return mix(demosaicBilinear(tex, ctx), demosaicEdgeAware(tex, ctx), ctx.P.demosaicSharp).clamp(0.0, LEVELS);
}

// Chroma noise reduction: keep the center pixel's luma (so grain/detail stays
// sharp) but replace its chroma with a 3x3 neighborhood average. This is what
// kills the colored-dot static that Bayer noise + demosaic leaves in shadows,
// exactly like a real camera's chroma NR. Strength blends toward the original.
const LUMA = vec3(0.299, 0.587, 0.114);
function stChromaDenoise(tex, ctx) {
  const t = ctx.texel;
  const c = texture(tex, screenUV).rgb;
  let sum = c;
  sum = sum.add(tapPx(tex, screenUV, t, -1, -1).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, 0, -1).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, 1, -1).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, -1, 0).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, 1, 0).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, -1, 1).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, 0, 1).rgb);
  sum = sum.add(tapPx(tex, screenUV, t, 1, 1).rgb);
  const avg = sum.div(9.0);

  // sharp luma + smoothed chroma
  const y = dot(c, LUMA);
  const denoised = vec3(y).add(avg.sub(dot(avg, LUMA)));
  return mix(c, denoised, ctx.P.chromaNR).clamp(0.0, LEVELS);
}

// --- RGB ISP ---

function stCCM(tex, ctx) {
  const c = texture(tex, screenUV).rgb;
  const r = dot(c, ctx.P.ccm0);
  const g = dot(c, ctx.P.ccm1);
  const b = dot(c, ctx.P.ccm2);
  return vec3(r, g, b).clamp(0.0, LEVELS);
}

function stTone(tex, ctx) {
  let c = texture(tex, screenUV).rgb;
  c = min(c, ctx.P.hiClip);
  c = c.div(ctx.P.hiClip).mul(LEVELS);
  c = c.div(LEVELS).clamp(0.0, 1.0).pow(ctx.P.gamma).mul(LEVELS);
  // crush shadows: anything below threshold -> 0
  c = c.mul(step(ctx.P.shadow, c));
  return c.clamp(0.0, LEVELS);
}

function stSaturation(tex, ctx) {
  const c = texture(tex, screenUV).rgb;
  const gray = c.r.add(c.g).add(c.b).div(3.0);
  return mix(vec3(gray), c, ctx.P.sat).clamp(0.0, LEVELS);
}

function stVignette(tex, ctx) {
  const c = texture(tex, screenUV).rgb;
  const res = ctx.resolution;
  const cxy = res.mul(0.5);
  const pos = screenUV.mul(res);
  const maxR = sqrt(dot(cxy, cxy));
  const d = pos.sub(cxy);
  const r = sqrt(dot(d, d)).div(maxR);
  const cosT = cos(r.mul(0.7853982)); // r * pi/4
  const falloff = float(1.0).sub(ctx.P.vignette.mul(cosT.pow(4.0).oneMinus()));
  return c.mul(falloff).clamp(0.0, LEVELS);
}

function stEdgeEnhance(tex, ctx) {
  const t = ctx.texel;
  const lum = (s) => s.r.mul(0.299).add(s.g.mul(0.587)).add(s.b.mul(0.114));
  const c = texture(tex, screenUV);
  const center = lum(c).mul(8.0);
  let sum = center;
  sum = sum.sub(lum(tapPx(tex, screenUV, t, -1, -1)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, 0, -1)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, 1, -1)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, -1, 0)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, 1, 0)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, -1, 1)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, 0, 1)));
  sum = sum.sub(lum(tapPx(tex, screenUV, t, 1, 1)));
  const edge = sum.div(8.0);
  // coring: zero weak edges (noise), then gain + clamp halos
  const cored = edge.mul(step(ctx.P.eeThresh, abs(edge)));
  const enhanced = cored.mul(ctx.P.eeGain).clamp(-40.0, 40.0);
  return c.rgb.add(vec3(enhanced)).clamp(0.0, LEVELS);
}

function quantize(v, q) {
  return floor(v.div(q).add(0.5)).mul(q);
}

function rgbToYCoCg(c) {
  const y = c.r.mul(0.25).add(c.g.mul(0.5)).add(c.b.mul(0.25));
  const co = c.r.sub(c.b).mul(0.5);
  const cg = c.g.mul(0.5).sub(c.r.add(c.b).mul(0.25));
  return vec3(y, co, cg);
}

function ycocgToRgb(c) {
  return vec3(
    c.x.add(c.y).sub(c.z),
    c.x.add(c.z),
    c.x.sub(c.y).sub(c.z),
  );
}

function dctBasis(pos, freq) {
  return cos(pos.mul(2.0).add(1.0).mul(freq).mul(0.19634954084936207));
}

function dctNorm1D(freq) {
  return mix(float(Math.SQRT1_2), float(1.0), step(0.5, freq)).mul(0.5);
}

function samplePixel(tex, ctx, p) {
  const samplePos = min(p.add(0.5), ctx.resolution.sub(0.5));
  return texture(tex, samplePos.div(ctx.resolution)).rgb;
}

function jpegChroma420(tex, ctx, p) {
  const chromaBase = floor(p.div(2.0)).mul(2.0);
  const uv00 = min(chromaBase.add(vec2(0.5, 0.5)), ctx.resolution.sub(0.5)).div(ctx.resolution);
  const uv10 = min(chromaBase.add(vec2(1.5, 0.5)), ctx.resolution.sub(0.5)).div(ctx.resolution);
  const uv01 = min(chromaBase.add(vec2(0.5, 1.5)), ctx.resolution.sub(0.5)).div(ctx.resolution);
  const uv11 = min(chromaBase.add(vec2(1.5, 1.5)), ctx.resolution.sub(0.5)).div(ctx.resolution);
  const c00 = rgbToYCoCg(texture(tex, uv00).rgb);
  const c10 = rgbToYCoCg(texture(tex, uv10).rgb);
  const c01 = rgbToYCoCg(texture(tex, uv01).rgb);
  const c11 = rgbToYCoCg(texture(tex, uv11).rgb);
  return c00.add(c10).add(c01).add(c11).mul(0.25).yz;
}

function jpegInput(tex, ctx, p) {
  const c = rgbToYCoCg(samplePixel(tex, ctx, p));
  const chroma = mix(c.yz, jpegChroma420(tex, ctx, p), ctx.P.jpegChroma420.mul(ctx.P.jpegStrength).clamp(0.0, 1.0));
  return vec3(c.x.sub(128.0), chroma.x, chroma.y);
}

function sampleDct(tex, ctx, p) {
  const samplePos = min(p.add(0.5), ctx.resolution.sub(0.5));
  return texture(tex, samplePos.div(ctx.resolution)).rgb;
}

function jpegAmount(ctx) {
  return ctx.P.jpegStrength.mul(0.22).clamp(0.0, 1.0);
}

function jpegQuantStep(ctx, u, v) {
  const freq = u.mul(u).add(v.mul(v));
  const base = float(101.0).sub(ctx.P.jpegQuality).mul(ctx.P.jpegStrength).mul(0.012).add(0.01);
  return vec3(
    base.mul(float(0.50).add(freq.mul(0.045))),
    base.mul(float(1.40).add(freq.mul(0.080))),
    base.mul(float(1.40).add(freq.mul(0.080))),
  );
}

function jpegTemporalDither(ctx, block, u, v, q) {
  const t = floor(ctx.frame.mul(0.20));
  const seed = vec3(block.x.add(u.mul(17.0)), block.y.add(v.mul(29.0)), t);
  const n0 = hash13(seed).sub(0.5);
  const n1 = hash13(seed.add(vec3(11.0, 7.0, 3.0))).sub(0.5);
  const n2 = hash13(seed.add(vec3(23.0, 19.0, 5.0))).sub(0.5);
  const amp = ctx.P.jpegStrength.mul(0.18).clamp(0.0, 0.45);
  return vec3(n0, n1, n2).mul(q).mul(amp);
}

function stJpegDctRows(tex, ctx) {
  const p = floor(screenUV.mul(ctx.resolution));
  const block = floor(p.div(8.0)).mul(8.0);
  const local = mod(p, 8.0);
  const u = local.x;
  let sum = vec3(0.0);
  for (let x = 0; x < 8; x += 1) {
    sum = sum.add(jpegInput(tex, ctx, block.add(vec2(x, local.y))).mul(dctBasis(float(x), u)));
  }
  return sum.mul(dctNorm1D(u));
}

function stJpegDctColsQuant(tex, ctx) {
  const p = floor(screenUV.mul(ctx.resolution));
  const block = floor(p.div(8.0)).mul(8.0);
  const local = mod(p, 8.0);
  const u = local.x;
  const v = local.y;
  let sum = vec3(0.0);
  for (let y = 0; y < 8; y += 1) {
    sum = sum.add(sampleDct(tex, ctx, block.add(vec2(u, y))).mul(dctBasis(float(y), v)));
  }
  const coeff = sum.mul(dctNorm1D(v));
  const q = jpegQuantStep(ctx, u, v);
  return quantize(coeff.add(jpegTemporalDither(ctx, block, u, v, q)), q);
}

function stJpegIdct(tex, ctx, originalTex) {
  const p = floor(screenUV.mul(ctx.resolution));
  const block = floor(p.div(8.0)).mul(8.0);
  const local = mod(p, 8.0);
  let sum = vec3(0.0);
  for (let v = 0; v < 8; v += 1) {
    const by = dctBasis(local.y, float(v)).mul(dctNorm1D(float(v)));
    for (let u = 0; u < 8; u += 1) {
      const bx = dctBasis(local.x, float(u)).mul(dctNorm1D(float(u)));
      sum = sum.add(sampleDct(tex, ctx, block.add(vec2(u, v))).mul(bx.mul(by)));
    }
  }
  const original = samplePixel(originalTex, ctx, p);
  const decoded = ycocgToRgb(sum.add(vec3(128.0, 0.0, 0.0))).clamp(0.0, LEVELS);
  return mix(original, decoded, jpegAmount(ctx)).clamp(0.0, LEVELS);
}

// final: bring 0..255 back to 0..1 for display
function stOutput(tex, ctx) {
  return texture(tex, screenUV).rgb.div(LEVELS);
}

// ---------------------------------------------------------------------------
// stage registry - ordered as a camera-inspired ISP signal path
// ---------------------------------------------------------------------------

export const STAGE_DEFS = [
  { id: "barrel", label: "Barrel distortion", make: stBarrel },
  { id: "ca", label: "Chromatic aberration", make: stChromatic },
  { id: "lens", label: "Lens PSF softness", make: stLensPsf },
  { id: "ccdbloom", label: "CCD bloom / vertical smear", make: stCcdBloom },
  { id: "mosaic", label: "Bayer mosaic", make: stMosaic },
  { id: "blacklevel", label: "Black level offset", make: stBlackLevel },
  { id: "noise", label: "CCD sensor noise", make: stBayerNoise },
  { id: "dpc", label: "Dead pixel correction", make: stDeadPixelCorrection },
  { id: "aaf", label: "Anti-alias filter (OLPF)", make: stAAF },
  { id: "bnr", label: "Bayer noise reduction", make: stBayerDenoise },
  { id: "wb", label: "White balance (Bayer)", make: stWhiteBalance },
  { id: "demosaic", label: "Demosaic", make: stDemosaic },
  { id: "chromanr", label: "Chroma noise reduction", make: stChromaDenoise },
  { id: "ccm", label: "Color correction matrix", make: stCCM },
  { id: "tone", label: "Tone curve", make: stTone },
  { id: "saturation", label: "Saturation boost", make: stSaturation },
  { id: "vignette", label: "Vignette", make: stVignette },
  { id: "edge", label: "Edge enhancement", make: stEdgeEnhance },
  { id: "jpeg", label: "JPEG DCT compression", multi: [stJpegDctRows, stJpegDctColsQuant, stJpegIdct] },
];

// ---------------------------------------------------------------------------
// uniforms built per preset (so we can hot-swap without rebuilding nodes)
// ---------------------------------------------------------------------------

export function makeUniforms() {
  return {
    resolution: uniform(new THREE.Vector2(1, 1)),
    texel: uniform(new THREE.Vector2(1, 1)),
    frame: uniform(0),
    // global noise trim: raw Bayer noise is injected, then reduced in later stages
    // down through Bayer/RGB denoising, so we scale the injection to roughly
    // what survives the realtime subset.
    noiseScale: uniform(0.35),
    P: {
      barrel: uniform(0), ca: uniform(0),
      lensSoftness: uniform(0.25),
      ccdBloom: uniform(0), ccdBloomThreshold: uniform(200),
      wbR: uniform(1), wbG: uniform(1), wbB: uniform(1),
      blR: uniform(0), blGr: uniform(0), blGb: uniform(0), blB: uniform(0),
      noise: uniform(0), colorNoise: uniform(0), hotRate: uniform(0),
      colFpn: uniform(0), rowFpn: uniform(0), prnu: uniform(0), dsnu: uniform(0),
      dpcThreshold: uniform(30), aaf: uniform(0), bayerNR: uniform(0), bnrRange: uniform(25),
      demosaicSharp: uniform(0.55),
      chromaNR: uniform(1.0),
      ccm0: uniform(new THREE.Vector3(1, 0, 0)),
      ccm1: uniform(new THREE.Vector3(0, 1, 0)),
      ccm2: uniform(new THREE.Vector3(0, 0, 1)),
      hiClip: uniform(255), gamma: uniform(1), shadow: uniform(0), sat: uniform(1),
      vignette: uniform(0), eeGain: uniform(0), eeThresh: uniform(0),
      jpegQuality: uniform(60), jpegStrength: uniform(1.0), jpegChroma420: uniform(0.75),
    },
  };
}

export function applyPreset(ctx, preset) {
  const P = ctx.P;
  P.barrel.value = preset.barrel_distortion;
  P.ca.value = preset.chromatic_aberration;
  P.lensSoftness.value = preset.lens_softness ?? 0.25;
  P.ccdBloom.value = preset.ccd_bloom_strength;
  P.ccdBloomThreshold.value = preset.ccd_bloom_threshold;
  P.wbR.value = preset.wb_shift[0];
  P.wbG.value = preset.wb_shift[1];
  P.wbB.value = preset.wb_shift[2];
  P.blR.value = preset.black_level[0];
  P.blGr.value = preset.black_level[1];
  P.blGb.value = preset.black_level[2];
  P.blB.value = preset.black_level[3];
  P.noise.value = preset.noise_intensity;
  P.colorNoise.value = preset.color_noise_intensity;
  P.hotRate.value = preset.hot_pixel_rate;
  P.colFpn.value = preset.column_fpn;
  P.rowFpn.value = preset.row_fpn;
  P.prnu.value = preset.prnu;
  P.dsnu.value = preset.dsnu;
  P.dpcThreshold.value = preset.dpc_threshold;
  P.aaf.value = preset.aaf_strength;
  P.bayerNR.value = preset.bnr_strength;
  P.bnrRange.value = preset.bnr_range_sigma;
  P.demosaicSharp.value = preset.demosaic_quality === "malvar" ? 0.85 : 0.55;
  P.ccm0.value.set(...preset.ccm[0]);
  P.ccm1.value.set(...preset.ccm[1]);
  P.ccm2.value.set(...preset.ccm[2]);
  P.hiClip.value = preset.highlight_clip;
  P.gamma.value = preset.gamma;
  P.shadow.value = preset.shadow_crush;
  P.sat.value = preset.saturation_boost;
  P.vignette.value = preset.vignette_strength;
  P.eeGain.value = preset.ee_gain;
  P.eeThresh.value = preset.ee_threshold;
  P.jpegQuality.value = preset.jpeg_quality;
  P.jpegStrength.value = 1.0;
}

// ---------------------------------------------------------------------------
// runner — one persistent material PER stage (built once, reused every frame).
//
// A NodeMaterial compiles its shader once and caches it, so we cannot reuse a
// single material and swap `.colorNode` between passes — every pass would run
// the first-compiled graph. Instead we bake a dedicated material per active
// stage (each sampling a fixed ping-pong target) and only rebuild the chain
// when the source image, working size, or enabled-stage set changes. Per frame
// we just issue the draws; uniforms (e.g. `frame`) update by reference.
// ---------------------------------------------------------------------------

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.ctx = makeUniforms();

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.rtA = new THREE.RenderTarget(1, 1, opts);
    this.rtB = new THREE.RenderTarget(1, 1, { ...opts });
    this.rtC = new THREE.RenderTarget(1, 1, { ...opts });

    // fullscreen quad — its material is swapped to the current step's material
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.mesh.frustumCulled = false;
    this.quadScene.add(this.mesh);

    this.enabled = new Set(STAGE_DEFS.map((s) => s.id));
    this.source = null;
    this.size = { w: 0, h: 0 };
    this.steps = [];       // [{ material, target }]
    this.outputMat = null; // draws final 0..255 texture to screen as 0..1
    this.dirty = true;
  }

  _mat(colorNode) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = colorNode;
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    return m;
  }

  setSource(tex) { this.source = tex; this.dirty = true; }

  setSize(w, h) {
    if (w === this.size.w && h === this.size.h) return;
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.rtC.setSize(w, h);
    this.size = { w, h };
    this.ctx.resolution.value.set(w, h);
    this.ctx.texel.value.set(1 / w, 1 / h);
    this.dirty = true;
  }

  setEnabled(id, on) {
    if (on) this.enabled.add(id);
    else this.enabled.delete(id);
    this.dirty = true;
  }

  _rebuild() {
    for (const s of this.steps) s.material.dispose();
    if (this.outputMat) this.outputMat.dispose();
    this.steps = [];
    this.dirty = false;
    if (!this.source) { this.outputMat = null; return; }

    // mandatory input + downsample pass: 0..1 source -> 0..255 in rtA.
    this.steps.push({ material: this._mat(stInput(this.source, this.ctx)), target: this.rtA });

    // ping-pong the active stages across rtA/rtB with baked input textures
    let read = this.rtA;
    let write = this.rtB;
    const active = STAGE_DEFS.filter((s) => this.enabled.has(s.id));
    for (const stage of active) {
      const makers = stage.multi || [stage.make];
      let originalTex = read.texture;
      if (stage.multi) {
        this.steps.push({ material: this._mat(stCopy(read.texture, this.ctx)), target: this.rtC });
        originalTex = this.rtC.texture;
      }
      for (const make of makers) {
        this.steps.push({ material: this._mat(make(read.texture, this.ctx, originalTex)), target: write });
        const tmp = read; read = write; write = tmp;
      }
    }

    const finalTex = this.steps[this.steps.length - 1].target.texture;
    this.outputMat = this._mat(stOutput(finalTex, this.ctx));
  }

  // run the chain and present to screen
  async render(frame) {
    if (this.dirty) this._rebuild();
    if (!this.source || !this.outputMat) return;
    this.ctx.frame.value = frame;
    const r = this.renderer;

    for (const step of this.steps) {
      this.mesh.material = step.material;
      r.setRenderTarget(step.target);
      await r.renderAsync(this.quadScene, this.quadCam);
    }

    this.mesh.material = this.outputMat;
    r.setRenderTarget(null);
    await r.renderAsync(this.quadScene, this.quadCam);
  }
}
