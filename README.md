# powershot for three.js

<p align="center">
  <img src="public/logo.png" alt="powershot" width="400">
</p>

Authentic digicam, analog tape, film and night-vision emulation post-processing for Three.js.

## Play live here.

https://cl0nazepamm.github.io/powershot-threejs/

## Run the demo

```sh
npm install
npm run dev
```

Requires WebGPU.

## Install in your Three.js project

```sh
npm install powershot-threejs three
```

Every mode works the same way: create a pipeline, apply a preset, render a texture through it. Pick your mode below and copy its section.

All snippets share this setup:

```js
import * as THREE from "three/webgpu";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();
```

The input texture can be an image, a video, or your scene. For a normal Three.js scene, render into a `THREE.RenderTarget` and pass `target.texture`:

```js
sceneRenderer.setRenderTarget(sceneTarget);
sceneRenderer.render(scene, camera);
sceneRenderer.setRenderTarget(null);

powershot.renderTexture(sceneTarget.texture, frame);
```

## Digicam

Mid-2000s point-and-shoot look: sensor noise, sharpening halos and JPEG blocks.

```js
import { Pipeline, PRESETS, applyPreset } from "powershot-threejs";

const powershot = new Pipeline(renderer);
powershot.setMode("digital");
powershot.setSize(width, height); // internal processing resolution
applyPreset(powershot.ctx, PRESETS.powershot);

powershot.renderTexture(inputTexture, frame);
```

Presets: `cybershot`, `powershot`, `coolpix`, `exilim`, `ixus`.

## Analog tape

VHS / camcorder look: chroma bleed, tracking errors, dropouts. Same `Pipeline` as digicam, different mode:

```js
import { Pipeline, PRESETS, applyPreset } from "powershot-threejs";

const powershot = new Pipeline(renderer);
powershot.setMode("analog");
powershot.setSize(width, height);
applyPreset(powershot.ctx, PRESETS.powershot);

powershot.renderTexture(inputTexture, frame);
```

## Film

Motion-picture film: a real negative-to-print chain with film stocks, grain, halation, gate weave and flicker.

> [!IMPORTANT]
> **Film runs alone, on linear light.** Do not combine it with the other PowerShot modes, and do not tone-map before it (no ACES / AgX / renderer tone mapping) — the negative→print chain **is** the tone map. Feed it a scene-linear HDR render target with `renderer.toneMapping = THREE.NoToneMapping`.

```js
import * as THREE from "three/webgpu";
import { FilmPipeline, FILM_PRESETS, applyFilmPreset } from "powershot-threejs";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();
renderer.toneMapping = THREE.NoToneMapping;

const film = new FilmPipeline(renderer);
film.setSize(width, height);
film.setInputEncoding("linear"); // input is scene-linear, not sRGB
applyFilmPreset(film.ctx, FILM_PRESETS.kodak_500t);

film.renderTexture(linearSceneTexture, frame);
```

Stocks: `kodak_500t`, `kodak_200t`, `kodak_250d`, `kodak_50d`.

## White phosphor

Night-vision tube: local gain, intensifier halo, scintillation, tube vignette — tuned around a P45-style white phosphor tube.

```js
import {
  InfraredPipeline,
  INFRARED_PRESETS,
  applyInfraredPreset,
} from "powershot-threejs";

const infrared = new InfraredPipeline(renderer);
infrared.setSize(width, height);
applyInfraredPreset(infrared.ctx, INFRARED_PRESETS.white_phosphor);

infrared.renderTexture(inputTexture, frame, { dt: deltaSeconds });
```

## NightShot

Sony Handycam "NightShot": a camcorder CCD with the IR-cut filter flipped out — AGC breathing, heavy noise, hot eye reflections, vertical smear, green monochrome, then the analog tape path.

```js
import {
  NightshotPipeline,
  NIGHTSHOT_PRESETS,
  applyNightshotPreset,
} from "powershot-threejs";

const nightshot = new NightshotPipeline(renderer);
nightshot.setSize(width, height);
applyNightshotPreset(nightshot, NIGHTSHOT_PRESETS.nightshot_plus);

nightshot.renderTexture(inputTexture, frame, { dt: deltaSeconds });
```

## Going further

Per-mode controls, linear/HDR input, output grading, `THREE.RenderPipeline` integration, real NIR input and the repo layout are in [ADVANCED.md](ADVANCED.md).

# Acknowledgements

- NTSC
- OpenISP
