import assert from "node:assert/strict";
import test from "node:test";

import {
  INFRARED_PRESETS,
  INFRARED_PRESET_KEYS,
  InfraredPipeline,
  applyInfraredPreset,
  applyInfraredProfile,
  makeInfraredUniforms,
} from "../src/infrared.js";

test("Gen 3 profile is restrained silver-blue and physically differentiated", () => {
  const preset = INFRARED_PRESETS.gen3_white_phosphor;
  const [r, g, b] = preset.phosphor_chroma;

  assert.ok(INFRARED_PRESET_KEYS.includes("gen3_white_phosphor"));
  assert.equal(preset.profile, "gen3");
  assert.equal(preset.input_mode, "rgb");
  assert.equal(preset.halo_disc, true);
  assert.ok(b > g && g > r, "tube mids should progress from silver red to blue");
  assert.ok(b - r >= 0.2 && b - r <= 0.4, "blue separation should be visible but not cyan");
  assert.ok(preset.highlight_white[0] > r, "highlights should converge toward icy white");
  assert.ok(preset.autogate_strength > 0 && preset.autogate_strength < 0.25);
  assert.ok(preset.edge_resolution_falloff > 0 && preset.edge_resolution_falloff < 1);
  assert.ok(preset.scint_bright_floor > 0 && preset.scint_bright_floor <= 0.15);
});

test("infrared preset application resets every new tube control", () => {
  const ctx = makeInfraredUniforms();
  const gen3 = INFRARED_PRESETS.gen3_white_phosphor;
  const ethereal = INFRARED_PRESETS.white_phosphor;

  applyInfraredPreset(ctx, gen3);
  assert.equal(ctx.P.autogateStrength.value, gen3.autogate_strength);
  assert.equal(ctx.P.edgeResolutionFalloff.value, gen3.edge_resolution_falloff);
  assert.equal(ctx.P.scintBrightFloor.value, gen3.scint_bright_floor);
  assert.deepEqual(ctx.P.phosphorChroma.value.toArray(), gen3.phosphor_chroma);

  applyInfraredPreset(ctx, ethereal);
  assert.equal(ctx.P.autogateStrength.value, 0);
  assert.equal(ctx.P.edgeResolutionFalloff.value, 0);
  assert.equal(ctx.P.scintBrightFloor.value, 1);

  applyInfraredPreset(ctx, gen3);
  assert.equal(ctx.P.autogateStrength.value, gen3.autogate_strength);
  assert.equal(ctx.P.edgeResolutionFalloff.value, gen3.edge_resolution_falloff);
  assert.equal(ctx.P.scintBrightFloor.value, gen3.scint_bright_floor);
});

test("profile application switches source contract and halo topology", () => {
  const pipeline = Object.create(InfraredPipeline.prototype);
  pipeline.ctx = makeInfraredUniforms();
  pipeline.inputMode = "rgb";
  pipeline.haloDisc = false;
  pipeline.dirty = false;
  pipeline.abcNeedsInit = false;

  applyInfraredProfile(pipeline, INFRARED_PRESETS.gen3_white_phosphor);
  assert.equal(pipeline.inputMode, "rgb");
  assert.equal(pipeline.haloDisc, true);
  assert.equal(pipeline.abcNeedsInit, true);

  pipeline.abcNeedsInit = false;
  applyInfraredProfile(pipeline, INFRARED_PRESETS.white_phosphor);
  assert.equal(pipeline.inputMode, "rgb");
  assert.equal(pipeline.haloDisc, false);
  assert.equal(pipeline.abcNeedsInit, true);

  applyInfraredProfile(pipeline, INFRARED_PRESETS.gen3_white_phosphor_nir);
  assert.equal(pipeline.inputMode, "nir");
  assert.equal(pipeline.ctx.P.nirInput.value, 1);
  assert.equal(
    pipeline.ctx.P.fluxScale.value,
    INFRARED_PRESETS.gen3_white_phosphor_nir.flux_scale,
  );
  assert.equal(pipeline.haloDisc, true);
});

test("input response preserves RGB blending and scales calibrated true-NIR flux", () => {
  const pipeline = Object.create(InfraredPipeline.prototype);
  pipeline.ctx = makeInfraredUniforms();

  pipeline.inputMode = "rgb";
  pipeline.ctx.P.fluxScale.value = 2.5;
  pipeline.setInputResponse(0.35, 4.0);
  assert.equal(pipeline.ctx.P.nirInput.value, 0.35);
  assert.equal(pipeline.ctx.P.fluxScale.value, 2.5);

  pipeline.inputMode = "nir";
  pipeline.setInputResponse(0.25, 4.0);
  assert.equal(pipeline.ctx.P.nirInput.value, 1);
  assert.equal(pipeline.ctx.P.fluxScale.value, 1.0);

  // Repeated writes use the immutable reference calibration, not the current
  // scaled value, so dragging the slider cannot compound the response.
  pipeline.setInputResponse(0.5, 4.0);
  assert.equal(pipeline.ctx.P.fluxScale.value, 2.0);
  pipeline.setInputResponse(2.0, 4.0);
  assert.equal(pipeline.ctx.P.fluxScale.value, 4.0);
  pipeline.setInputResponse(-1.0, 4.0);
  assert.equal(pipeline.ctx.P.fluxScale.value, 0.0);
});

test("all infrared presets provide finite profile controls", () => {
  const finiteFields = [
    "autogate_strength",
    "autogate_threshold",
    "autogate_softness",
    "edge_resolution_falloff",
    "scint_bright_floor",
  ];

  for (const key of INFRARED_PRESET_KEYS) {
    const preset = INFRARED_PRESETS[key];
    for (const field of finiteFields) {
      assert.ok(Number.isFinite(preset[field]), `${key}.${field} must be finite`);
    }
    assert.equal(preset.phosphor_chroma.length, 3);
    assert.equal(preset.highlight_white.length, 3);
  }
});
