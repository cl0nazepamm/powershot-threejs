// PowerSHOT realtime ISP — bootstrap (three.js WebGPU).
import * as THREE from "three/webgpu";
import { PRESETS, PRESET_KEYS } from "./presets.js";
import { Pipeline, applyPreset, STAGE_DEFS } from "./pipeline.js";

const MAX_WORK = 1600; // cap working resolution for snappy realtime
const ANALOG_WORK = [720, 540];
const DEFAULT_IMAGE = `${import.meta.env.BASE_URL}vibe%20coding.jpg`;

const els = {
  canvas: document.getElementById("view"),
  mode: document.getElementById("mode"),
  preset: document.getElementById("preset"),
  digitalControls: document.getElementById("digital-controls"),
  analogControls: document.getElementById("analog-controls"),
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
  edgewave: document.getElementById("edgewave"),
  edgewaveval: document.getElementById("edgewaveval"),
  dropouts: document.getElementById("dropouts"),
  dropoutsval: document.getElementById("dropoutsval"),
  scanlines: document.getElementById("scanlines"),
  scanlinesval: document.getElementById("scanlinesval"),
  headswitch: document.getElementById("headswitch"),
  headswitchval: document.getElementById("headswitchval"),
  freeze: document.getElementById("freeze-noise"),
  stages: document.getElementById("stages"),
  stageControls: document.getElementById("stage-controls"),
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  enableStages: document.getElementById("enable-stages"),
  disableStages: document.getElementById("disable-stages"),
  status: document.getElementById("status"),
};

let renderer, pipeline, source = null;
let frame = 0;
let mode = "digital";
let presetKey = "cybershot";
let busy = false;
let freezeNoise = true;

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

  buildPresetUI();
  buildStageUI();
  wireInput();

  await loadImage(DEFAULT_IMAGE);
  applyPreset(pipeline.ctx, PRESETS[presetKey]);
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

function wireInput() {
  els.mode.addEventListener("change", () => {
    mode = els.mode.value;
    freezeNoise = mode === "digital";
    pipeline.setMode(mode);
    syncModeUI();
    syncFreezeUI();
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
  els.freeze.addEventListener("click", () => {
    freezeNoise = !freezeNoise;
    syncFreezeUI();
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
  const analogMode = mode === "analog";
  els.digitalControls.hidden = analogMode;
  els.stageControls.hidden = analogMode;
  els.analogControls.hidden = !analogMode;
  els.mode.value = mode;
}

function syncFreezeUI() {
  const noun = mode === "analog" ? "tape" : "noise";
  els.freeze.textContent = freezeNoise ? `unfreeze ${noun}` : `freeze ${noun}`;
  els.freeze.classList.toggle("active", freezeNoise);
}

function syncEffectUI() {
  syncModeUI();

  const lens = pipeline.ctx.P.lensSoftness.value;
  els.lens.value = Math.round(lens * 100);
  els.lensval.textContent = lens.toFixed(2);

  const bloom = pipeline.ctx.P.ccdBloom.value;
  els.bloom.value = Math.round(bloom * 100);
  els.bloomval.textContent = bloom.toFixed(2);

  const noise = pipeline.ctx.noiseScale.value;
  els.noise.value = Math.round(noise * 100);
  els.noiseval.textContent = noise.toFixed(2);

  const bnr = pipeline.ctx.P.bayerNR.value;
  els.bayernr.value = Math.round(bnr * 100);
  els.bayernrval.textContent = bnr.toFixed(2);

  const jpeg = pipeline.ctx.P.jpegStrength.value;
  els.jpeg.value = Math.round(jpeg * 100);
  els.jpegval.textContent = jpeg.toFixed(2);

  const analog = pipeline.ctx.P.analogStrength.value;
  els.analog.value = Math.round(analog * 100);
  els.analogval.textContent = analog.toFixed(2);

  const tracking = pipeline.ctx.P.analogTracking.value;
  els.tracking.value = Math.round(tracking * 100);
  els.trackingval.textContent = tracking.toFixed(2);

  const chromaBleed = pipeline.ctx.P.analogChromaBleed.value;
  els.chromableed.value = Math.round(chromaBleed * 100);
  els.chromableedval.textContent = chromaBleed.toFixed(2);

  const ringing = pipeline.ctx.P.analogRinging.value;
  els.ringing.value = Math.round(ringing * 100);
  els.ringingval.textContent = ringing.toFixed(2);

  const tapeNoise = pipeline.ctx.P.analogTapeNoise.value;
  els.tapenoise.value = Math.round(tapeNoise * 100);
  els.tapenoiseval.textContent = tapeNoise.toFixed(2);

  const edgeWave = pipeline.ctx.P.analogEdgeWave.value;
  els.edgewave.value = Math.round(edgeWave * 100);
  els.edgewaveval.textContent = edgeWave.toFixed(2);

  const dropouts = pipeline.ctx.P.analogDropouts.value;
  els.dropouts.value = Math.round(dropouts * 100);
  els.dropoutsval.textContent = dropouts.toFixed(2);

  const scanlines = pipeline.ctx.P.analogScanlines.value;
  els.scanlines.value = Math.round(scanlines * 100);
  els.scanlinesval.textContent = scanlines.toFixed(2);

  const headSwitch = pipeline.ctx.P.analogHeadSwitch.value;
  els.headswitch.value = Math.round(headSwitch * 100);
  els.headswitchval.textContent = headSwitch.toFixed(2);

  syncFreezeUI();
}

async function loadFile(file) {
  const bitmap = await createImageBitmap(file);
  setSource(bitmap, file.name);
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
  resizeForSource();
}

function resizeForSource() {
  if (!source) return;
  const imgW = source.userData.w;
  const imgH = source.userData.h;
  const sensor = mode === "analog" ? ANALOG_WORK : PRESETS[presetKey].sensor_resolution;
  const fit = Math.min(sensor[0] / imgW, sensor[1] / imgH, MAX_WORK / imgW, MAX_WORK / imgH, 1.0);
  let w = Math.round(imgW * fit); w -= w % 2;
  let h = Math.round(imgH * fit); h -= h % 2;

  renderer.setSize(w, h, false);
  pipeline.setSize(w, h);
}

async function tick() {
  if (!source || busy) return;
  busy = true;
  if (!freezeNoise) frame += 1;

  try {
    await pipeline.render(frame);
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
    const r = pipeline.ctx.resolution.value;
    const frozen = freezeNoise ? " · frozen" : "";
    const modeLabel = mode === "analog" ? "Analog VHS" : PRESETS[presetKey].name;
    const stageLabel = mode === "analog" ? "analog mode" : `${pipeline.enabled.size}/${STAGE_DEFS.length} stages`;
    setStatus(`${modeLabel}\n${r.x}×${r.y} · ${fps} fps · ${stageLabel}${frozen}`);
  }
}

init();
