# PowerShot-threejs — CLAUDE.md

Realtime ISP (film / infrared / nightshot / solar-flare) as TSL stage functions
for three.js WebGPU. Published to npm as `powershot-threejs` (0.9.0).

Behavior rules live in `~/.claude/CLAUDE.md` and are not repeated here. This
file is facts about this repo.

## This repo is the SOURCE OF TRUTH for two vendored copies

`src/` is copied into two downstream consumers. **A change here is not finished
until both copies match**, or you have said explicitly which you skipped.

| Copy | Path | Notes |
|---|---|---|
| upstream (here) | `src/*.js` | CRLF |
| max.js runtime | `../maxjs/web/vendor/powershot-threejs/` | CRLF, flattened (no `src/`) |
| the website | `../clone-llc/vendor/powershot-threejs/` | **LF-normalized**, flattened |

All three were verified content-identical on 2026-08-13.

Because clone-llc's copy is LF and the other two are CRLF, a plain `diff` reports
every line as changed. Always compare with:

```
diff -q --strip-trailing-cr src/pipeline.js ../clone-llc/vendor/powershot-threejs/pipeline.js
```

`clone-llc` also reaches this code through `tools/sync-runtime.mjs`, which
replays site edits from `runtime-patches/*.patch` — so an upstream change that
collides with a site patch fails loudly there rather than silently reverting.
That is the intended behavior; do not "fix" it by dropping the patch without
checking whether it still describes a real divergence.

## Layout

```
src/index.js              public entry
src/pipeline.js           TSL stage library + ping-pong runner (the big one)
src/presets.js            named looks (kodak_500t, kodak_200t, …)
src/film.js               film emulation stages
src/infrared.js           NIR / thermal
src/nightshot.js          low-light
src/render-pipeline.js    render-pipeline integration
src/solar-flare*.js       flare model + PSF + optics profile
src/assets/               heliar-tronnier-100mm-v1.bin (flare PSF, ~2.6 MB)
tools/                    solar-flare optics + atlas generators
docs/                     SOLAR_FLARES.md, ADVANCED.md
index.html, flare.html, nv.html   local demos (vite)
```

`package.json` `files[]` is the published surface — if you add a runtime source
file, add it there too or it ships broken.

## Domain convention (the thing that bites)

Pixel values inside the pipeline live in a **0..255 "signal" space**, not 0..1.
Textures are sampled in 0..1 and multiplied up at the first stage so every
constant (`highlight_clip`, `shadow_crush`, `noise*255`, thresholds) matches the
Python reference 1:1, then divided back to 0..1 at the final stage. A constant
that looks off by 255× is almost always this.

## Assets

`src/assets/heliar-tronnier-100mm-v1.bin` is the flare PSF. Consumers that run
with `flareEnabled: false` may omit it — clone-llc historically did, then needed
it back when TELEVISED turned the solar flare on. If a downstream reports a
missing-asset 404, that is the cause.
