# powershot for three.js

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-dark.png">
    <img src="public/logo.png" alt="powershot" width="400">
  </picture>
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

## Drop it on your scene (default workflow)

Every effect is a `THREE.RenderPipeline` output-node pass — wrap the node
chain you already have and you're done. Sizing, frame counting, and per-frame
bookkeeping are automatic:

```js
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { Pipeline, powerShotPass } from "powershot-threejs";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();

const powershot = new Pipeline(renderer);
powershot.setMode("analog");            // or "digital"
powershot.setPreset("powershot");
powershot.setInputEncoding("linear");   // a raw scene pass carries linear light

const renderPipeline = new THREE.RenderPipeline(renderer);
renderPipeline.outputNode = powerShotPass(pass(scene, camera), powershot);

function animate() {
  renderPipeline.render();
}
```

`filmPass`, `infraredPass`, `nightshotPass`, and `solarFlarePass` work exactly
the same way, and any existing output node can stand in for the scene pass —
stack your own manipulations first and put the camera last. Two rules:

- **Film replaces the tonemap.** `filmPass` must be the only display transform
  in the chain (no ACES / AgX before it) and wants `setInputEncoding("linear")`.
- Feeding an already display-referred chain (post-tonemap manipulations)?
  Skip `setInputEncoding` — the default expects encoded input.

Adapters auto-size to the source; pass `{ autoSize: false }` or
`{ resolutionScale }` to manage effect resolution yourself. See
[docs/ADVANCED.md](docs/ADVANCED.md) for the full adapter contract.

## Processing images and videos

The same pipelines also run standalone on any texture: create a pipeline, pick
a preset by name, call `render(texture)` every frame. Pick your mode below and
copy its section. All snippets share this setup:

```js
import * as THREE from "three/webgpu";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();
```

The input texture can be an image, a video, or a render target's `.texture`.
`render()` locks the internal processing resolution to the first frame it
sees; call `setSize(w, h)` first to pick your own (e.g. a low
authentic-camera resolution). When you need deterministic control — explicit
frame numbers, fixed `dt`, an output render target — use
`renderTexture(texture, frame, options)`; see [docs/ADVANCED.md](docs/ADVANCED.md).

## Digicam

Mid-2000s point-and-shoot look: sensor noise, sharpening halos and JPEG blocks.

```js
import { Pipeline } from "powershot-threejs";

const powershot = new Pipeline(renderer);
powershot.setMode("digital");
powershot.setPreset("powershot");

// each frame:
powershot.render(inputTexture);
```

Presets: `cybershot`, `powershot`, `coolpix`, `exilim`, `ixus`.

## Analog tape

VHS / camcorder look: chroma bleed, tracking errors, dropouts. Same `Pipeline` as digicam, different mode:

```js
import { Pipeline } from "powershot-threejs";

const powershot = new Pipeline(renderer);
powershot.setMode("analog");
powershot.setPreset("powershot");

// each frame:
powershot.render(inputTexture);
```

## Film

Motion-picture film: a real negative-to-print chain with film stocks, grain, halation, gate weave and flicker.

> [!IMPORTANT]
> **Film runs alone, on linear light.** Do not combine it with the other PowerShot modes, and do not tone-map before it (no ACES / AgX / renderer tone mapping) — the negative→print chain **is** the tone map. Feed it a scene-linear HDR render target with `renderer.toneMapping = THREE.NoToneMapping`.

```js
import * as THREE from "three/webgpu";
import { FilmPipeline } from "powershot-threejs";

const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();
renderer.toneMapping = THREE.NoToneMapping;

const film = new FilmPipeline(renderer);
film.setInputEncoding("linear"); // input is scene-linear, not sRGB
film.setPreset("kodak_500t");

// each frame:
film.render(linearSceneTexture);
```

Stocks: `kodak_500t`, `kodak_200t`, `kodak_250d`, `kodak_50d`.

## White phosphor

Night-vision tube: local gain, intensifier halo, scintillation, tube vignette — tuned around a P45-style white phosphor tube.

```js
import { InfraredPipeline } from "powershot-threejs";

const infrared = new InfraredPipeline(renderer);
infrared.setPreset("white_phosphor");

// each frame (frame timing for the tube's auto-brightness loop is automatic):
infrared.render(inputTexture);
```

## NightShot

Sony Handycam "NightShot": a camcorder CCD with the IR-cut filter flipped out — AGC breathing, heavy noise, vertical smear, green monochrome, then the analog tape path.

```js
import { NightshotPipeline } from "powershot-threejs";

const nightshot = new NightshotPipeline(renderer);
nightshot.setPreset("nightshot_plus");

// each frame:
nightshot.render(inputTexture);
```

## Solar Flares

Solar Flares, the spectral sunlight flare, is a separate scene-linear optical
pass, not a sprite effect or a digicam preset. It uses a traced Heliar prescription for internal
reflections, an aperture FFT for diffraction, a source-centred glare halo, and
a low-frequency veiling layer.
Run it before PowerShot, film, exposure, tone mapping, and output conversion:

```js
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import {
  SolarFlarePipeline,
  loadHeliarTronnierFlareProfile,
  solarFlarePass,
} from "powershot-threejs";

const scenePass = pass(scene, camera);
const profile = await loadHeliarTronnierFlareProfile();
const flare = new SolarFlarePipeline(renderer, {
  profile,
  camera,
  sun, // THREE.DirectionalLight
});
flare.setSize(width, height);
flare.setAperture({ fNumber: 8, blades: 7 });

const renderPipeline = new THREE.RenderPipeline(renderer);
renderPipeline.outputNode = solarFlarePass(scenePass, flare, {
  camera,
  sun,
  depthTexture: scenePass.getTexture("depth"),
});

function animate() {
  renderPipeline.render();
}
```

The true solar direction is never clamped to the viewport, so the lens can flare
when the sun is just outside frame. Scene depth resolves partial on-screen solar
occlusion. For off-screen occlusion, supply a camera-to-sun visibility provider.
Run `npm run dev` and open `/powershot-threejs/flare.html` for the interactive
WebGPU sunlight, aperture, component-isolation, and occlusion demo.
The full model targets WebGPU. On the WebGL2 fallback and iOS Safari the pass
runs a reduced source-plus-glare composite instead of going black.
See [docs/SOLAR_FLARES.md](docs/SOLAR_FLARES.md) for the optical model, controls,
PowerShot ordering, backend support, and calibration contract.

## Going further

Per-mode controls, linear/HDR input, output grading, `THREE.RenderPipeline` integration, real NIR input and the repo layout are in [docs/ADVANCED.md](docs/ADVANCED.md).

# Acknowledgements

- NTSC
- OpenISP
