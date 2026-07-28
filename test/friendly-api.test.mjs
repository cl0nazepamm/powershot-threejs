// Friendly API layer: setPreset(nameOrObject) and the render(texture)
// overload. The contract under test: the friendly paths are sugar only —
// they resolve to the exact classic calls and never touch the pixel path.

import assert from "node:assert/strict";
import test from "node:test";

import {
  Pipeline,
  applyPreset,
  autoFrameTick,
  resolvePreset,
  textureDimensions,
} from "../src/pipeline.js";
import { PRESETS, PRESET_KEYS } from "../src/presets.js";
import { FILM_PRESETS, FilmPipeline } from "../src/film.js";
import { INFRARED_PRESETS, InfraredPipeline } from "../src/infrared.js";
import { NIGHTSHOT_PRESETS, NightshotPipeline } from "../src/nightshot.js";

// Constructors only allocate JS-side state; no GPU work happens until render.
const stubRenderer = () => ({ hasFeature: () => false });

// ── resolvePreset ───────────────────────────────────────────────────

test("resolvePreset resolves keys, passes objects through, rejects junk", () => {
  assert.equal(resolvePreset(PRESETS, "powershot"), PRESETS.powershot);
  assert.equal(resolvePreset(PRESETS, PRESETS.ixus), PRESETS.ixus);

  assert.throws(
    () => resolvePreset(PRESETS, "powershit", "camera preset"),
    (e) => {
      assert.match(e.message, /Unknown camera preset "powershit"/);
      for (const key of PRESET_KEYS) assert.match(e.message, new RegExp(key));
      return true;
    },
  );
  assert.throws(() => resolvePreset(PRESETS, 42), TypeError);
  assert.throws(() => resolvePreset(PRESETS, null), TypeError);
});

// ── setPreset parity with the classic functions ─────────────────────

test("Pipeline.setPreset(name) matches applyPreset(ctx, PRESETS[name])", () => {
  for (const key of PRESET_KEYS) {
    const friendly = new Pipeline(stubRenderer()).setPreset(key);
    const classic = new Pipeline(stubRenderer());
    applyPreset(classic.ctx, PRESETS[key]);

    for (const k of Object.keys(friendly.ctx.P)) {
      const a = friendly.ctx.P[k].value;
      const b = classic.ctx.P[k].value;
      if (a && a.isVector3) assert.ok(a.equals(b), `${key}.${k}`);
      else assert.equal(a, b, `${key}.${k}`);
    }
  }
});

test("FilmPipeline.setPreset resolves stocks by name", () => {
  const film = new FilmPipeline(stubRenderer()).setPreset("kodak_500t");
  assert.equal(film.ctx.P.exposure.value, FILM_PRESETS.kodak_500t.exposure);
  assert.equal(
    film.ctx.P.grainStrength.value,
    FILM_PRESETS.kodak_500t.grain_strength,
  );
  assert.throws(() => film.setPreset("kodak_5000t"), /Unknown film stock/);
});

test("InfraredPipeline.setPreset applies the full profile, not just uniforms", () => {
  const ir = new InfraredPipeline(stubRenderer()).setPreset("white_phosphor_nir");
  assert.equal(ir.inputMode, "nir");
  assert.equal(ir.ctx.P.nirInput.value, 1);

  const rgb = new InfraredPipeline(stubRenderer()).setPreset("white_phosphor");
  assert.equal(rgb.inputMode, "rgb");
  assert.throws(() => rgb.setPreset("gen4"), /Unknown infrared preset/);
});

test("NightshotPipeline.setPreset drives sensor, camcorder, and smear", () => {
  const ns = new NightshotPipeline(stubRenderer()).setPreset("nightshot_plus");
  const preset = NIGHTSHOT_PRESETS.nightshot_plus;
  assert.equal(ns.ctx.P.smear.value, preset.smear);
  assert.equal(ns.ctx.P.smearThreshold.value, preset.smear_threshold);
  assert.equal(ns.ir.ctx.P.gain.value, preset.ir.gain);
  assert.throws(() => ns.setPreset("nightshot_ultra"), /Unknown NightShot preset/);
});

// ── render() overload dispatch ──────────────────────────────────────

const fakeTexture = (w = 640, h = 480) => ({ image: { width: w, height: h } });

const recordCalls = (pipeline) => {
  const calls = [];
  pipeline.renderTexture = (tex, frame, options) => {
    calls.push({ tex, frame, options });
    return true;
  };
  return calls;
};

test("render(number) keeps the legacy explicit-frame contract", async () => {
  const p = new Pipeline(stubRenderer());
  const calls = recordCalls(p);
  p.source = "SOURCE";

  await p.render(7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tex, "SOURCE");
  assert.equal(calls[0].frame, 7);
  assert.deepEqual(p.size, { w: 0, h: 0 }); // legacy path never auto-sizes
});

test("render(texture) auto-sizes to the first frame and counts frames", async () => {
  const p = new Pipeline(stubRenderer());
  const calls = recordCalls(p);
  const tex = fakeTexture(320, 240);

  await p.render(tex);
  await p.render(tex);
  await p.render(tex);

  assert.deepEqual(p.size, { w: 320, h: 240 });
  assert.deepEqual(calls.map((c) => c.frame), [0, 1, 2]);
  assert.equal(calls[0].tex, tex);
});

test("render(texture) respects an explicit setSize", async () => {
  const p = new Pipeline(stubRenderer());
  recordCalls(p);
  p.setSize(160, 120);
  await p.render(fakeTexture(1920, 1080));
  assert.deepEqual(p.size, { w: 160, h: 120 });
});

test("InfraredPipeline.render(texture) supplies dt; explicit dt wins", async () => {
  const ir = new InfraredPipeline(stubRenderer());
  const calls = recordCalls(ir);

  await ir.render(fakeTexture());
  assert.ok(calls[0].options.dt > 0);

  await ir.render(fakeTexture(), { dt: 0.5 });
  assert.equal(calls[1].options.dt, 0.5);
});

// ── helpers ─────────────────────────────────────────────────────────

test("autoFrameTick clamps dt and advances frames per effect", () => {
  const effect = {};
  const first = autoFrameTick(effect);
  assert.equal(first.frame, 0);
  assert.equal(first.dt, 1 / 60); // no previous tick to measure against

  const second = autoFrameTick(effect);
  assert.equal(second.frame, 1);
  assert.ok(second.dt >= 1 / 240 && second.dt <= 1 / 15);
});

test("textureDimensions reads images, videos, and render targets", () => {
  assert.deepEqual(textureDimensions(fakeTexture(12, 34)), { w: 12, h: 34 });
  assert.deepEqual(
    textureDimensions({ image: { videoWidth: 720, videoHeight: 480, width: 0, height: 0 } }),
    { w: 720, h: 480 },
  );
  assert.equal(textureDimensions({ image: { width: 0, height: 0 } }), null);
  assert.equal(textureDimensions({}), null);
  assert.equal(textureDimensions(null), null);
});
