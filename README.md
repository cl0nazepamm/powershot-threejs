# powershot for three.js

<p align="center">
  <img src="public/logo.png" alt="powershot" width="400">
</p>

Authentic digicam, analog tape and film emulation post-processing filters for Three.js.

## Play live here.

https://cl0nazepamm.github.io/powershot-threejs/

## Run

Install dependencies, then start the static dev server:

```sh
npm install
npm run dev
```

Requires WebGPU.

## Use in your Three.js project

Install the package next to your existing Three.js app:

```sh
npm install powershot-threejs three
```

Create one pipeline for your renderer, apply a preset, and render a texture through it:

```js
import * as THREE from "three/webgpu";
import { Pipeline, PRESETS, applyPreset } from "powershot-threejs";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();

const powershot = new Pipeline(renderer);
powershot.setMode("analog"); // "analog" or "digital"
powershot.setSize(width, height); // internal processing resolution
applyPreset(powershot.ctx, PRESETS.powershot);

// Render `inputTexture` into the current canvas.
powershot.renderTexture(inputTexture, frame);
```

To keep the same on-screen scale while processing at a lower authentic analog resolution, keep your canvas CSS size fixed and pass the lower internal size to `setSize()`.

For motion-picture film emulation, use `FilmPipeline` instead. It models a negative-to-print chain with film stocks, grain, halation, gate weave, flicker, print warmth, and negative inspection.

```js
import * as THREE from "three/webgpu";
import { FilmPipeline, FILM_PRESETS, applyFilmPreset } from "powershot-threejs";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();

const film = new FilmPipeline(renderer);
film.setSize(width, height);
applyFilmPreset(film.ctx, FILM_PRESETS.kodak_500t);

// Optional controls.
film.ctx.power.value = 1.0; // blends between source and film render
film.ctx.P.exposure.value = 0.0; // stops at the film plane
film.ctx.P.grainStrength.value = 1.0;
film.ctx.P.halStrength.value = 0.35;
film.ctx.P.negativeView.value = 0; // set to 1 to inspect the negative

film.renderTexture(inputTexture, frame);
```

For infrared / night-vision rendering, use `InfraredPipeline`. It has a dedicated pseudo-NIR signal path with local gain, broad intensifier halo, pale highlight cores, dark-biased scintillation, tube vignette, and optional eye-mask gating. The built-in preset is tuned around a P45-style white phosphor tube rather than a flat color grade.

```js
import * as THREE from "three/webgpu";
import {
  InfraredPipeline,
  INFRARED_PRESETS,
  applyInfraredPreset,
} from "powershot-threejs";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();

const infrared = new InfraredPipeline(renderer);
infrared.setSize(width, height);
infrared.setInputMode("rgb"); // "rgb" simulates NIR from RGB, "nir" treats the source as mono/real NIR
applyInfraredPreset(infrared.ctx, INFRARED_PRESETS.white_phosphor);

// Optional aligned mask texture for eye/retinal flare regions.
infrared.setEyeMask(maskTexture);

infrared.renderTexture(inputTexture, frame);
```

Useful infrared controls:

- `infrared.ctx.power.value` - blends between source and infrared render.
- `infrared.ctx.P.exposure.value` - input amplification in stops.
- `infrared.ctx.P.localGain.value` - dark-region adaptation strength.
- `infrared.ctx.P.glowStrength.value` - broad green bloom amount.
- `infrared.ctx.P.eyeStrength.value` - compact highlight / eye flare amount.
- `infrared.ctx.P.noiseAmount.value` - master monochrome sensor and phosphor noise.
- `infrared.setInputMode("nir")` - use when the input is already monochrome or actual NIR.

RGB images do not contain actual infrared reflectance. The default path is an artistic pseudo-NIR approximation; pass real monochrome/NIR input and call `setInputMode("nir")` when you have real IR source material.

For a normal Three.js scene, render your scene into a `THREE.RenderTarget`, then pass `target.texture` to `renderTexture()`:

```js
sceneRenderer.setRenderTarget(sceneTarget);
sceneRenderer.render(scene, camera);
sceneRenderer.setRenderTarget(null);

powershot.renderTexture(sceneTarget.texture, frame);
```

If your app already uses `THREE.RenderPipeline`, wrap the output node you already had and make any PowerShot effect the final stage:

```js
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import {
  FilmPipeline,
  InfraredPipeline,
  Pipeline,
  PRESETS,
  applyPreset,
  effectPass,
  filmPass,
  infraredPass,
  powerShotPass,
} from "powershot-threejs";

const scenePass = pass(scene, camera);

const powershot = new Pipeline(renderer);
powershot.setMode("analog");
powershot.setSize(width, height);
applyPreset(powershot.ctx, PRESETS.powershot);

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
    applyPreset(effect.ctx, PRESETS.powershot);
  },
  resolutionScale: 0.75,
});
```

`powerShotPass()`, `filmPass()`, `infraredPass()`, and `effectPass()` accept any RenderPipeline-compatible output node, so existing node chains can be passed in place of `scenePass`. The adapter auto-sizes effects with `setSize(width, height)` by default; pass `{ autoSize: false }` if you manage effect resolution yourself.

Useful controls:

- `powershot.ctx.power.value` - blends between source and effect.
- `powershot.ctx.noiseScale.value` - global noise scale.
- `powershot.ctx.P.jpegStrength.value` - digital JPEG amount.
- `powershot.ctx.P.analogStrength.value` - analog/VHS amount.
- `powershot.setOutputColorGrading({ brightness, contrast })` - final grading.

## Structure

- `index.html` - UI shell and import map for Three.js WebGPU.
- `src/index.js` - public package exports.
- `src/main.js` - demo bootstrap, controls, image loading, and render loop.
- `src/pipeline.js` - reusable realtime ISP stages and WebGPU render passes.
- `src/film.js` - reusable motion-picture film emulation pipeline and stock presets.
- `src/infrared.js` - reusable pseudo-NIR night-vision pipeline and presets.
- `src/render-pipeline.js` - RenderPipeline output-node adapters for PowerShot effects.
- `src/presets.js` - camera preset values.
- `src/styles.css` - app UI styles.
- `public/logo.png` - PowerSHOT logo.
- `public/vibe coding.jpg` - default test image.

# Acknowledgements

- NTSC
- OpenISP
