import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GHOST_WAVELENGTHS_NM,
  HELIAR_TRONNIER_100MM,
} from "../src/solar-flare-profile.js";
import {
  enumerateTwoReflectionPaths,
  integratePupilThroughput,
  prepareLens,
  traceGhostGrid,
} from "./solar-flare-optics.mjs";

// Shipped defaults trade faint ghost-tail fidelity for a ~4× smaller atlas.
// Pass --max for the calibration-grade build (24 paths × 31 angles × 17² grid,
// ~9.8 MiB), or override --paths/--angles/--grid individually.
const ARGS = new Map(process.argv.slice(2)
  .filter((arg) => arg.startsWith("--"))
  .map((arg) => {
    const eq = arg.indexOf("=");
    return eq < 0 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)];
  }));
const MAX_QUALITY = ARGS.get("max") === true;
const intArg = (name, lean, max) => {
  const value = Number.parseInt(ARGS.get(name), 10);
  return Number.isFinite(value) ? value : (MAX_QUALITY ? max : lean);
};
const GRID_SIZE = intArg("grid", 13, 17);
const ANGLE_COUNT = intArg("angles", 21, 31);
const PATH_COUNT = intArg("paths", 16, 24);
const MAX_INCIDENCE_DEG = 30;
const MAGIC = "PSFLARE";
const HEADER_BYTES = 64;
const FLAG_LOG2_THROUGHPUT = 1 << 0;
const FLAG_LOG2_FLUX = 1 << 1;
const FLAG_BOUNDARY_EXTRAPOLATED = 1 << 2;
const DEFAULT_OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/assets/heliar-tronnier-100mm-v1.bin",
);

function floatToHalf(value) {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = value;
  const bits = intView[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13);
}

function nearestValidGridRecords(valid, gridSize) {
  const count = gridSize * gridSize;
  const nearest = new Int32Array(count);
  nearest.fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < count; i += 1) {
    if (!valid[i]) continue;
    nearest[i] = i;
    queue[tail++] = i;
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % gridSize;
    const y = Math.floor(index / gridSize);
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < gridSize ? index + 1 : -1,
      y > 0 ? index - gridSize : -1,
      y + 1 < gridSize ? index + gridSize : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || nearest[neighbor] >= 0) continue;
      nearest[neighbor] = nearest[index];
      queue[tail++] = neighbor;
    }
  }

  return nearest;
}

function encodePath(path, options) {
  const {
    lens,
    wavelengthsNm,
    angleCount,
    maxIncidenceDeg,
    gridSize,
    pupilRadiusMm,
  } = options;
  const gridVertexCount = gridSize * gridSize;
  const recordCount = wavelengthsNm.length * angleCount * gridVertexCount;
  const atlasA = new Float32Array(recordCount * 4);
  const atlasB = new Float32Array(recordCount * 4);
  let record = 0;
  let integratedEnergy = 0;
  let tracedGridCount = 0;
  let validCount = 0;

  for (const wavelengthNm of wavelengthsNm) {
    const prepared = prepareLens(lens, wavelengthNm);
    for (let angleIndex = 0; angleIndex < angleCount; angleIndex += 1) {
      const incidenceDeg = (angleIndex / (angleCount - 1)) * maxIncidenceDeg;
      const traced = traceGhostGrid({
        prepared,
        path,
        gridSize,
        pupilRadiusMm,
        incidenceRad: incidenceDeg * Math.PI / 180,
      });
      integratedEnergy += integratePupilThroughput(
        traced.samples,
        gridSize,
        pupilRadiusMm,
      );
      tracedGridCount += 1;
      const valid = traced.samples.map(
        (sample, vertex) => sample.valid && traced.flux[vertex] > 0,
      );
      const nearest = nearestValidGridRecords(valid, gridSize);
      for (let vertex = 0; vertex < gridVertexCount; vertex += 1) {
        const isValid = valid[vertex];
        const sourceVertex = nearest[vertex];
        const sample = sourceVertex >= 0
          ? traced.samples[sourceVertex]
          : traced.samples[vertex];
        const flux = sourceVertex >= 0 ? traced.flux[sourceVertex] : 0;
        const offset = record * 4;
        atlasA[offset] = sample.sensorXmm / (lens.sensorWidthMm * 0.5);
        atlasA[offset + 1] = sample.sensorYmm / (lens.sensorHeightMm * 0.5);
        atlasA[offset + 2] = sample.apertureXmm;
        atlasA[offset + 3] = sample.apertureYmm;
        atlasB[offset] = sourceVertex >= 0
          ? Math.log2(Math.max(1e-30, sample.throughput))
          : 0;
        atlasB[offset + 1] = sample.maxRelativeRadius;
        atlasB[offset + 2] = sourceVertex >= 0 ? Math.log2(Math.max(1e-30, flux)) : 0;
        atlasB[offset + 3] = isValid ? 1 : 0;
        if (isValid) {
          validCount += 1;
        }
        record += 1;
      }
    }
  }

  return {
    path,
    atlasA,
    atlasB,
    integratedEnergy: integratedEnergy / Math.max(1, tracedGridCount),
    validFraction: validCount / recordCount,
  };
}

function writeHalfArray(target, byteOffset, source) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  for (let i = 0; i < source.length; i += 1) {
    view.setUint16(byteOffset + i * 2, floatToHalf(source[i]), true);
  }
}

async function generate(outputPath) {
  const lens = HELIAR_TRONNIER_100MM;
  const allPaths = enumerateTwoReflectionPaths(lens);
  if (PATH_COUNT > allPaths.length) {
    throw new RangeError(
      `--paths=${PATH_COUNT} exceeds the ${allPaths.length} valid two-reflection paths.`,
    );
  }
  const pupilRadiusMm = lens.surfaces[0].semiApertureMm;
  const options = {
    lens,
    wavelengthsNm: GHOST_WAVELENGTHS_NM,
    angleCount: ANGLE_COUNT,
    maxIncidenceDeg: MAX_INCIDENCE_DEG,
    gridSize: GRID_SIZE,
    pupilRadiusMm,
  };

  process.stdout.write(
    `Tracing ${allPaths.length} Heliar paths at ${GHOST_WAVELENGTHS_NM.length}`
    + ` wavelengths × ${ANGLE_COUNT} angles × ${GRID_SIZE}² rays...\n`,
  );
  const encoded = allPaths.map((path, index) => {
    const result = encodePath(path, options);
    process.stdout.write(
      `  ${String(index + 1).padStart(2, "0")}/${allPaths.length}`
      + ` path ${path[0]}→${path[1]}`
      + ` energy=${result.integratedEnergy.toExponential(4)}`
      + ` valid=${(result.validFraction * 100).toFixed(1)}%\n`,
    );
    return result;
  });
  encoded.sort((a, b) => b.integratedEnergy - a.integratedEnergy);
  const selected = encoded.slice(0, PATH_COUNT);

  const gridVertexCount = GRID_SIZE * GRID_SIZE;
  const recordsPerPath = GHOST_WAVELENGTHS_NM.length * ANGLE_COUNT * gridVertexCount;
  const recordCount = PATH_COUNT * recordsPerPath;
  const channelValueCount = recordCount * 4;
  const pairsBytes = PATH_COUNT * 2;
  const pairsEnd = HEADER_BYTES + pairsBytes;
  const energyOffset = (pairsEnd + 3) & ~3;
  const dataAOffset = energyOffset + PATH_COUNT * 4;
  const dataBOffset = dataAOffset + channelValueCount * 2;
  const totalBytes = dataBOffset + channelValueCount * 2;
  const payloadBytes = totalBytes - HEADER_BYTES;
  const output = Buffer.alloc(totalBytes);
  output.write(MAGIC, 0, "ascii");
  const header = new DataView(output.buffer, output.byteOffset, output.byteLength);
  header.setUint32(8, 1, true);
  header.setUint32(12, HEADER_BYTES, true);
  header.setUint32(16, PATH_COUNT, true);
  header.setUint32(20, GHOST_WAVELENGTHS_NM.length, true);
  header.setUint32(24, ANGLE_COUNT, true);
  header.setUint32(28, GRID_SIZE, true);
  header.setUint32(32, recordCount, true);
  header.setFloat32(36, lens.sensorWidthMm, true);
  header.setFloat32(40, lens.sensorHeightMm, true);
  header.setFloat32(44, MAX_INCIDENCE_DEG, true);
  header.setFloat32(48, pupilRadiusMm, true);
  header.setFloat32(52, lens.designFNumber, true);
  header.setUint32(
    56,
    FLAG_LOG2_THROUGHPUT | FLAG_LOG2_FLUX | FLAG_BOUNDARY_EXTRAPOLATED,
    true,
  );
  header.setUint32(60, payloadBytes, true);

  for (let pathIndex = 0; pathIndex < selected.length; pathIndex += 1) {
    const item = selected[pathIndex];
    output[HEADER_BYTES + pathIndex * 2] = item.path[0];
    output[HEADER_BYTES + pathIndex * 2 + 1] = item.path[1];
    header.setFloat32(energyOffset + pathIndex * 4, item.integratedEnergy, true);
    writeHalfArray(
      output,
      dataAOffset + pathIndex * item.atlasA.length * 2,
      item.atlasA,
    );
    writeHalfArray(
      output,
      dataBOffset + pathIndex * item.atlasB.length * 2,
      item.atlasB,
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  process.stdout.write(
    `Wrote ${(totalBytes / (1024 * 1024)).toFixed(2)} MiB to ${outputPath}\n`,
  );
  process.stdout.write("Selected paths:\n");
  for (const item of selected) {
    process.stdout.write(
      `  ${item.path[0]}→${item.path[1]} ${item.integratedEnergy.toExponential(5)}\n`,
    );
  }
}

const outputPath = typeof ARGS.get("output") === "string"
  ? resolve(process.cwd(), ARGS.get("output"))
  : DEFAULT_OUTPUT;

await generate(outputPath);
