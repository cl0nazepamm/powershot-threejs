// Shared demo scenery for the PowerShot demo pages (demo-only, not shipped).
//
// Two scenes, extracted verbatim from the pages that authored them so every
// demo shows the same world:
//   - createDaylightScene: the flare demo's farm — sun with shadows, HDR solar
//     disk, gradient sky, barn, trees, chrome reflector. The disk can live in
//     a separate scene for the flare demo's depth-masked TSL composite, or in
//     the main scene for plain render-target sources.
//   - createNightScene: the NV demo's night yard — porch bulb, LED flood,
//     sodium lamp, faint moon. Material names and userData are load-bearing:
//     the NV demo's three-band NIR classifier keys off them.

import * as THREE from "three/webgpu";
import { DEFAULT_SOLAR_DIAMETER_DEG } from "./solar-flare.js";

export const SOLAR_DIAMETER_DEG = DEFAULT_SOLAR_DIAMETER_DEG;
const SUN_DISTANCE = 700;

// One MeshStandardMaterial factory for both scenes; `material` keeps the
// daylight scene's positional style and defaults.
function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.0, ...opts });
}

function material(color, roughness = 0.82, metalness = 0) {
  return std(color, { roughness, metalness });
}

// Camera-mounted illuminator — the same physical prop in every demo that
// straps a light to the lens (NV demo's 850 nm IR flood, main demo's
// flashlight). Adds the camera to the scene graph so the child light is
// collected, and configures the live 1024 shadow map the beam needs.
export function attachCameraIlluminator(scene, camera, {
  color = 0x000000, // black in RGB: invisible in visible-light renders
  intensity = 70,
  emitterClass = "ir",
} = {}) {
  scene.add(camera);
  const light = new THREE.SpotLight(color, intensity, 0, 0.55, 0.45, 2);
  light.userData.emitterClass = emitterClass;
  light.position.set(0.15, -0.1, 0);
  camera.add(light);
  light.target.position.set(0, 0, -10); // beam follows the view
  camera.add(light.target);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.near = 0.2;
  light.shadow.camera.far = 60;
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.02;
  return light;
}

// ── daylight farm (from flare-demo) ─────────────────────────────────

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

function addTree(scene, x, z, height, crownColor = 0x193523) {
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

function addBarn(scene) {
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

export function createDaylightScene({ separateSunScene = false } = {}) {
  const scene = new THREE.Scene();
  const sunScene = separateSunScene ? new THREE.Scene() : null;
  const skyTexture = makeSkyTexture();
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

  addBarn(scene);

  [
    [-22, -8, 13], [-19, -19, 10], [-4, -26, 13], [8, -31, 15],
    [18, -22, 11], [25, -7, 14], [5.7, 2.0, 15], [-6, 8, 10],
  ].forEach(([x, z, height], index) => {
    addTree(scene, x, z, height, index % 3 === 0 ? 0x21442b : 0x193523);
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

  const sun = new THREE.DirectionalLight(0xfff1d6, 3.2);
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
  sun.userData.solarFlareRadiance = 9;
  sun.userData.angularDiameterDeg = SOLAR_DIAMETER_DEG;
  const lightTarget = new THREE.Vector3(0, 0, -7);
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
  const sunDisk = new THREE.Mesh(new THREE.SphereGeometry(diskRadius, 48, 24), diskMaterial);
  sunDisk.name = "HDR solar disk (0.533 degrees)";
  sunDisk.frustumCulled = false;
  (sunScene ?? scene).add(sunDisk);

  const sunDirection = new THREE.Vector3();

  function updateSky(elevationDeg) {
    const skyCanvas = skyTexture.image;
    const context = skyCanvas.getContext("2d");
    const daylight = THREE.MathUtils.smoothstep(elevationDeg, 3, 24);
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

  function setSun(azimuthDeg, elevationDeg) {
    const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
    const elevation = THREE.MathUtils.degToRad(elevationDeg);
    const horizontal = Math.cos(elevation);
    sunDirection.set(
      Math.sin(azimuth) * horizontal,
      Math.sin(elevation),
      Math.cos(azimuth) * horizontal,
    ).normalize();

    sun.position.copy(lightTarget).addScaledVector(sunDirection, 130);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    updateSky(elevationDeg);
  }

  // The disk sits a fixed angular distance from the eye, so it follows the
  // camera; call once per frame after camera movement.
  function updateSunDisk(camera) {
    sunDisk.position.copy(camera.position).addScaledVector(sunDirection, SUN_DISTANCE);
    sunDisk.updateMatrixWorld();
  }

  setSun(-152.5, 14.5);

  return {
    scene,
    sunScene,
    sun,
    sunDisk,
    setSun,
    update: updateSunDisk, // per-frame hook: keep the disk centred on the eye
    view: {
      fov: 49,
      near: 0.1,
      far: 1400,
      position: [14, 6, 24],
      target: [0, 3.2, -4],
      minDistance: 8,
      maxDistance: 62,
      maxPolarAngle: Math.PI * 0.49,
    },
  };
}

// ── night yard (from nv-demo) ───────────────────────────────────────

export function createNightScene() {
  const scene = new THREE.Scene();
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

  // shadow maps for the raster path (page-added lights configure themselves)
  scene.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    if (o.isSpotLight) {
      o.castShadow = true;
      o.shadow.mapSize.set(512, 512);
      o.shadow.bias = -0.0004;
      o.shadow.normalBias = 0.02;
    }
  });

  return {
    scene,
    update() {}, // per-frame hook (static yard; parity with the daylight rig)
    view: {
      fov: 58,
      near: 0.1,
      far: 200,
      position: [0.5, 1.8, 6.5],
      target: [0, 1.2, -10],
      minDistance: 3,
      maxDistance: 30,
      maxPolarAngle: Math.PI * 0.52,
    },
  };
}
