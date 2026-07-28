// Spectral NIR night-vision test scene.
//
// The speedball spectral path tracer (speedball-gi, NV mode) renders a night yard
// at hero wavelengths λ ∈ [550, 900] nm importance-sampled against a Gen-3
// GaAs photocathode. The resulting LINEAR relative photocathode response feeds
// the PowerSHOT image-intensifier model (setInputMode("nir")) — no RGB
// heuristic anywhere.
//
// The scene is built to prove the physics:
//   - an 850 nm IR ILLUMINATOR is bolted to the camera (black in RGB —
//     literally invisible in visible mode, a floodlight through the tube)
//   - a hedge and a green-painted fence share the SAME sRGB color; the hedge
//     is foliage (NIR albedo 0.55, chlorophyll red edge) and glows white, the
//     paint (0.07) stays dark — metamerism, impossible with any RGB filter
//   - an incandescent porch bulb vs an LED floodlight of similar visible
//     brightness: the Planck NIR tail makes the bulb dominate through the tube
//   - a sodium street lamp (589 nm line) goes dim; water goes black; skin lifts
//
// Keys: V visible/NV · N tube/NightShot · P tube profile · I toggle IR illuminator · [ ] tube exposure
//       - = input gamma (18%-pivoted mid correction)
//       NightShot: , . VHS strength · < > tape noise · ; ' CCD smear · drag orbit

import * as THREE from "three/webgpu";
import { dot, screenUV, texture, vec3, vec4 } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createSpectralTracer } from "speedball-gi/spectral-tracer";
import { attachCameraIlluminator, createNightScene } from "./demo-scenes.js";
import { createNirBand } from "./nir_band.js";
import {
  InfraredPipeline, INFRARED_PRESETS, applyInfraredProfile,
} from "./infrared.js";
import {
  NightshotPipeline, NIGHTSHOT_PRESETS, applyNightshotPreset,
} from "./nightshot.js";

const canvas = document.getElementById("canvas");
const hud = document.getElementById("hud");

// Keep the traced resolution tube-ish: 1 spp/frame accumulates, and the
// intensifier is tuned around ~1280×960 anyway.
const MAX_PIXELS = 1280 * 800;
const ELECTRON_PROFILE = Object.freeze({
  electronsPerUnit: 1024,
});

let renderer, scene, camera, controls, tracer, infrared, nightshot;
let nirBandsRT, fluxRT, collapseQuad;
let irLight, mode = "nv", irOn = true;
let electronModelOn = true;
// imaging device consuming the flux: Gen-3 tube or Sony NightShot camcorder
let device = "tube";
let tubeProfileKey = "gen3_white_phosphor_nir";
let frame = 0, lastT = 0, statusLine = "";
// realtime three-band raster path (see src/nir_band.js)
let realtime = true, band = null;
const nirMats = new Map();      // original material -> three-band NIR material
const lightRestore = [];        // [{ light, color, intensity }]

// bisect flags: ?mode=visible · ?tube=0 (raw flux, no intensifier) · ?trace=0
// (no tracer; feed the tube a synthetic gradient instead)
const params = new URLSearchParams(location.search);
const USE_TUBE = params.get("tube") !== "0";
const USE_TRACER = params.get("trace") !== "0";
const START_MODE = params.get("mode") === "visible" ? "visible" : "nv";

function buildScene() {
  // Shared night yard (src/demo-scenes.js) — material names and userData are
  // the classifier's ground truth, so the scene must come from one source.
  const rig = createNightScene();
  scene = rig.scene;

  // ── camera + THE IR ILLUMINATOR bolted to it ──────────────────────
  camera = new THREE.PerspectiveCamera(rig.view.fov, 1, rig.view.near, rig.view.far);
  camera.position.set(...rig.view.position);

  // Black in RGB: contributes nothing in visible mode (its 850 nm band is
  // outside the visible λ domain AND its color is zero). Through the tube it
  // is the on-camera floodlight every security camera / NV rig has. Its live
  // shadow map matters on the realtime raster path (the tracer shadows by
  // tracing); the camera-mounted beam MUST be occluded or the trick dies.
  irLight = attachCameraIlluminator(scene, camera);
}

// ── realtime NIR band raster ─────────────────────────────────────────
// RGB temporarily carries three NIR bands. Materials and lights are evaluated
// independently per band, Three performs the component-wise lighting, and one
// fullscreen pass collapses the result through the photocathode weights.
function nirMaterialFor(m) {
  if (Array.isArray(m)) return m.map(nirMaterialFor);
  let nm = nirMats.get(m);
  if (!nm) {
    const r = band.reflectanceBands(m);
    const e = band.emissiveBands(m);
    nm = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(r[0], r[1], r[2]),
      roughness: Number.isFinite(m.roughness) ? m.roughness : 1,
      metalness: Number.isFinite(m.metalness) ? m.metalness : 0,
      side: m.side,
      transparent: m.transparent === true,
      opacity: Number.isFinite(m.opacity) ? m.opacity : 1,
      alphaTest: Number.isFinite(m.alphaTest) ? m.alphaTest : 0,
    });
    nm.emissive.setRGB(e[0], e[1], e[2]);
    nm.toneMapped = false;
    nirMats.set(m, nm);
  }
  return nm;
}

function renderNirRealtime() {
  const swaps = [];
  const prevTarget = renderer.getRenderTarget?.() ?? null;
  const prevTM = renderer.toneMapping;
  try {
    scene.traverse((o) => {
      if (!o.isMesh) return;
      swaps.push([o, o.material]);
      o.material = nirMaterialFor(o.material);
    });
    lightRestore.length = 0;
    scene.traverse((o) => {
      if (!o.isLight || o.isAmbientLight || o.isHemisphereLight) return;
      lightRestore.push({ light: o, color: o.color.clone(), intensity: o.intensity });
      const values = band.lightBands(o); // integrals are cheap; live-tracks toggles
      const peak = Math.max(values[0], values[1], values[2]);
      if (peak > 0) {
        o.color.setRGB(values[0] / peak, values[1] / peak, values[2] / peak);
        o.intensity = peak;
      } else {
        o.color.setRGB(0, 0, 0);
        o.intensity = 0;
      }
    });

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(nirBandsRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(fluxRT);
    collapseQuad.render(renderer);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevTM;
    for (const [o, m] of swaps) o.material = m;
    for (const r of lightRestore) { r.light.color.copy(r.color); r.light.intensity = r.intensity; }
  }
}

function sizeFor() {
  const w = window.innerWidth, h = window.innerHeight;
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
  return { w: Math.max(64, Math.round(w * scale)), h: Math.max(64, Math.round(h * scale)) };
}

function applySize() {
  const { w, h } = sizeFor();
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (nirBandsRT) nirBandsRT.setSize(w, h);
  if (fluxRT) fluxRT.setSize(w, h);
  infrared.setSize(w, h);
  if (nightshot) nightshot.setSize(w, h);
  tracer.markSceneDirty(); // kernel dims are baked per build
}

function setMode(next) {
  mode = next;
  tracer.setRenderMode(mode === "nv" ? "nv" : "visible");
  // the intensifier emits sRGB-encoded pixels (Linear canvas = no double
  // encode); the visible blit emits display-linear and wants the sRGB encode.
  renderer.outputColorSpace = mode === "nv" ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
}

function activeIrCtx() {
  return device === "nightshot" ? nightshot.ir.ctx : infrared.ctx;
}

function hudText() {
  const P = activeIrCtx().P;
  const rt = mode === "nv" && realtime;
  return [
    "SPECTRAL NIR NIGHT VISION — tracer / 3-band raster → intensifier",
    `mode        ${mode === "nv" ? "NV (relative response λ550–900)" : "VISIBLE (XYZ λ380–720)"}   [V]`,
    mode === "nv"
      ? `device      ${device === "tube" ? `Gen-3 tube · ${INFRARED_PRESETS[tubeProfileKey].name}` : "Sony NightShot (CCD + tape path)"}   [N]`
      : "",
    mode === "nv" && device === "tube"
      ? "profile     Silver Blue / Ethereal   [P]"
      : "",
    mode === "nv" && device === "nightshot"
      ? `tape        VHS ${nightshot.cam.ctx.P.analogStrength.value.toFixed(2)} [, .] · noise ${nightshot.cam.ctx.P.analogTapeNoise.value.toFixed(2)} [< >] · smear ${nightshot.ctx.P.smear.value.toFixed(2)} [; ']`
      : "",
    mode === "nv"
      ? `render      ${rt ? "REALTIME — 3-band NIR raster + shadow maps" : "PATH TRACED — 1 spp progressive"}   [R]`
      : "",
    `electrons   ${electronModelOn ? "ON" : "OFF"} — tube only, ${ELECTRON_PROFILE.electronsPerUnit} e/unit   [E]`,
    `IR illum    ${irOn ? "ON — 850 nm, black in RGB" : "OFF"}   [I]`,
    `tube exp    ${P.exposure.value.toFixed(2)} stops   [ / ]`,
    `input γ     ${P.inputGamma.value.toFixed(2)}   - / =`,
    rt ? "" : `samples     ${tracer.getSampleCount()}`,
    statusLine ? `status      ${statusLine}` : "",
    "",
    "same-green hedge vs painted fence = metamer pair",
    "porch bulb (incandescent) vs LED flood · sodium lamp · pond · person",
  ].filter(Boolean).join("\n");
}

async function init() {
  renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();

  band = createNirBand();
  buildScene();

  infrared = new InfraredPipeline(renderer);
  applyInfraredProfile(infrared, INFRARED_PRESETS[tubeProfileKey]);
  infrared.setElectronModel(ELECTRON_PROFILE);

  nightshot = new NightshotPipeline(renderer);
  applyNightshotPreset(nightshot, NIGHTSHOT_PRESETS.nightshot_plus);
  nightshot.ir.setInputMode("nir");

  const targetOptions = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  };
  nirBandsRT = new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: true });
  fluxRT = new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: false });

  const bands = texture(nirBandsRT.texture, screenUV).rgb;
  const weights = vec3(band.weights[0], band.weights[1], band.weights[2]);
  const flux = dot(bands, weights).max(0.0);
  const collapseMaterial = new THREE.MeshBasicNodeMaterial();
  collapseMaterial.colorNode = vec4(flux, flux, flux, 1.0);
  collapseMaterial.depthTest = false;
  collapseMaterial.depthWrite = false;
  collapseMaterial.toneMapped = false;
  collapseQuad = new THREE.QuadMesh(collapseMaterial);

  tracer = createSpectralTracer({
    renderer, scene, camera,
    enabled: USE_TRACER,
    onStatus: (s) => {
      statusLine = String(s)
        .replace(/^max\.js - /, "")
        .replace("photocathode flux", "photocathode response");
      console.log(s);
    },
    onError: (e) => { statusLine = `ERROR ${e?.message || e}`; console.error(e); },
  });
  tracer.setNvTarget(fluxRT);
  if (USE_TRACER) tracer.start();
  setMode(START_MODE);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.2, -10);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  // lights (incl. the camera-mounted IR spot) are baked into the light buffer
  // at build time — re-bake while the rig moves
  controls.addEventListener("change", () => tracer.markSceneDirty());

  applySize();
  window.addEventListener("resize", applySize);

  window.addEventListener("keydown", (e) => {
    if (e.key === "v" || e.key === "V") setMode(mode === "nv" ? "visible" : "nv");
    if (e.key === "n" || e.key === "N") device = device === "tube" ? "nightshot" : "tube";
    if (e.key === "p" || e.key === "P") {
      tubeProfileKey = tubeProfileKey === "gen3_white_phosphor_nir"
        ? "white_phosphor_nir"
        : "gen3_white_phosphor_nir";
      applyInfraredProfile(infrared, INFRARED_PRESETS[tubeProfileKey]);
    }
    if (e.key === "r" || e.key === "R") realtime = !realtime;
    if (e.key === "e" || e.key === "E") {
      electronModelOn = !electronModelOn;
      infrared.setElectronModel(electronModelOn ? ELECTRON_PROFILE : false);
    }
    if (e.key === "i" || e.key === "I") {
      irOn = !irOn;
      irLight.intensity = irOn ? 70 : 0;
      tracer.markSceneDirty(); // raster path picks the change up live
    }
    if (e.key === "[") activeIrCtx().P.exposure.value -= 0.25;
    if (e.key === "]") activeIrCtx().P.exposure.value += 0.25;
    // 18%-pivoted input gamma — the grey/green mid-correction knob
    if (e.key === "-") activeIrCtx().P.inputGamma.value = Math.max(0.35, activeIrCtx().P.inputGamma.value - 0.05);
    if (e.key === "=") activeIrCtx().P.inputGamma.value = Math.min(2.0, activeIrCtx().P.inputGamma.value + 0.05);
    // NightShot tape-path trims
    const clamp03 = (v) => Math.min(3, Math.max(0, v));
    const A = nightshot.cam.ctx.P;
    if (e.key === ",") A.analogStrength.value = clamp03(A.analogStrength.value - 0.1);
    if (e.key === ".") A.analogStrength.value = clamp03(A.analogStrength.value + 0.1);
    if (e.key === "<") A.analogTapeNoise.value = clamp03(A.analogTapeNoise.value - 0.1);
    if (e.key === ">") A.analogTapeNoise.value = clamp03(A.analogTapeNoise.value + 0.1);
    if (e.key === ";") nightshot.ctx.P.smear.value = Math.min(2, Math.max(0, nightshot.ctx.P.smear.value - 0.1));
    if (e.key === "'") nightshot.ctx.P.smear.value = Math.min(2, Math.max(0, nightshot.ctx.P.smear.value + 0.1));
  });

  renderer.setAnimationLoop((t) => {
    const dt = lastT > 0 ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    controls.update();
    frame += 1;

    const imager = device === "nightshot" ? nightshot : infrared;
    if (mode === "nv" && realtime) {
      // realtime path: raster three NIR bands, collapse to relative sensor
      // response, then run the imager. The
      // camera-mounted IR beam follows the rig with no rebake, no reset.
      renderNirRealtime();
      if (USE_TUBE) imager.renderTexture(fluxRT.texture, frame, { dt });
    } else {
      const drew = USE_TRACER ? tracer.render() : true;
      if (mode === "nv" && drew && USE_TUBE) {
        imager.renderTexture(fluxRT.texture, frame, { dt });
      }
    }
    if ((frame & 7) === 0) hud.textContent = hudText();
  });
}

init().catch((e) => {
  hud.textContent = `failed to start: ${e?.message || e}\n(WebGPU browser required)`;
  console.error(e);
});
