# WebGPU spectral sunlight flare

PowerShot's flare is a scene-linear camera-optics pass. It deliberately does not
use Three.js `Lensflare`, a chain of circles, RGB channel offsets, or bloom as a
substitute for all flare phenomena.

## What is simulated

The shipped `Tronnier Heliar 100 mm` profile contains:

- 16 strongest two-reflection ghost paths selected from 28 valid surface pairs.
- Three coating-aware transport wavelengths at 475, 550, and 650 nm.
- 21 source-incidence bins from 0° through 30°.
- A 13×13 entrance-pupil grid per path, wavelength, and incidence bin.
- Sensor position, aperture-plane position, housing radius, thin-film
  throughput, and finite-area pupil-to-sensor flux concentration.
- A seven-blade Fraunhofer PSF generated from an energy-normalized complex-pupil FFT.
- Five-wavelength diffraction integration at 430, 480, 530, 590, and 650 nm.
- Integration over the projected 0.533° solar disc: nine source directions for
  the ghost transport and thirteen taps inside the diffraction pattern. The
  disc radius is derived from the active lens focal length rather than a fixed
  blur kernel.
- A compact full-resolution source-glare response with a clipped white core,
  cool scatter halo, uneven short streaks, and a small offset cyan lobe. The
  aperture star remains in the FFT pass instead of being redrawn analytically.
- Fixed low-order pupil error, minute edge variation, and weak surface defects
  keep the lens signature stable while avoiding a mathematically perfect star.
- Three broad analytic veiling-glare lobes.

The shipped half-float transfer atlas is 2.6 MiB;
`npm run generate:flare-atlas:max` rebuilds the 9.84 MiB calibration-grade
version (24 paths × 31 angles × 17² grid), and `--paths/--angles/--grid`
override the tiers individually. Throughput and flux are
log2-encoded in the asset to retain the energy range of good anti-reflection
coatings, then decoded before additive HDR accumulation. Flux density is
computed from finite pupil-cell and mapped sensor-triangle areas rather than a
point derivative, so unresolved caustics cannot become single-vertex energy
spikes. Incomplete density control volumes are reconstructed from the nearest
fully supported pupil cell and renormalized to the traced pupil-area energy.
Invalid boundary rays retain a zero coverage flag but carry an extrapolated edge
transform, preventing clipped triangles from stretching across the frame.

Atlas sensor millimetres and diffraction extents are transformed through the
active perspective projection. For strict reproduction, make the camera field
of view match the profile's 100 mm focal length on a 36 × 24 mm gate. A
different perspective field of view remains angularly registered, but is a
virtual remapping rather than a claim that the prescription changed focal
length. Orthographic cameras are rejected.

## Correct pipeline order

```text
scene + sky in scene-linear HDR
→ solar visibility
→ spectral internal-reflection ghosts
→ spectral aperture diffraction
→ veiling glare
→ sensor bloom / halation
→ exposure
→ tone mapping or film print response
→ output colour conversion
```

Do not add the flare after tone mapping. Display white no longer contains the
radiometric range needed to drive a credible optical response.

To feed the result into the digital PowerShot ISP:

```js
const scenePass = pass(scene, camera);
const optical = spectralFlarePass(scenePass, flare, {
  camera,
  sun,
  depthTexture: scenePass.getTexture("depth"),
});

powershot.setInputEncoding("linear");
renderPipeline.outputNode = powerShotPass(optical, powershot);
```

Film follows the same ordering, but `FilmPipeline` remains the only display
transform and receives linear input.

## Sun contract

`sun` can be a `THREE.DirectionalLight` or a descriptor:

```js
const sun = {
  // World-space direction from the camera toward the source.
  direction: new THREE.Vector3(0.2, 0.35, -1).normalize(),
  color: new THREE.Color(1.0, 0.94, 0.82),
  sourceRadiance: 4.0,
  angularDiameterDeg: 0.533,
};
```

For a directional light, PowerShot derives the source direction from
`light.position - light.target.position`. `sourceRadiance` is scene-relative
because Three.js applications do not share one absolute radiometric exposure
scale. Set `light.userData.spectralFlareRadiance` when its lighting intensity
and desired camera-source radiance use different calibrations.

On-screen visibility samples nine points over the finite solar disc against the
scene depth texture. Visibility is temporally smoothed, with a slower response
for broad veiling glare than for sharp ghosts. Screen depth cannot determine
whether an off-screen sun is hidden, so applications with large occluders should
provide a synchronous camera-to-sun test:

```js
flare.setVisibilityProvider(({ camera, direction }) => {
  return cameraToSunIsClear(camera.position, direction) ? 1 : 0;
});
```

## Main controls

```js
flare.setStrength({
  strength: 1,
  ghosts: 1,
  ghostRadianceScale: 20,
  diffraction: 1,
  glare: 1,
  veiling: 0.06,
});

flare.setAperture({
  fNumber: 8,
  blades: 7,
  roundness: 0.08,
  rotation: 0, // radians, fixed relative to the sensor
});
```

The flare remains active outside the frame until the lens hood acceptance curve
rejects it. `flare.settings.hoodAngleDeg` controls the fade beyond the atlas's
30° incidence limit. Ghosts render at half resolution by default; diffraction
keeps full pixel density inside a tightly bounded window around the PSF quad
and the veil renders at one-sixteenth resolution. The source-glare response is
evaluated in the composite, so it
costs no render target and stays stable at any resolution. Its response curve
sits between the starburst and the slow veil so the halo dims quickly behind an
occluder while keeping a little forward scatter. Set `ghostResolutionScale: 1`
at construction for calibration captures. Aperture, housing, and pupil-coverage
edges use derivative-based pixel coverage. The prefiltered diffraction FFT is
treated as a continuous energy density; scaled half-float storage retains its
faint tail, and f-stop changes preserve the expected inverse-square integrated
aperture energy while widening the pattern.

`ghostRadianceScale` calibrates the atlas' physical relative throughput to the
application's scene-relative HDR radiance convention. It does not alter path
positions, dispersion, aperture clipping, or the ranking of reflection paths.

## Accuracy boundary

The optical geometry is traced from a real historical prescription, and the
runtime atlas is deterministic. The coating is a physically evaluated
single-layer quarter-wave model. It is not a claim to reproduce a specific
commercial lens coating, sensor cover glass, dust pattern, or proprietary
camera response exactly. Match a particular lens by calibrating path strengths,
coating curves, veiling intensity, source radiance, and the downstream sensor
model against photographs from that lens.

The prescription is a classic public Tronnier Heliar design. The surface table
was digitized from OpenLensFlare's `heliar-tronnier.xml` sample
(BSD-2-Clause, © István Csoba), which follows the same historical design used
by Hullin et al. 2011. The atlas generator in
`tools/generate-spectral-flare-atlas.mjs` recomputes the shipped asset from the
human-readable prescription in `src/spectral-flare-profile.js`; no third-party
binary data ships with PowerShot.
