import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  cos,
  exp,
  exp2,
  float,
  floor,
  fwidth,
  int,
  instanceIndex,
  ivec2,
  max,
  min,
  mix,
  mod,
  positionGeometry,
  pow,
  screenUV,
  sin,
  smoothstep,
  step,
  texture,
  textureLoad,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex,
} from "three/tsl";

import {
  DIFFRACTION_WAVELENGTHS_NM,
  HELIAR_TRONNIER_100MM,
  makeSpectralRgbWeights,
} from "./spectral-flare-profile.js";
import {
  createDiffractionPsfTexture,
  releaseDiffractionPsf,
} from "./spectral-flare-psf.js";

const DEG2RAD = Math.PI / 180;
const DEFAULT_SOLAR_DIAMETER_DEG = 0.533;
const REFERENCE_DIFFRACTION_NM = 550;
const VISIBILITY_SAMPLES = Object.freeze([
  [0, 0],
  [0.527, 0],
  [-0.527, 0],
  [0, 0.527],
  [0, -0.527],
  [0.372, 0.372],
  [-0.372, 0.372],
  [0.372, -0.372],
  [-0.372, -0.372],
]);

export const SPECTRAL_FLARE_DEFAULTS = Object.freeze({
  enabled: true,
  strength: 1,
  ghostStrength: 1,
  diffractionStrength: 5,
  glareStrength: 1,
  veilingStrength: 0.06,
  fNumber: 8,
  apertureBlades: 7,
  apertureRoundness: 0.08,
  apertureRotation: 0,
  hoodAngleDeg: 38,
  housingClip: 1,
  ghostResolutionScale: 0.75,
  veilResolutionScale: 0.125,
  sunSamples: 9,
  sourceAngularDiameterDeg: DEFAULT_SOLAR_DIAMETER_DEG,
  sharpVisibilitySeconds: 0.055,
  veilVisibilitySeconds: 0.32,
  diffractionScale: 1,
  psfSize: 512,
  ghostRadianceScale: 20,
});

const _drawingBufferSize = new THREE.Vector2();
const _lightPosition = new THREE.Vector3();
const _targetPosition = new THREE.Vector3();
const _worldDirection = new THREE.Vector3();
const _cameraDirection = new THREE.Vector3();
const _cameraPosition = new THREE.Vector3();
const _sampleDirection = new THREE.Vector3();
const _tangentX = new THREE.Vector3();
const _tangentY = new THREE.Vector3();
const _fallbackUp = new THREE.Vector3(0, 1, 0);

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clampNumber(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function smoothstepNumber(minValue, maxValue, value) {
  if (minValue === maxValue) return value < minValue ? 0 : 1;
  const t = clampNumber((value - minValue) / (maxValue - minValue), 0, 1);
  return t * t * (3 - 2 * t);
}

export function diffractionPeakScale(fNumber, designFNumber = 8) {
  const current = finitePositive(fNumber, designFNumber);
  const design = finitePositive(designFNumber, 8);
  return (design / current) ** 4;
}

// Each straight blade edge diffracts a streak along its normal, in both
// directions. Opposite edges of an even-count iris are parallel, so their
// streaks overlap: N blades produce 2N spikes when N is odd, N when even.
// |cos(harmonic·angle)| peaks exactly on that spike set.
export function apertureSpikeHarmonic(blades) {
  const count = clampNumber(Math.round(finite(blades, 7)), 3, 32);
  return count % 2 === 0 ? count / 2 : count;
}

export function sensorGateToNdc(camera, lens, target = new THREE.Vector2()) {
  if (!camera?.isPerspectiveCamera) {
    throw new TypeError("sensorGateToNdc() requires a PerspectiveCamera.");
  }
  const projection = camera.projectionMatrix.elements;
  return target.set(
    Math.abs(projection[0]) * (lens.sensorWidthMm * 0.5) / lens.focalLengthMm,
    Math.abs(projection[5]) * (lens.sensorHeightMm * 0.5) / lens.focalLengthMm,
  );
}

function rendererSize(renderer) {
  if (typeof renderer.getDrawingBufferSize === "function") {
    renderer.getDrawingBufferSize(_drawingBufferSize);
  } else {
    renderer.getSize(_drawingBufferSize);
    _drawingBufferSize.multiplyScalar(renderer.getPixelRatio?.() || 1);
  }
  return {
    width: Math.max(1, Math.round(_drawingBufferSize.x)),
    height: Math.max(1, Math.round(_drawingBufferSize.y)),
  };
}

function makeTarget(width, height, options = {}) {
  return new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
    ...options,
  });
}

function makeFullscreenGeometry() {
  return new THREE.PlaneGeometry(2, 2);
}

function makeGhostGridGeometry(gridSize, instanceCount) {
  const geometry = new THREE.InstancedBufferGeometry();
  const vertexCount = gridSize * gridSize;
  const positions = new Float32Array(vertexCount * 3);
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const index = y * gridSize + x;
      positions[index * 3] = (x / (gridSize - 1)) * 2 - 1;
      positions[index * 3 + 1] = (y / (gridSize - 1)) * 2 - 1;
    }
  }

  const indices = new Uint16Array((gridSize - 1) * (gridSize - 1) * 6);
  let write = 0;
  for (let y = 0; y < gridSize - 1; y += 1) {
    for (let x = 0; x < gridSize - 1; x += 1) {
      const a = y * gridSize + x;
      const b = a + 1;
      const c = a + gridSize;
      const d = c + 1;
      if ((x + y) % 2 === 0) {
        indices[write++] = a;
        indices[write++] = b;
        indices[write++] = d;
        indices[write++] = d;
        indices[write++] = c;
        indices[write++] = a;
      } else {
        indices[write++] = a;
        indices[write++] = b;
        indices[write++] = c;
        indices[write++] = b;
        indices[write++] = d;
        indices[write++] = c;
      }
    }
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.instanceCount = instanceCount;
  geometry.computeBoundingSphere();
  return geometry;
}

function makeNodeMaterial(colorNode, { positionNode = null, blending = false } = {}) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = colorNode;
  material.positionNode = positionNode;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;
  material.transparent = blending;
  material.blending = blending ? THREE.CustomBlending : THREE.NoBlending;
  if (blending) {
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquation = THREE.AddEquation;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneFactor;
    material.blendEquationAlpha = THREE.AddEquation;
  }
  return material;
}

function createHalfTexture(data, width, name) {
  const padded = new Uint16Array(width * 4);
  padded.set(data);
  const result = new THREE.DataTexture(
    padded,
    width,
    1,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  result.name = name;
  result.colorSpace = THREE.NoColorSpace;
  result.minFilter = THREE.NearestFilter;
  result.magFilter = THREE.NearestFilter;
  result.generateMipmaps = false;
  result.needsUpdate = true;
  return result;
}

function spectralWeightsTexture(weights, name) {
  const data = new Uint16Array(weights.length * 4);
  for (let i = 0; i < weights.length; i += 1) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(weights[i][0]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(weights[i][1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(weights[i][2]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  return createHalfTexture(data, weights.length, name);
}

function copyDescriptorColor(target, value) {
  if (value?.isColor) target.copy(value);
  else if (Array.isArray(value)) target.setRGB(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1);
  else if (value !== undefined) target.set(value);
  else target.setRGB(1, 0.965, 0.89);
}

function descriptorDirection(target, sun) {
  if (sun?.isDirectionalLight) {
    sun.updateMatrixWorld?.();
    sun.target?.updateMatrixWorld?.();
    sun.getWorldPosition(_lightPosition);
    sun.target.getWorldPosition(_targetPosition);
    return target.copy(_lightPosition).sub(_targetPosition).normalize();
  }
  const direction = sun?.direction || sun?.toSunDirection || sun;
  if (direction?.isVector3) return target.copy(direction).normalize();
  if (Array.isArray(direction)) {
    return target.set(direction[0] || 0, direction[1] || 0, direction[2] || -1).normalize();
  }
  return target.set(0.3, 0.35, -1).normalize();
}

export function resolveSunSource(sun, target = {}) {
  const direction = target.direction?.isVector3
    ? target.direction
    : new THREE.Vector3();
  descriptorDirection(direction, sun);
  const color = target.color?.isColor ? target.color : new THREE.Color();
  copyDescriptorColor(color, sun?.color);
  const radiance = finiteNonNegative(
    sun?.sourceRadiance
      ?? sun?.radiance
      ?? sun?.userData?.spectralFlareRadiance
      ?? sun?.intensity,
    1,
  );
  const angularDiameterDeg = finitePositive(
    sun?.angularDiameterDeg ?? sun?.userData?.angularDiameterDeg,
    DEFAULT_SOLAR_DIAMETER_DEG,
  );
  return {
    direction,
    color,
    radiance,
    angularDiameterDeg,
  };
}

// Projects a direction at infinity. Unlike Vector3.project(), this never clamps
// to the viewport, so sources just outside the frame still drive the lens.
export function projectSunDirection(camera, worldDirection, target = {}) {
  if (!camera?.isPerspectiveCamera) {
    throw new TypeError("projectSunDirection() requires a PerspectiveCamera.");
  }
  camera.updateMatrixWorld?.();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  _cameraDirection.copy(worldDirection).transformDirection(camera.matrixWorldInverse).normalize();

  const towardCameraFront = -_cameraDirection.z;
  const incidenceRad = Math.acos(clampNumber(towardCameraFront, -1, 1));
  const azimuthRad = Math.atan2(_cameraDirection.y, _cameraDirection.x);
  const projection = camera.projectionMatrix.elements;
  const safeW = Math.max(1e-7, towardCameraFront);
  const ndcX = (projection[0] * _cameraDirection.x + projection[8] * _cameraDirection.z)
    / safeW;
  const ndcY = (projection[5] * _cameraDirection.y + projection[9] * _cameraDirection.z)
    / safeW;

  target.cameraDirection ||= new THREE.Vector3();
  target.ndc ||= new THREE.Vector2();
  target.cameraDirection.copy(_cameraDirection);
  target.ndc.set(ndcX, ndcY);
  target.incidenceRad = incidenceRad;
  target.incidenceDeg = incidenceRad / DEG2RAD;
  target.azimuthRad = azimuthRad;
  target.frontFacing = towardCameraFront > 0;
  target.projectionScaleX = Math.abs(projection[0]);
  target.projectionScaleY = Math.abs(projection[5]);
  return target;
}

function makeSunDiskOffsets(count) {
  const result = [[0, 0]];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 1; i < count; i += 1) {
    const radius = Math.sqrt((i - 0.5) / Math.max(1, count - 0.5));
    const angle = i * goldenAngle;
    result.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return result;
}

export class SpectralLensFlarePipeline {
  constructor(renderer, options = {}) {
    if (!renderer?.isWebGPURenderer) {
      throw new TypeError("SpectralLensFlarePipeline requires THREE.WebGPURenderer.");
    }
    if (!options.profile?.textureA || !options.profile?.textureB) {
      throw new Error(
        "SpectralLensFlarePipeline requires a loaded flare profile. "
        + "Call loadHeliarTronnierFlareProfile() first.",
      );
    }

    this.renderer = renderer;
    this.profile = options.profile;
    this.ownsProfile = options.ownsProfile === true;
    this.lens = options.lens || HELIAR_TRONNIER_100MM;
    this.settings = {
      ...SPECTRAL_FLARE_DEFAULTS,
      ...options,
    };
    delete this.settings.profile;
    delete this.settings.lens;
    delete this.settings.ownsProfile;
    this.settings.ghostRadianceScale = Math.max(
      0,
      finite(
        this.settings.ghostRadianceScale,
        SPECTRAL_FLARE_DEFAULTS.ghostRadianceScale,
      ),
    );

    this.camera = options.camera || null;
    this.sun = options.sun || null;
    this.visibilityProvider = options.visibilityProvider || null;
    this.source = null;
    this.size = { width: 1, height: 1 };
    this._rendererState = {};
    this._sunSource = resolveSunSource(this.sun || {}, {});
    this._projection = {};
    this._visibilityInitialized = false;
    this._visibilityCurrent = null;

    this.ctx = {
      sourceRadiance: uniform(1),
      sourceColor: uniform(new THREE.Color(1, 0.965, 0.89)),
      totalStrength: uniform(this.settings.enabled ? this.settings.strength : 0),
      ghostStrength: uniform(this.settings.ghostStrength),
      ghostRadianceScale: uniform(Math.max(
        0,
        finite(this.settings.ghostRadianceScale, SPECTRAL_FLARE_DEFAULTS.ghostRadianceScale),
      )),
      diffractionStrength: uniform(this.settings.diffractionStrength),
      glareStrength: uniform(this.settings.glareStrength),
      veilingStrength: uniform(this.settings.veilingStrength),
      diffractionEnergyScale: uniform(1),
      apertureRadiusMm: uniform(this.lens.focalLengthMm / (2 * this.settings.fNumber)),
      apertureBlades: uniform(this.settings.apertureBlades),
      apertureRoundness: uniform(this.settings.apertureRoundness),
      apertureRotation: uniform(this.settings.apertureRotation),
      spikeHarmonic: uniform(apertureSpikeHarmonic(this.settings.apertureBlades)),
      housingClip: uniform(this.settings.housingClip),
      angleIndex: uniform(0, "uint"),
      angleMix: uniform(0),
      sunCosPhi: uniform(1),
      sunSinPhi: uniform(0),
      sunSampleWeight: uniform(1),
      sunNdc: uniform(new THREE.Vector2()),
      sunUv: uniform(new THREE.Vector2(0.5, 0.5)),
      sunDiskUv: uniform(new THREE.Vector2(0.001, 0.001)),
      sensorToNdc: uniform(new THREE.Vector2(1, 1)),
      sunRadiusInPsfUv: uniform(0),
      psfHalfSizeNdc: uniform(new THREE.Vector2(0.05, 0.05)),
      aspect: uniform(1),
      axial: uniform(1),
      externalVisibility: uniform(1),
      hoodAcceptance: uniform(1),
      useDepth: uniform(0),
      reversedDepth: uniform(renderer.reversedDepthBuffer ? 1 : 0),
      visibilityDt: uniform(1 / 60),
      sharpVisibilitySeconds: uniform(this.settings.sharpVisibilitySeconds),
      veilVisibilitySeconds: uniform(this.settings.veilVisibilitySeconds),
    };

    this.rtGhost = makeTarget(1, 1);
    this.rtDiffraction = makeTarget(1, 1);
    this.rtVeil = makeTarget(1, 1);
    this.rtVisibilityRaw = makeTarget(1, 1, {
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.rtVisibilityA = makeTarget(1, 1);
    this.rtVisibilityB = makeTarget(1, 1);

    this._placeholderDepth = new THREE.DepthTexture(1, 1);
    this._placeholderDepth.minFilter = THREE.NearestFilter;
    this._placeholderDepth.magFilter = THREE.NearestFilter;
    this._depthNode = texture(this._placeholderDepth);
    this._sourceNode = texture(this._placeholderDepth, screenUV);
    this._visibilityNode = texture(this.rtVisibilityA.texture, vec2(0.5));

    this._ghostWeightsTexture = spectralWeightsTexture(
      this.profile.spectralRgbWeights,
      "PowerShot ghost spectral weights",
    );
    this._diffractionWeights = makeSpectralRgbWeights(DIFFRACTION_WAVELENGTHS_NM);
    this._psf = createDiffractionPsfTexture({
      size: this.settings.psfSize,
      blades: this.settings.apertureBlades,
      roundness: this.settings.apertureRoundness,
      rotation: this.settings.apertureRotation,
    });
    this._psfNode = texture(this._psf.texture);

    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    this.quadMesh = new THREE.Mesh(makeFullscreenGeometry(), null);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);

    this.ghostScene = new THREE.Scene();
    this.ghostMesh = new THREE.Mesh(
      makeGhostGridGeometry(
        this.profile.gridSize,
        this.profile.pathCount * this.profile.wavelengthCount,
      ),
      null,
    );
    this.ghostMesh.frustumCulled = false;
    this.ghostScene.add(this.ghostMesh);

    this.diffractionScene = new THREE.Scene();
    this.diffractionMesh = new THREE.Mesh(makeFullscreenGeometry(), null);
    this.diffractionMesh.frustumCulled = false;
    this.diffractionScene.add(this.diffractionMesh);

    this._buildMaterials();
    this.setAperture({
      fNumber: this.settings.fNumber,
      blades: this.settings.apertureBlades,
      roundness: this.settings.apertureRoundness,
      rotation: this.settings.apertureRotation,
    });
    this.setSize(1, 1);
  }

  _buildMaterials() {
    this._buildVisibilityMaterials();
    this._buildGhostMaterial();
    this._buildDiffractionMaterial();
    this._buildVeilMaterial();
    this._buildCompositeMaterial();
  }

  _buildVisibilityMaterials() {
    let diskVisibility = float(0);
    for (const [ox, oy] of VISIBILITY_SAMPLES) {
      const sampleUv = this.ctx.sunUv.add(this.ctx.sunDiskUv.mul(vec2(ox, oy)));
      const inside = step(0, sampleUv.x)
        .mul(step(sampleUv.x, 1))
        .mul(step(0, sampleUv.y))
        .mul(step(sampleUv.y, 1));
      const depth = this._depthNode.sample(sampleUv).r;
      const normalSky = step(0.99999, depth);
      const reversedSky = float(1).sub(step(0.00001, depth));
      const sky = mix(normalSky, reversedSky, this.ctx.reversedDepth);
      const depthVisible = mix(1, sky, inside.mul(this.ctx.useDepth));
      diskVisibility = diskVisibility.add(depthVisible);
    }
    diskVisibility = diskVisibility.div(VISIBILITY_SAMPLES.length)
      .mul(this.ctx.externalVisibility)
      .mul(this.ctx.hoodAcceptance);
    this.visibilityRawMaterial = makeNodeMaterial(vec4(diskVisibility, 0, 0, 1));

    const raw = texture(this.rtVisibilityRaw.texture, vec2(0.5)).r;
    const makeSmoothMaterial = (previousTarget) => {
      const previous = texture(previousTarget.texture, vec2(0.5));
      const sharpMix = float(1).sub(exp(
        this.ctx.visibilityDt.negate().div(max(this.ctx.sharpVisibilitySeconds, 1e-4)),
      ));
      const veilMix = float(1).sub(exp(
        this.ctx.visibilityDt.negate().div(max(this.ctx.veilVisibilitySeconds, 1e-4)),
      ));
      return makeNodeMaterial(vec4(
        mix(previous.r, raw, sharpMix),
        mix(previous.g, raw, veilMix),
        raw,
        1,
      ));
    };
    this.visibilitySmoothA = makeSmoothMaterial(this.rtVisibilityB);
    this.visibilitySmoothB = makeSmoothMaterial(this.rtVisibilityA);
  }

  _buildGhostMaterial() {
    const wavelengthCount = uint(this.profile.wavelengthCount);
    const angleCount = uint(this.profile.angleCount);
    const gridVertexCount = uint(this.profile.gridVertexCount);
    const atlasWidth = uint(this.profile.atlasWidth);
    const instance = uint(instanceIndex);
    const wavelengthIndex = mod(instance, wavelengthCount);
    const pathIndex = instance.div(wavelengthCount);
    const vertex = uint(vertexIndex);
    const recordFor = (angleIndex) => pathIndex
      .mul(wavelengthCount)
      .add(wavelengthIndex)
      .mul(angleCount)
      .add(angleIndex)
      .mul(gridVertexCount)
      .add(vertex);
    const atlasLoad = (atlas, record) => textureLoad(
      atlas,
      ivec2(int(mod(record, atlasWidth)), int(record.div(atlasWidth))),
    );

    const record0 = recordFor(this.ctx.angleIndex);
    const record1 = recordFor(min(this.ctx.angleIndex.add(uint(1)), angleCount.sub(uint(1))));
    const transferA = mix(
      atlasLoad(this.profile.textureA, record0),
      atlasLoad(this.profile.textureA, record1),
      this.ctx.angleMix,
    ).toVar("flareTransferA");
    const transferB = mix(
      atlasLoad(this.profile.textureB, record0),
      atlasLoad(this.profile.textureB, record1),
      this.ctx.angleMix,
    ).toVar("flareTransferB");

    const sensorPosition = vec2(
      transferA.x.mul(this.ctx.sunCosPhi).sub(transferA.y.mul(this.ctx.sunSinPhi)),
      transferA.x.mul(this.ctx.sunSinPhi).add(transferA.y.mul(this.ctx.sunCosPhi)),
    ).mul(this.ctx.sensorToNdc);
    // The aperture is fixed to the camera sensor. Counter-rotation prevents an
    // iris polygon from turning to face the source as its azimuth changes.
    const aperturePosition = vec2(
      transferA.z.mul(this.ctx.sunCosPhi).add(transferA.w.mul(this.ctx.sunSinPhi)),
      transferA.w.mul(this.ctx.sunCosPhi).sub(transferA.z.mul(this.ctx.sunSinPhi)),
    );
    const vAperture = varying(aperturePosition, "vFlareAperture");
    const vRelativeRadius = varying(transferB.y, "vFlareRelativeRadius");
    const vEnergy = varying(
      exp2(transferB.x.add(transferB.z)),
      "vFlareEnergy",
    );
    const vValid = varying(transferB.w, "vFlareValid");
    const vSpectralWeight = varying(
      textureLoad(this._ghostWeightsTexture, ivec2(int(wavelengthIndex), 0)).rgb,
      "vFlareSpectralWeight",
    );

    const aperture = vAperture.div(max(this.ctx.apertureRadiusMm, 1e-5));
    const apertureAngle = atan(aperture.y, aperture.x).sub(this.ctx.apertureRotation);
    const sector = float(Math.PI * 2).div(max(this.ctx.apertureBlades, 3));
    const localAngle = mod(apertureAngle.add(sector.mul(0.5)).add(Math.PI * 8), sector)
      .sub(sector.mul(0.5));
    const polygonBoundary = cos(float(Math.PI).div(max(this.ctx.apertureBlades, 3)))
      .div(max(cos(localAngle), 1e-4));
    const boundary = mix(
      polygonBoundary,
      1,
      this.ctx.apertureRoundness.clamp(0, 1),
    );
    const apertureEdge = aperture.length().sub(boundary);
    const apertureAa = max(fwidth(apertureEdge), 1e-5);
    const apertureMask = float(1).sub(smoothstep(
      apertureAa.negate(),
      apertureAa,
      apertureEdge,
    ));
    const housingEdge = vRelativeRadius.sub(this.ctx.housingClip);
    const housingAa = max(fwidth(housingEdge), 1e-5);
    const housingMask = float(1).sub(smoothstep(
      housingAa.negate(),
      housingAa,
      housingEdge,
    ));
    // Atlas-invalid vertices carry an extrapolated boundary transform. Treat
    // the interpolated validity as sub-cell pupil coverage instead of cutting
    // a huge triangle against an off-screen sentinel position.
    const validMask = smoothstep(0.02, 0.98, vValid);
    const visibility = this._visibilityNode.r;
    const energy = vEnergy
      .mul(validMask)
      .mul(apertureMask)
      .mul(housingMask)
      .mul(visibility)
      .mul(this.ctx.sourceRadiance)
      .mul(this.ctx.totalStrength)
      .mul(this.ctx.ghostStrength)
      .mul(this.ctx.ghostRadianceScale)
      .mul(this.ctx.sunSampleWeight);
    const color = vSpectralWeight.mul(this.ctx.sourceColor).mul(energy);
    this.ghostMaterial = makeNodeMaterial(vec4(color, 0), {
      positionNode: vec3(sensorPosition, 0),
      blending: true,
    });
    this.ghostMesh.material = this.ghostMaterial;
  }

  _buildDiffractionMaterial() {
    const positionNode = vec3(
      this.ctx.sunNdc.add(positionGeometry.xy.mul(this.ctx.psfHalfSizeNdc)),
      0,
    );
    let spectral = vec3(0);
    const center = uv().sub(0.5);
    const solarSamples = makeSunDiskOffsets(13);
    for (let i = 0; i < DIFFRACTION_WAVELENGTHS_NM.length; i += 1) {
      const wavelengthNm = DIFFRACTION_WAVELENGTHS_NM[i];
      const scale = REFERENCE_DIFFRACTION_NM / wavelengthNm;
      const energyCorrection = scale * scale;
      let psf = float(0);
      for (const [ox, oy] of solarSamples) {
        const sampleUv = center
          .sub(vec2(ox, oy).mul(this.ctx.sunRadiusInPsfUv))
          .mul(scale)
          .add(0.5);
        const inside = step(0, sampleUv.x)
          .mul(step(sampleUv.x, 1))
          .mul(step(0, sampleUv.y))
          .mul(step(sampleUv.y, 1));
        psf = psf.add(this._psfNode.sample(sampleUv).r.mul(inside));
      }
      psf = psf
        .div(solarSamples.length)
        .mul(energyCorrection * this._psf.size * this._psf.size);
      spectral = spectral.add(vec3(...this._diffractionWeights[i]).mul(psf));
    }
    const visibility = pow(max(this._visibilityNode.r, 0), 1.5);
    const color = max(spectral, vec3(0))
      .mul(this.ctx.sourceColor)
      .mul(this.ctx.sourceRadiance)
      .mul(this.ctx.totalStrength)
      .mul(this.ctx.diffractionStrength)
      .mul(this.ctx.diffractionEnergyScale)
      .mul(visibility);
    this.diffractionMaterial = makeNodeMaterial(vec4(color, 0), { positionNode });
    this.diffractionMesh.material = this.diffractionMaterial;
  }

  _buildVeilMaterial() {
    const delta = screenUV.sub(this.ctx.sunUv).mul(vec2(this.ctx.aspect, 1));
    const radius = delta.length();
    const lobe = (amplitude, scale, exponent) => float(amplitude).div(
      pow(float(1).add(pow(radius.div(scale), 2)), exponent),
    );
    const directional = exp(abs(delta.x).mul(-1.6))
      .mul(exp(abs(delta.y).mul(-0.55)))
      .mul(0.025);
    const axialWash = pow(max(this.ctx.axial, 0), 8).mul(0.018);
    const glare = lobe(0.32, 0.055, 1.22)
      .add(lobe(0.16, 0.28, 1.08))
      .add(lobe(0.055, 1.15, 0.92))
      .add(directional)
      .add(axialWash);
    const luminance = this.ctx.sourceColor.dot(vec3(0.2126, 0.7152, 0.0722));
    const wideColor = mix(this.ctx.sourceColor, vec3(luminance), 0.62);
    const color = mix(this.ctx.sourceColor, wideColor, smoothstep(0.08, 0.75, radius))
      .mul(glare)
      .mul(this._visibilityNode.g)
      .mul(this.ctx.sourceRadiance)
      .mul(this.ctx.totalStrength)
      .mul(this.ctx.veilingStrength);
    this.veilMaterial = makeNodeMaterial(vec4(color, 0));
  }

  _buildCompositeMaterial() {
    const source = this._sourceNode;
    const ghost = max(texture(this.rtGhost.texture, screenUV).rgb, vec3(0));
    const diffraction = max(texture(this.rtDiffraction.texture, screenUV).rgb, vec3(0));
    const veil = max(texture(this.rtVeil.texture, screenUV).rgb, vec3(0));

    // Source glare: the bright scatter halo hugging the sun itself, from
    // wide-angle surface, coating and sensor-stack scatter. It is much tighter
    // than the veil, so it is evaluated analytically here at full resolution
    // instead of passing through the eighth-resolution veil target.
    const delta = screenUV.sub(this.ctx.sunUv).mul(vec2(this.ctx.aspect, 1));
    const radius = delta.length();
    const lobe = (amplitude, scale, exponent) => float(amplitude).div(
      pow(float(1).add(pow(radius.div(scale), 2)), exponent),
    );
    const halo = lobe(2.2, 0.016, 1.8).add(lobe(0.32, 0.085, 1.4));

    // Blade streaks: the far-field continuation of the aperture diffraction
    // spikes past the bounded PSF quad, fixed to the sensor via the aperture
    // rotation. screenUV is Y-down while the aperture mask is Y-up, hence the
    // negation. An iris edge diffracts an optically razor-thin streak along
    // its normal; the sensor records that streak convolved with the projected
    // solar disc, so a visible ray keeps a constant linear width of about one
    // solar diameter while its ~1/r² knife-edge peak decays. Against the sky
    // it therefore tapers to a point rather than widening into a wedge.
    const spikeAngle = atan(delta.y.negate(), delta.x).sub(this.ctx.apertureRotation);
    // sin(m·θ)/m ≈ angular offset from the nearest spike axis; times radius
    // gives the perpendicular linear distance to that axis.
    const spikeOffset = radius
      .mul(abs(sin(spikeAngle.mul(this.ctx.spikeHarmonic))))
      .div(this.ctx.spikeHarmonic);
    const streakWidth = max(this.ctx.sunDiskUv.y.mul(1.4), 1e-4);
    const streakSection = exp(spikeOffset.div(streakWidth).pow(2).negate());
    // Blade seams are never machine-perfect, so spike strength varies a
    // little around the iris instead of repeating with mechanical symmetry.
    const seamVariation = float(0.8).add(sin(spikeAngle.mul(2).add(1.3)).mul(0.2));
    // Longer wavelengths diffract at wider angles, so the tips trend warm
    // while the base keeps the source colour.
    const streakTint = mix(vec3(1), vec3(1.12, 0.94, 0.72), smoothstep(0.03, 0.18, radius));
    // The inner fade hands the near field back to the measured FFT starburst
    // instead of double-counting its energy around the solar disc.
    const streak = lobe(1.2, 0.02, 1.1)
      .mul(streakSection)
      .mul(seamVariation)
      .mul(smoothstep(0.004, 0.012, radius));

    // Halo response sits between the starburst (visibility^1.5) and the slow
    // veil: it dims quickly behind an occluder but keeps some forward scatter.
    // The streaks are diffraction, so they follow the starburst curve.
    const glareVisibility = pow(max(this._visibilityNode.r, 0), 1.25);
    const streakVisibility = pow(max(this._visibilityNode.r, 0), 1.5);
    const glare = this.ctx.sourceColor
      .mul(streakTint.mul(streak).mul(streakVisibility).add(halo.mul(glareVisibility)))
      .mul(this.ctx.sourceRadiance)
      .mul(this.ctx.totalStrength)
      .mul(this.ctx.glareStrength);

    this.compositeMaterial = makeNodeMaterial(vec4(
      source.rgb.add(ghost).add(diffraction).add(glare).add(veil),
      source.a,
    ));
  }

  setCamera(camera) {
    this.camera = camera || null;
    return this;
  }

  setSun(sun) {
    this.sun = sun || null;
    return this;
  }

  setVisibilityProvider(provider) {
    if (provider !== null && provider !== undefined && typeof provider !== "function") {
      throw new TypeError("visibilityProvider must be a function or null.");
    }
    this.visibilityProvider = provider || null;
    return this;
  }

  setEnabled(enabled) {
    this.settings.enabled = enabled === true;
    this.ctx.totalStrength.value = this.settings.enabled ? this.settings.strength : 0;
    return this;
  }

  setStrength({
    strength = this.settings.strength,
    ghosts = this.settings.ghostStrength,
    ghostRadianceScale = this.settings.ghostRadianceScale,
    diffraction = this.settings.diffractionStrength,
    glare = this.settings.glareStrength,
    veiling = this.settings.veilingStrength,
  } = {}) {
    this.settings.strength = Math.max(0, finite(strength, this.settings.strength));
    this.settings.ghostStrength = Math.max(0, finite(ghosts, this.settings.ghostStrength));
    this.settings.ghostRadianceScale = Math.max(
      0,
      finite(ghostRadianceScale, this.settings.ghostRadianceScale),
    );
    this.settings.diffractionStrength = Math.max(
      0,
      finite(diffraction, this.settings.diffractionStrength),
    );
    this.settings.glareStrength = Math.max(0, finite(glare, this.settings.glareStrength));
    this.settings.veilingStrength = Math.max(0, finite(veiling, this.settings.veilingStrength));
    this.ctx.totalStrength.value = this.settings.enabled ? this.settings.strength : 0;
    this.ctx.ghostStrength.value = this.settings.ghostStrength;
    this.ctx.ghostRadianceScale.value = this.settings.ghostRadianceScale;
    this.ctx.diffractionStrength.value = this.settings.diffractionStrength;
    this.ctx.glareStrength.value = this.settings.glareStrength;
    this.ctx.veilingStrength.value = this.settings.veilingStrength;
    return this;
  }

  setAperture({
    fNumber = this.settings.fNumber,
    blades = this.settings.apertureBlades,
    roundness = this.settings.apertureRoundness,
    rotation = this.settings.apertureRotation,
  } = {}) {
    const nextFNumber = clampNumber(finitePositive(fNumber, this.settings.fNumber), 1, 64);
    const nextBlades = clampNumber(Math.round(finite(blades, this.settings.apertureBlades)), 3, 32);
    const nextRoundness = clampNumber(finite(roundness, this.settings.apertureRoundness), 0, 1);
    const nextRotation = finite(rotation, this.settings.apertureRotation);
    const psfChanged = nextBlades !== this.settings.apertureBlades
      || Math.abs(nextRoundness - this.settings.apertureRoundness) > 1e-8
      || Math.abs(nextRotation - this.settings.apertureRotation) > 1e-8;

    this.settings.fNumber = nextFNumber;
    this.settings.apertureBlades = nextBlades;
    this.settings.apertureRoundness = nextRoundness;
    this.settings.apertureRotation = nextRotation;
    this.ctx.apertureRadiusMm.value = this.lens.focalLengthMm / (2 * nextFNumber);
    this.ctx.apertureBlades.value = nextBlades;
    this.ctx.apertureRoundness.value = nextRoundness;
    this.ctx.apertureRotation.value = nextRotation;
    this.ctx.spikeHarmonic.value = apertureSpikeHarmonic(nextBlades);
    this.ctx.diffractionEnergyScale.value = diffractionPeakScale(
      nextFNumber,
      this.profile.designFNumber,
    );

    if (psfChanged) {
      releaseDiffractionPsf(this._psf);
      this._psf = createDiffractionPsfTexture({
        size: this.settings.psfSize,
        blades: nextBlades,
        roundness: nextRoundness,
        rotation: nextRotation,
      });
      this._psfNode.value = this._psf.texture;
    }
    this._updateDiffractionExtent();
    return this;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.size.width === w && this.size.height === h) return this;
    this.size = { width: w, height: h };
    this.rtGhost.setSize(
      Math.max(1, Math.round(w * clampNumber(this.settings.ghostResolutionScale, 0.125, 1))),
      Math.max(1, Math.round(h * clampNumber(this.settings.ghostResolutionScale, 0.125, 1))),
    );
    this.rtDiffraction.setSize(w, h);
    this.rtVeil.setSize(
      Math.max(1, Math.round(w * clampNumber(this.settings.veilResolutionScale, 0.03125, 0.5))),
      Math.max(1, Math.round(h * clampNumber(this.settings.veilResolutionScale, 0.03125, 0.5))),
    );
    this.ctx.aspect.value = w / h;
    this._updateDiffractionExtent();
    return this;
  }

  _updateDiffractionExtent() {
    const lambdaMm = REFERENCE_DIFFRACTION_NM * 1e-6;
    // The pupil-plane FFT reaches Nyquist at ±λ·N·fill·f#/2 on the sensor
    // (the aperture spans fill·N samples, so one frequency bin is
    // λ·f#·fill mm and N bins cover twice the half extent). The quad must
    // span exactly this window or the pattern renders at the wrong scale.
    this._psfHalfExtentMm = 0.5
      * lambdaMm
      * this._psf.size
      * this._psf.apertureFill
      * this.settings.fNumber
      * this.settings.diffractionScale;
  }

  _updateSunState(camera, sun, options) {
    this._sunSource = resolveSunSource(sun || this.sun || {}, this._sunSource);
    this._projection = projectSunDirection(
      camera,
      this._sunSource.direction,
      this._projection,
    );

    const incidenceDeg = this._projection.incidenceDeg;
    const maxAtlasDeg = this.profile.maxIncidenceDeg;
    const hoodAngleDeg = Math.max(maxAtlasDeg + 0.001, this.settings.hoodAngleDeg);
    const hood = this._projection.frontFacing
      ? 1 - smoothstepNumber(maxAtlasDeg, hoodAngleDeg, incidenceDeg)
      : 0;
    const atlasCoordinate = clampNumber(
      (incidenceDeg / maxAtlasDeg) * (this.profile.angleCount - 1),
      0,
      this.profile.angleCount - 1,
    );
    const angleIndex = Math.min(
      this.profile.angleCount - 2,
      Math.max(0, Math.floor(atlasCoordinate)),
    );

    const angularDiameterDeg = finitePositive(
      options.angularDiameterDeg,
      this._sunSource.angularDiameterDeg || this.settings.sourceAngularDiameterDeg,
    );
    const angularRadius = angularDiameterDeg * 0.5 * DEG2RAD;
    const diskNdcX = this._projection.projectionScaleX * Math.tan(angularRadius);
    const diskNdcY = this._projection.projectionScaleY * Math.tan(angularRadius);
    const sunUvX = this._projection.ndc.x * 0.5 + 0.5;
    // screenUV follows the render-target convention used by WebGPU (Y down),
    // while NDC is Y up.
    const sunUvY = 0.5 - this._projection.ndc.y * 0.5;
    const overlapsViewport = sunUvX + diskNdcX * 0.5 >= 0
      && sunUvX - diskNdcX * 0.5 <= 1
      && sunUvY + diskNdcY * 0.5 >= 0
      && sunUvY - diskNdcY * 0.5 <= 1;

    let externalVisibility = finite(options.visibility, 1);
    const provider = options.visibilityProvider || this.visibilityProvider;
    if (typeof provider === "function") {
      const supplied = provider({
        camera,
        sun: sun || this.sun,
        direction: this._sunSource.direction,
        incidenceDeg,
        ndc: this._projection.ndc,
      });
      if (Number.isFinite(supplied)) externalVisibility *= supplied;
    }

    this.ctx.sourceRadiance.value = finiteNonNegative(
      options.sourceRadiance,
      this._sunSource.radiance,
    );
    this.ctx.sourceColor.value.copy(this._sunSource.color);
    this.ctx.angleIndex.value = angleIndex;
    this.ctx.angleMix.value = atlasCoordinate - angleIndex;
    this.ctx.sunCosPhi.value = Math.cos(this._projection.azimuthRad);
    this.ctx.sunSinPhi.value = Math.sin(this._projection.azimuthRad);
    this.ctx.sunNdc.value.copy(this._projection.ndc);
    this.ctx.sunUv.value.set(sunUvX, sunUvY);
    this.ctx.sunDiskUv.value.set(diskNdcX * 0.5, diskNdcY * 0.5);
    this.ctx.sensorToNdc.value.set(
      this._projection.projectionScaleX * (this.lens.sensorWidthMm * 0.5)
        / this.lens.focalLengthMm,
      this._projection.projectionScaleY * (this.lens.sensorHeightMm * 0.5)
        / this.lens.focalLengthMm,
    );
    const psfHalfExtentMm = Math.max(1e-8, this._psfHalfExtentMm);
    this.ctx.psfHalfSizeNdc.value.set(
      this._projection.projectionScaleX * psfHalfExtentMm / this.lens.focalLengthMm,
      this._projection.projectionScaleY * psfHalfExtentMm / this.lens.focalLengthMm,
    );
    const solarImageRadiusMm = this.lens.focalLengthMm * Math.tan(angularRadius);
    this.ctx.sunRadiusInPsfUv.value = solarImageRadiusMm / (2 * psfHalfExtentMm);
    this.ctx.axial.value = Math.max(0, -this._projection.cameraDirection.z);
    this.ctx.externalVisibility.value = clampNumber(externalVisibility, 0, 1);
    this.ctx.hoodAcceptance.value = hood;
    this.ctx.useDepth.value = options.depthTexture && overlapsViewport ? 1 : 0;
    this.ctx.reversedDepth.value = this.renderer.reversedDepthBuffer ? 1 : 0;
    this.ctx.visibilityDt.value = this._visibilityInitialized
      ? clampNumber(finite(options.dt, 1 / 60), 1 / 1000, 0.25)
      : 2;

    return {
      hood,
      angularRadius,
      cameraDirection: this._projection.cameraDirection,
    };
  }

  _setGhostSample(direction, sampleWeight) {
    const front = Math.max(1e-8, -direction.z);
    const incidence = Math.acos(clampNumber(front, -1, 1));
    const incidenceDeg = incidence / DEG2RAD;
    const atlasCoordinate = clampNumber(
      (incidenceDeg / this.profile.maxIncidenceDeg) * (this.profile.angleCount - 1),
      0,
      this.profile.angleCount - 1,
    );
    const angleIndex = Math.min(
      this.profile.angleCount - 2,
      Math.max(0, Math.floor(atlasCoordinate)),
    );
    const phi = Math.atan2(direction.y, direction.x);
    this.ctx.angleIndex.value = angleIndex;
    this.ctx.angleMix.value = atlasCoordinate - angleIndex;
    this.ctx.sunCosPhi.value = Math.cos(phi);
    this.ctx.sunSinPhi.value = Math.sin(phi);
    this.ctx.sunSampleWeight.value = sampleWeight;
  }

  _renderVisibility(depthTexture) {
    this._depthNode.value = depthTexture || this._placeholderDepth;
    const r = this.renderer;
    if (!this._visibilityInitialized) {
      r.setRenderTarget(this.rtVisibilityA);
      r.clear();
      r.setRenderTarget(this.rtVisibilityB);
      r.clear();
    }
    this.quadMesh.material = this.visibilityRawMaterial;
    r.setRenderTarget(this.rtVisibilityRaw);
    r.clear();
    r.render(this.quadScene, this.quadCamera);

    const writeA = this._visibilityCurrent !== this.rtVisibilityA;
    const target = writeA ? this.rtVisibilityA : this.rtVisibilityB;
    this.quadMesh.material = writeA ? this.visibilitySmoothA : this.visibilitySmoothB;
    r.setRenderTarget(target);
    r.clear();
    r.render(this.quadScene, this.quadCamera);
    this._visibilityCurrent = target;
    this._visibilityNode.value = target.texture;
    this._visibilityInitialized = true;
  }

  _renderGhosts(cameraDirection, angularRadius) {
    const r = this.renderer;
    r.setRenderTarget(this.rtGhost);
    r.clear();
    if (this.ctx.hoodAcceptance.value <= 0 || this.ctx.totalStrength.value <= 0) return;

    _tangentX.set(cameraDirection.z, 0, -cameraDirection.x);
    if (_tangentX.lengthSq() < 1e-10) _tangentX.copy(_fallbackUp);
    _tangentX.normalize();
    _tangentY.crossVectors(cameraDirection, _tangentX).normalize();
    const sampleCount = clampNumber(Math.round(this.settings.sunSamples), 1, 13);
    const offsets = makeSunDiskOffsets(sampleCount);
    const tangentScale = Math.tan(angularRadius);
    this.ghostMesh.material = this.ghostMaterial;
    for (const [ox, oy] of offsets) {
      _sampleDirection.copy(cameraDirection)
        .addScaledVector(_tangentX, ox * tangentScale)
        .addScaledVector(_tangentY, oy * tangentScale)
        .normalize();
      this._setGhostSample(_sampleDirection, 1 / sampleCount);
      r.render(this.ghostScene, this.quadCamera);
    }
  }

  _renderDiffraction() {
    const r = this.renderer;
    r.setRenderTarget(this.rtDiffraction);
    r.clear();
    if (this.ctx.hoodAcceptance.value <= 0 || this.ctx.totalStrength.value <= 0) return;
    r.render(this.diffractionScene, this.quadCamera);
  }

  _renderVeil() {
    const r = this.renderer;
    this.quadMesh.material = this.veilMaterial;
    r.setRenderTarget(this.rtVeil);
    r.clear();
    r.render(this.quadScene, this.quadCamera);
  }

  renderTexture(inputTexture, frame = 0, options = {}) {
    if (!inputTexture) return false;
    const camera = options.camera || this.camera;
    if (!camera?.isPerspectiveCamera) {
      throw new Error(
        "SpectralLensFlarePipeline.renderTexture() requires a PerspectiveCamera.",
      );
    }
    const sun = options.sun || this.sun;
    if (!sun) {
      throw new Error("SpectralLensFlarePipeline.renderTexture() requires a sun source.");
    }

    const fallback = rendererSize(this.renderer);
    const width = Math.max(1, Math.round(options.width || this.size.width || fallback.width));
    const height = Math.max(1, Math.round(options.height || this.size.height || fallback.height));
    this.setSize(width, height);
    this.source = inputTexture;
    this._sourceNode.value = inputTexture;
    const sunState = this._updateSunState(camera, sun, options);

    const renderer = this.renderer;
    THREE.RendererUtils.resetRendererState(renderer, this._rendererState);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;

    try {
      this._renderVisibility(options.depthTexture || null);
      this._renderGhosts(sunState.cameraDirection, sunState.angularRadius);
      this._renderDiffraction();
      this._renderVeil();

      this.quadMesh.material = this.compositeMaterial;
      renderer.setRenderTarget(options.outputTarget || null);
      renderer.render(this.quadScene, this.quadCamera);
      return true;
    } finally {
      THREE.RendererUtils.restoreRendererState(renderer, this._rendererState);
    }
  }

  render(frame = 0, options = {}) {
    return this.renderTexture(this.source, frame, options);
  }

  dispose() {
    this.visibilityRawMaterial.dispose();
    this.visibilitySmoothA.dispose();
    this.visibilitySmoothB.dispose();
    this.ghostMaterial.dispose();
    this.diffractionMaterial.dispose();
    this.veilMaterial.dispose();
    this.compositeMaterial.dispose();
    this.rtGhost.dispose();
    this.rtDiffraction.dispose();
    this.rtVeil.dispose();
    this.rtVisibilityRaw.dispose();
    this.rtVisibilityA.dispose();
    this.rtVisibilityB.dispose();
    this._placeholderDepth.dispose();
    this._ghostWeightsTexture.dispose();
    releaseDiffractionPsf(this._psf);
    this.quadMesh.geometry.dispose();
    this.ghostMesh.geometry.dispose();
    this.diffractionMesh.geometry.dispose();
    if (this.ownsProfile) {
      this.profile.textureA?.dispose?.();
      this.profile.textureB?.dispose?.();
    }
  }
}
