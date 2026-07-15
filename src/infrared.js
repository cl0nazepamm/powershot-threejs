// PowerSHOT infrared mode - image-intensifier night-vision emulation.
//
// This is a separate imaging path from the visible-light digital ISP. It models
// a modern Gen-3 image-intensifier tube: a GaAs photocathode (red/NIR-weighted
// spectral response), an MCP gain stage with a constant-output transfer curve,
// a real temporal auto-brightness-control loop, resolution-limited optics,
// sparse photon scintillation, and a phosphor screen.
//
// It works in a single scalar relative-response channel L in scene-linear 0..1+.
// The response is resolved ONCE per frame into a full-resolution single-channel
// prepass target (either simulated from RGB, or read from a spectral renderer).
// An opt-in relative-electron model can quantize that response before the tube
// gain stages; default rgb/nir behavior remains unchanged. Everything
// downstream - PSF, adaptation analysis, halo, ABC, develop - reads that
// target, so the source is decoded in exactly one place. The shipped look is
// a high-end white-phosphor tube.

import * as THREE from "three/webgpu";
import {
  vec2, vec3, vec4, float, uniform, texture, screenUV,
  mix, max, min, dot, abs, floor, fract, sin, cos, sqrt, log, exp, step,
  smoothstep,
} from "three/tsl";
import { powershotLinearGrade } from "./pipeline.js";

const LUM709 = vec3(0.2126, 0.7152, 0.0722);
const TAU = 6.2831853;
const GOLDEN_ANGLE = 2.39996323;
// Native resolution class of a Gen-3 tube's usable output (~1280x960 fibre
// bundle). Sparkle grain is specified at this scale and multiplied up for
// larger canvases so setSize(3840, 2160) doesn't yield 1-px sparkles.
const TUBE_REFERENCE_MIN_DIM = 960;

function exp2u(x) {
  return exp(x.mul(Math.LN2));
}

function srgbToLinear(c) {
  const lo = c.mul(1.0 / 12.92);
  const hi = c.add(0.055).div(1.055).max(0.0).pow(2.4);
  return mix(lo, hi, step(0.04045, c));
}

function linearToSrgb(c) {
  const v = c.clamp(0.0, 1.0);
  const lo = v.mul(12.92);
  const hi = v.pow(1.0 / 2.4).mul(1.055).sub(0.055);
  return mix(lo, hi, step(0.0031308, v));
}

function hash13(p) {
  const a = fract(p.mul(0.1031));
  const d = dot(a, vec3(a.z, a.y, a.x).add(31.32));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
}

// Box-Muller gaussian keyed to a grain cell and a temporal phase. Used for the
// continuous shot-noise "fizz" on lit surfaces (Poisson sqrt(N) behaviour).
function gaussTemporal(p, t, salt) {
  const u1 = hash13(vec3(p.x, p.y, t.add(salt))).max(1e-6);
  const u2 = hash13(vec3(p.x.add(11.0), p.y.add(3.0), t.add(salt).add(1.7))).max(1e-6);
  return sqrt(log(u1).mul(-2.0)).mul(cos(u2.mul(6.2831853)));
}

// Convert relative response to a stochastic photoelectron observation, then
// normalize back into the signal range expected by the existing tube stages.
// The low-count branch uses an inverse Poisson CDF; the bright branch uses a
// Cornish-Fisher corrected Gaussian approximation. This is compiled only when
// setElectronModel(...) is enabled.
function relativeElectronSample(signal, ctx, salt) {
  const P = ctx.P;
  const scale = P.electronsPerUnit.max(1.0);
  const mean = signal.max(0.0).mul(scale);
  const cell = floor(screenUV.mul(ctx.resolution).div(ctx.grainScale.max(1.0)));
  const random = hash13(vec3(cell.x, cell.y, ctx.frame.add(salt))).max(1e-6);
  let probability = exp(mean.negate());
  let cumulative = probability;
  let discrete = float(0.0);
  for (let k = 1; k < 24; k += 1) {
    discrete = discrete.add(step(cumulative, random));
    probability = probability.mul(mean).div(k);
    cumulative = cumulative.add(probability);
  }
  const z = gaussTemporal(cell, ctx.frame, salt + 17.0);
  const gaussian = floor(mean
    .add(z.mul(sqrt(mean.max(1e-6))))
    .add(z.mul(z).sub(1.0).div(6.0))
    .add(0.5))
    .max(0.0);
  const observed = mix(discrete, gaussian, step(8.0, mean)).div(scale);
  return mix(signal, observed, P.noiseAmount.clamp(0.0, 1.0));
}

// --- Stage 1: GaAs photocathode spectral response -------------------------
// Fake the NIR-weighted response of a Gen-3 photocathode from an RGB frame
// (which carries no real NIR): rising red>green>blue quantum efficiency, a
// chlorophyll "Wood effect" foliage glow, a waxy skin lift, and suppression of
// blue sky / open water toward black. Returns a scalar relative response.
//
// This is the raster FALLBACK. When a linear NIR-response input is
// available (a spectral tracer's NIR channel), use setInputMode("nir") and the
// prepass reads the flux directly instead - RGB carries zero information about
// NIR (metamerism), so no heuristic can recover it.
function nirFromLinear(lin, ctx) {
  const P = ctx.P;
  const broad = dot(lin, P.spectralMix);
  const redExcess = max(lin.r.sub(lin.g.add(lin.b).mul(0.5)), 0.0);
  const greenDominance = max(lin.g.sub(lin.r.mul(0.58).add(lin.b.mul(0.42))), 0.0);
  const vegExcess = greenDominance.mul(smoothstep(0.035, 0.55, lin.g));
  const skin = max(min(lin.r.mul(0.95), lin.g).sub(lin.b.mul(0.72)), 0.0);
  const skyMask = smoothstep(0.02, 0.38, lin.b.sub(max(lin.r, lin.g).mul(0.86)));
  const waterMask = smoothstep(0.02, 0.34, min(lin.g, lin.b).sub(lin.r.mul(1.12)));

  let sim = broad
    .add(redExcess.mul(P.redReflectance))
    .add(vegExcess.mul(P.greenReflectance))
    .add(skin.mul(P.skinBoost));
  sim = sim
    .mul(float(1.0).sub(P.skySuppress.mul(skyMask)))
    .mul(float(1.0).sub(P.waterSuppress.mul(waterMask)))
    .sub(lin.b.mul(P.blueSuppression));

  const mono = dot(lin, LUM709);
  sim = sim.max(0.0).pow(P.photocathodeGamma);
  return fluxInputTrim(mix(sim, mono, P.nirInput).max(0.0), ctx);
}

// Input-gamma pre-trim shared by both flux branches - a power pivoted at 18%
// grey (same semantics as film.js): in logE it rescales the scene around the
// mid-grey anchor, like shooting a flatter/steeper scene, so tube gain, ABC
// calibration and mid-grey neutrality stay untouched. Applied before the
// exposure gain so that slider stays "stops at the photocathode". This is the
// look-correction knob for grey/green mids the exposure slider can't fix.
function fluxInputTrim(flux, ctx) {
  const P = ctx.P;
  return flux.div(0.18).max(1e-7).pow(P.inputGamma).mul(0.18)
    .mul(exp2u(P.exposure.add(ctx.inputExposure)));
}

// --- Stage 0: NIR prepass ---------------------------------------------------
// Resolve the scalar relative response once per frame into a full-res target.
// Every later stage reads this texture, so input decode happens exactly here
// (the spectral heuristic used to be re-evaluated ~7x per pixel: 5 PSF taps +
// the sharp read + the analysis pass).
function stNirPrepass(srcTex, ctx, { inputMode, inputEncoding }) {
  const P = ctx.P;
  if (inputMode === "nir") {
    // Linear photocathode response (e.g. a spectral tracer's NIR accumulation
    // channel): a raw single-channel LINEAR read - no sRGB decode, no luma
    // dot. fluxScale calibrates the renderer's flux range onto the range the
    // tube presets were tuned for.
    const flux = texture(srcTex, screenUV).r;
    return vec4(fluxInputTrim(flux.max(0.0).mul(P.fluxScale), ctx), 0.0, 0.0, 1.0);
  }
  const raw = texture(srcTex, screenUV).rgb;
  const lin = inputEncoding === "srgb" ? srgbToLinear(raw) : raw;
  return vec4(nirFromLinear(lin, ctx), 0.0, 0.0, 1.0);
}

// --- Stage 7 (folded into read): resolution-limited PSF -------------------
// A real tube is never razor-sharp (cascaded photocathode gap + MCP pore
// sampling + phosphor grain + fibre-optic window). A small 3x3 gaussian of the
// prepass keeps the signal soft so scintillation later sits as crisp sparkle
// on a soft base - the cure for "generic grain". Full 9-tap kernel (the old
// 5-tap plus kernel passed diagonals unblurred - a faint cross artifact).
function softNir(nirTex, ctx, uv) {
  const o = ctx.texel.mul(ctx.P.psfSigma);
  let sum = float(0.0);
  const w = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  let k = 0;
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      sum = sum.add(texture(nirTex, uv.add(o.mul(vec2(i, j)))).r.mul(w[k] / 16));
      k += 1;
    }
  }
  return sum;
}

// --- Stage 11: phosphor screen --------------------------------------------
// One intensity-invariant chroma multiply; only the brightest blooming cores
// desaturate toward white (eye/sensor clip). White phosphor is a cool
// near-neutral, NOT pure (1,1,1).
function phosphorMap(L, ctx) {
  const P = ctx.P;
  let screen = L.sub(P.screenBlack).max(0.0);
  screen = screen.mul(P.screenGain);
  screen = screen.div(screen.add(P.screenShoulder)).mul(P.screenShoulder.add(1.0));
  screen = screen.max(0.0).pow(P.phosphorGamma);

  const base = P.phosphorChroma.mul(screen);
  const white = P.highlightWhite.mul(min(screen, float(1.0)));
  const s = smoothstep(P.bloomStart, P.bloomStart.add(P.bloomRange), screen)
    .mul(P.highlightDesat);
  return mix(base, white, s);
}

// --- Stage 8: chicken-wire fixed pattern ----------------------------------
// Faint hexagonal MCP multifibre-boundary gain modulation, visible only in
// bright uniform fields, near-invisible on a high-end white-phosphor tube. A
// smooth 3-plane-wave honeycomb (no hard SDF) avoids moire against the pixel
// grid. Replaces the old CCD-style row/column gaussian streaks.
function hexGain(ctx, uv, L) {
  const P = ctx.P;
  const aspect = ctx.resolution.x.div(ctx.resolution.y);
  const p = vec2(uv.x.sub(0.5).mul(aspect), uv.y.sub(0.5)).mul(P.chickenFreq);
  const a = p.x;
  const b = p.x.mul(0.5).add(p.y.mul(0.8660254));
  const c = p.x.mul(-0.5).add(p.y.mul(0.8660254));
  const h = cos(a.mul(TAU)).add(cos(b.mul(TAU))).add(cos(c.mul(TAU)));
  const hn = h.add(1.5).mul(1.0 / 4.5).clamp(0.0, 1.0); // 0 at cell borders, 1 at centres
  const line = float(1.0).sub(smoothstep(0.0, P.chickenLine.add(1e-3), hn));
  const gate = smoothstep(P.chickenGateLo, P.chickenGateHi, L);
  return float(1.0).sub(P.chickenAmp.mul(line).mul(gate));
}

// --- Stage 9: scintillation -----------------------------------------------
// The headline fix. Real intensifier noise is NOT symmetric gaussian grain - it
// is a SPARSE field of brief BRIGHT flashes (single amplified photo-electrons),
// each ~one resolution element, whose density RISES as the signal falls (dark
// areas boil, bright areas are clean), riding on the EBI self-glow floor, plus a
// continuous sqrt(signal) shot fizz on lit surfaces.
//
// One frame's sparse sparkle field, a pure function of (cell, frame phase).
function sparkleAt(cell, fphase, L, ctx) {
  const P = ctx.P;
  const u = hash13(vec3(cell.x, cell.y, fphase.add(11.0)));
  const darkness = float(1.0).sub(smoothstep(0.025, 0.58, L));
  const dens = P.scintDensity.mul(
    float(1.0).add(P.scintDarkBoost.mul(darkness)),
  );
  const fire = step(float(1.0).sub(dens), u); // only the top `dens` fraction fire
  const v = hash13(vec3(cell.x.add(7.0), cell.y.add(3.0), fphase.add(23.0)));
  const amp = v.pow(P.scintSharp).mul(P.scintGain); // pow -> rare bright pops, not uniform
  // Each event is ONE photoelectron through the full MCP gain: its amplitude
  // is independent of the local signal (constant), riding just above the EBI
  // floor. The sqrt(signal) behaviour belongs to the continuous `shot` fizz,
  // not here - the old sqrt(L) term dimmed events exactly where they should
  // dominate (dark regions). Density alone carries the dark/bright asymmetry.
  const ride = float(1.0).add(P.ebi.mul(P.scintFloor));
  return fire.mul(amp).mul(ride);
}

function scintillation(L, ctx, includeShotNoise = true) {
  const P = ctx.P;
  // scintGrain is specified in TUBE pixels (~1280x960); grainScale (derived in
  // setSize) keeps sparkles ~one resolution element on larger canvases.
  const grain = max(P.scintGrain.mul(ctx.grainScale), float(0.5));
  const cell = floor(screenUV.mul(ctx.resolution).div(grain));
  const f = ctx.frame;

  // Continuous shot fizz: absolute noise ~ sqrt(signal), so relative noise falls
  // as the surface brightens (correct Poisson / high-SNR behaviour).
  const shot = includeShotNoise
    ? gaussTemporal(cell, f, 37.0).mul(sqrt(L.add(P.ebi)).mul(P.shotStrength))
    : float(0.0);

  // Sparse sparkle with a STATELESS phosphor "boil": because each frame's field
  // is a pure function of (cell, frame), we recompute the two previous frames and
  // combine with a decaying max() - each flash turns on sharply then fades over a
  // couple of frames (P45 ~1 ms afterglow), so the field boils rather than
  // blinks like TV snow. Needs no history buffer, and freezes correctly when the
  // frame uniform is held constant.
  const s0 = sparkleAt(cell, f, L, ctx);
  const s1 = sparkleAt(cell, f.sub(1.0), L, ctx).mul(P.persistence);
  const s2 = sparkleAt(cell, f.sub(2.0), L, ctx).mul(P.persistence.mul(P.persistence));
  const sparkle = max(s0, max(s1, s2));

  return shot.add(sparkle).mul(P.noiseAmount);
}

function infraredOutputAlpha(sourceSample, effectColor) {
  const sourceAlpha = sourceSample.a.clamp(0.0, 1.0);
  const effectDelta = dot(abs(effectColor.sub(sourceSample.rgb)), LUM709);
  const effectAlpha = effectDelta.sub(0.002).mul(6.0).clamp(0.0, 0.65);
  return sourceAlpha.add(effectAlpha.mul(sourceAlpha.oneMinus())).clamp(0.0, 1.0);
}

function stAnalysis(nirTex, ctx, eyeMaskTex) {
  const nir = texture(nirTex, screenUV).r;
  const glowMask = smoothstep(
    ctx.P.glowThreshold,
    ctx.P.glowThreshold.add(ctx.P.glowSoftness),
    nir,
  );
  // Saturate BEFORE the blur: a real halo is charge spreading across the
  // photocathode-MCP gap - a fixed angular disc whose CORE saturates as the
  // source brightens. An unclamped source makes the blurred halo grow with
  // brightness instead, and true-NIR inputs (unclamped Planck-tail sources)
  // would nuke the whole frame.
  const glowSource = min(nir.mul(glowMask), ctx.P.glowSaturate);
  const mask = eyeMaskTex ? texture(eyeMaskTex, screenUV).r.clamp(0.0, 1.0) : float(0.0);
  return vec4(nir, glowSource, glowSource.mul(mask), 1.0);
}

// Two-pass analysis blur. The adaptation mean (r) always uses the separable
// gaussian. The glow channels (g, b) optionally use a 13-tap Vogel-disc kernel
// per pass (rotated differently each pass) - a flatter, more disc-like halo
// profile than a gaussian, closer to the fixed angular spread of a real tube.
function stAnalysisBlur(tex, ctx, dx, dy, disc) {
  const sigma = 2.55;
  let sum = vec3(0.0);
  let wsum = 0.0;
  for (let i = -6; i <= 6; i += 1) {
    const w = Math.exp(-(i * i) / (2.0 * sigma * sigma));
    const off = ctx.analysisTexel.mul(vec2(dx, dy)).mul(ctx.P.glowRadius.mul(i));
    sum = sum.add(texture(tex, screenUV.add(off)).rgb.mul(w));
    wsum += w;
  }
  const gauss = sum.div(wsum);
  if (!disc) return vec4(gauss, 1.0);

  const rot = dy === 0 ? 0.0 : GOLDEN_ANGLE * 0.5; // decorrelate the two passes
  let glow = vec2(0.0);
  const taps = 13;
  for (let i = 0; i < taps; i += 1) {
    const r = Math.sqrt((i + 0.5) / taps) * 6.0; // match the gaussian footprint (+/-6 taps)
    const ang = i * GOLDEN_ANGLE + rot;
    const off = ctx.analysisTexel
      .mul(vec2(Math.cos(ang) * r, Math.sin(ang) * r))
      .mul(ctx.P.glowRadius);
    glow = glow.add(texture(tex, screenUV.add(off)).gb.mul(1 / taps));
  }
  return vec4(gauss.r, glow.x, glow.y, 1.0);
}

// --- Stage 3b: temporal ABC (gain breathing) --------------------------------
// A real tube's auto-brightness control is a feedback loop with real time
// constants: sweep a light into frame and the whole image dims over
// ~100-200 ms, then recovers over ~300-500 ms after it leaves (tubes dim
// faster than they recover). State is one float in a 1x1 ping-pong target:
//   gain <- lerp(gainPrev, middleGrey / mean, 1 - exp(-dt / tau))
// The mean is taken from a sparse grid of the quarter-res analysis target,
// which holds the PRE-gain signal - reading the post-gain image instead would
// close the loop on itself and oscillate.
function stAbcUpdate(analysisTex, gainPrevTex, ctx) {
  const P = ctx.P;
  let sum = float(0.0);
  const grid = 8;
  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      sum = sum.add(texture(analysisTex, vec2((i + 0.5) / grid, (j + 0.5) / grid)).r);
    }
  }
  const mean = sum.mul(1.0 / (grid * grid)).max(1e-4);
  const target = P.middleGrey.div(mean).clamp(P.abcMin, P.abcMax);
  const prev = texture(gainPrevTex, vec2(0.5, 0.5)).r;
  // dimming (target below current gain) uses the fast attack constant
  const tau = mix(P.abcRecover, P.abcAttack, step(target, prev)).max(1e-3);
  const k = float(1.0).sub(exp(ctx.dt.negate().div(tau)));
  return vec4(mix(prev, target, k), 0.0, 0.0, 1.0);
}

function stDevelop(
  srcTex, nirTex, ctx, analysisTex, abcGainTex, eyeMaskTex,
  stages, outputEncoding, electronModel,
) {
  const P = ctx.P;
  const sourceSample = texture(srcTex, screenUV);
  const nirSharp = texture(nirTex, screenUV).r; // sharp, for eye local contrast
  const analysis = analysisTex ? texture(analysisTex, screenUV).rgb : vec3(nirSharp, 0.0, 0.0);

  // 1+7: photocathode signal, resolution-limited (soft).
  let signal = softNir(nirTex, ctx, screenUV);
  if (electronModel) signal = relativeElectronSample(signal, ctx, 71.0);

  // 3: adaptation - local shading (same-frame tone mapping of the blurred local
  // mean, reduced) x global ABC breathing (temporal loop, 1x1 state target).
  // Both together match footage: local keeps detail near hot sources, global
  // makes the whole image breathe when the scene brightness changes.
  // Applied to the SCENE signal only - the EBI floor is injected after, so a
  // pitch-black frame (true night, no sources) can't be gained into grey fog:
  // the tube's self-glow is independent of scene-driven adaptation.
  if (stages.adaptation) {
    const local = max(analysis.r, float(1e-4));
    const adaptiveGain = P.middleGrey
      .div(local)
      .pow(P.localGain)
      .clamp(P.minGain, P.maxGain);
    const abcGain = abcGainTex ? texture(abcGainTex, vec2(0.5, 0.5)).r : float(1.0);
    signal = signal.mul(adaptiveGain).mul(abcGain);
  }

  // 2: EBI self-glow floor - lifts blacks into a faint glowing grey so noise has
  // something to ride on (what you see with the lens cap on). Post-adaptation,
  // pre-MCP: it still rides the MCP gain, as in a real tube.
  let background = P.ebi;
  if (electronModel) background = relativeElectronSample(P.ebi, ctx, 131.0);
  signal = signal.add(background);

  // 4: MCP gain + Naka-Rushton transfer - constant-gain region, saturation knee,
  // and a hard ceiling (maxOutput). The phosphor is linear, so no extra gamma.
  const x = signal.mul(P.gain);
  signal = x.div(x.div(P.maxOutput).add(1.0));

  // 5: halo / bloom - bright sources bloom into a fixed angular disc (charge
  // spreading across the photocathode-MCP gap), constant in screen space. The
  // source is saturated pre-blur (stAnalysis), so doubling a light's intensity
  // past glowSaturate drives the halo core toward clip without growing its radius.
  if (stages.glow) {
    signal = signal.add(analysis.g.mul(P.glowStrength));
  }

  // 6: eyeshine / retroreflection (animal eyes, retroreflectors under the IR
  // illuminator), with the optional eye-mask input.
  if (stages.eyes) {
    const localContrast = nirSharp.sub(analysis.r.mul(P.eyeLocalRatio)).max(0.0);
    const eyeCore = smoothstep(
      P.eyeThreshold,
      P.eyeThreshold.add(P.eyeSoftness),
      localContrast,
    ).mul(P.eyeStrength);
    signal = signal
      .add(eyeCore.mul(P.eyeCoreStrength))
      .add(eyeCore.mul(analysis.g).mul(P.eyeHaloStrength));

    if (eyeMaskTex) {
      const mask = texture(eyeMaskTex, screenUV).r.clamp(0.0, 1.0);
      signal = signal
        .add(analysis.b.mul(P.maskedEyeHalo).mul(P.eyeStrength))
        .add(eyeCore.mul(mask).mul(P.maskedEyeCore));
    }
  }

  // 8+9: device-locked chicken-wire, then sparse scintillation on top.
  if (stages.noise) {
    signal = signal.mul(hexGain(ctx, screenUV, signal));
    // Electron mode already supplies input shot noise; retain only the MCP-like
    // sparse events here so the same variance is not added twice.
    signal = signal.add(scintillation(signal, ctx, !electronModel)).max(P.ebi.mul(0.5));
  }

  // 10: eyepiece shading - circular field-stop vignette + centre hotspot only.
  // No CRT scanlines and no whole-frame flicker: an intensifier is not a raster
  // display and autogating runs at kHz, imperceptibly. The hotspot is gain, not
  // emitted light: multiplying preserves true black instead of painting a
  // green veil over unexposed NightShot pixels.
  if (stages.display) {
    const p = screenUV.sub(0.5);
    const aspect = ctx.resolution.x.div(ctx.resolution.y);
    const q = vec2(p.x.mul(aspect), p.y);
    const radius = sqrt(dot(q, q));
    const vignette = float(1.0).sub(smoothstep(0.25, 0.78, radius).mul(P.vignette));
    const hotspot = exp(radius.mul(radius).mul(-8.0)).mul(P.hotspot);
    signal = signal.mul(vignette).mul(hotspot.add(1.0));
  }

  // 11: phosphor colour map. sRGB encode only for display-referred handoff; a
  // linear output feeds a post stack that encodes at its own output stage.
  // The post-effect grade lands here, on the linear phosphor colour — after
  // AGC/ABC so the punch survives the tube's own normalisation.
  const phosphor = powershotLinearGrade(phosphorMap(signal.clamp(0.0, 1.35), ctx), ctx);
  if (outputEncoding === "linear") {
    const effectColor = phosphor.max(0.0);
    const finalColor = mix(sourceSample.rgb, effectColor, ctx.power).max(0.0);
    return vec4(finalColor, infraredOutputAlpha(sourceSample, finalColor));
  }
  const effectColor = linearToSrgb(phosphor).clamp(0.0, 1.0);
  const finalColor = mix(sourceSample.rgb, effectColor, ctx.power).clamp(0.0, 1.0);
  return vec4(finalColor, infraredOutputAlpha(sourceSample, finalColor));
}

export function makeInfraredUniforms() {
  return {
    resolution: uniform(new THREE.Vector2(1, 1)),
    texel: uniform(new THREE.Vector2(1, 1)),
    analysisTexel: uniform(new THREE.Vector2(1, 1)),
    frame: uniform(0),
    // post-effect grade on the linear phosphor output (powershotLinearGrade)
    outputBrightness: uniform(0),
    outputContrast: uniform(0),
    // Extra scene-linear plate gain in stops, before the tube response. Kept
    // separate from P.exposure so host exposure can stack with the mode trim.
    inputExposure: uniform(0),
    // frame delta in seconds, clamped by renderTexture (tab-switch spikes
    // would otherwise snap the ABC loop).
    dt: uniform(1 / 60),
    // internal canvas-size multiplier for the sparkle grain (see setSize)
    grainScale: uniform(1),
    power: uniform(1),
    P: {
      // photocathode spectral response
      exposure: uniform(1.0),
      // 18%-pivoted input power (see fluxInputTrim). 1.0 = untouched
      // scene-linear; <1 flattens grey/green mids, >1 steepens them.
      inputGamma: uniform(1.0),
      nirInput: uniform(0.0),
      // Linear NIR-response calibration (setInputMode("nir") path only)
      fluxScale: uniform(1.0),
      // Optional relative-electron front end. This is the expected
      // photoelectron count for input signal 1.0; P.ebi supplies the existing
      // input-referred dark background and is sampled independently.
      electronsPerUnit: uniform(1024.0),
      spectralMix: uniform(new THREE.Vector3(0.50, 0.40, 0.10)),
      redReflectance: uniform(0.25),
      greenReflectance: uniform(0.65),
      blueSuppression: uniform(0.10),
      skySuppress: uniform(0.45),
      waterSuppress: uniform(0.35),
      skinBoost: uniform(0.12),
      photocathodeGamma: uniform(0.88),

      // tube self-glow floor
      ebi: uniform(0.0045),

      // local adaptation
      middleGrey: uniform(0.18),
      localGain: uniform(0.32),
      minGain: uniform(0.70),
      maxGain: uniform(3.0),

      // temporal ABC (global gain breathing)
      abcAttack: uniform(0.08),
      abcRecover: uniform(0.35),
      abcMin: uniform(0.45),
      abcMax: uniform(2.6),

      // MCP gain + Naka-Rushton transfer
      gain: uniform(3.4),
      maxOutput: uniform(1.05),

      // halo / bloom
      glowThreshold: uniform(0.60),
      glowSoftness: uniform(0.22),
      glowStrength: uniform(0.45),
      glowRadius: uniform(1.45),
      glowSaturate: uniform(1.5),

      // eyeshine
      eyeStrength: uniform(0.90),
      eyeThreshold: uniform(0.30),
      eyeSoftness: uniform(0.12),
      eyeLocalRatio: uniform(1.15),
      eyeCoreStrength: uniform(0.56),
      eyeHaloStrength: uniform(0.50),
      maskedEyeCore: uniform(0.90),
      maskedEyeHalo: uniform(0.80),

      // resolution-limited optics
      psfSigma: uniform(0.75),

      // chicken-wire fixed pattern
      chickenAmp: uniform(0.02),
      chickenFreq: uniform(38.0),
      chickenLine: uniform(0.06),
      chickenGateLo: uniform(0.45),
      chickenGateHi: uniform(0.85),

      // scintillation noise
      noiseAmount: uniform(0.70),
      scintGrain: uniform(1.15),
      scintDensity: uniform(0.055),
      scintGain: uniform(0.55),
      scintSharp: uniform(3.2),
      scintDarkBoost: uniform(1.0),
      shotStrength: uniform(0.035),
      scintFloor: uniform(0.5),

      // phosphor screen
      phosphorChroma: uniform(new THREE.Vector3(0.92, 0.96, 1.00)),
      highlightWhite: uniform(new THREE.Vector3(1.00, 1.00, 1.00)),
      screenBlack: uniform(0.004),
      screenGain: uniform(1.08),
      screenShoulder: uniform(0.92),
      phosphorGamma: uniform(0.94),
      highlightDesat: uniform(0.55),
      bloomStart: uniform(0.75),
      bloomRange: uniform(0.55),

      // eyepiece shading
      vignette: uniform(0.30),
      hotspot: uniform(0.10),

      // phosphor persistence (scintillation boil tail)
      persistence: uniform(0.32),
    },
  };
}

export const INFRARED_PRESETS = {
  white_phosphor: {
    name: "P45 White Phosphor",
    sensor_resolution: [1280, 960],
    exposure: 0.85,
    nir_input: 0.0,
    spectral_mix: [0.58, 0.34, 0.08],
    red_reflectance: 0.24,
    green_reflectance: 0.92,
    blue_suppression: 0.16,
    sky_suppress: 0.66,
    water_suppress: 0.52,
    skin_boost: 0.17,
    photocathode_gamma: 0.86,
    ebi: 0.0065,
    middle_grey: 0.18,
    local_gain: 0.34,
    min_gain: 0.58,
    max_gain: 4.2,
    abc_attack: 0.08,
    abc_recover: 0.35,
    abc_min: 0.45,
    abc_max: 2.6,
    gain: 3.9,
    max_output: 0.98,
    glow_threshold: 0.44,
    glow_softness: 0.24,
    glow_strength: 0.34,
    glow_radius: 1.90,
    glow_saturate: 1.5,
    eye_strength: 0.78,
    eye_threshold: 0.28,
    eye_softness: 0.14,
    eye_local_ratio: 1.15,
    eye_core_strength: 0.50,
    eye_halo_strength: 0.44,
    masked_eye_core: 0.82,
    masked_eye_halo: 0.68,
    psf_sigma: 0.92,
    chicken_amp: 0.012,
    chicken_freq: 44.0,
    chicken_line: 0.045,
    chicken_gate_lo: 0.54,
    chicken_gate_hi: 0.92,
    noise_amount: 0.48,
    scint_grain: 1.05,
    scint_density: 0.018,
    // constant-amplitude events: gain now IS the pop brightness (was scaled by
    // ~sqrt(signal) before); density alone carries the dark/bright asymmetry.
    scint_gain: 0.55,
    scint_sharp: 4.2,
    scint_dark_boost: 1.6,
    shot_strength: 0.026,
    scint_floor: 0.72,
    phosphor_chroma: [0.78, 0.86, 0.96],
    highlight_white: [0.96, 0.98, 1.00],
    screen_black: 0.006,
    screen_gain: 1.12,
    screen_shoulder: 0.86,
    phosphor_gamma: 0.94,
    highlight_desat: 0.46,
    bloom_start: 0.64,
    bloom_range: 0.58,
    vignette: 0.26,
    hotspot: 0.055,
    persistence: 0.42,
  },
  // Tuned for a linear relative-response input (setInputMode("nir") fed by a
  // spectral tracer's NIR channel): linear flux with far hotter dynamic range
  // than the RGB heuristic - unclamped Planck-tail sources, unlit night ground
  // around 0.02-0.05 flux. The RGB-heuristic spectral controls are inert on
  // this path. Expect to trim flux_scale / gain against your renderer's units.
  white_phosphor_nir: {
    name: "P45 White Phosphor (true NIR)",
    sensor_resolution: [1280, 960],
    exposure: 0.0,
    nir_input: 1.0,
    flux_scale: 1.0,
    spectral_mix: [0.58, 0.34, 0.08],
    red_reflectance: 0.24,
    green_reflectance: 0.92,
    blue_suppression: 0.16,
    sky_suppress: 0.66,
    water_suppress: 0.52,
    skin_boost: 0.17,
    photocathode_gamma: 1.0,
    ebi: 0.0065,
    middle_grey: 0.18,
    local_gain: 0.30,
    min_gain: 0.58,
    max_gain: 5.0,
    abc_attack: 0.08,
    abc_recover: 0.35,
    abc_min: 0.45,
    abc_max: 3.4,
    gain: 6.5,
    max_output: 0.98,
    glow_threshold: 0.30,
    glow_softness: 0.24,
    glow_strength: 0.34,
    glow_radius: 1.90,
    glow_saturate: 1.5,
    eye_strength: 0.78,
    eye_threshold: 0.28,
    eye_softness: 0.14,
    eye_local_ratio: 1.15,
    eye_core_strength: 0.50,
    eye_halo_strength: 0.44,
    masked_eye_core: 0.82,
    masked_eye_halo: 0.68,
    psf_sigma: 0.92,
    chicken_amp: 0.012,
    chicken_freq: 44.0,
    chicken_line: 0.045,
    chicken_gate_lo: 0.54,
    chicken_gate_hi: 0.92,
    noise_amount: 0.48,
    scint_grain: 1.05,
    scint_density: 0.022,
    scint_gain: 0.55,
    scint_sharp: 4.2,
    scint_dark_boost: 1.6,
    shot_strength: 0.026,
    scint_floor: 0.72,
    phosphor_chroma: [0.78, 0.86, 0.96],
    highlight_white: [0.96, 0.98, 1.00],
    screen_black: 0.006,
    screen_gain: 1.12,
    screen_shoulder: 0.86,
    phosphor_gamma: 0.94,
    highlight_desat: 0.46,
    bloom_start: 0.64,
    bloom_range: 0.58,
    vignette: 0.26,
    hotspot: 0.055,
    persistence: 0.42,
  },
};

export const INFRARED_PRESET_KEYS = Object.keys(INFRARED_PRESETS);

export function applyInfraredPreset(ctx, preset) {
  const P = ctx.P;
  P.exposure.value = preset.exposure;
  P.inputGamma.value = preset.input_gamma ?? 1.0;
  P.nirInput.value = preset.nir_input;
  P.fluxScale.value = preset.flux_scale ?? 1.0;
  P.spectralMix.value.set(...preset.spectral_mix);
  P.redReflectance.value = preset.red_reflectance;
  P.greenReflectance.value = preset.green_reflectance;
  P.blueSuppression.value = preset.blue_suppression;
  P.skySuppress.value = preset.sky_suppress;
  P.waterSuppress.value = preset.water_suppress ?? 0.35;
  P.skinBoost.value = preset.skin_boost;
  P.photocathodeGamma.value = preset.photocathode_gamma ?? 0.88;
  P.ebi.value = preset.ebi;
  P.middleGrey.value = preset.middle_grey;
  P.localGain.value = preset.local_gain;
  P.minGain.value = preset.min_gain;
  P.maxGain.value = preset.max_gain;
  P.abcAttack.value = preset.abc_attack ?? 0.08;
  P.abcRecover.value = preset.abc_recover ?? 0.35;
  P.abcMin.value = preset.abc_min ?? 0.45;
  P.abcMax.value = preset.abc_max ?? 2.6;
  P.gain.value = preset.gain;
  P.maxOutput.value = preset.max_output;
  P.glowThreshold.value = preset.glow_threshold;
  P.glowSoftness.value = preset.glow_softness;
  P.glowStrength.value = preset.glow_strength;
  P.glowRadius.value = preset.glow_radius;
  P.glowSaturate.value = preset.glow_saturate ?? 1.5;
  P.eyeStrength.value = preset.eye_strength;
  P.eyeThreshold.value = preset.eye_threshold;
  P.eyeSoftness.value = preset.eye_softness;
  P.eyeLocalRatio.value = preset.eye_local_ratio;
  P.eyeCoreStrength.value = preset.eye_core_strength;
  P.eyeHaloStrength.value = preset.eye_halo_strength;
  P.maskedEyeCore.value = preset.masked_eye_core;
  P.maskedEyeHalo.value = preset.masked_eye_halo;
  P.psfSigma.value = preset.psf_sigma;
  P.chickenAmp.value = preset.chicken_amp;
  P.chickenFreq.value = preset.chicken_freq;
  P.chickenLine.value = preset.chicken_line;
  P.chickenGateLo.value = preset.chicken_gate_lo;
  P.chickenGateHi.value = preset.chicken_gate_hi;
  P.noiseAmount.value = preset.noise_amount;
  P.scintGrain.value = preset.scint_grain;
  P.scintDensity.value = preset.scint_density;
  P.scintGain.value = preset.scint_gain;
  P.scintSharp.value = preset.scint_sharp;
  P.scintDarkBoost.value = preset.scint_dark_boost;
  P.shotStrength.value = preset.shot_strength;
  P.scintFloor.value = preset.scint_floor;
  P.phosphorChroma.value.set(...preset.phosphor_chroma);
  P.highlightWhite.value.set(...preset.highlight_white);
  P.screenBlack.value = preset.screen_black ?? 0.004;
  P.screenGain.value = preset.screen_gain ?? 1.08;
  P.screenShoulder.value = preset.screen_shoulder ?? 0.92;
  P.phosphorGamma.value = preset.phosphor_gamma ?? 0.94;
  P.highlightDesat.value = preset.highlight_desat ?? 0.55;
  P.bloomStart.value = preset.bloom_start;
  P.bloomRange.value = preset.bloom_range;
  P.vignette.value = preset.vignette;
  P.hotspot.value = preset.hotspot;
  P.persistence.value = preset.persistence ?? 0.3;
}

export const INFRARED_STAGE_DEFS = [
  { id: "adaptation", label: "Local gain adaptation" },
  { id: "glow", label: "Intensifier halo" },
  { id: "eyes", label: "Retinal flare" },
  { id: "noise", label: "Tube scintillation" },
  { id: "display", label: "Phosphor display" },
];

export class InfraredPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.ctx = makeInfraredUniforms();

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    // full-res single-channel electron-flux prepass
    this.rtNir = new THREE.RenderTarget(1, 1, { ...opts, format: THREE.RedFormat });
    this.rtAnalysisA = new THREE.RenderTarget(1, 1, opts);
    this.rtAnalysisB = new THREE.RenderTarget(1, 1, { ...opts });
    // 1x1 ABC gain state (ping-pong: update A->B, copy B->A). Nearest filter:
    // r16f state, no interpolation wanted.
    const gainOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.rtGainA = new THREE.RenderTarget(1, 1, gainOpts);
    this.rtGainB = new THREE.RenderTarget(1, 1, { ...gainOpts });

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.mesh.frustumCulled = false;
    this.quadScene.add(this.mesh);

    this.enabled = new Set(["adaptation", "glow", "eyes", "noise", "display"]);
    this.source = null;
    this.eyeMask = null;
    this.size = { w: 0, h: 0 };
    // "rgb": simulate NIR from an RGB frame. "nir": the source IS linear
    // photocathode response (single channel) - read raw, no decode, no heuristic.
    this.inputMode = "rgb";
    this.electronModel = false;  // opt-in; default shaders remain unchanged
    this.inputEncoding = "srgb";   // decode applied to "rgb" sources
    this.outputEncoding = "srgb";  // "linear" for a handoff into a post stack
    this.haloDisc = false;         // Vogel-disc halo profile (see stAnalysisBlur)
    this.steps = [];
    this.developMat = null;
    this.abcInitMat = null;
    this.abcNeedsInit = true;
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

  setSource(tex) {
    if (this.source === tex) return;
    this.source = tex;
    this.clearHistory();
    this.dirty = true;
  }

  setSize(w, h) {
    if (w === this.size.w && h === this.size.h) return;
    const aw = Math.max(1, Math.round(w / 4));
    const ah = Math.max(1, Math.round(h / 4));
    this.rtNir.setSize(Math.max(1, w), Math.max(1, h));
    this.rtAnalysisA.setSize(aw, ah);
    this.rtAnalysisB.setSize(aw, ah);
    this.size = { w, h };
    this.ctx.resolution.value.set(w, h);
    this.ctx.texel.value.set(1 / w, 1 / h);
    this.ctx.analysisTexel.value.set(1 / aw, 1 / ah);
    // sparkle grain is specified at tube resolution; scale it up with the canvas
    this.ctx.grainScale.value = Math.max(1, Math.min(w, h) / TUBE_REFERENCE_MIN_DIM);
    this.clearHistory();
    this.dirty = true;
  }

  // "rgb" (default): simulate NIR from RGB. "nir": treat the source as a
  // linear photocathode response (e.g. a spectral tracer's NIR channel).
  setInputMode(mode) {
    const next = mode === "nir" ? "nir" : "rgb";
    if (this.inputMode === next) return;
    this.inputMode = next;
    this.ctx.P.nirInput.value = next === "nir" ? 1 : 0;
    this.dirty = true;
  }

  // Opt-in relative-electron shot-noise model. This never changes Speedball GI
  // or the default rgb/nir path; disabling it removes the model at graph build.
  setElectronModel(options = false) {
    const enabled = options === true || (
      options && typeof options === "object" && options.enabled !== false
    );
    let changed = enabled !== this.electronModel;
    if (options && typeof options === "object") {
      const requestedScale = Number(options.electronsPerUnit);
      if (Number.isFinite(requestedScale)) {
        const value = Math.min(1e6, Math.max(1, requestedScale));
        if (this.ctx.P.electronsPerUnit.value !== value) {
          this.ctx.P.electronsPerUnit.value = value;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.electronModel = enabled;
    this.clearHistory();
    this.dirty = true;
  }

  getElectronModel() {
    return {
      enabled: this.electronModel,
      electronsPerUnit: this.ctx.P.electronsPerUnit.value,
    };
  }

  // Encoding of an "rgb" source: "srgb" (default - typical canvas/video input)
  // or "linear" (an HDR render target - avoids a double decode).
  setInputEncoding(mode) {
    const next = mode === "linear" ? "linear" : "srgb";
    if (this.inputEncoding === next) return;
    this.inputEncoding = next;
    this.dirty = true;
  }

  setInputExposure(stops = 0) {
    this.ctx.inputExposure.value = Number.isFinite(stops) ? stops : 0;
  }

  // "srgb" (default): display-referred output. "linear": hand off to a post
  // stack that does its own output encode (avoids a double encode).
  setOutputEncoding(mode) {
    const next = mode === "linear" ? "linear" : "srgb";
    if (this.outputEncoding === next) return;
    this.outputEncoding = next;
    this.dirty = true;
  }

  setOutputColorGrading({ brightness = 0, contrast = 0 } = {}) {
    this.ctx.outputBrightness.value = Number.isFinite(brightness) ? brightness : 0;
    this.ctx.outputContrast.value = Number.isFinite(contrast) ? contrast : 0;
  }

  // Flat Vogel-disc halo profile instead of the separable gaussian.
  setHaloDisc(on) {
    const next = on === true;
    if (this.haloDisc === next) return;
    this.haloDisc = next;
    this.dirty = true;
  }

  setEyeMask(textureObject) {
    if (this.eyeMask === textureObject) return;
    if (textureObject) {
      textureObject.colorSpace = THREE.NoColorSpace;
      textureObject.flipY = false;
      textureObject.generateMipmaps = false;
      textureObject.minFilter = THREE.LinearFilter;
      textureObject.magFilter = THREE.LinearFilter;
    }
    this.eyeMask = textureObject || null;
    this.dirty = true;
  }

  clearEyeMask() {
    this.setEyeMask(null);
  }

  clearHistory() {
    // The phosphor "boil" is stateless (it recomputes prior frames
    // analytically); the only history is the ABC gain state, reset to 1.0.
    this.abcNeedsInit = true;
  }

  setEnabled(id, on) {
    const hasStage = this.enabled.has(id);
    if (on === hasStage) return;
    if (on) this.enabled.add(id);
    else this.enabled.delete(id);
    this.dirty = true;
  }

  _rebuild() {
    for (const s of this.steps) s.material.dispose();
    if (this.developMat) this.developMat.dispose();
    this.steps = [];
    this.developMat = null;
    this.dirty = false;
    if (!this.source) return;

    const stages = {
      adaptation: this.enabled.has("adaptation"),
      glow: this.enabled.has("glow"),
      eyes: this.enabled.has("eyes"),
      noise: this.enabled.has("noise"),
      display: this.enabled.has("display"),
    };
    const needsAnalysis = stages.adaptation || stages.glow || stages.eyes;

    if (!this.abcInitMat) {
      this.abcInitMat = this._mat(vec4(1.0, 0.0, 0.0, 1.0));
    }

    // Stage 0: resolve relative response once into the full-res prepass target.
    this.steps.push({
      material: this._mat(stNirPrepass(this.source, this.ctx, {
        inputMode: this.inputMode,
        inputEncoding: this.inputEncoding,
      })),
      target: this.rtNir,
    });

    if (needsAnalysis) {
      this.steps.push({
        material: this._mat(stAnalysis(this.rtNir.texture, this.ctx, this.eyeMask)),
        target: this.rtAnalysisA,
      });
      this.steps.push({
        material: this._mat(stAnalysisBlur(this.rtAnalysisA.texture, this.ctx, 1, 0, this.haloDisc)),
        target: this.rtAnalysisB,
      });
      this.steps.push({
        material: this._mat(stAnalysisBlur(this.rtAnalysisB.texture, this.ctx, 0, 1, this.haloDisc)),
        target: this.rtAnalysisA,
      });
    }

    if (stages.adaptation) {
      // ABC loop: update reads (analysis mean, gain A) -> writes gain B, then
      // B is copied back to A so the develop pass always reads A.
      this.steps.push({
        material: this._mat(stAbcUpdate(
          needsAnalysis ? this.rtAnalysisA.texture : this.rtNir.texture,
          this.rtGainA.texture,
          this.ctx,
        )),
        target: this.rtGainB,
      });
      this.steps.push({
        material: this._mat(vec4(texture(this.rtGainB.texture, vec2(0.5, 0.5)).r, 0.0, 0.0, 1.0)),
        target: this.rtGainA,
      });
    }

    this.developMat = this._mat(
      stDevelop(
        this.source,
        this.rtNir.texture,
        this.ctx,
        needsAnalysis ? this.rtAnalysisA.texture : null,
        stages.adaptation ? this.rtGainA.texture : null,
        this.eyeMask,
        stages,
        this.outputEncoding,
        this.electronModel,
      ),
    );
    this.developMat.transparent = true;
    this.developMat.blending = THREE.NoBlending;
  }

  renderTexture(inputTexture, frame = 0, { outputTarget = null, dt = 1 / 60 } = {}) {
    if (!inputTexture) return false;
    this.setSource(inputTexture);
    if (this.dirty) this._rebuild();
    if (!this.source || !this.developMat) return false;
    this.ctx.frame.value = frame;
    this.ctx.dt.value = Math.min(Math.max(Number.isFinite(dt) ? dt : 1 / 60, 0), 0.1);
    const r = this.renderer;
    const previousTarget = r.getRenderTarget?.() ?? null;

    try {
      if (this.abcNeedsInit && this.abcInitMat) {
        this.mesh.material = this.abcInitMat;
        r.setRenderTarget(this.rtGainA);
        r.render(this.quadScene, this.quadCam);
        r.setRenderTarget(this.rtGainB);
        r.render(this.quadScene, this.quadCam);
        this.abcNeedsInit = false;
      }
      for (const step of this.steps) {
        this.mesh.material = step.material;
        r.setRenderTarget(step.target);
        r.render(this.quadScene, this.quadCam);
      }
      this.mesh.material = this.developMat;
      r.setRenderTarget(outputTarget);
      r.render(this.quadScene, this.quadCam);
      return true;
    } finally {
      r.setRenderTarget(previousTarget);
    }
  }

  async render(frame, options = {}) {
    this.renderTexture(this.source, frame, options);
  }

  dispose() {
    for (const s of this.steps) s.material.dispose();
    this.steps = [];
    if (this.developMat) this.developMat.dispose();
    this.developMat = null;
    if (this.abcInitMat) this.abcInitMat.dispose();
    this.abcInitMat = null;
    this.rtNir.dispose();
    this.rtAnalysisA.dispose();
    this.rtAnalysisB.dispose();
    this.rtGainA.dispose();
    this.rtGainB.dispose();
    this.mesh.geometry.dispose();
  }
}
