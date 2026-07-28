import * as THREE from "three/webgpu";
import {
  float,
  pass,
  step,
  vec4,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  SpectralLensFlarePipeline,
  loadHeliarTronnierFlareProfile,
  spectralFlarePass,
} from "./index.js";

const SOLAR_DIAMETER_DEG = 0.533;
const SUN_DISTANCE = 700;
const BASE_SUN_AZIMUTH_DEG = -152.5;
const CAMERA_HOME = new THREE.Vector3(14, 6, 24);
const TARGET_HOME = new THREE.Vector3(0, 3.2, -4);
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
  diffraction: 5,
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
window.__spectralFlareDebug = debug;

let renderer;
let scene;
let sunScene;
let camera;
let controls;
let sun;
let sunDisk;
let skyTexture;
let flare;
let renderPipeline;
let sourcePass;
let frameFailed = false;

const sunDirection = new THREE.Vector3();
const lightTarget = new THREE.Vector3(0, 0, -7);

function material(color, roughness = 0.82, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeSkyTexture() {
  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const texture = new THREE.CanvasTexture(skyCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.name = "PowerShot flare demo sky";
  return texture;
}

function updateSky() {
  if (!skyTexture) return;
  const skyCanvas = skyTexture.image;
  const context = skyCanvas.getContext("2d");
  const daylight = THREE.MathUtils.smoothstep(parameters.sunElevation, 3, 24);
  const gradient = context.createLinearGradient(0, 0, 0, skyCanvas.height);
  const top = new THREE.Color(0x345f91).lerp(new THREE.Color(0x173557), 1 - daylight);
  const horizon = new THREE.Color(0xf2c995).lerp(new THREE.Color(0xe38955), 1 - daylight);
  const groundHaze = new THREE.Color(0xb7b8a6).lerp(new THREE.Color(0x8b6251), 1 - daylight);
  gradient.addColorStop(0, `#${top.getHexString()}`);
  gradient.addColorStop(0.72, `#${horizon.getHexString()}`);
  gradient.addColorStop(1, `#${groundHaze.getHexString()}`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, skyCanvas.width, skyCanvas.height);
  skyTexture.needsUpdate = true;
}

function addTree(x, z, height, crownColor = 0x193523) {
  const group = new THREE.Group();
  const trunk = shadowed(new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.035, height * 0.052, height * 0.46, 9),
    material(0x4b3627, 0.96),
  ));
  trunk.position.y = height * 0.23;
  group.add(trunk);

  const crownMaterial = material(crownColor, 0.94);
  for (const [y, radius] of [
    [0.48, 0.25],
    [0.64, 0.22],
    [0.78, 0.17],
  ]) {
    const crown = shadowed(new THREE.Mesh(
      new THREE.ConeGeometry(height * radius, height * 0.42, 11),
      crownMaterial,
    ));
    crown.position.y = height * y;
    group.add(crown);
  }

  group.position.set(x, 0, z);
  scene.add(group);
  return group;
}

function addBarn() {
  const barn = new THREE.Group();
  const walls = shadowed(new THREE.Mesh(
    new THREE.BoxGeometry(8, 4.8, 6.2),
    material(0x6f3023, 0.88),
  ));
  walls.position.y = 2.4;
  barn.add(walls);

  const roof = shadowed(new THREE.Mesh(
    new THREE.ConeGeometry(5.6, 2.7, 4),
    material(0x24282a, 0.58, 0.18),
  ));
  roof.position.y = 6.1;
  roof.rotation.y = Math.PI * 0.25;
  roof.scale.z = 0.78;
  barn.add(roof);

  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(2.3, 3.5),
    material(0x241a17, 0.92),
  );
  door.position.set(0, 1.8, 3.106);
  barn.add(door);

  const windowMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x98b7bf,
    roughness: 0.12,
    metalness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  for (const x of [-2.2, 2.2]) {
    const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.1), windowMaterial);
    windowMesh.position.set(x, 3.05, 3.115);
    barn.add(windowMesh);
  }

  barn.position.set(-11, 0, -13);
  barn.rotation.y = 0.12;
  scene.add(barn);
}

function buildScene() {
  scene = new THREE.Scene();
  sunScene = new THREE.Scene();
  skyTexture = makeSkyTexture();
  scene.background = skyTexture;
  scene.fog = new THREE.FogExp2(0xb9ad93, 0.007);

  const ground = shadowed(new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    material(0x526343, 0.98),
  ));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(7.2, 115),
    material(0x605b50, 0.98),
  );
  road.rotation.x = -Math.PI / 2;
  road.rotation.z = -0.09;
  road.position.set(8, 0.018, -24);
  road.receiveShadow = true;
  scene.add(road);

  addBarn();

  [
    [-22, -8, 13], [-19, -19, 10], [-4, -26, 13], [8, -31, 15],
    [18, -22, 11], [25, -7, 14], [5.7, 2.0, 15], [-6, 8, 10],
  ].forEach(([x, z, height], index) => {
    addTree(x, z, height, index % 3 === 0 ? 0x21442b : 0x193523);
  });

  const stoneMaterial = material(0x77756c, 0.9);
  [
    [-3, 0.45, -2, 1.1], [17, 0.35, -5, 0.8], [5, 0.5, -17, 1.25],
    [-18, 0.4, 3, 0.9],
  ].forEach(([x, y, z, scale], index) => {
    const rock = shadowed(new THREE.Mesh(
      new THREE.DodecahedronGeometry(scale, 1),
      stoneMaterial,
    ));
    rock.position.set(x, y, z);
    rock.scale.set(1.45, 0.65 + index * 0.05, 1);
    rock.rotation.set(0.15 * index, 0.7 * index, 0.08);
    scene.add(rock);
  });

  const reflector = shadowed(new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 48, 24),
    new THREE.MeshPhysicalMaterial({
      color: 0x8d969c,
      roughness: 0.16,
      metalness: 0.92,
      clearcoat: 0.35,
      clearcoatRoughness: 0.08,
    }),
  ));
  reflector.position.set(6.8, 1.15, -5.5);
  scene.add(reflector);

  const fill = new THREE.HemisphereLight(0xbad7ef, 0x514536, 0.5);
  scene.add(fill);

  sun = new THREE.DirectionalLight(0xfff1d6, 3.2);
  sun.name = "Physical sun";
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 42;
  sun.shadow.camera.bottom = -42;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.025;
  sun.userData.spectralFlareRadiance = 9;
  sun.userData.angularDiameterDeg = SOLAR_DIAMETER_DEG;
  sun.target.position.copy(lightTarget);
  scene.add(sun, sun.target);

  const diskMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: true,
  });
  diskMaterial.color.setRGB(90, 72, 48);
  const diskRadius = Math.tan(
    THREE.MathUtils.degToRad(SOLAR_DIAMETER_DEG * 0.5),
  ) * SUN_DISTANCE;
  sunDisk = new THREE.Mesh(new THREE.SphereGeometry(diskRadius, 48, 24), diskMaterial);
  sunDisk.name = "HDR solar disk (0.533 degrees)";
  sunDisk.frustumCulled = false;
  sunDisk.visible = SHOW_SUN_DISK;
  sunScene.add(sunDisk);

  camera = new THREE.PerspectiveCamera(49, 1, 0.1, 1400);
  camera.position.copy(CAMERA_HOME);
  camera.lookAt(TARGET_HOME);

  controls = new OrbitControls(camera, canvas);
  controls.target.copy(TARGET_HOME);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.minDistance = 8;
  controls.maxDistance = 62;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.update();

  updateSky();
  updateSun();
}

function updateSun() {
  if (!sun || !camera) return;
  const azimuth = THREE.MathUtils.degToRad(BASE_SUN_AZIMUTH_DEG + parameters.sunAngle);
  const elevation = THREE.MathUtils.degToRad(parameters.sunElevation);
  const horizontal = Math.cos(elevation);
  sunDirection.set(
    Math.sin(azimuth) * horizontal,
    Math.sin(elevation),
    Math.cos(azimuth) * horizontal,
  ).normalize();

  sun.position.copy(lightTarget).addScaledVector(sunDirection, 130);
  sunDisk.position.copy(camera.position).addScaledVector(sunDirection, SUN_DISTANCE);
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  sunDisk.updateMatrixWorld();
  updateSky();
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
    camera.position.copy(CAMERA_HOME);
    controls.target.copy(TARGET_HOME);
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
  flare = new SpectralLensFlarePipeline(renderer, {
    profile,
    camera,
    sun,
    fNumber: parameters.fNumber,
    apertureBlades: 7,
    apertureRoundness: 0.08,
    ghostStrength: parameters.ghost,
    diffractionStrength: parameters.diffraction,
    glareStrength: parameters.glare,
    veilingStrength: parameters.veil,
  });
  flare.setAperture({ fNumber: parameters.fNumber, blades: 7, roundness: 0.08 });

  sourcePass = pass(scene, camera);
  const depthTexture = sourcePass.getTexture("depth");
  const depthNode = sourcePass.getTextureNode("depth");
  const skyMask = renderer.reversedDepthBuffer
    ? float(1).sub(step(0.00001, depthNode.r))
    : step(0.99999, depthNode.r);
  const sunPass = pass(sunScene, camera, { depthBuffer: false });
  const sceneWithSun = vec4(
    sourcePass.rgb.add(sunPass.rgb.mul(skyMask)),
    sourcePass.a,
  );
  const flareNode = spectralFlarePass(sceneWithSun, flare, {
    camera,
    sun,
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
