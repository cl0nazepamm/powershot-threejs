import * as THREE from "three/webgpu";

const PSF_CACHE = new Map();

function reverseBits(value, bits) {
  let reversed = 0;
  for (let i = 0; i < bits; i += 1) {
    reversed = (reversed << 1) | ((value >>> i) & 1);
  }
  return reversed;
}

function fft1d(real, imag, offset, stride, count) {
  const bits = Math.log2(count);
  for (let i = 0; i < count; i += 1) {
    const j = reverseBits(i, bits);
    if (j <= i) continue;
    const ia = offset + i * stride;
    const ib = offset + j * stride;
    [real[ia], real[ib]] = [real[ib], real[ia]];
    [imag[ia], imag[ib]] = [imag[ib], imag[ia]];
  }

  for (let width = 2; width <= count; width *= 2) {
    const half = width / 2;
    const step = (-2 * Math.PI) / width;
    for (let start = 0; start < count; start += width) {
      for (let j = 0; j < half; j += 1) {
        const angle = step * j;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const even = offset + (start + j) * stride;
        const odd = offset + (start + j + half) * stride;
        const tr = wr * real[odd] - wi * imag[odd];
        const ti = wr * imag[odd] + wi * real[odd];
        const er = real[even];
        const ei = imag[even];
        real[even] = er + tr;
        imag[even] = ei + ti;
        real[odd] = er - tr;
        imag[odd] = ei - ti;
      }
    }
  }
}

function polygonRadius(angle, blades, roundness) {
  const sector = (2 * Math.PI) / blades;
  const local = ((angle + sector * 0.5 + Math.PI * 8) % sector) - sector * 0.5;
  const polygon = Math.cos(Math.PI / blades) / Math.max(1e-6, Math.cos(local));
  return polygon * (1 - roundness) + roundness;
}

function makeApertureMask(size, blades, roundness, rotation, fill) {
  const real = new Float64Array(size * size);
  const imag = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const py = ((y + 0.5) / size - 0.5) * 2;
    for (let x = 0; x < size; x += 1) {
      const px = ((x + 0.5) / size - 0.5) * 2;
      const radius = Math.hypot(px, py) / fill;
      const angle = Math.atan2(py, px) - rotation;
      const boundary = polygonRadius(angle, blades, roundness);
      const edge = 1.5 / (size * fill);
      const coverage = Math.max(0, Math.min(1, (boundary + edge - radius) / (2 * edge)));
      // A mild smoothstep is enough to anti-alias the pupil edge without
      // changing its total aperture area materially.
      real[y * size + x] = coverage * coverage * (3 - 2 * coverage);
    }
  }
  return { real, imag };
}

function fft2d(real, imag, size) {
  for (let y = 0; y < size; y += 1) fft1d(real, imag, y * size, 1, size);
  for (let x = 0; x < size; x += 1) fft1d(real, imag, x, size, size);
}

function convolveFiniteSun(psf, size, sigmaPixels) {
  if (!(sigmaPixels > 0.01)) return psf;
  const radius = Math.max(1, Math.ceil(sigmaPixels * 3));
  const kernel = [];
  let kernelSum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigmaPixels * sigmaPixels));
    kernel.push(weight);
    kernelSum += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= kernelSum;

  const tmp = new Float64Array(psf.length);
  const out = new Float64Array(psf.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.max(0, Math.min(size - 1, x + k));
        value += psf[y * size + sx] * kernel[k + radius];
      }
      tmp[y * size + x] = value;
    }
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.max(0, Math.min(size - 1, y + k));
        value += tmp[sy * size + x] * kernel[k + radius];
      }
      out[y * size + x] = value;
    }
  }
  return out;
}

export function generateDiffractionPsf({
  size = 256,
  blades = 7,
  roundness = 0.08,
  rotation = 0,
  apertureFill = 0.88,
  finiteSunSigmaPixels = 0,
} = {}) {
  if (size < 32 || (size & (size - 1)) !== 0) {
    throw new RangeError("Diffraction PSF size must be a power of two >= 32.");
  }
  if (!Number.isInteger(blades) || blades < 3 || blades > 32) {
    throw new RangeError("Aperture blade count must be an integer from 3 to 32.");
  }

  const { real, imag } = makeApertureMask(
    size,
    blades,
    Math.max(0, Math.min(1, roundness)),
    rotation,
    Math.max(0.1, Math.min(0.98, apertureFill)),
  );
  fft2d(real, imag, size);

  let psf = new Float64Array(size * size);
  let energy = 0;
  const half = size >> 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x + half) % size;
      const sourceY = (y + half) % size;
      const source = sourceY * size + sourceX;
      const magnitude = real[source] * real[source] + imag[source] * imag[source];
      psf[y * size + x] = magnitude;
      energy += magnitude;
    }
  }

  const invEnergy = 1 / Math.max(1e-30, energy);
  for (let i = 0; i < psf.length; i += 1) psf[i] *= invEnergy;
  psf = convolveFiniteSun(psf, size, finiteSunSigmaPixels);

  // The blur kernel is normalized, but edge clamping can introduce a minute
  // error. Renormalize so f-stop and wavelength changes do not create energy.
  let finalEnergy = 0;
  for (let i = 0; i < psf.length; i += 1) finalEnergy += psf[i];
  const normalize = 1 / Math.max(1e-30, finalEnergy);
  const halfData = new Uint16Array(psf.length);
  for (let i = 0; i < psf.length; i += 1) {
    halfData[i] = THREE.DataUtils.toHalfFloat(psf[i] * normalize);
  }

  return {
    size,
    blades,
    roundness,
    rotation,
    apertureFill,
    finiteSunSigmaPixels,
    data: halfData,
  };
}

export function createDiffractionPsfTexture(options = {}) {
  const key = JSON.stringify({
    size: options.size ?? 256,
    blades: options.blades ?? 7,
    roundness: options.roundness ?? 0.08,
    rotation: options.rotation ?? 0,
    apertureFill: options.apertureFill ?? 0.88,
    finiteSunSigmaPixels: options.finiteSunSigmaPixels ?? 0,
  });
  const cached = PSF_CACHE.get(key);
  if (cached) {
    cached.users += 1;
    return cached;
  }

  const generated = generateDiffractionPsf(options);
  const texture = new THREE.DataTexture(
    generated.data,
    generated.size,
    generated.size,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  texture.name = `PowerShot ${generated.blades}-blade diffraction PSF`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // The physical PSF is much finer than a display pixel at typical focal
  // lengths. Energy-preserving minification keeps sub-pixel diffraction from
  // disappearing when the bounded PSF quad covers only a few dozen pixels.
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  const entry = { ...generated, texture, users: 1, key };
  PSF_CACHE.set(key, entry);
  return entry;
}

export function releaseDiffractionPsf(entry) {
  if (!entry) return;
  entry.users = Math.max(0, entry.users - 1);
  if (entry.users === 0) {
    entry.texture.dispose();
    PSF_CACHE.delete(entry.key);
  }
}
