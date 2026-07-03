// True-NIR night-vision test scene.
//
// A spectral path tracer (vendored from maxjs, NV mode) renders a night yard
// at hero wavelengths λ ∈ [550, 900] nm importance-sampled against a Gen-3
// GaAs photocathode. The resulting LINEAR electron flux feeds the PowerSHOT
// image-intensifier model (setInputMode("nir")) — no RGB heuristic anywhere.
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
// Keys: V visible/NV · I toggle IR illuminator · [ ] tube exposure · drag orbit

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createSpectralTracer } from "../demo/spectral_tracer.js";
import { createNirBand } from "../demo/nir_band.js";
import {
  InfraredPipeline, INFRARED_PRESETS, applyInfraredPreset,
} from "./infrared.js";

const canvas = document.getElementById("canvas");
const hud = document.getElementById("hud");

// Keep the traced resolution tube-ish: 1 spp/frame accumulates, and the
// intensifier is tuned around ~1280×960 anyway.
const MAX_PIXELS = 1280 * 800;

let renderer, scene, camera, controls, tracer, infrared, fluxRT;
let irLight, mode = "nv", irOn = true;
let frame = 0, lastT = 0, statusLine = "";
// realtime band-collapsed raster path (see demo/nir_band.js)
let realtime = true, band = null;
const nirMats = new Map();      // original material → monochrome NIR material
const lightRestore = [];        // [{ light, color, intensity }]

// bisect flags: ?mode=visible · ?tube=0 (raw flux, no intensifier) · ?trace=0
// (no tracer; feed the tube a synthetic gradient instead)
const params = new URLSearchParams(location.search);
const USE_TUBE = params.get("tube") !== "0";
const USE_TRACER = params.get("trace") !== "0";
const START_MODE = params.get("mode") === "visible" ? "visible" : "nv";

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.0, ...opts });
}

function buildScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000); // moonless night, no env

  // ── ground: dirt yard + asphalt path ─────────────────────────────
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), std(0x1a1610));
  ground.material.name = "ground_dirt";
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const path = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.05, 40), std(0x0d0d0e, { roughness: 0.85 }));
  path.material.name = "asphalt_path"; // classifier → NIR 0.06 (near-black)
  path.position.set(0, 0.026, -8);
  scene.add(path);

  // ── THE METAMER PAIR: identical sRGB green, different NIR truth ──
  const hedgeGreen = 0x0c2008; // same color object for both
  for (let i = 0; i < 5; i += 1) {
    const hedge = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.5, 1.2),
      std(hedgeGreen, { roughness: 0.95 }),
    );
    hedge.material.name = "hedge_foliage"; // classifier → NIR 0.55 (red edge)
    hedge.position.set(-6 + i * 3.0, 0.75, -14);
    scene.add(hedge);
  }
  for (let i = 0; i < 5; i += 1) {
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.5, 0.12),
      std(hedgeGreen, { roughness: 0.7 }),
    );
    plank.material.name = "fence_green_paint";
    plank.material.userData.nirAlbedo = 0.07; // authored: green PAINT, no red edge
    plank.position.set(-6 + i * 3.0, 0.75, -17.5);
    scene.add(plank);
  }

  // ── trees ─────────────────────────────────────────────────────────
  for (const [x, z] of [[-11, -7], [11, -11]]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 3.4, 8), std(0x241a10));
    trunk.material.name = "tree_trunk";
    trunk.position.set(x, 1.7, z);
    scene.add(trunk);
    for (const [dx, dy, dz, r] of [[0, 4.2, 0, 1.9], [-1.1, 3.4, 0.4, 1.2], [1.0, 3.6, -0.5, 1.3]]) {
      const crown = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), std(0x11260a, { roughness: 0.95 }));
      crown.material.name = "tree_foliage"; // classifier → NIR 0.55
      crown.position.set(x + dx, dy, z + dz);
      scene.add(crown);
    }
  }

  // ── pond: water absorbs NIR → black through the tube ─────────────
  const pond = new THREE.Mesh(new THREE.CircleGeometry(3.4, 28), std(0x04101a, { roughness: 0.12 }));
  pond.material.name = "water_pond"; // classifier → NIR 0.04
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(7.5, 0.03, -4);
  scene.add(pond);

  // ── a person by the hedge (skin lifts in NIR) ─────────────────────
  const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.1, 6, 12), std(0xb0785a, { roughness: 0.6 }));
  person.material.name = "person"; // skin-tone heuristic → NIR 0.62
  person.position.set(-3.4, 0.9, -12.2);
  scene.add(person);

  // ── emitters ──────────────────────────────────────────────────────
  // incandescent porch bulb (Planck tail → NV monster)
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.0, 8), std(0x14100c));
  post.position.set(-9, 1.5, -3);
  scene.add(post);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc98c, emissiveIntensity: 6 }),
  );
  bulb.position.set(-9, 3.1, -3);
  scene.add(bulb);
  const porch = new THREE.PointLight(0xffc98c, 22, 0, 2);
  porch.position.copy(bulb.position);
  porch.userData.emitterClass = "incandescent";
  porch.userData.colorTemp = 2856;
  scene.add(porch);

  // LED floodlight of similar visible punch (no NIR tail → dark in NV)
  const ledHead = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.3, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xdfe9ff, emissiveIntensity: 5 }),
  );
  ledHead.position.set(9, 3.4, -9);
  scene.add(ledHead);
  const led = new THREE.SpotLight(0xdfe9ff, 26, 0, 0.7, 0.5, 2);
  led.position.copy(ledHead.position);
  led.target.position.set(6, 0, -5);
  led.userData.emitterClass = "led";
  scene.add(led);
  scene.add(led.target);

  // sodium street lamp far down the path (589 nm line → dim in NV)
  const sodium = new THREE.PointLight(0xff9a33, 34, 0, 2);
  sodium.position.set(0, 5.2, -24);
  sodium.userData.emitterClass = "sodium";
  scene.add(sodium);
  const sodiumHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff9a33, emissiveIntensity: 8 }),
  );
  sodiumHead.position.copy(sodium.position);
  scene.add(sodiumHead);

  // faint moon so the unlit yard isn't a void
  const moon = new THREE.DirectionalLight(0x8fa4c8, 0.06);
  moon.position.set(14, 22, 10);
  moon.target.position.set(0, 0, -8);
  scene.add(moon);
  scene.add(moon.target);

  // ── camera + THE IR ILLUMINATOR bolted to it ──────────────────────
  camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
  camera.position.set(0.5, 1.8, 6.5);
  scene.add(camera); // must be in-graph so the child light is collected

  // Black in RGB: contributes nothing in visible mode (its 850 nm band is
  // outside the visible λ domain AND its color is zero). Through the tube it
  // is the on-camera floodlight every security camera / NV rig has.
  irLight = new THREE.SpotLight(0x000000, 70, 0, 0.55, 0.45, 2);
  irLight.userData.emitterClass = "ir";
  irLight.position.set(0.15, -0.1, 0);
  camera.add(irLight);
  irLight.target.position.set(0, 0, -10);
  camera.add(irLight.target);

  // shadow maps only matter on the realtime raster path (the tracer shadows
  // by tracing); the camera-mounted beam MUST be occluded or the trick dies
  irLight.castShadow = true;
  irLight.shadow.mapSize.set(1024, 1024);
  irLight.shadow.camera.near = 0.2;
  irLight.shadow.camera.far = 60;
  irLight.shadow.bias = -0.0004;
  irLight.shadow.normalBias = 0.02;
  scene.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    if (o.isSpotLight && o !== irLight) {
      o.castShadow = true;
      o.shadow.mapSize.set(512, 512);
      o.shadow.bias = -0.0004;
      o.shadow.normalBias = 0.02;
    }
  });
}

// ── realtime NIR band raster ─────────────────────────────────────────
// Swap every material for its collapsed monochrome twin and every light for a
// white light at its collapsed NIR flux, raster into the flux RT with shadow
// maps, restore. Direct term matches the tracer's NEE analytically; indirect
// bounces are the accuracy traded for framerate — the tube re-noises either
// way, so the horror-game loop stays authentic.
function nirMaterialFor(m) {
  let nm = nirMats.get(m);
  if (!nm) {
    const r = band.reflectance(m);
    const e = band.emissiveFlux(m);
    nm = new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, r, r),
      roughness: Number.isFinite(m.roughness) ? m.roughness : 1,
      metalness: Number.isFinite(m.metalness) ? m.metalness : 0,
    });
    nm.emissive.setRGB(e, e, e);
    nirMats.set(m, nm);
  }
  return nm;
}

function renderNirRealtime() {
  const swaps = [];
  scene.traverse((o) => {
    if (o.isMesh) { swaps.push([o, o.material]); o.material = nirMaterialFor(o.material); }
  });
  lightRestore.length = 0;
  scene.traverse((o) => {
    if (!o.isLight || o.isAmbientLight || o.isHemisphereLight) return;
    lightRestore.push({ light: o, color: o.color.clone(), intensity: o.intensity });
    const flux = band.lightFlux(o); // integrals are cheap; live-tracks toggles
    o.color.setRGB(1, 1, 1);
    o.intensity = flux;
  });

  const prevTarget = renderer.getRenderTarget?.() ?? null;
  const prevTM = renderer.toneMapping;
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(fluxRT);
    renderer.render(scene, camera);
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
  if (fluxRT) fluxRT.setSize(w, h);
  infrared.setSize(w, h);
  tracer.markSceneDirty(); // kernel dims are baked per build
}

function setMode(next) {
  mode = next;
  tracer.setRenderMode(mode === "nv" ? "nv" : "visible");
  // the intensifier emits sRGB-encoded pixels (Linear canvas = no double
  // encode); the visible blit emits display-linear and wants the sRGB encode.
  renderer.outputColorSpace = mode === "nv" ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
}

function hudText() {
  const P = infrared.ctx.P;
  const rt = mode === "nv" && realtime;
  return [
    "TRUE-NIR NIGHT VISION — spectral tracer → Gen-3 intensifier",
    `mode        ${mode === "nv" ? "NV (photocathode flux λ550–900)" : "VISIBLE (XYZ λ380–720)"}   [V]`,
    mode === "nv"
      ? `render      ${rt ? "REALTIME — band-collapsed raster + shadow maps" : "PATH TRACED — 1 spp progressive"}   [R]`
      : "",
    `IR illum    ${irOn ? "ON — 850 nm, black in RGB" : "OFF"}   [I]`,
    `tube exp    ${P.exposure.value.toFixed(2)} stops   [ / ]`,
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
  applyInfraredPreset(infrared.ctx, INFRARED_PRESETS.white_phosphor_nir);
  infrared.setInputMode("nir");
  infrared.setHaloDisc(true);

  fluxRT = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // the realtime path rasters real geometry into this target — it needs a
    // z-buffer (the tracer's fullscreen blit ignores it: depthTest false)
    depthBuffer: true,
    colorSpace: THREE.NoColorSpace,
  });

  tracer = createSpectralTracer({
    renderer, scene, camera,
    enabled: USE_TRACER,
    onStatus: (s) => { statusLine = String(s).replace(/^max\.js - /, ""); console.log(s); },
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
    if (e.key === "r" || e.key === "R") realtime = !realtime;
    if (e.key === "i" || e.key === "I") {
      irOn = !irOn;
      irLight.intensity = irOn ? 70 : 0;
      tracer.markSceneDirty(); // raster path picks the change up live
    }
    if (e.key === "[") infrared.ctx.P.exposure.value -= 0.25;
    if (e.key === "]") infrared.ctx.P.exposure.value += 0.25;
  });

  renderer.setAnimationLoop((t) => {
    const dt = lastT > 0 ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    controls.update();
    frame += 1;

    if (mode === "nv" && realtime) {
      // realtime path: raster the collapsed NIR band, tube on top. The
      // camera-mounted IR beam follows the rig with no rebake, no reset.
      renderNirRealtime();
      if (USE_TUBE) infrared.renderTexture(fluxRT.texture, frame, { dt });
    } else {
      const drew = USE_TRACER ? tracer.render() : true;
      if (mode === "nv" && drew && USE_TUBE) {
        infrared.renderTexture(fluxRT.texture, frame, { dt });
      }
    }
    if ((frame & 7) === 0) hud.textContent = hudText();
  });
}

init().catch((e) => {
  hud.textContent = `failed to start: ${e?.message || e}\n(WebGPU browser required)`;
  console.error(e);
});
