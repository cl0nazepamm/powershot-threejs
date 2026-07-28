import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three/webgpu";

import {
  GHOST_WAVELENGTHS_NM,
  HELIAR_TRONNIER_100MM,
  decodeSpectralFlareAtlas,
  makeSpectralRgbWeights,
  parseSpectralFlareAtlas,
} from "../src/spectral-flare-profile.js";
import {
  createDiffractionPsfTexture,
  generateDiffractionPsf,
  releaseDiffractionPsf,
} from "../src/spectral-flare-psf.js";
import {
  SPECTRAL_FLARE_DEFAULTS,
  apertureSpikeHarmonic,
  diffractionPeakScale,
  projectSunDirection,
  sensorGateToNdc,
} from "../src/spectral-flare.js";
import {
  cauchyIndex,
  computeFluxScale,
  enumerateTwoReflectionPaths,
  integratePupilThroughput,
  prepareLens,
  thinFilmReflectance,
  traceGhostRay,
} from "../tools/spectral-flare-optics.mjs";

const atlasUrl = new URL(
  "../src/assets/heliar-tronnier-100mm-v1.bin",
  import.meta.url,
);

async function loadAtlas() {
  const file = await readFile(atlasUrl);
  return parseSpectralFlareAtlas(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    { createTextures: false },
  );
}

test("shipped Heliar atlas has the expected dimensions and ranked paths", async () => {
  const profile = await loadAtlas();
  assert.equal(profile.pathCount, 24);
  assert.equal(profile.wavelengthCount, 3);
  assert.equal(profile.angleCount, 31);
  assert.equal(profile.gridSize, 17);
  assert.equal(profile.recordCount, 24 * 3 * 31 * 17 * 17);
  assert.equal(profile.log2Throughput, true);
  assert.equal(profile.log2Flux, true);
  assert.equal(profile.boundaryExtrapolated, true);

  const pairs = new Set();
  for (let i = 0; i < profile.pathCount; i += 1) {
    const later = profile.pathPairs[i * 2];
    const earlier = profile.pathPairs[i * 2 + 1];
    assert.ok(later > earlier, `path ${later}→${earlier} has physical bounce order`);
    pairs.add(`${later}:${earlier}`);
    if (i > 0) {
      assert.ok(
        profile.pathEnergy[i - 1] >= profile.pathEnergy[i],
        "paths are sorted by integrated energy",
      );
    }
  }
  assert.equal(pairs.size, profile.pathCount);
});

test("atlas transport contains finite, unclamped off-screen rays and valid optical energy", async () => {
  const profile = await loadAtlas();
  const { atlasA, atlasB } = decodeSpectralFlareAtlas(profile);
  let validCount = 0;
  let offscreenCount = 0;
  let positiveEnergyCount = 0;
  for (let i = 0; i < profile.recordCount; i += 1) {
    const offset = i * 4;
    if (atlasB[offset + 3] <= 0.5) continue;
    validCount += 1;
    assert.ok(Number.isFinite(atlasA[offset]));
    assert.ok(Number.isFinite(atlasA[offset + 1]));
    assert.ok(Number.isFinite(atlasB[offset]));
    assert.ok(Number.isFinite(atlasB[offset + 2]));
    if (Math.abs(atlasA[offset]) > 1 || Math.abs(atlasA[offset + 1]) > 1) {
      offscreenCount += 1;
    }
    if (2 ** (atlasB[offset] + atlasB[offset + 2]) > 0) {
      positiveEnergyCount += 1;
    }
  }
  assert.ok(validCount > 100_000);
  assert.ok(offscreenCount > 1_000, "off-screen transport is preserved");
  assert.equal(positiveEnergyCount, validCount);
});

test("atlas raw channel arrays are retained only on the debug parse path", async () => {
  const file = await readFile(atlasUrl);
  const gpuProfile = parseSpectralFlareAtlas(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    { createTextures: true },
  );
  assert.equal(gpuProfile.atlasAHalf, undefined);
  assert.equal(gpuProfile.atlasBHalf, undefined);
  assert.equal(gpuProfile.textureA.image.width, gpuProfile.atlasWidth);
  assert.equal(gpuProfile.textureA.image.height, gpuProfile.atlasHeight);
  assert.throws(() => decodeSpectralFlareAtlas(gpuProfile), /createTextures/);

  const debugProfile = await loadAtlas();
  assert.ok(debugProfile.atlasAHalf instanceof Uint16Array);
  const { atlasA } = decodeSpectralFlareAtlas(debugProfile);
  assert.equal(atlasA.length, debugProfile.recordCount * 4);
});

test("cached PSF texture entries drop the unscaled CPU copy", () => {
  const entry = createDiffractionPsfTexture({ size: 64 });
  assert.equal(entry.data, undefined);
  assert.ok(entry.texture.image.data instanceof Uint16Array);
  assert.equal(entry.texture.image.data.length, 64 * 64);
  releaseDiffractionPsf(entry);
});

test("finite-area ghost density conserves affine pupil energy", () => {
  const gridSize = 5;
  const pupilRadiusMm = 1;
  const samples = [];
  for (let y = 0; y < gridSize; y += 1) {
    const py = (y / (gridSize - 1)) * 2 - 1;
    for (let x = 0; x < gridSize; x += 1) {
      const px = (x / (gridSize - 1)) * 2 - 1;
      samples.push({
        sensorXmm: px * 2,
        sensorYmm: py * 3,
        throughput: 0.5,
        valid: true,
      });
    }
  }

  const flux = computeFluxScale(samples, gridSize, pupilRadiusMm);
  for (const density of flux) {
    assert.ok(Math.abs(density - 1 / 6) < 1e-12);
  }
  assert.ok(
    Math.abs(integratePupilThroughput(samples, gridSize, pupilRadiusMm) - 2) < 1e-12,
  );
});

test("incomplete boundary control volumes are reconstructed without losing energy", () => {
  const gridSize = 5;
  const pupilRadiusMm = 1;
  const stepMm = (2 * pupilRadiusMm) / (gridSize - 1);
  const pupilTriangleArea = stepMm * stepMm * 0.5;
  const samples = [];
  for (let y = 0; y < gridSize; y += 1) {
    const py = (y / (gridSize - 1)) * 2 - 1;
    for (let x = 0; x < gridSize; x += 1) {
      const px = (x / (gridSize - 1)) * 2 - 1;
      samples.push({
        sensorXmm: px * 2,
        sensorYmm: py * 3,
        throughput: 0.5 + x * 0.01,
        valid: true,
      });
    }
  }
  // Collapse one mapped boundary fan almost to a point. A point-Jacobian
  // estimate turns this into a bright vertex; the finite boundary control
  // volume must inherit a resolved interior density instead.
  const boundary = 2 * gridSize;
  const interior = boundary + 1;
  samples[boundary].sensorXmm = samples[interior].sensorXmm - 1e-8;
  samples[boundary].sensorYmm = samples[interior].sensorYmm;

  const flux = computeFluxScale(samples, gridSize, pupilRadiusMm);
  assert.ok(flux[boundary] / flux[interior] < 2);

  let inputEnergy = 0;
  let outputEnergy = 0;
  const accumulate = (a, b, c) => {
    const ax = samples[a].sensorXmm;
    const ay = samples[a].sensorYmm;
    const mappedArea = Math.abs(
      (samples[b].sensorXmm - ax) * (samples[c].sensorYmm - ay)
      - (samples[b].sensorYmm - ay) * (samples[c].sensorXmm - ax),
    ) * 0.5;
    inputEnergy += pupilTriangleArea * (
      samples[a].throughput + samples[b].throughput + samples[c].throughput
    ) / 3;
    outputEnergy += mappedArea * (
      flux[a] * samples[a].throughput
      + flux[b] * samples[b].throughput
      + flux[c] * samples[c].throughput
    ) / 3;
  };
  for (let y = 0; y < gridSize - 1; y += 1) {
    for (let x = 0; x < gridSize - 1; x += 1) {
      const a = y * gridSize + x;
      const b = a + 1;
      const c = a + gridSize;
      const d = c + 1;
      if ((x + y) % 2 === 0) {
        accumulate(a, b, d);
        accumulate(d, c, a);
      } else {
        accumulate(a, b, c);
        accumulate(b, d, c);
      }
    }
  }
  assert.ok(Math.abs(outputEnergy / inputEnergy - 1) < 1e-12);
});

test("spectral integration stays signed until wavelengths are accumulated", () => {
  const weights = makeSpectralRgbWeights(GHOST_WAVELENGTHS_NM);
  assert.equal(weights.length, 3);
  assert.ok(weights.flat().some((value) => value < 0));
  for (let channel = 0; channel < 3; channel += 1) {
    const white = weights.reduce((sum, weight) => sum + weight[channel], 0);
    assert.ok(Math.abs(white - 1) < 1e-6);
  }
});

test("diffraction FFT conserves energy and produces a blade-dependent star", () => {
  const psf = generateDiffractionPsf({
    size: 128,
    blades: 7,
    roundness: 0.05,
    finiteSunSigmaPixels: 0.6,
  });
  let energy = 0;
  let peak = 0;
  for (const half of psf.data) {
    const value = THREE.DataUtils.fromHalfFloat(half);
    energy += value;
    peak = Math.max(peak, value);
  }
  assert.ok(Math.abs(energy - 1) < 0.01, `PSF energy was ${energy}`);
  assert.ok(peak > 0.05);

  const center = psf.size / 2;
  const horizontal = THREE.DataUtils.fromHalfFloat(
    psf.data[center * psf.size + center + 12],
  );
  const diagonal = THREE.DataUtils.fromHalfFloat(
    psf.data[(center + 9) * psf.size + center + 9],
  );
  assert.notEqual(horizontal, diagonal);
});

test("diffraction pupil imperfections are deterministic and break exact mirror symmetry", () => {
  const imperfect = generateDiffractionPsf({ size: 256 });
  const repeated = generateDiffractionPsf({ size: 256 });
  const clean = generateDiffractionPsf({
    size: 256,
    wavefrontError: 0,
    edgeVariation: 0,
    scatterStrength: 0,
  });
  assert.deepEqual(imperfect.data, repeated.data);

  const asymmetry = (psf) => {
    const center = psf.size / 2;
    let difference = 0;
    let energy = 0;
    for (let y = 0; y < psf.size; y += 1) {
      for (let x = 0; x < psf.size; x += 1) {
        const mirrorX = (2 * center - x + psf.size) % psf.size;
        const mirrorY = (2 * center - y + psf.size) % psf.size;
        const value = THREE.DataUtils.fromHalfFloat(
          psf.data[y * psf.size + x],
        );
        const mirror = THREE.DataUtils.fromHalfFloat(
          psf.data[mirrorY * psf.size + mirrorX],
        );
        difference += Math.abs(value - mirror);
        energy += value;
      }
    }
    return difference / energy;
  };

  assert.ok(asymmetry(clean) < 1e-6);
  assert.ok(asymmetry(imperfect) > 0.03);
});

test("scaled half-float PSF storage retains faint optical tails", () => {
  const unscaled = generateDiffractionPsf({ size: 256, storageScale: 1 });
  const scaled = generateDiffractionPsf({ size: 256, storageScale: 4096 });
  const nonzero = (psf) => psf.textureData.reduce(
    (sum, value) => sum + Number(value !== 0),
    0,
  );
  assert.ok(nonzero(scaled) > nonzero(unscaled) * 4);
});

test("lens compiler models dispersion, coated Fresnel energy, and two-bounce paths", () => {
  const blue = cauchyIndex(1.652, 58.57, 475);
  const red = cauchyIndex(1.652, 58.57, 650);
  assert.ok(blue > red);

  const reflectance = thinFilmReflectance({
    nIncident: 1,
    nCoating: 1.38,
    nTransmit: 1.652,
    cosIncident: 1,
    wavelengthNm: 620,
    coatingDesignNm: 620,
  });
  assert.ok(reflectance > 0 && reflectance < 0.02);

  const paths = enumerateTwoReflectionPaths(HELIAR_TRONNIER_100MM);
  assert.equal(paths.length, 28);
  const prepared = prepareLens(HELIAR_TRONNIER_100MM, 550);
  const ray = traceGhostRay(prepared, [3, 1], 0, 0, 5 * Math.PI / 180);
  assert.equal(ray.valid, true);
  assert.ok(ray.throughput > 0 && ray.throughput < 1);
});

test("sun projection remains true outside the frame instead of clamping", () => {
  const camera = new THREE.PerspectiveCamera(20, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const outside = projectSunDirection(
    camera,
    new THREE.Vector3(Math.sin(25 * Math.PI / 180), 0, -Math.cos(25 * Math.PI / 180)),
  );
  assert.equal(outside.frontFacing, true);
  assert.ok(outside.ndc.x > 1, `expected off-screen NDC, got ${outside.ndc.x}`);

  const behind = projectSunDirection(camera, new THREE.Vector3(0, 0, 1));
  assert.equal(behind.frontFacing, false);
});

test("sensor-space transport registers to the active perspective projection", () => {
  const verticalFovDeg = THREE.MathUtils.radToDeg(
    2 * Math.atan((HELIAR_TRONNIER_100MM.sensorHeightMm * 0.5)
      / HELIAR_TRONNIER_100MM.focalLengthMm),
  );
  const camera = new THREE.PerspectiveCamera(verticalFovDeg, 1.5, 0.1, 1000);
  camera.updateProjectionMatrix();
  const scale = sensorGateToNdc(camera, HELIAR_TRONNIER_100MM);
  assert.ok(Math.abs(scale.x - 1) < 1e-6);
  assert.ok(Math.abs(scale.y - 1) < 1e-6);
  assert.throws(
    () => sensorGateToNdc(new THREE.OrthographicCamera(), HELIAR_TRONNIER_100MM),
    /PerspectiveCamera/,
  );
});

test("defaults include an enabled source-glare component and a fine PSF grid", () => {
  assert.ok(SPECTRAL_FLARE_DEFAULTS.glareStrength > 0);
  assert.equal(SPECTRAL_FLARE_DEFAULTS.psfSize, 1024);
  assert.ok(SPECTRAL_FLARE_DEFAULTS.psfStorageScale > 1);
});

test("blade streak count follows iris parity: 2N spikes when odd, N when even", () => {
  assert.equal(apertureSpikeHarmonic(7), 7);
  assert.equal(apertureSpikeHarmonic(9), 9);
  assert.equal(apertureSpikeHarmonic(6), 3);
  assert.equal(apertureSpikeHarmonic(8), 4);
  assert.equal(apertureSpikeHarmonic(Number.NaN), 7);
});

test("diffraction peak scaling preserves inverse-square integrated aperture energy", () => {
  const integrated = (fNumber) => diffractionPeakScale(fNumber, 8) * fNumber ** 2;
  const at4 = integrated(4);
  const at8 = integrated(8);
  const at16 = integrated(16);
  assert.ok(Math.abs(at4 / at8 - 4) < 1e-12);
  assert.ok(Math.abs(at16 / at8 - 0.25) < 1e-12);
});
