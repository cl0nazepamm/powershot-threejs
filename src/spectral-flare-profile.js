import * as THREE from "three/webgpu";

export const GHOST_WAVELENGTHS_NM = Object.freeze([475, 550, 650]);
export const DIFFRACTION_WAVELENGTHS_NM = Object.freeze([430, 480, 530, 590, 650]);

// Classic Tronnier Heliar 100 mm five-element prescription.
// Provenance: surface table digitized from OpenLensFlare's
// examples/systems/heliar-tronnier.xml (BSD-2-Clause, (c) Istvan Csoba,
// https://github.com/csobaistvan/OpenLensFlare), which tabulates the public
// A. W. Tronnier Heliar design for Voigtlaender (mid-20th century, patents
// long expired) also used by Hullin et al. 2011. The table is factual optical
// data; attribution is retained here regardless.
// Distances are millimetres and each surface's `thicknessMm` advances to the
// following surface. A zero radius is a plane, not an optically inert surface.
export const HELIAR_TRONNIER_100MM = Object.freeze({
  id: "heliar-tronnier-100mm",
  name: "Tronnier Heliar 100 mm",
  focalLengthMm: 100,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  designFNumber: 8,
  maxIncidenceDeg: 30,
  surfaces: Object.freeze([
    Object.freeze({
      kind: "glass",
      semiApertureMm: 14.5,
      thicknessMm: 7.7,
      radiusMm: 30.809999,
      nD: 1.652,
      abbeV: 58.57,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 14.5,
      thicknessMm: 1.85,
      radiusMm: -89.349998,
      nD: 1.603,
      abbeV: 38.029999,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 14.5,
      thicknessMm: 3.52,
      radiusMm: 580.380005,
      nD: 1,
      abbeV: 89.300003,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 12.3,
      thicknessMm: 1.85,
      radiusMm: -80.629997,
      nD: 1.643,
      abbeV: 47.740002,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 12,
      thicknessMm: 4.18,
      radiusMm: 28.34,
      nD: 1,
      abbeV: 89.300003,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "aperture",
      semiApertureMm: 11.6,
      thicknessMm: 3,
      radiusMm: 0,
      nD: 1,
      abbeV: 89.300003,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 12.3,
      thicknessMm: 1.85,
      radiusMm: 0,
      nD: 1.581,
      abbeV: 40.98,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 12.3,
      thicknessMm: 7.27,
      radiusMm: 32.189999,
      nD: 1.694,
      abbeV: 53.200001,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "glass",
      semiApertureMm: 12.3,
      thicknessMm: 82.857002,
      radiusMm: -52.990002,
      nD: 1,
      abbeV: 89.300003,
      coatingDesignNm: 620,
      coatingIor: 1.38,
    }),
    Object.freeze({
      kind: "sensor",
      semiApertureMm: 18,
      thicknessMm: 0.001,
      radiusMm: 0,
      nD: 1,
      abbeV: 89.300003,
      coatingDesignNm: 0,
      coatingIor: 1,
    }),
  ]),
});

export const DEFAULT_SPECTRAL_FLARE_ATLAS_URL = new URL(
  "./assets/heliar-tronnier-100mm-v1.bin",
  import.meta.url,
);

const MAGIC = "PSFLARE";
const HEADER_BYTES = 64;
const FLAG_LOG2_THROUGHPUT = 1 << 0;
const FLAG_LOG2_FLUX = 1 << 1;
const FLAG_BOUNDARY_EXTRAPOLATED = 1 << 2;

function asymmetricGaussian(wavelengthNm, meanNm, sigmaLeft, sigmaRight) {
  const sigma = wavelengthNm < meanNm ? sigmaLeft : sigmaRight;
  const d = (wavelengthNm - meanNm) / sigma;
  return Math.exp(-0.5 * d * d);
}

// Compact multi-Gaussian analytic fit of the CIE 1931 standard observer.
export function cie1931XyzApprox(wavelengthNm) {
  const x = 1.056 * asymmetricGaussian(wavelengthNm, 599.8, 37.9, 31)
    + 0.362 * asymmetricGaussian(wavelengthNm, 442, 16, 26.7)
    - 0.065 * asymmetricGaussian(wavelengthNm, 501.1, 20.4, 26.2);
  const y = 0.821 * asymmetricGaussian(wavelengthNm, 568.8, 46.9, 40.5)
    + 0.286 * asymmetricGaussian(wavelengthNm, 530.9, 16.3, 31.1);
  const z = 1.217 * asymmetricGaussian(wavelengthNm, 437, 11.8, 36)
    + 0.681 * asymmetricGaussian(wavelengthNm, 459, 26, 13.8);
  return [Math.max(0, x), Math.max(0, y), Math.max(0, z)];
}

export function xyzToLinearSrgb([x, y, z]) {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

export function makeSpectralRgbWeights(wavelengthsNm) {
  if (!Array.isArray(wavelengthsNm) || wavelengthsNm.length === 0) {
    throw new TypeError("wavelengthsNm must be a non-empty array.");
  }

  const raw = wavelengthsNm.map((wavelengthNm, index) => {
    if (wavelengthsNm.length === 1) {
      return xyzToLinearSrgb(cie1931XyzApprox(wavelengthNm));
    }
    const left = index === 0
      ? wavelengthNm - (wavelengthsNm[index + 1] - wavelengthNm) * 0.5
      : (wavelengthsNm[index - 1] + wavelengthNm) * 0.5;
    const right = index === wavelengthsNm.length - 1
      ? wavelengthNm + (wavelengthNm - wavelengthsNm[index - 1]) * 0.5
      : (wavelengthNm + wavelengthsNm[index + 1]) * 0.5;
    const width = Math.max(1, right - left);
    return xyzToLinearSrgb(cie1931XyzApprox(wavelengthNm)).map((v) => v * width);
  });

  const sum = [0, 0, 0];
  for (const weight of raw) {
    sum[0] += weight[0];
    sum[1] += weight[1];
    sum[2] += weight[2];
  }

  return raw.map((weight) => weight.map(
    (value, channel) => value / Math.max(1e-8, Math.abs(sum[channel])),
  ));
}

function readMagic(bytes) {
  return String.fromCharCode(...bytes.subarray(0, MAGIC.length));
}

function decodeHalfArray(source) {
  const decoded = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    decoded[i] = THREE.DataUtils.fromHalfFloat(source[i]);
  }
  return decoded;
}

function makeHalfFloatAtlasTexture(source, width, height, name) {
  const padded = new Uint16Array(width * height * 4);
  padded.set(source);
  const texture = new THREE.DataTexture(
    padded,
    width,
    height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  texture.name = name;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function parseSpectralFlareAtlas(arrayBuffer, { createTextures = true } = {}) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new TypeError("parseSpectralFlareAtlas expects an ArrayBuffer.");
  }
  if (arrayBuffer.byteLength < HEADER_BYTES) {
    throw new Error("Spectral flare atlas is shorter than its header.");
  }

  const bytes = new Uint8Array(arrayBuffer);
  if (readMagic(bytes) !== MAGIC) {
    throw new Error("Invalid spectral flare atlas magic.");
  }

  const view = new DataView(arrayBuffer);
  const version = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  const pathCount = view.getUint32(16, true);
  const wavelengthCount = view.getUint32(20, true);
  const angleCount = view.getUint32(24, true);
  const gridSize = view.getUint32(28, true);
  const recordCount = view.getUint32(32, true);
  const sensorWidthMm = view.getFloat32(36, true);
  const sensorHeightMm = view.getFloat32(40, true);
  const maxIncidenceDeg = view.getFloat32(44, true);
  const pupilRadiusMm = view.getFloat32(48, true);
  const designFNumber = view.getFloat32(52, true);
  const flags = view.getUint32(56, true);
  const payloadBytes = view.getUint32(60, true);

  if (version !== 1 || headerBytes !== HEADER_BYTES) {
    throw new Error(`Unsupported spectral flare atlas version ${version}.`);
  }
  if (
    pathCount === 0
    || wavelengthCount !== GHOST_WAVELENGTHS_NM.length
    || angleCount < 2
    || gridSize < 2
    || recordCount !== pathCount * wavelengthCount * angleCount * gridSize * gridSize
  ) {
    throw new Error("Spectral flare atlas dimensions are inconsistent.");
  }

  let offset = headerBytes;
  const pairsByteLength = pathCount * 2;
  const pathPairs = new Uint8Array(arrayBuffer.slice(offset, offset + pairsByteLength));
  offset += pairsByteLength;
  offset = (offset + 3) & ~3;

  const energyByteLength = pathCount * 4;
  const pathEnergy = new Float32Array(arrayBuffer.slice(offset, offset + energyByteLength));
  offset += energyByteLength;

  const channelValueCount = recordCount * 4;
  const channelByteLength = channelValueCount * 2;
  const expectedPayloadBytes = (offset - headerBytes) + channelByteLength * 2;
  if (
    payloadBytes !== expectedPayloadBytes
    || offset + channelByteLength * 2 !== arrayBuffer.byteLength
  ) {
    throw new Error("Spectral flare atlas payload size is inconsistent.");
  }

  // Views, not copies: the texture path pads straight out of the fetch buffer,
  // so the multi-megabyte payload is never duplicated on the JS heap.
  const atlasAHalf = new Uint16Array(arrayBuffer, offset, channelValueCount);
  offset += channelByteLength;
  const atlasBHalf = new Uint16Array(arrayBuffer, offset, channelValueCount);

  const atlasWidth = 2048;
  const atlasHeight = Math.ceil(recordCount / atlasWidth);
  const result = {
    version,
    pathCount,
    wavelengthCount,
    angleCount,
    gridSize,
    gridVertexCount: gridSize * gridSize,
    recordCount,
    sensorWidthMm,
    sensorHeightMm,
    maxIncidenceDeg,
    pupilRadiusMm,
    designFNumber,
    wavelengthsNm: GHOST_WAVELENGTHS_NM.slice(0, wavelengthCount),
    spectralRgbWeights: makeSpectralRgbWeights(
      GHOST_WAVELENGTHS_NM.slice(0, wavelengthCount),
    ),
    pathPairs,
    pathEnergy,
    atlasWidth,
    atlasHeight,
    log2Throughput: (flags & FLAG_LOG2_THROUGHPUT) !== 0,
    log2Flux: (flags & FLAG_LOG2_FLUX) !== 0,
    boundaryExtrapolated: (flags & FLAG_BOUNDARY_EXTRAPOLATED) !== 0,
  };

  if (createTextures) {
    result.textureA = makeHalfFloatAtlasTexture(
      atlasAHalf,
      atlasWidth,
      atlasHeight,
      "PowerShot Heliar transfer A",
    );
    result.textureB = makeHalfFloatAtlasTexture(
      atlasBHalf,
      atlasWidth,
      atlasHeight,
      "PowerShot Heliar transfer B",
    );
  } else {
    // Raw channel views are retained only for the debug/test parse path. The
    // GPU path samples the padded textures, so it drops the views and lets the
    // GC reclaim the source ArrayBuffer they would otherwise pin.
    result.atlasAHalf = atlasAHalf;
    result.atlasBHalf = atlasBHalf;
  }

  return result;
}

export async function loadHeliarTronnierFlareProfile({
  url = DEFAULT_SPECTRAL_FLARE_ATLAS_URL,
  fetch: fetchImpl = globalThis.fetch,
  createTextures = true,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation is available for the flare atlas.");
  }
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Unable to load spectral flare atlas (${response.status}).`);
  }
  return parseSpectralFlareAtlas(await response.arrayBuffer(), { createTextures });
}

export function disposeSpectralFlareProfile(profile) {
  profile?.textureA?.dispose?.();
  profile?.textureB?.dispose?.();
}

// Test/debug helper. Runtime rendering intentionally keeps the atlas packed as
// half-float textures; decoding is useful for audit tools and deterministic
// tests, so the raw arrays only exist when parsed with createTextures: false.
export function decodeSpectralFlareAtlas(profile) {
  if (!profile?.atlasAHalf || !profile?.atlasBHalf) {
    throw new Error(
      "decodeSpectralFlareAtlas() needs a profile parsed with createTextures: false.",
    );
  }
  return {
    atlasA: decodeHalfArray(profile.atlasAHalf),
    atlasB: decodeHalfArray(profile.atlasBHalf),
  };
}
