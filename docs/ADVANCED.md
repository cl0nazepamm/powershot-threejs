# PowerShot advanced guide

Fine-grained controls, linear/HDR input, `THREE.RenderPipeline` integration, real NIR input, and the repo layout. For basic per-mode usage see the [README](../README.md).

## Controls shared by every mode

- `setPreset(nameOrObject)` - the friendly preset entry point on every pipeline (`Pipeline`, `FilmPipeline`, `InfraredPipeline`, `NightshotPipeline`). Accepts a preset key string or a full preset object, returns the pipeline for chaining, and throws listing the valid keys on a typo. The classic function forms (`applyPreset(pipeline.ctx, preset)`, `applyFilmPreset`, `applyInfraredPreset`, `applyInfraredProfile`, `applyNightshotPreset`) remain fully supported and byte-identical in effect; note `setPreset` on `InfraredPipeline` applies the full *profile* (input mode, response calibration, halo shape, history reset), matching `applyInfraredProfile`.
- `render(texture, options?)` - the friendly per-frame call: sizes the pipeline to the first input frame if `setSize()` was never called, advances an internal frame counter, and (for `InfraredPipeline` / `NightshotPipeline`) measures wall-clock `dt` for the temporal loops. The legacy form `render(frameNumber)` — drawing the current source with an explicit frame — still works unchanged.
- `renderTexture(texture, frame, options)` - the deterministic expert call: you own the frame counter, `options.dt` (infrared/nightshot), and can pass `options.outputTarget` to render into a target instead of the canvas. Use this for reproducible output (e.g. A/B verification) — the friendly `render()` uses wall-clock time and is intentionally not deterministic.
- `ctx.power.value` - blends between source and effect.
- `setInputEncoding("linear")` - the source is a scene-linear HDR render target: input gain and the camera OETF are applied before the ISP, making it the imager (feed it with the renderer's tone mapping OFF). `FilmPipeline` takes the same flag (skips the sRGB decode; its own `exposure` is already in stops) — and for film, that linear deferred path is the intended setup: film fully replaces tonemap, so do not tone-map before it.
- `setInputExposure(stops)` - plate gain before the effect, taken in linear light whatever the source encoding is (an encoded image/video is decoded, gained, and re-encoded — an exact round trip at 0 stops), so the imager sees it as light and bloom, noise and highlight clip all respond to it. Available on **every** pipeline (`Pipeline`, `FilmPipeline`, `InfraredPipeline`, `NightshotPipeline`; NightShot forwards it to its sensor). It is separate from each mode's own trim — on film it stacks with the stock's `P.exposure` and survives `setPreset`, so one host control drives every mode. Uniform-only: safe to animate per frame, never dirties the graph.
- **The exposure contract**: scene linear light → `setInputExposure(stops)` → the imager (ISP / film response / phosphor) → `setOutputColorGrading`. Exposure decisions go before the response curve — grain, halation, bloom, noise and highlight roll-off all move with them; taste decisions (brightness/contrast) go after it. Think pre-LUT gain vs post-LUT trims in a grading suite.
- `setOutputColorGrading({ brightness, contrast })` - post-effect corrective grade on linear colour (`powershotLinearGrade`: brightness = photographic gain, ±1 ≈ ±2 stops; contrast = power pivoted on 18% grey). Applied after the ISP / film print / phosphor — not as input exposure. Same API on `FilmPipeline` / `InfraredPipeline` / `NightshotPipeline` (nightshot forwards to its camera ISP).

## Digicam

- `powershot.ctx.P.jpegStrength.value` - digital JPEG amount.
- `powershot.ctx.noiseScale.value` - global noise scale (shared with analog mode).

Shipped cameras: `cybershot` (Sony Cyber-shot DSC-W70), `powershot` (Canon PowerShot A520), `coolpix` (Nikon Coolpix L18), `exilim` (Casio Exilim EX-Z75), `ixus` (Canon IXUS 60 / SD600).

## Analog tape

- `powershot.ctx.P.analogStrength.value` - analog/VHS amount.
- `powershot.ctx.P.analogTrackingChoppiness.value` - tracking-wave character (`0` = legacy smooth wave, `1` = short stepped timing errors).

To keep the same on-screen scale while processing at a lower authentic analog resolution, keep your canvas CSS size fixed and pass the lower internal size to `setSize()`.

## Film emulation

**Film replaces the tonemap pipeline entirely.** Do not run ACES / AgX / renderer tone mapping (or any other display transform) before it — the negative→print H&D chain *is* the tone map. And do not chain it with other PowerShot modes: it is a complete negative-to-print system, not a grade you stack.

The intended input is your **linear deferred** (scene-linear HDR) render target with `film.setInputEncoding("linear")` so the sRGB decode is skipped, and `renderer.toneMapping = THREE.NoToneMapping` on the source pass.

Feeding a plain sRGB image or video also works (that is what the demo does) — skip `setInputEncoding` and the pipeline decodes sRGB itself.

Controls:

- `film.ctx.power.value` - blends between source and film render.
- `film.ctx.P.exposure.value` - stops at the film plane.
- `film.ctx.P.grainStrength.value` - grain amount.
- `film.ctx.P.halStrength.value` - halation amount.
- `film.ctx.P.negativeView.value` - set to `1` to inspect the negative.

Shipped stocks: `kodak_500t` (Vision3 500T → 2383 print), `kodak_200t` (Vision3 200T), `kodak_250d` (Vision3 250D), `kodak_50d` (Vision3 50D).

## White phosphor

- `infrared.ctx.power.value` - blends between source and infrared render.
- `infrared.ctx.P.exposure.value` - input amplification in stops.
- `infrared.ctx.P.localGain.value` - dark-region adaptation strength.
- `infrared.ctx.P.abcAttack.value` / `abcRecover` - temporal auto-brightness time constants (seconds); the whole image dims fast when a bright light enters frame and recovers slower after it leaves. Pass real `dt` into `renderTexture` for correct breathing.
- `infrared.ctx.P.glowStrength.value` - broad intensifier halo amount.
- `infrared.ctx.P.glowSaturate.value` - halo source clip; brighter sources saturate the halo core instead of growing its radius.
- `infrared.ctx.P.noiseAmount.value` - master monochrome sensor and phosphor noise.
- `infrared.setInputEncoding("linear")` - the "rgb" source is a linear HDR render target rather than sRGB-encoded (avoids a double decode).
- `infrared.setOutputEncoding("linear")` - emit linear output for a post stack that encodes at its own output stage.
- `infrared.setHaloDisc(true)` - flat disc halo profile instead of a gaussian.

The pipeline is internally sized for a tube-resolution look (~1280x960); larger canvases automatically scale the scintillation grain so sparkles stay ~one resolution element.

### Real NIR input

RGB images do not contain actual infrared reflectance, so the default path is an artistic pseudo-NIR approximation. When you have real IR source material:

- `infrared.setInputMode("nir")` - the source is a linear monochrome NIR or relative-photocathode-response signal in the red channel (e.g. a spectral renderer's NIR output); read raw, no decode, no RGB heuristic. Calibrate with `infrared.ctx.P.fluxScale.value` and start from the `white_phosphor_nir` preset. The input contract is a single-channel LINEAR texture with no tone mapping or sRGB encode. The included preset is visually calibrated, not an absolute electron-count model.
- `infrared.setNirBands(true)` - with `setInputMode("nir")`, the source is a three-band NIR render (see below) and the prepass collapses it through the photocathode band weights, so no separate collapse pass is needed. `NightshotPipeline.ir` takes the same call.
- `oculography` - neutral 640x480 active-NIR video-oculography: fixed gain, mild optical softness/noise and LED-reflection bloom, with image-intensifier tint, chicken-wire, scintillation, autogating, and persistence disabled.
- `infrared.setElectronModel({ electronsPerUnit: 1024 })` - opt into input-referred photoelectron shot noise. `electronsPerUnit` maps relative signal `1.0` to an expected count; the existing `ebi` value supplies the independently sampled dark background. Call `setElectronModel(false)` to restore the original path. It is disabled by default.

### NIR band from a raster render

`createNirBand()` (from `powershot-threejs/infrared`) produces that linear response with Three's ordinary raster lighting - no spectral renderer. It resolves once the Jakob-Hanika sRGB-to-reflectance LUT has loaded (`loadSpectralLut()`, about 0.9 MB, fetched on first use only).

- `band.reflectanceBands(material)` / `band.emissiveBands(material)` / `band.lightBands(light)` - three NIR band values (550-650, 650-800, 800-900 nm) for a material's colour, emission and a light. Write them into RGB for a render pass: Three multiplies material and emitter per band, keeping their spectral correlation.
- `band.colorBands(r, g, b)` - the bands of a plain linear RGB colour; `band.redEdge` - each band's share past the 700-740 nm red edge, where an authored NIR level takes over from the colour.
- `band.createRasterNodes({ size = 32 })` - per-texel conversion for node materials: a half-float RGB-to-bands 3D LUT with TSL helpers `reflectance(rgb)`, `emission(rgb)` and `tagged(rgb, nirAlbedo, flatBands)` (keeps a texture's variation under a material's `nirAlbedo`; a negative level means untagged). `dispose()` releases the LUT.
- `band.weights` - photocathode band weights; `dot(bands, weights)` collapses the lit bands to the relative response for `setInputMode("nir")`, as `setNirBands(true)` does in the tube.
- Material NIR truth: `userData.nirAlbedo` (0-1) wins; otherwise `classifyNir()` tags foliage, water, asphalt and skin from name and colour; otherwise the JH upsampler extrapolates the RGB spectrum past 720 nm.
- Light spectra follow `userData.emitterClass`: `incandescent` (Planck tail, `userData.colorTemp` K), `led` (no NIR), `sodium` (589 nm line), `ir` (850 nm illuminator, black in RGB).
- Spectral renderers can share the model: `photocathodeS()` / `buildPhotocathodeSampler()` define the NV band, `createJhUpsampler(createSpectralLutTextures(lut), lut.res)` evaluates the upsampler in TSL at a hero wavelength.

`nv.html` shows the full path: band materials and lights, one render, then the tube collapses the bands (`setNirBands`).

## NightShot

- `nightshot.ctx.power.value` - blends between source and NightShot render.
- `nightshot.ctx.P.smear.value` - interline vertical-smear strength.
- `nightshot.ctx.P.smearThreshold.value` - how bright a specular must be to smear.

## Use with THREE.RenderPipeline

If your app already uses `THREE.RenderPipeline`, wrap the output node you already had and make any PowerShot effect the final stage:

```js
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import {
  FilmPipeline,
  InfraredPipeline,
  Pipeline,
  effectPass,
  filmPass,
  infraredPass,
  powerShotPass,
} from "powershot-threejs";

const scenePass = pass(scene, camera);

const powershot = new Pipeline(renderer);
powershot.setMode("analog");
powershot.setPreset("powershot");

const renderPipeline = new THREE.RenderPipeline(renderer);
renderPipeline.outputNode = powerShotPass(scenePass, powershot);

function animate() {
  renderPipeline.render();
}
```

All shipped effects can be used the same way:

```js
const film = new FilmPipeline(renderer);
const infrared = new InfraredPipeline(renderer);

renderPipeline.outputNode = filmPass(scenePass, film);
renderPipeline.outputNode = infraredPass(scenePass, infrared);
```

Use `effectPass()` when you want the adapter to create or configure the effect lazily:

```js
renderPipeline.outputNode = effectPass(scenePass, {
  createEffect: (renderer) => new Pipeline(renderer),
  configureEffect: (effect) => {
    effect.setMode("analog");
    effect.setPreset("powershot");
  },
  resolutionScale: 0.75,
});
```

`powerShotPass()`, `filmPass()`, `infraredPass()`, `nightshotPass()`, and `effectPass()` accept any RenderPipeline-compatible output node, so existing node chains can be passed in place of `scenePass`. The adapter auto-sizes effects with `setSize(width, height)` by default; pass `{ autoSize: false }` if you manage effect resolution yourself. Remember film's rule still applies here: `filmPass` should be the only display transform in the chain and its input node must carry linear, un-tonemapped light.

## Structure

- `index.html` - UI shell and import map for Three.js WebGPU.
- `src/index.js` - public package exports.
- `src/main.js` - demo bootstrap, controls, source management (3D scenes, image, video), and render loop.
- `src/demo-scenes.js` - shared demo scenery: the daylight farm (also used by the flare demo) and the night yard (also used by the NV demo), rendered to a half-float plate and fed to the pipelines as scene-linear input.
- `src/pipeline.js` - reusable realtime ISP stages and WebGPU render passes.
- `src/film.js` - reusable motion-picture film emulation pipeline and stock presets.
- `src/infrared.js` - reusable pseudo-NIR night-vision pipeline and presets.
- `src/nightshot.js` - Sony NightShot camcorder emulation composing the NIR sensor with the analog tape path.
- `src/render-pipeline.js` - RenderPipeline output-node adapters for PowerShot effects.
- `nv.html` + `src/nv-demo.js` - NIR night-vision demo: a three-band NIR raster
  render that the tube collapses to a linear relative photocathode response
  (`setInputMode("nir")` + `setNirBands`) - no RGB heuristic anywhere. The tube enables the opt-in
  relative-electron model; press `E` to compare it with the original noise path.
- `src/nir_band.js` - realtime three-band raster NIR. Material and emitter spectra
  stay separate until Three performs component-wise lighting, then the bands
  collapse through photocathode weights.
- `src/nir_spectral.js` - the spectral model under it: photocathode response,
  NIR classifier, and the Jakob-Hanika upsampler (CPU and TSL) over
  `src/srgb_lut.js`, which `tools/gen-spectral-lut.mjs` regenerates
  (`npm run generate:spectral-lut`).
- `src/presets.js` - camera preset values.
- `src/styles.css` - app UI styles.
- `public/logo.png` - PowerSHOT logo.
- `public/logo-dark.png` - inverted logo for dark-mode README rendering.
- `public/vibe coding.jpg` - default test image.
