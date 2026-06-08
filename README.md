# powershot for three.js

<p align="center">
  <img src="public/logo.png" alt="powershot" width="400">
</p>

Authentic digital and analog post-processing filters for Three.js.

Beware: digital ISP is not a cheap effect.

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
- `src/presets.js` - camera preset values.
- `src/styles.css` - app UI styles.
- `public/logo.png` - PowerSHOT logo.
- `public/vibe coding.jpg` - default test image.

# Acknowledgements

- NTSC
- OpenISP
