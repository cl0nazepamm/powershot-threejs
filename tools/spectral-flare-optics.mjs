const FRAUNHOFER_F_NM = 486.1327;
const FRAUNHOFER_D_NM = 587.5618;
const FRAUNHOFER_C_NM = 656.2725;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 1e-14)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function reflect(direction, normal) {
  const scale = 2 * dot(direction, normal);
  return normalize([
    direction[0] - scale * normal[0],
    direction[1] - scale * normal[1],
    direction[2] - scale * normal[2],
  ]);
}

function refract(direction, normal, eta) {
  const ni = dot(normal, direction);
  const k = 1 - eta * eta * (1 - ni * ni);
  if (k < 0) return null;
  const scale = eta * ni + Math.sqrt(k);
  return normalize([
    eta * direction[0] - scale * normal[0],
    eta * direction[1] - scale * normal[1],
    eta * direction[2] - scale * normal[2],
  ]);
}

export function cauchyIndex(nD, abbeV, wavelengthNm) {
  if (!(nD > 1.000001) || !(abbeV > 0)) return nD;
  const f = FRAUNHOFER_F_NM * 0.001;
  const d = FRAUNHOFER_D_NM * 0.001;
  const c = FRAUNHOFER_C_NM * 0.001;
  const lambda = wavelengthNm * 0.001;
  const b = ((nD - 1) / abbeV) / (1 / (f * f) - 1 / (c * c));
  const a = nD - b / (d * d);
  return a + b / (lambda * lambda);
}

function interfaceAmplitude(n0, n1, cos0, cos1, polarization) {
  if (polarization === "s") {
    return (n0 * cos0 - n1 * cos1) / (n0 * cos0 + n1 * cos1);
  }
  return (n1 * cos0 - n0 * cos1) / (n1 * cos0 + n0 * cos1);
}

function coatedPolarizedReflectance(
  n0,
  n1,
  n2,
  cos0,
  cos1,
  cos2,
  phase,
  polarization,
) {
  const r01 = interfaceAmplitude(n0, n1, cos0, cos1, polarization);
  const r12 = interfaceAmplitude(n1, n2, cos1, cos2, polarization);
  const phaseR = Math.cos(phase);
  const phaseI = Math.sin(phase);
  const numeratorR = r01 + r12 * phaseR;
  const numeratorI = r12 * phaseI;
  const product = r01 * r12;
  const denominatorR = 1 + product * phaseR;
  const denominatorI = product * phaseI;
  return (numeratorR * numeratorR + numeratorI * numeratorI)
    / Math.max(1e-20, denominatorR * denominatorR + denominatorI * denominatorI);
}

// Lossless, single-layer thin-film reflectance averaged over s and p
// polarization. Transmission is treated as 1-R by the offline path tracer.
export function thinFilmReflectance({
  nIncident,
  nCoating,
  nTransmit,
  cosIncident,
  wavelengthNm,
  coatingDesignNm,
}) {
  const n0 = Math.max(1e-6, nIncident);
  const n1 = Math.max(1e-6, nCoating);
  const n2 = Math.max(1e-6, nTransmit);
  const cos0 = clamp(Math.abs(cosIncident), 0, 1);
  const sin0 = Math.sqrt(Math.max(0, 1 - cos0 * cos0));
  const sin1 = (n0 / n1) * sin0;
  const sin2 = (n0 / n2) * sin0;
  if (sin1 >= 1 || sin2 >= 1) return 1;
  const cos1 = Math.sqrt(Math.max(0, 1 - sin1 * sin1));
  const cos2 = Math.sqrt(Math.max(0, 1 - sin2 * sin2));

  if (!(coatingDesignNm > 0) || !(nCoating > 0)) {
    const rs = interfaceAmplitude(n0, n2, cos0, cos2, "s");
    const rp = interfaceAmplitude(n0, n2, cos0, cos2, "p");
    return clamp((rs * rs + rp * rp) * 0.5, 0, 1);
  }

  const thicknessNm = coatingDesignNm / (4 * n1);
  const phase = (4 * Math.PI * n1 * thicknessNm * cos1) / wavelengthNm;
  const rs = coatedPolarizedReflectance(n0, n1, n2, cos0, cos1, cos2, phase, "s");
  const rp = coatedPolarizedReflectance(n0, n1, n2, cos0, cos1, cos2, phase, "p");
  return clamp((rs + rp) * 0.5, 0, 1);
}

export function prepareLens(lens, wavelengthNm) {
  const sensorDistanceMm = lens.surfaces.reduce(
    (sum, surface) => sum + surface.thicknessMm,
    0,
  );
  const surfaces = [];
  let vertexZ = sensorDistanceMm;
  let previousIndex = 1;

  for (let index = 0; index < lens.surfaces.length; index += 1) {
    const surface = lens.surfaces[index];
    const nextIndex = surface.kind === "aperture" || surface.kind === "sensor"
      ? previousIndex
      : cauchyIndex(surface.nD, surface.abbeV, wavelengthNm);
    surfaces.push({
      ...surface,
      index,
      vertexZ,
      centerZ: vertexZ - surface.radiusMm,
      nBefore: previousIndex,
      nAfter: nextIndex,
    });
    if (surface.kind !== "aperture" && surface.kind !== "sensor") {
      previousIndex = nextIndex;
    }
    vertexZ -= surface.thicknessMm;
  }

  return { lens, wavelengthNm, sensorDistanceMm, surfaces };
}

function intersectSurface(surface, position, direction) {
  if (surface.radiusMm === 0) {
    if (Math.abs(direction[2]) < 1e-12) return null;
    const t = (surface.vertexZ - position[2]) / direction[2];
    if (!(t >= -1e-7)) return null;
    const hit = [
      position[0] + direction[0] * t,
      position[1] + direction[1] * t,
      position[2] + direction[2] * t,
    ];
    return {
      position: hit,
      normal: direction[2] > 0 ? [0, 0, -1] : [0, 0, 1],
    };
  }

  const dx = position[0];
  const dy = position[1];
  const dz = position[2] - surface.centerZ;
  const b = dx * direction[0] + dy * direction[1] + dz * direction[2];
  const c = dx * dx + dy * dy + dz * dz - surface.radiusMm * surface.radiusMm;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const inside = Math.sign(surface.radiusMm * direction[2]) || 1;
  const t = -b + Math.sqrt(discriminant) * inside;
  if (!(t >= -1e-7)) return null;
  const hit = [
    position[0] + direction[0] * t,
    position[1] + direction[1] * t,
    position[2] + direction[2] * t,
  ];
  const normal = normalize([
    (hit[0] / Math.abs(surface.radiusMm)) * -inside,
    (hit[1] / Math.abs(surface.radiusMm)) * -inside,
    ((hit[2] - surface.centerZ) / Math.abs(surface.radiusMm)) * -inside,
  ]);
  return normal ? { position: hit, normal } : null;
}

export function enumerateTwoReflectionPaths(lens) {
  const interfaces = lens.surfaces
    .map((surface, index) => ({ surface, index }))
    .filter(({ surface }) => surface.kind === "glass")
    .map(({ index }) => index);
  const paths = [];
  for (let later = 1; later < interfaces.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      paths.push([interfaces[later], interfaces[earlier]]);
    }
  }
  return paths;
}

export function traceGhostRay(
  prepared,
  path,
  pupilXmm,
  pupilYmm,
  incidenceRad,
) {
  let position = [pupilXmm, pupilYmm, prepared.sensorDistanceMm + 0.1];
  let direction = normalize([Math.sin(incidenceRad), 0, -Math.cos(incidenceRad)]);
  let throughput = 1;
  let maxRelativeRadius = 0;
  let apertureXmm = 0;
  let apertureYmm = 0;
  let hitSensor = false;
  let phase = 0;
  let delta = 1;
  let surfaceIndex = 0;
  let guard = 0;

  while (
    direction
    && surfaceIndex >= 0
    && surfaceIndex < prepared.surfaces.length
    && guard < prepared.surfaces.length * 4
  ) {
    guard += 1;
    const surface = prepared.surfaces[surfaceIndex];
    const reflectRay = phase < path.length && surfaceIndex === path[phase];
    if (reflectRay) {
      delta = -delta;
      phase += 1;
    }

    const intersection = intersectSurface(surface, position, direction);
    if (!intersection) break;
    position = intersection.position;

    if (surface.kind === "aperture") {
      apertureXmm = position[0];
      apertureYmm = position[1];
    } else if (surface.kind !== "sensor") {
      maxRelativeRadius = Math.max(
        maxRelativeRadius,
        Math.hypot(position[0], position[1]) / Math.max(1e-6, surface.semiApertureMm),
      );
    }

    if (surface.kind === "sensor") {
      hitSensor = phase === path.length && direction[2] < 0;
      break;
    }
    if (surface.kind === "aperture") {
      surfaceIndex += delta;
      continue;
    }

    const forward = direction[2] < 0;
    const nIncident = forward ? surface.nBefore : surface.nAfter;
    const nTransmit = forward ? surface.nAfter : surface.nBefore;
    const cosIncident = clamp(dot(
      [-direction[0], -direction[1], -direction[2]],
      intersection.normal,
    ), 0, 1);
    const reflectance = thinFilmReflectance({
      nIncident,
      nCoating: surface.coatingIor,
      nTransmit,
      cosIncident,
      wavelengthNm: prepared.wavelengthNm,
      coatingDesignNm: surface.coatingDesignNm,
    });

    if (reflectRay) {
      throughput *= reflectance;
      direction = reflect(direction, intersection.normal);
    } else {
      throughput *= 1 - reflectance;
      direction = refract(direction, intersection.normal, nIncident / nTransmit);
    }
    surfaceIndex += delta;
  }

  const valid = hitSensor
    && Number.isFinite(position[0])
    && Number.isFinite(position[1])
    && Number.isFinite(throughput)
    && throughput > 0;

  return {
    sensorXmm: valid ? position[0] : 0,
    sensorYmm: valid ? position[1] : 0,
    apertureXmm: valid ? apertureXmm : 0,
    apertureYmm: valid ? apertureYmm : 0,
    throughput: valid ? throughput : 0,
    maxRelativeRadius: valid ? maxRelativeRadius : 2,
    valid,
  };
}

function visitGridTriangles(gridSize, visitor) {
  for (let y = 0; y < gridSize - 1; y += 1) {
    for (let x = 0; x < gridSize - 1; x += 1) {
      const a = y * gridSize + x;
      const b = a + 1;
      const c = a + gridSize;
      const d = c + 1;
      if ((x + y) % 2 === 0) {
        visitor(a, b, d);
        visitor(d, c, a);
      } else {
        visitor(a, b, c);
        visitor(b, d, c);
      }
    }
  }
}

function sensorTriangleArea(samples, a, b, c) {
  const ax = samples[a].sensorXmm;
  const ay = samples[a].sensorYmm;
  const abx = samples[b].sensorXmm - ax;
  const aby = samples[b].sensorYmm - ay;
  const acx = samples[c].sensorXmm - ax;
  const acy = samples[c].sensorYmm - ay;
  return Math.abs(abx * acy - aby * acx) * 0.5;
}

export function computeFluxScale(samples, gridSize, pupilRadiusMm) {
  const count = gridSize * gridSize;
  const stepMm = (2 * pupilRadiusMm) / (gridSize - 1);
  const pupilTriangleArea = stepMm * stepMm * 0.5;
  const pupilArea = new Float64Array(count);
  const sensorArea = new Float64Array(count);
  const supportCount = new Uint8Array(count);
  const topologyCount = new Uint8Array(count);
  const flux = new Float64Array(count);
  let totalPupilArea = 0;
  let totalSensorArea = 0;

  visitGridTriangles(gridSize, (a, b, c) => {
    for (const vertex of [a, b, c]) topologyCount[vertex] += 1;
    if (!samples[a].valid || !samples[b].valid || !samples[c].valid) return;
    const mappedArea = sensorTriangleArea(samples, a, b, c);
    if (!Number.isFinite(mappedArea) || mappedArea <= 0) return;
    totalPupilArea += pupilTriangleArea;
    totalSensorArea += mappedArea;
    for (const vertex of [a, b, c]) {
      // One third is the standard mass-lumped control volume at a triangle
      // vertex. The common factor cancels in the final ratio.
      pupilArea[vertex] += pupilTriangleArea;
      sensorArea[vertex] += mappedArea;
      supportCount[vertex] += 1;
    }
  });

  const reliable = new Uint8Array(count);
  const nearestReliable = new Int32Array(count);
  nearestReliable.fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < count; i += 1) {
    if (pupilArea[i] > 0 && sensorArea[i] > 0) {
      // This is a finite-area inverse Jacobian over the actual rasterized
      // pupil cells. Unlike a point derivative, a fold cannot turn one grid
      // vertex into an unbounded triangular energy spike.
      flux[i] = pupilArea[i] / sensorArea[i];
    }
    // A control volume on the traced-valid boundary is incomplete. Only cells
    // with every topological neighbor represented can establish a stable local
    // density; outer-grid and validity-boundary vertices are reconstructed
    // from that resolved interior below.
    if (
      topologyCount[i] >= 4
      && supportCount[i] === topologyCount[i]
      && flux[i] > 0
    ) {
      reliable[i] = 1;
      nearestReliable[i] = i;
      queue[tail++] = i;
    }
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
      if (neighbor < 0 || nearestReliable[neighbor] >= 0) continue;
      nearestReliable[neighbor] = nearestReliable[index];
      queue[tail++] = neighbor;
    }
  }

  const unresolvedDensity = totalPupilArea / Math.max(totalSensorArea, Number.EPSILON);
  for (let i = 0; i < count; i += 1) {
    if (!samples[i].valid || supportCount[i] === 0 || reliable[i]) continue;
    const source = nearestReliable[i];
    flux[i] = source >= 0 ? flux[source] : unresolvedDensity;
  }

  // Boundary reconstruction changes local interpolation but must not create or
  // destroy path energy. Normalize the rasterized triangle integral back to
  // the pupil-area integral for this wavelength and source angle.
  let inputEnergy = 0;
  let outputEnergy = 0;
  visitGridTriangles(gridSize, (a, b, c) => {
    if (!samples[a].valid || !samples[b].valid || !samples[c].valid) return;
    const mappedArea = sensorTriangleArea(samples, a, b, c);
    if (!Number.isFinite(mappedArea) || mappedArea <= 0) return;
    inputEnergy += pupilTriangleArea * (
      samples[a].throughput + samples[b].throughput + samples[c].throughput
    ) / 3;
    outputEnergy += mappedArea * (
      flux[a] * samples[a].throughput
      + flux[b] * samples[b].throughput
      + flux[c] * samples[c].throughput
    ) / 3;
  });
  if (inputEnergy > 0 && outputEnergy > 0) {
    const normalization = inputEnergy / outputEnergy;
    for (let i = 0; i < count; i += 1) flux[i] *= normalization;
  }
  return flux;
}

export function integratePupilThroughput(samples, gridSize, pupilRadiusMm) {
  const stepMm = (2 * pupilRadiusMm) / (gridSize - 1);
  const pupilTriangleArea = stepMm * stepMm * 0.5;
  let energy = 0;
  visitGridTriangles(gridSize, (a, b, c) => {
    if (!samples[a].valid || !samples[b].valid || !samples[c].valid) return;
    energy += pupilTriangleArea * (
      samples[a].throughput + samples[b].throughput + samples[c].throughput
    ) / 3;
  });
  return energy;
}

export function traceGhostGrid({
  prepared,
  path,
  gridSize,
  pupilRadiusMm,
  incidenceRad,
}) {
  const samples = [];
  for (let y = 0; y < gridSize; y += 1) {
    const py = ((y / (gridSize - 1)) * 2 - 1) * pupilRadiusMm;
    for (let x = 0; x < gridSize; x += 1) {
      const px = ((x / (gridSize - 1)) * 2 - 1) * pupilRadiusMm;
      samples.push(traceGhostRay(prepared, path, px, py, incidenceRad));
    }
  }
  const flux = computeFluxScale(samples, gridSize, pupilRadiusMm);
  return { samples, flux };
}
