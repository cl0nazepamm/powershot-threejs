# demo

Dev-only vendored snapshot used by the `nv.html` test scene. Nothing in this
directory is part of the published npm package (it is not in the `files`
list in `package.json`).

- `spectral_kernel.js` and `spectral_tracer.js` are vendored from the maxjs
  repo, which is their canonical home.
- `spectral_traverse.js` and `spectral_scene.js` are canonical in the
  `speedball-gi` package.
- `srgb_lut.js` is the Jakob–Hanika sRGB→reflectance coefficient LUT from
  maxjs.

Do not edit these copies in place — sync changes from the canonical homes
instead.

`nir_band.js` is original to this repo: CPU band-collapse of the NIR domain
for the realtime raster mode.

`three-mesh-bvh` is pinned at 0.8.3 — 0.9.x changed the internal BVH node
layout the flattener reads and crashes the GPU process.

The contract between any renderer and the intensifier: a single-channel
LINEAR electron-flux texture (no tone map, no sRGB), scaled so unlit night
ground lands around 0.02–0.05. Feed it via `infrared.setInputMode("nir")`.
