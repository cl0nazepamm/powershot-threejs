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

For a normal Three.js scene, render your scene into a `THREE.RenderTarget`, then pass `target.texture` to `renderTexture()`:

```js
sceneRenderer.setRenderTarget(sceneTarget);
sceneRenderer.render(scene, camera);
sceneRenderer.setRenderTarget(null);

powershot.renderTexture(sceneTarget.texture, frame);
```

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
- `src/presets.js` - camera preset values.
- `src/styles.css` - app UI styles.
- `public/logo.png` - PowerSHOT logo.
- `public/vibe coding.jpg` - default test image.

# Acknowledgements

- NTSC
- OpenISP
