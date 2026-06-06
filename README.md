# PowerSHOT Three.js

<p align="center">
  <img src="public/logo.png" alt="PowerSHOT" width="400">
</p>

Digital camera post-processing in Three.js WebGPU.

It runs the camera-inspired ISP chain interactively on the GPU, including CCD bloom smear, Bayer/noise artifacts, chroma cleanup, tone shaping, sharpening, vignette, and multipass JPEG DCT block compression.

## Live

https://cl0nazepamm.github.io/powershot-threejs/

## Run

Install dependencies, then start the static dev server:

```sh
npm install
npm run dev
```

Use Chrome or Edge with WebGPU enabled. The app loads `public/vibe coding.jpg` by default and lets you drop in your own image.

## Structure

- `index.html` - UI shell and import map for Three.js WebGPU.
- `src/main.js` - app bootstrap, controls, image loading, and render loop.
- `src/pipeline.js` - realtime ISP stages and WebGPU render passes.
- `src/presets.js` - camera preset values.
- `src/styles.css` - app UI styles.
- `public/logo.png` - PowerSHOT logo.
- `public/vibe coding.jpg` - default test image.
