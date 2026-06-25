// PowerSHOT realtime ISP — bootstrap (three.js WebGPU).
import * as THREE from "three/webgpu";
import {
  Pipeline, PRESETS, PRESET_KEYS, STAGE_DEFS, applyPreset,
  FilmPipeline, FILM_PRESETS, FILM_PRESET_KEYS, applyFilmPreset,
  InfraredPipeline, INFRARED_PRESETS, applyInfraredPreset,
} from "./index.js";

const MAX_WORK = 1600; // cap working resolution for snappy realtime
const ANALOG_WORK = [720, 540];
const DEFAULT_IMAGE = `${import.meta.env.BASE_URL}vibe%20coding.jpg`;

const els = {
  canvas: document.getElementById("view"),
  mode: document.getElementById("mode"),
  resolution: document.getElementById("resolution"),
  resolutionval: document.getElementById("resolutionval"),
  preset: document.getElementById("preset"),
  digitalControls: document.getElementById("digital-controls"),
  analogControls: document.getElementById("analog-controls"),
  filmControls: document.getElementById("film-controls"),
  infraredControls: document.getElementById("infrared-controls"),
  filmpreset: document.getElementById("filmpreset"),
  filmexposure: document.getElementById("filmexposure"),
  filmexposureval: document.getElementById("filmexposureval"),
  filmgamma: document.getElementById("filmgamma"),
  filmgammaval: document.getElementById("filmgammaval"),
  filmgrain: document.getElementById("filmgrain"),
  filmgrainval: document.getElementById("filmgrainval"),
  filmgrainsize: document.getElementById("filmgrainsize"),
  filmgrainsizeval: document.getElementById("filmgrainsizeval"),
  filmgrainsat: document.getElementById("filmgrainsat"),
  filmgrainsatval: document.getElementById("filmgrainsatval"),
  filmhalation: document.getElementById("filmhalation"),
  filmhalationval: document.getElementById("filmhalationval"),
  filmhalthreshold: document.getElementById("filmhalthreshold"),
  filmhalthresholdval: document.getElementById("filmhalthresholdval"),
  filmhalradius: document.getElementById("filmhalradius"),
  filmhalradiusval: document.getElementById("filmhalradiusval"),
  filmprintexp: document.getElementById("filmprintexp"),
  filmprintexpval: document.getElementById("filmprintexpval"),
  filmwarmth: document.getElementById("filmwarmth"),
  filmwarmthval: document.getElementById("filmwarmthval"),
  filmweave: document.getElementById("filmweave"),
  filmweaveval: document.getElementById("filmweaveval"),
  filmflicker: document.getElementById("filmflicker"),
  filmflickerval: document.getElementById("filmflickerval"),
  filmnegview: document.getElementById("filmnegview"),
  infraredexposure: document.getElementById("infraredexposure"),
  infraredexposureval: document.getElementById("infraredexposureval"),
  infraredresponse: document.getElementById("infraredresponse"),
  infraredresponseval: document.getElementById("infraredresponseval"),
  infraredlocalgain: document.getElementById("infraredlocalgain"),
  infraredlocalgainval: document.getElementById("infraredlocalgainval"),
  infraredglow: document.getElementById("infraredglow"),
  infraredglowval: document.getElementById("infraredglowval"),
  infraredglowthreshold: document.getElementById("infraredglowthreshold"),
  infraredglowthresholdval: document.getElementById("infraredglowthresholdval"),
  infraredeyes: document.getElementById("infraredeyes"),
  infraredeyesval: document.getElementById("infraredeyesval"),
  infrarednoise: document.getElementById("infrarednoise"),
  infrarednoiseval: document.getElementById("infrarednoiseval"),
  infraredvignette: document.getElementById("infraredvignette"),
  infraredvignetteval: document.getElementById("infraredvignetteval"),
  infraredhotspot: document.getElementById("infraredhotspot"),
  infraredhotspotval: document.getElementById("infraredhotspotval"),
  lens: document.getElementById("lens"),
  lensval: document.getElementById("lensval"),
  bloom: document.getElementById("bloom"),
  bloomval: document.getElementById("bloomval"),
  noise: document.getElementById("noise"),
  noiseval: document.getElementById("noiseval"),
  bayernr: document.getElementById("bayernr"),
  bayernrval: document.getElementById("bayernrval"),
  chroma: document.getElementById("chroma"),
  chromaval: document.getElementById("chromaval"),
  jpeg: document.getElementById("jpeg"),
  jpegval: document.getElementById("jpegval"),
  jpegquality: document.getElementById("jpegquality"),
  jpegqualityval: document.getElementById("jpegqualityval"),
  jpegchroma: document.getElementById("jpegchroma"),
  jpegchromaval: document.getElementById("jpegchromaval"),
  jpegmidtone: document.getElementById("jpegmidtone"),
  jpegmidtoneval: document.getElementById("jpegmidtoneval"),
  jpeghighlight: document.getElementById("jpeghighlight"),
  jpeghighlightval: document.getElementById("jpeghighlightval"),
  brightness: document.getElementById("brightness"),
  brightnessval: document.getElementById("brightnessval"),
  contrast: document.getElementById("contrast"),
  contrastval: document.getElementById("contrastval"),
  analog: document.getElementById("analog"),
  analogval: document.getElementById("analogval"),
  tracking: document.getElementById("tracking"),
  trackingval: document.getElementById("trackingval"),
  chromableed: document.getElementById("chromableed"),
  chromableedval: document.getElementById("chromableedval"),
  ringing: document.getElementById("ringing"),
  ringingval: document.getElementById("ringingval"),
  tapenoise: document.getElementById("tapenoise"),
  tapenoiseval: document.getElementById("tapenoiseval"),
  bandmask: document.getElementById("bandmask"),
  bandmaskval: document.getElementById("bandmaskval"),
  edgewave: document.getElementById("edgewave"),
  edgewaveval: document.getElementById("edgewaveval"),
  dropouts: document.getElementById("dropouts"),
  dropoutsval: document.getElementById("dropoutsval"),
  scanlines: document.getElementById("scanlines"),
  scanlinesval: document.getElementById("scanlinesval"),
  headswitch: document.getElementById("headswitch"),
  headswitchval: document.getElementById("headswitchval"),
  freeze: document.getElementById("freeze-noise"),
  record: document.getElementById("record"),
  videoControls: document.getElementById("video-controls"),
  playpause: document.getElementById("playpause"),
  mute: document.getElementById("mute"),
  seek: document.getElementById("seek"),
  timeval: document.getElementById("timeval"),
  volume: document.getElementById("volume"),
  volval: document.getElementById("volval"),
  stages: document.getElementById("stages"),
  stageControls: document.getElementById("stage-controls"),
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  enableStages: document.getElementById("enable-stages"),
  disableStages: document.getElementById("disable-stages"),
  status: document.getElementById("status"),
};

let renderer, pipeline, filmPipeline, infraredPipeline, source = null;
let currentVideo = null;
let videoFrameDirty = false;
// Firefox's WebGPU can't copy an HTMLVideoElement directly into a texture; when
// that's the case we draw each frame into a 2D canvas first and upload that.
let videoBridgeCanvas = null;
let videoBridgeCtx = null;
let scrubbing = false;
let userMuted = false;
let userVolume = 1;
let recorder = null;
let recChunks = [];
let recLoopWas = false;
let frame = 0;
let mode = "analog";
let presetKey = "cybershot";
let filmPresetKey = FILM_PRESET_KEYS[0];
let infraredPresetKey = "white_phosphor";
let resolutionScale = 0.65;
let busy = false;
let freezeNoise = false;
let outputBrightness = 0;
let outputContrast = 0;

// fps tracking
let fpsLast = performance.now();
let fpsCount = 0;
let fps = 0;

function setStatus(msg) { els.status.textContent = msg; }

async function init() {
  if (!navigator.gpu) {
    setStatus("WebGPU not available in this browser.\nUse Chrome/Edge 113+ or Firefox Nightly.");
    return;
  }

  renderer = new THREE.WebGPURenderer({ canvas: els.canvas, antialias: false });
  renderer.toneMapping = THREE.NoToneMapping;
  // present our gamma-encoded 0..1 values verbatim (no extra sRGB encode)
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  await renderer.init();

  pipeline = new Pipeline(renderer);
  pipeline.setMode(mode === "analog" ? "analog" : "digital");
  filmPipeline = new FilmPipeline(renderer);
  infraredPipeline = new InfraredPipeline(renderer);

  buildPresetUI();
  buildFilmPresetUI();
  buildStageUI();
  wireInput();

  await loadImage(DEFAULT_IMAGE);
  applyPreset(pipeline.ctx, PRESETS[presetKey]);
  applyFilmPreset(filmPipeline.ctx, FILM_PRESETS[filmPresetKey]);
  applyInfraredPreset(infraredPipeline.ctx, INFRARED_PRESETS[infraredPresetKey]);
  syncEffectUI();

  renderer.setAnimationLoop(tick);
}

function buildPresetUI() {
  for (const key of PRESET_KEYS) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${key} — ${PRESETS[key].name}`;
    els.preset.appendChild(opt);
  }
  els.preset.value = presetKey;
  els.preset.addEventListener("change", () => {
    presetKey = els.preset.value;
    applyPreset(pipeline.ctx, PRESETS[presetKey]);
    syncEffectUI();
    resizeForSource();
  });
}

function buildFilmPresetUI() {
  for (const key of FILM_PRESET_KEYS) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${key} — ${FILM_PRESETS[key].name}`;
    els.filmpreset.appendChild(opt);
  }
  els.filmpreset.value = filmPresetKey;
  els.filmpreset.addEventListener("change", () => {
    filmPresetKey = els.filmpreset.value;
    applyFilmPreset(filmPipeline.ctx, FILM_PRESETS[filmPresetKey]);
    syncEffectUI();
  });
}

function buildStageUI() {
  els.stages.innerHTML = "";
  for (const stage of STAGE_DEFS) {
    const row = document.createElement("label");
    row.className = "row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pipeline.enabled.has(stage.id);
    row.classList.toggle("off", !cb.checked);
    cb.addEventListener("change", () => {
      pipeline.setEnabled(stage.id, cb.checked);
      row.classList.toggle("off", !cb.checked);
    });
    const span = document.createElement("span");
    span.textContent = stage.label;
    row.appendChild(cb);
    row.appendChild(span);
    els.stages.appendChild(row);
  }
}

function setSlider(slider, label, value, scale = 100, digits = 2) {
  slider.value = Math.round(value * scale);
  label.textContent = digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

function wireInput() {
  els.mode.addEventListener("change", () => {
    mode = els.mode.value;
    if (mode === "analog" || mode === "digital") pipeline.setMode(mode);
    syncModeUI();
    syncFreezeUI();
    resizeForSource();
  });
  els.resolution.addEventListener("input", () => {
    resolutionScale = Math.min(1, Math.max(0.1, els.resolution.value / 100));
    els.resolutionval.textContent = `${resolutionScale.toFixed(2)}x`;
    resizeForSource();
  });
  els.lens.addEventListener("input", () => {
    const v = els.lens.value / 100;
    pipeline.ctx.P.lensSoftness.value = v;
    els.lensval.textContent = v.toFixed(2);
  });
  els.bloom.addEventListener("input", () => {
    const v = els.bloom.value / 100;
    pipeline.ctx.P.ccdBloom.value = v;
    els.bloomval.textContent = v.toFixed(2);
  });
  els.noise.addEventListener("input", () => {
    const v = els.noise.value / 100;
    pipeline.ctx.noiseScale.value = v;
    els.noiseval.textContent = v.toFixed(2);
  });
  els.bayernr.addEventListener("input", () => {
    const v = els.bayernr.value / 100;
    pipeline.ctx.P.bayerNR.value = v;
    els.bayernrval.textContent = v.toFixed(2);
  });
  els.chroma.addEventListener("input", () => {
    const v = els.chroma.value / 100;
    pipeline.ctx.P.chromaNR.value = v;
    els.chromaval.textContent = v.toFixed(2);
  });
  els.jpeg.addEventListener("input", () => {
    const v = els.jpeg.value / 100;
    pipeline.ctx.P.jpegStrength.value = v;
    els.jpegval.textContent = v.toFixed(2);
  });
  els.jpegquality.addEventListener("input", () => {
    const v = Number(els.jpegquality.value);
    pipeline.ctx.P.jpegQuality.value = v;
    els.jpegqualityval.textContent = String(Math.round(v));
  });
  els.jpegchroma.addEventListener("input", () => {
    const v = els.jpegchroma.value / 100;
    pipeline.ctx.P.jpegChroma420.value = v;
    els.jpegchromaval.textContent = v.toFixed(2);
  });
  els.jpegmidtone.addEventListener("input", () => {
    const v = els.jpegmidtone.value / 100;
    pipeline.ctx.P.jpegMidtone.value = v;
    els.jpegmidtoneval.textContent = v.toFixed(2);
  });
  els.jpeghighlight.addEventListener("input", () => {
    const v = els.jpeghighlight.value / 100;
    pipeline.ctx.P.jpegHighlight.value = v;
    els.jpeghighlightval.textContent = v.toFixed(2);
  });
  els.brightness.addEventListener("input", () => {
    outputBrightness = els.brightness.value / 100;
    pipeline.setOutputColorGrading({ brightness: outputBrightness, contrast: outputContrast });
    els.brightnessval.textContent = outputBrightness.toFixed(2);
  });
  els.contrast.addEventListener("input", () => {
    outputContrast = els.contrast.value / 100;
    pipeline.setOutputColorGrading({ brightness: outputBrightness, contrast: outputContrast });
    els.contrastval.textContent = outputContrast.toFixed(2);
  });
  els.analog.addEventListener("input", () => {
    const v = els.analog.value / 100;
    pipeline.ctx.P.analogStrength.value = v;
    els.analogval.textContent = v.toFixed(2);
  });
  els.tracking.addEventListener("input", () => {
    const v = els.tracking.value / 100;
    pipeline.ctx.P.analogTracking.value = v;
    els.trackingval.textContent = v.toFixed(2);
  });
  els.chromableed.addEventListener("input", () => {
    const v = els.chromableed.value / 100;
    pipeline.ctx.P.analogChromaBleed.value = v;
    els.chromableedval.textContent = v.toFixed(2);
  });
  els.ringing.addEventListener("input", () => {
    const v = els.ringing.value / 100;
    pipeline.ctx.P.analogRinging.value = v;
    els.ringingval.textContent = v.toFixed(2);
  });
  els.tapenoise.addEventListener("input", () => {
    const v = els.tapenoise.value / 100;
    pipeline.ctx.P.analogTapeNoise.value = v;
    els.tapenoiseval.textContent = v.toFixed(2);
  });
  els.bandmask.addEventListener("input", () => {
    const v = els.bandmask.value / 100;
    pipeline.ctx.P.analogBandMask.value = v;
    els.bandmaskval.textContent = v.toFixed(2);
  });
  els.edgewave.addEventListener("input", () => {
    const v = els.edgewave.value / 100;
    pipeline.ctx.P.analogEdgeWave.value = v;
    els.edgewaveval.textContent = v.toFixed(2);
  });
  els.dropouts.addEventListener("input", () => {
    const v = els.dropouts.value / 100;
    pipeline.ctx.P.analogDropouts.value = v;
    els.dropoutsval.textContent = v.toFixed(2);
  });
  els.scanlines.addEventListener("input", () => {
    const v = els.scanlines.value / 100;
    pipeline.ctx.P.analogScanlines.value = v;
    els.scanlinesval.textContent = v.toFixed(2);
  });
  els.headswitch.addEventListener("input", () => {
    const v = els.headswitch.value / 100;
    pipeline.ctx.P.analogHeadSwitch.value = v;
    els.headswitchval.textContent = v.toFixed(2);
  });

  const wireFilmSlider = (el, valEl, apply) => {
    el.addEventListener("input", () => {
      const v = el.value / 100;
      apply(v);
      valEl.textContent = v.toFixed(2);
    });
  };
  const FP = () => filmPipeline.ctx.P;
  wireFilmSlider(els.filmexposure, els.filmexposureval, (v) => { FP().exposure.value = v; });
  wireFilmSlider(els.filmgamma, els.filmgammaval, (v) => { FP().inputGamma.value = v; });
  wireFilmSlider(els.filmgrain, els.filmgrainval, (v) => { FP().grainStrength.value = v; });
  wireFilmSlider(els.filmgrainsize, els.filmgrainsizeval, (v) => { FP().grainSize.value = v; });
  wireFilmSlider(els.filmgrainsat, els.filmgrainsatval, (v) => { FP().grainSaturation.value = v; });
  wireFilmSlider(els.filmhalation, els.filmhalationval, (v) => { FP().halStrength.value = v; });
  wireFilmSlider(els.filmhalthreshold, els.filmhalthresholdval, (v) => { FP().halThreshold.value = v; });
  wireFilmSlider(els.filmhalradius, els.filmhalradiusval, (v) => { FP().halRadius.value = v; });
  wireFilmSlider(els.filmprintexp, els.filmprintexpval, (v) => { FP().printExposure.value = v * 0.301; });
  wireFilmSlider(els.filmwarmth, els.filmwarmthval, (v) => { FP().printWarmth.value = v; });
  wireFilmSlider(els.filmweave, els.filmweaveval, (v) => { FP().weave.value = v; });
  wireFilmSlider(els.filmflicker, els.filmflickerval, (v) => { FP().flicker.value = v; });
  els.filmnegview.addEventListener("click", () => {
    const on = filmPipeline.ctx.P.negativeView.value < 0.5;
    filmPipeline.ctx.P.negativeView.value = on ? 1 : 0;
    els.filmnegview.textContent = on ? "show print" : "show negative";
    els.filmnegview.classList.toggle("active", on);
  });

  const wireInfraredSlider = (el, valEl, apply) => {
    el.addEventListener("input", () => {
      const v = el.value / 100;
      apply(v);
      valEl.textContent = v.toFixed(2);
    });
  };
  const IP = () => infraredPipeline.ctx.P;
  wireInfraredSlider(els.infraredexposure, els.infraredexposureval, (v) => { IP().exposure.value = v; });
  wireInfraredSlider(els.infraredresponse, els.infraredresponseval, (v) => { IP().nirInput.value = v; });
  wireInfraredSlider(els.infraredlocalgain, els.infraredlocalgainval, (v) => { IP().localGain.value = v; });
  wireInfraredSlider(els.infraredglow, els.infraredglowval, (v) => { IP().glowStrength.value = v; });
  wireInfraredSlider(els.infraredglowthreshold, els.infraredglowthresholdval, (v) => { IP().glowThreshold.value = v; });
  wireInfraredSlider(els.infraredeyes, els.infraredeyesval, (v) => { IP().eyeStrength.value = v; });
  wireInfraredSlider(els.infrarednoise, els.infrarednoiseval, (v) => { IP().noiseAmount.value = v; });
  wireInfraredSlider(els.infraredvignette, els.infraredvignetteval, (v) => { IP().vignette.value = v; });
  wireInfraredSlider(els.infraredhotspot, els.infraredhotspotval, (v) => { IP().hotspot.value = v; });

  els.freeze.addEventListener("click", () => {
    freezeNoise = !freezeNoise;
    syncFreezeUI();
  });

  els.record.addEventListener("click", () => {
    if (recorder) stopRecording();
    else startRecording();
  });

  els.playpause.addEventListener("click", () => {
    if (!currentVideo) return;
    if (currentVideo.paused) currentVideo.play().catch(() => {});
    else currentVideo.pause();
  });
  els.mute.addEventListener("click", () => {
    if (!currentVideo) return;
    userMuted = !currentVideo.muted;
    currentVideo.muted = userMuted;
    syncTransportUI();
  });
  els.volume.addEventListener("input", () => {
    userVolume = els.volume.value / 100;
    els.volval.textContent = String(Math.round(els.volume.value));
    if (currentVideo) {
      currentVideo.volume = userVolume;
      if (userVolume > 0 && currentVideo.muted) {
        currentVideo.muted = userMuted = false;
        syncTransportUI();
      }
    }
  });
  els.seek.addEventListener("pointerdown", () => { scrubbing = true; });
  els.seek.addEventListener("pointerup", () => { scrubbing = false; });
  els.seek.addEventListener("input", () => {
    if (!currentVideo || !isFinite(currentVideo.duration) || currentVideo.duration <= 0) return;
    currentVideo.currentTime = (els.seek.value / 1000) * currentVideo.duration;
    videoFrameDirty = true; // show the seeked frame even while paused
    els.timeval.textContent = `${fmtTime(currentVideo.currentTime)} / ${fmtTime(currentVideo.duration)}`;
  });

  els.enableStages.addEventListener("click", () => {
    for (const stage of STAGE_DEFS) pipeline.setEnabled(stage.id, true);
    buildStageUI();
  });
  els.disableStages.addEventListener("click", () => {
    for (const stage of STAGE_DEFS) pipeline.setEnabled(stage.id, false);
    buildStageUI();
  });

  els.drop.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
  });

  for (const ev of ["dragenter", "dragover"]) {
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("hot"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("hot"); });
  }
  els.drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
}

function syncModeUI() {
  els.digitalControls.hidden = mode !== "digital";
  els.stageControls.hidden = mode !== "digital";
  els.analogControls.hidden = mode !== "analog";
  els.filmControls.hidden = mode !== "film";
  els.infraredControls.hidden = mode !== "infrared";
  els.mode.value = mode;
}

function syncFreezeUI() {
  const noun = mode === "analog" ? "tape"
    : mode === "film" ? "grain"
    : mode === "infrared" ? "phosphor"
    : "noise";
  els.freeze.textContent = freezeNoise ? `unfreeze ${noun}` : `freeze ${noun}`;
  els.freeze.classList.toggle("active", freezeNoise);
}

function syncEffectUI() {
  syncModeUI();

  const lens = pipeline.ctx.P.lensSoftness.value;
  els.resolution.value = Math.round(resolutionScale * 100);
  els.resolutionval.textContent = `${resolutionScale.toFixed(2)}x`;

  setSlider(els.lens, els.lensval, lens);

  const bloom = pipeline.ctx.P.ccdBloom.value;
  setSlider(els.bloom, els.bloomval, bloom);

  const noise = pipeline.ctx.noiseScale.value;
  setSlider(els.noise, els.noiseval, noise);

  const bnr = pipeline.ctx.P.bayerNR.value;
  setSlider(els.bayernr, els.bayernrval, bnr);

  const chroma = pipeline.ctx.P.chromaNR.value;
  setSlider(els.chroma, els.chromaval, chroma);

  const jpeg = pipeline.ctx.P.jpegStrength.value;
  setSlider(els.jpeg, els.jpegval, jpeg);

  const jpegQuality = pipeline.ctx.P.jpegQuality.value;
  setSlider(els.jpegquality, els.jpegqualityval, jpegQuality, 1, 0);

  const jpegChroma = pipeline.ctx.P.jpegChroma420.value;
  setSlider(els.jpegchroma, els.jpegchromaval, jpegChroma);

  const jpegMidtone = pipeline.ctx.P.jpegMidtone.value;
  setSlider(els.jpegmidtone, els.jpegmidtoneval, jpegMidtone);

  const jpegHighlight = pipeline.ctx.P.jpegHighlight.value;
  setSlider(els.jpeghighlight, els.jpeghighlightval, jpegHighlight);

  setSlider(els.brightness, els.brightnessval, outputBrightness);
  setSlider(els.contrast, els.contrastval, outputContrast);

  const analog = pipeline.ctx.P.analogStrength.value;
  setSlider(els.analog, els.analogval, analog);

  const tracking = pipeline.ctx.P.analogTracking.value;
  setSlider(els.tracking, els.trackingval, tracking);

  const chromaBleed = pipeline.ctx.P.analogChromaBleed.value;
  setSlider(els.chromableed, els.chromableedval, chromaBleed);

  const ringing = pipeline.ctx.P.analogRinging.value;
  setSlider(els.ringing, els.ringingval, ringing);

  const tapeNoise = pipeline.ctx.P.analogTapeNoise.value;
  setSlider(els.tapenoise, els.tapenoiseval, tapeNoise);

  const bandMask = pipeline.ctx.P.analogBandMask.value;
  setSlider(els.bandmask, els.bandmaskval, bandMask);

  const edgeWave = pipeline.ctx.P.analogEdgeWave.value;
  setSlider(els.edgewave, els.edgewaveval, edgeWave);

  const dropouts = pipeline.ctx.P.analogDropouts.value;
  setSlider(els.dropouts, els.dropoutsval, dropouts);

  const scanlines = pipeline.ctx.P.analogScanlines.value;
  setSlider(els.scanlines, els.scanlinesval, scanlines);

  const headSwitch = pipeline.ctx.P.analogHeadSwitch.value;
  setSlider(els.headswitch, els.headswitchval, headSwitch);

  const FP = filmPipeline.ctx.P;
  setSlider(els.filmexposure, els.filmexposureval, FP.exposure.value);
  setSlider(els.filmgamma, els.filmgammaval, FP.inputGamma.value);
  setSlider(els.filmgrain, els.filmgrainval, FP.grainStrength.value);
  setSlider(els.filmgrainsize, els.filmgrainsizeval, FP.grainSize.value);
  setSlider(els.filmgrainsat, els.filmgrainsatval, FP.grainSaturation.value);
  setSlider(els.filmhalation, els.filmhalationval, FP.halStrength.value);
  setSlider(els.filmhalthreshold, els.filmhalthresholdval, FP.halThreshold.value);
  setSlider(els.filmhalradius, els.filmhalradiusval, FP.halRadius.value);
  setSlider(els.filmprintexp, els.filmprintexpval, FP.printExposure.value / 0.301);
  setSlider(els.filmwarmth, els.filmwarmthval, FP.printWarmth.value);
  setSlider(els.filmweave, els.filmweaveval, FP.weave.value);
  setSlider(els.filmflicker, els.filmflickerval, FP.flicker.value);

  const IP = infraredPipeline.ctx.P;
  setSlider(els.infraredexposure, els.infraredexposureval, IP.exposure.value);
  setSlider(els.infraredresponse, els.infraredresponseval, IP.nirInput.value);
  setSlider(els.infraredlocalgain, els.infraredlocalgainval, IP.localGain.value);
  setSlider(els.infraredglow, els.infraredglowval, IP.glowStrength.value);
  setSlider(els.infraredglowthreshold, els.infraredglowthresholdval, IP.glowThreshold.value);
  setSlider(els.infraredeyes, els.infraredeyesval, IP.eyeStrength.value);
  setSlider(els.infrarednoise, els.infrarednoiseval, IP.noiseAmount.value);
  setSlider(els.infraredvignette, els.infraredvignetteval, IP.vignette.value);
  setSlider(els.infraredhotspot, els.infraredhotspotval, IP.hotspot.value);

  syncFreezeUI();
}

async function loadFile(file) {
  if (file.type.startsWith("video/")) return loadVideo(file);
  const bitmap = await createImageBitmap(file);
  setSource(bitmap, file.name);
}

function loadVideo(file) {
  stopVideo();
  const video = document.createElement("video");
  video.src = URL.createObjectURL(file);
  video.loop = true;
  video.muted = userMuted;     // starts audible by default — playback is user-initiated
  video.volume = userVolume;
  video.playsInline = true;
  video.preload = "auto";
  video.addEventListener("error", () => setStatus(`could not load ${file.name}`));
  video.addEventListener("play", syncTransportUI);
  video.addEventListener("pause", syncTransportUI);
  // loadeddata → first frame is decoded, so we can show it paused (no autoplay)
  video.addEventListener("loadeddata", () => {
    setVideoSource(video, file.name).catch((err) => setStatus(`could not load ${file.name}\n${err?.message || err}`));
  }, { once: true });
}

// Probe once whether this WebGPU backend can copy an HTMLVideoElement straight
// into a texture. Chrome/Dawn can; Firefox can't and instead throws / raises a
// validation error that three.js swallows, leaving every video frame black. We
// detect that and route through a canvas instead. Doing a real probe (rather
// than sniffing the UA) means we automatically use the fast direct path again
// once a browser gains support. The video must already have a decoded frame.
async function videoUploadUnsupported(video) {
  const device = renderer?.backend?.device;
  if (!device) return false; // can't probe — assume direct works
  let tmp;
  let threw = false;
  device.pushErrorScope("validation");
  try {
    tmp = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: video }, { texture: tmp }, { width: 1, height: 1 },
    );
  } catch {
    threw = true;
  }
  const err = await device.popErrorScope();
  tmp?.destroy();
  return threw || err !== null;
}

async function setVideoSource(video, label) {
  if (source) source.dispose();
  currentVideo = video;
  // Plain Texture (not VideoTexture) so the frame goes through the exact same
  // NoColorSpace upload path images use — keeps the filtered look identical.
  // On backends that can't upload a video element, draw it into a 2D canvas
  // first (every backend accepts a canvas) and upload that instead.
  videoBridgeCanvas = videoBridgeCtx = null;
  let uploadSource = video;
  if (await videoUploadUnsupported(video)) {
    videoBridgeCanvas = document.createElement("canvas");
    videoBridgeCanvas.width = video.videoWidth;
    videoBridgeCanvas.height = video.videoHeight;
    videoBridgeCtx = videoBridgeCanvas.getContext("2d");
    videoBridgeCtx.drawImage(video, 0, 0); // seed the first (paused) frame
    uploadSource = videoBridgeCanvas;
  }
  const tex = new THREE.Texture(uploadSource);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter; // no per-frame mipmap regen for video
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.userData.w = video.videoWidth;
  tex.userData.h = video.videoHeight;
  tex.userData.label = label;
  tex.userData.isVideo = true;
  source = tex;
  videoFrameDirty = true;       // push the first (paused) frame through once
  pipeline.setSource(source);
  filmPipeline.setSource(source);
  infraredPipeline.setSource(source);
  resizeForSource();
  els.videoControls.hidden = false;
  els.volume.value = Math.round(userVolume * 100);
  els.volval.textContent = String(Math.round(userVolume * 100));
  syncTransportUI();
  setStatus(`${label}\nloaded · press play`);
}

function stopVideo() {
  if (!currentVideo) return;
  currentVideo.pause();
  URL.revokeObjectURL(currentVideo.src);
  currentVideo = null;
  videoBridgeCanvas = videoBridgeCtx = null;
  els.videoControls.hidden = true;
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function syncTransportUI() {
  if (!currentVideo) return;
  const paused = currentVideo.paused;
  els.playpause.textContent = paused ? "play" : "pause";
  els.playpause.classList.toggle("active", !paused);
  els.mute.textContent = currentVideo.muted ? "unmute" : "mute";
  els.mute.classList.toggle("active", currentVideo.muted);
}

function updateTransportProgress() {
  if (!currentVideo || scrubbing) return;
  const d = currentVideo.duration || 0;
  const t = currentVideo.currentTime || 0;
  if (d) els.seek.value = Math.round((t / d) * 1000);
  els.timeval.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = async () => { setSource(await createImageBitmap(img), url); resolve(); };
    img.onerror = () => { setStatus(`could not load ${url}\n(drop your own image)`); resolve(); };
    img.src = url;
  });
}

function setSource(bitmap, label) {
  stopVideo();
  if (source) source.dispose();
  source = new THREE.Texture(bitmap);
  source.colorSpace = THREE.NoColorSpace;
  source.flipY = false;
  source.minFilter = THREE.LinearMipmapLinearFilter;
  source.magFilter = THREE.LinearFilter;
  source.generateMipmaps = true;
  source.needsUpdate = true;
  source.userData.w = bitmap.width;
  source.userData.h = bitmap.height;
  source.userData.label = label;
  pipeline.setSource(source);
  filmPipeline.setSource(source);
  infraredPipeline.setSource(source);
  resizeForSource();
}

function resizeForSource() {
  if (!source) return;
  const imgW = source.userData.w;
  const imgH = source.userData.h;
  // film is not tied to a camera sensor — it works at the full display fit
  const displaySensor = mode === "film" ? [MAX_WORK, MAX_WORK]
    : mode === "infrared" ? INFRARED_PRESETS[infraredPresetKey].sensor_resolution
    : PRESETS[presetKey].sensor_resolution;
  const processSensor = mode === "analog" ? ANALOG_WORK : displaySensor;
  const displayFit = Math.min(displaySensor[0] / imgW, displaySensor[1] / imgH, MAX_WORK / imgW, MAX_WORK / imgH, 1.0);
  const processFit = Math.min(processSensor[0] / imgW, processSensor[1] / imgH, MAX_WORK / imgW, MAX_WORK / imgH, 1.0);
  let displayW = Math.max(2, Math.round(imgW * displayFit)); displayW -= displayW % 2;
  let displayH = Math.max(2, Math.round(imgH * displayFit)); displayH -= displayH % 2;
  let w = Math.max(2, Math.round(imgW * processFit * resolutionScale)); w -= w % 2;
  let h = Math.max(2, Math.round(imgH * processFit * resolutionScale)); h -= h % 2;

  renderer.setSize(w, h, false);
  els.canvas.style.width = `${displayW}px`;
  els.canvas.style.height = `${displayH}px`;
  if (mode === "film") filmPipeline.setSize(w, h);
  else if (mode === "infrared") infraredPipeline.setSize(w, h);
  else pipeline.setSize(w, h);
}

function pickRecMime(withAudio) {
  const a = withAudio ? ",opus" : "";
  const types = [`video/webm;codecs=vp9${a}`, `video/webm;codecs=vp8${a}`, "video/webm"];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function startRecording() {
  if (!source) return;
  if (!els.canvas.captureStream) {
    setStatus("recording not supported in this browser");
    return;
  }
  // captures the filtered canvas (processing resolution) in realtime
  const stream = els.canvas.captureStream(30);
  // mux in the source video's audio track (silent if muted / no audio)
  try {
    const atrack = currentVideo?.captureStream?.().getAudioTracks?.()[0];
    if (atrack) stream.addTrack(atrack);
  } catch { /* element captureStream unsupported — record video only */ }
  const mimeType = pickRecMime(stream.getAudioTracks().length > 0);
  if (!mimeType) {
    setStatus("recording not supported in this browser");
    return;
  }
  recChunks = [];
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const base = (source?.userData.label || "powershot").replace(/\.[^.]+$/, "");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-powershot.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    recChunks = [];
  };
  recorder.start();

  if (currentVideo) {
    // record = capture the whole clip: rewind, play through once, auto-stop at the end
    recLoopWas = currentVideo.loop;
    currentVideo.loop = false;
    currentVideo.currentTime = 0;
    videoFrameDirty = true;
    currentVideo.addEventListener("ended", stopRecording, { once: true });
    currentVideo.play().catch(() => {});
    setStatus(`recording ${fmtTime(currentVideo.duration)}…`);
  } else {
    setStatus("recording… (click again to stop)");
  }
  syncRecordUI();
}

function stopRecording() {
  if (currentVideo) {
    currentVideo.removeEventListener("ended", stopRecording);
    currentVideo.pause();
    currentVideo.loop = recLoopWas;
  }
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  syncRecordUI();
}

function syncRecordUI() {
  const on = !!recorder;
  els.record.textContent = on ? "stop recording" : "record video";
  els.record.classList.toggle("active", on);
}

async function tick() {
  if (!source || busy) return;
  busy = true;
  if (!freezeNoise) frame += 1;

  // re-upload the current video frame while it plays (or once after a seek)
  if (source.userData.isVideo && currentVideo && currentVideo.readyState >= 2) {
    if (!currentVideo.paused || videoFrameDirty) {
      if (videoBridgeCtx) {
        videoBridgeCtx.drawImage(currentVideo, 0, 0, videoBridgeCanvas.width, videoBridgeCanvas.height);
      }
      source.needsUpdate = true;
      videoFrameDirty = false;
    }
    updateTransportProgress();
  }

  try {
    if (mode === "film") await filmPipeline.render(frame);
    else if (mode === "infrared") await infraredPipeline.render(frame);
    else await pipeline.render(frame);
  } catch (err) {
    setStatus("render error:\n" + (err?.message || err));
    renderer.setAnimationLoop(null);
    console.error(err);
    return;
  } finally {
    busy = false;
  }

  // fps
  fpsCount += 1;
  const now = performance.now();
  if (now - fpsLast >= 500) {
    fps = Math.round((fpsCount * 1000) / (now - fpsLast));
    fpsLast = now; fpsCount = 0;
    const r = mode === "film" ? filmPipeline.ctx.resolution.value
      : mode === "infrared" ? infraredPipeline.ctx.resolution.value
      : pipeline.ctx.resolution.value;
    const frozen = freezeNoise ? " · frozen" : "";
    const modeLabel = mode === "analog" ? "Analog"
      : mode === "film" ? FILM_PRESETS[filmPresetKey].name
      : mode === "infrared" ? INFRARED_PRESETS[infraredPresetKey].name
      : PRESETS[presetKey].name;
    const stageLabel = mode === "analog" ? "analog mode"
      : mode === "film" ? "film mode"
      : mode === "infrared" ? "infrared mode"
      : `${pipeline.enabled.size}/${STAGE_DEFS.length} stages`;
    const rec = recorder
      ? (currentVideo ? ` · ● REC ${fmtTime(currentVideo.currentTime)}/${fmtTime(currentVideo.duration)}` : " · ● REC")
      : "";
    setStatus(`${modeLabel}\n${r.x}×${r.y} · ${fps} fps · ${stageLabel}${frozen}${rec}`);
  }
}

init();
