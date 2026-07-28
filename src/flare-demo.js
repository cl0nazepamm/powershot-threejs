import * as THREE from "three/webgpu";
import {
  float,
  pass,
  step,
  vec4,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  SolarFlarePipeline,
  loadHeliarTronnierFlareProfile,
  solarFlarePass,
} from "./index.js";
import { SOLAR_DIAMETER_DEG, createDaylightScene } from "./demo-scenes.js";

const BASE_SUN_AZIMUTH_DEG = -152.5;
const USE_SCENE_DEPTH = new URLSearchParams(location.search).get("depth") !== "0";
const SHOW_SUN_DISK = new URLSearchParams(location.search).get("disk") !== "0";

const canvas = document.getElementById("viewport");
const loading = document.getElementById("loading");
const status = document.getElementById("status");

const parameters = {
  sunAngle: 0,
  sunElevation: 14.5,
  fNumber: 8,
  ghost: 1,
  diffraction: 1,
  glare: 1,
  veil: 0.06,
  visibility: 1,
};

const debug = {
  ready: false,
  frames: 0,
  error: null,
  webgpu: Boolean(navigator.gpu),
  depthOcclusion: false,
  profile: null,
  sunNdc: [0, 0],
  controls: { ...parameters },
};
window.__solarFlareDebug = debug;

let renderer;
let rig;
let camera;
let controls;
let flare;
let renderPipeline;
let sourcePass;
let frameFailed = false;

function buildScene() {
  rig = createDaylightScene({ separateSunScene: true });
  rig.sunDisk.visible = SHOW_SUN_DISK;

  const view = rig.view;
  camera = new THREE.PerspectiveCamera(view.fov, 1, view.near, view.far);
  camera.position.set(...view.position);
  camera.lookAt(...view.target);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(...view.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.minDistance = view.minDistance;
  controls.maxDistance = view.maxDistance;
  controls.maxPolarAngle = view.maxPolarAngle;
  controls.update();

  updateSun();
}

function updateSun() {
  if (!rig || !camera) return;
  rig.setSun(BASE_SUN_AZIMUTH_DEG + parameters.sunAngle, parameters.sunElevation);
  rig.update(camera);
}

function setFailure(error) {
  if (frameFailed) return;
  frameFailed = true;
  const message = error instanceof Error ? error.message : String(error);
  debug.error = message;
  status.textContent = "render error";
  loading.textContent = message;
  loading.classList.remove("done");
  loading.classList.add("error");
  renderer?.setAnimationLoop(null);
  console.error(error);
}

function bindRange(name, format, apply) {
  const input = document.getElementById(name);
  const output = document.getElementById(`${name}Value`);

  const update = () => {
    parameters[name] = Number(input.value);
    output.textContent = format(parameters[name]);
    debug.controls[name] = parameters[name];
    apply?.();
  };

  input.addEventListener("input", update);
  update();
}

function bindControls() {
  const updateSolar = () => updateSun();
  const updateAperture = () => flare?.setAperture({
    fNumber: parameters.fNumber,
    blades: 7,
    roundness: 0.08,
  });
  const updateStrength = () => flare?.setStrength({
    strength: 1,
    ghosts: parameters.ghost,
    diffraction: parameters.diffraction,
    glare: parameters.glare,
    veiling: parameters.veil,
  });

  bindRange("sunAngle", (value) => `${value.toFixed(1)}°`, updateSolar);
  bindRange("sunElevation", (value) => `${value.toFixed(1)}°`, updateSolar);
  bindRange("fNumber", (value) => `f/${value.toFixed(1)}`, updateAperture);
  bindRange("ghost", (value) => `${value.toFixed(2)}×`, updateStrength);
  bindRange("diffraction", (value) => `${value.toFixed(2)}×`, updateStrength);
  bindRange("glare", (value) => `${value.toFixed(2)}×`, updateStrength);
  bindRange("veil", (value) => `${value.toFixed(2)}×`, updateStrength);
  bindRange("visibility", (value) => `${Math.round(value * 100)}%`);

  canvas.addEventListener("dblclick", () => {
    camera.position.set(...rig.view.position);
    controls.target.set(...rig.view.target);
    controls.update();
  });
}

function resize() {
  if (!renderer || !camera) return;
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

async function init() {
  if (!navigator.gpu) {
    throw new Error("This demo requires a browser with WebGPU enabled.");
  }

  renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 0.72;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();

  buildScene();
  bindControls();
  resize();

  const profile = await loadHeliarTronnierFlareProfile();
  flare = new SolarFlarePipeline(renderer, {
    profile,
    camera,
    sun: rig.sun,
    fNumber: parameters.fNumber,
    apertureBlades: 7,
    apertureRoundness: 0.08,
    ghostStrength: parameters.ghost,
    diffractionStrength: parameters.diffraction,
    glareStrength: parameters.glare,
    veilingStrength: parameters.veil,
  });
  flare.setAperture({ fNumber: parameters.fNumber, blades: 7, roundness: 0.08 });

  sourcePass = pass(rig.scene, camera);
  const depthTexture = sourcePass.getTexture("depth");
  const depthNode = sourcePass.getTextureNode("depth");
  const skyMask = renderer.reversedDepthBuffer
    ? float(1).sub(step(0.00001, depthNode.r))
    : step(0.99999, depthNode.r);
  const sunPass = pass(rig.sunScene, camera, { depthBuffer: false });
  const sceneWithSun = vec4(
    sourcePass.rgb.add(sunPass.rgb.mul(skyMask)),
    sourcePass.a,
  );
  const flareNode = solarFlarePass(sceneWithSun, flare, {
    camera,
    sun: rig.sun,
    depthTexture: () => (USE_SCENE_DEPTH ? depthTexture : null),
    visibility: () => parameters.visibility,
    angularDiameterDeg: SOLAR_DIAMETER_DEG,
  });
  renderPipeline = new THREE.RenderPipeline(renderer, flareNode);

  debug.profile = `${profile.pathCount} paths · ${profile.wavelengthCount} wavelengths`;
  debug.depthOcclusion = USE_SCENE_DEPTH && Boolean(depthTexture);
  debug.ready = true;
  document.documentElement.dataset.flareReady = "true";
  document.documentElement.dataset.depthOcclusion = String(debug.depthOcclusion);
  status.textContent = "WebGPU live";
  loading.classList.add("done");

  window.addEventListener("resize", resize);
  window.addEventListener("unhandledrejection", (event) => setFailure(event.reason));

  renderer.setAnimationLoop(() => {
    try {
      controls.update();
      updateSun();
      renderPipeline.render();
      debug.frames += 1;
      debug.sunNdc[0] = Number(flare.ctx.sunNdc.value.x.toFixed(4));
      debug.sunNdc[1] = Number(flare.ctx.sunNdc.value.y.toFixed(4));
      document.documentElement.dataset.flareFrames = String(debug.frames);
      document.documentElement.dataset.sunNdc = debug.sunNdc.join(",");
      document.documentElement.dataset.useDepth = String(flare.ctx.useDepth.value);
      document.documentElement.dataset.hoodAcceptance =
        Number(flare.ctx.hoodAcceptance.value.toFixed(4)).toString();
    } catch (error) {
      setFailure(error);
    }
  });
}

init().catch(setFailure);
