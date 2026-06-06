// PowerSHOT realtime ISP — bootstrap (three.js WebGPU).
import * as THREE from "three/webgpu";
import { PRESETS, PRESET_KEYS } from "./presets.js";
import { Pipeline, applyPreset, STAGE_DEFS } from "./pipeline.js";

const MAX_WORK = 1600; // cap working resolution for snappy realtime
const DEFAULT_IMAGE = `${import.meta.env.BASE_URL}vibe%20coding.jpg`;

const els = {
  canvas: document.getElementById("view"),
  preset: document.getElementById("preset"),
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
  freeze: document.getElementById("freeze-noise"),
  stages: document.getElementById("stages"),
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  enableStages: document.getElementById("enable-stages"),
  disableStages: document.getElementById("disable-stages"),
  status: document.getElementById("status"),
};

let renderer, pipeline, source = null;
let frame = 0;
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

function syncFreezeUI() {
  els.freeze.textContent = freezeNoise ? "unfreeze noise" : "freeze noise";
  els.freeze.classList.toggle("active", freezeNoise);
}

function syncEffectUI() {
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
  const sensor = PRESETS[presetKey].sensor_resolution;
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
    setStatus(`${PRESETS[presetKey].name}\n${r.x}×${r.y} · ${fps} fps · ${pipeline.enabled.size}/${STAGE_DEFS.length} stages${frozen}`);
  }
}

init();
