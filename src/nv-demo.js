// NIR night-vision test scene.
//
// A night yard rendered as three NIR bands (src/nir_band.js): materials and
// lights are integrated against a Gen-3 GaAs photocathode over λ ∈ [550, 900]
// nm, Three's raster lighting multiplies them per band, and the PowerSHOT
// image-intensifier model collapses the bands to a LINEAR relative photocathode
// response (setInputMode("nir") + setNirBands) — no RGB heuristic and no
// spectral renderer.
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

// Keep the render resolution tube-ish: the intensifier is tuned around
// ~1280×960 anyway.
const MAX_PIXELS = 1280 * 800;
const ELECTRON_PROFILE = Object.freeze({
  electronsPerUnit: 1024,
});

let renderer, scene, camera, controls, infrared, nightshot;
let nirBandsRT, collapseQuad;
let irLight, mode = "nv", irOn = true;
let electronModelOn = true;
// imaging device consuming the flux: Gen-3 tube or Sony NightShot camcorder
let device = "tube";
let tubeProfileKey = "gen3_white_phosphor_nir";
const tubeProfileKeys = ["gen3_white_phosphor_nir", "white_phosphor_nir", "aura_nir"];
let frame = 0, lastT = 0;
let band = null; // three-band NIR raster (src/nir_band.js)
const nirMats = new Map();      // original material -> three-band NIR material
const lightRestore = [];        // [{ light, color, intensity }]

// bisect flags: ?mode=visible · ?tube=0 (raw flux on screen, no intensifier)
const params = new URLSearchParams(location.search);
const USE_TUBE = params.get("tube") !== "0";
const START_MODE = params.get("mode") === "visible" ? "visible" : "nv";

function buildScene() {
  // Shared night yard (src/demo-scenes.js) — material names and userData are
  // the classifier's ground truth, so the scene must come from one source.
  const rig = createNightScene();
  scene = rig.scene;

  // ── camera + THE IR ILLUMINATOR bolted to it ──────────────────────
  camera = new THREE.PerspectiveCamera(rig.view.fov, 1, rig.view.near, rig.view.far);
  camera.position.set(...rig.view.position);

  // Black in RGB: contributes nothing in visible mode (its color is zero).
  // Through the tube it is the on-camera floodlight every security camera /
  // NV rig has. Its live shadow map matters: the camera-mounted beam MUST be
  // occluded or the trick dies.
  irLight = attachCameraIlluminator(scene, camera);
}

// ── NIR band raster ─────────────────────────────────────────────────
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
    if (!USE_TUBE) {
      // raw flux on screen: collapse the bands without the tube
      renderer.setRenderTarget(null);
      collapseQuad.render(renderer);
    }
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
  infrared.setSize(w, h);
  if (nightshot) nightshot.setSize(w, h);
}

function setMode(next) {
  mode = next;
  // the intensifier emits sRGB-encoded pixels (Linear canvas = no double
  // encode); the visible raster render wants the sRGB encode.
  renderer.outputColorSpace = mode === "nv" ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
}

function activeIrCtx() {
  return device === "nightshot" ? nightshot.ir.ctx : infrared.ctx;
}

function hudText() {
  const P = activeIrCtx().P;
  return [
    "NIR NIGHT VISION — 3-band raster → intensifier",
    `mode        ${mode === "nv" ? "NV (relative response λ550–900)" : "VISIBLE (raster RGB)"}   [V]`,
    mode === "nv"
      ? `device      ${device === "tube" ? `Gen-3 tube · ${INFRARED_PRESETS[tubeProfileKey].name}` : "Sony NightShot (CCD + tape path)"}   [N]`
      : "",
    mode === "nv" && device === "tube"
      ? "profile     Silver Blue / Ethereal / Aura   [P]"
      : "",
    mode === "nv" && device === "nightshot"
      ? `tape        VHS ${nightshot.cam.ctx.P.analogStrength.value.toFixed(2)} [, .] · noise ${nightshot.cam.ctx.P.analogTapeNoise.value.toFixed(2)} [< >] · smear ${nightshot.ctx.P.smear.value.toFixed(2)} [; ']`
      : "",
    `electrons   ${electronModelOn ? "ON" : "OFF"} — tube only, ${ELECTRON_PROFILE.electronsPerUnit} e/unit   [E]`,
    `IR illum    ${irOn ? "ON — 850 nm, black in RGB" : "OFF"}   [I]`,
    `tube exp    ${P.exposure.value.toFixed(2)} stops   [ / ]`,
    `input γ     ${P.inputGamma.value.toFixed(2)}   - / =`,
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
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();

  band = await createNirBand();
  buildScene();

  infrared = new InfraredPipeline(renderer);
  applyInfraredProfile(infrared, INFRARED_PRESETS[tubeProfileKey]);
  infrared.setElectronModel(ELECTRON_PROFILE);
  infrared.setNirBands(true);

  nightshot = new NightshotPipeline(renderer);
  applyNightshotPreset(nightshot, NIGHTSHOT_PRESETS.nightshot_plus);
  nightshot.ir.setInputMode("nir");
  nightshot.ir.setNirBands(true);

  const targetOptions = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  };
  nirBandsRT = new THREE.RenderTarget(1, 1, { ...targetOptions, depthBuffer: true });

  const bands = texture(nirBandsRT.texture, screenUV).rgb;
  const weights = vec3(band.weights[0], band.weights[1], band.weights[2]);
  const flux = dot(bands, weights).max(0.0);
  const collapseMaterial = new THREE.MeshBasicNodeMaterial();
  collapseMaterial.colorNode = vec4(flux, flux, flux, 1.0);
  collapseMaterial.depthTest = false;
  collapseMaterial.depthWrite = false;
  collapseMaterial.toneMapped = false;
  collapseQuad = new THREE.QuadMesh(collapseMaterial);

  setMode(START_MODE);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.2, -10);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  applySize();
  window.addEventListener("resize", applySize);

  window.addEventListener("keydown", (e) => {
    if (e.key === "v" || e.key === "V") setMode(mode === "nv" ? "visible" : "nv");
    if (e.key === "n" || e.key === "N") device = device === "tube" ? "nightshot" : "tube";
    if (e.key === "p" || e.key === "P") {
      tubeProfileKey = tubeProfileKeys[(tubeProfileKeys.indexOf(tubeProfileKey) + 1) % tubeProfileKeys.length];
      applyInfraredProfile(infrared, INFRARED_PRESETS[tubeProfileKey]);
    }
    if (e.key === "e" || e.key === "E") {
      electronModelOn = !electronModelOn;
      infrared.setElectronModel(electronModelOn ? ELECTRON_PROFILE : false);
    }
    if (e.key === "i" || e.key === "I") {
      irOn = !irOn;
      irLight.intensity = irOn ? 70 : 0;
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
    if (mode === "nv") {
      // raster three NIR bands; the imager collapses them to the relative
      // sensor response. The camera-mounted IR beam follows the rig live.
      renderNirRealtime();
      if (USE_TUBE) imager.renderTexture(nirBandsRT.texture, frame, { dt });
    } else {
      renderer.render(scene, camera);
    }
    if ((frame & 7) === 0) hud.textContent = hudText();
  });
}

init().catch((e) => {
  hud.textContent = `failed to start: ${e?.message || e}\n(WebGPU browser required)`;
  console.error(e);
});
