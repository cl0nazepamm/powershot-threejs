import assert from 'node:assert/strict';

import {
  INFRARED_PRESETS, INFRARED_PRESET_KEYS, InfraredPipeline,
} from '../src/infrared.js';

const preset = INFRARED_PRESETS.oculography;

assert.ok(INFRARED_PRESET_KEYS.includes('oculography'));
assert.equal(preset.profile, 'raw_vog');
assert.equal(preset.input_mode, 'nir');
assert.equal(preset.halo_disc, false);
assert.deepEqual(preset.sensor_resolution, [640, 480]);
assert.deepEqual(preset.phosphor_chroma, [1, 1, 1]);
assert.deepEqual(preset.highlight_white, [1, 1, 1]);
assert.equal(preset.local_gain, 0);
assert.equal(preset.abc_min, 1);
assert.equal(preset.abc_max, 1);
assert.equal(preset.chicken_amp, 0);
assert.equal(preset.scint_density, 0);
assert.equal(preset.scint_gain, 0);
assert.equal(preset.persistence, 0);
assert.ok(preset.psf_sigma > 0 && preset.psf_sigma < 1);
assert.ok(preset.glow_strength > 0 && preset.glow_strength < 0.2);

// Switching from the creative profile must restore the complete legacy
// contract, including topology, input interpretation and every uniform.
const pipeline = new InfraredPipeline(null);
const baseline = new InfraredPipeline(null);
const values = (p) => Object.fromEntries(Object.entries(p.ctx.P).map(
  ([key, node]) => [key, node.value?.toArray ? node.value.toArray() : node.value],
));
for (const key of INFRARED_PRESET_KEYS.filter(key => !key.startsWith('aura'))) {
  baseline.setPreset(key);
  pipeline.setPreset('aura_nir');
  pipeline.setPreset(key);
  assert.deepEqual(values(pipeline), values(baseline), `${key}: no Aura colour/gain leakage`);
  assert.equal(pipeline.diffuseBloom, false);
  assert.equal(pipeline.inputMode, baseline.inputMode);
  assert.equal(pipeline.haloDisc, baseline.haloDisc);
}
for (const key of ['aura', 'aura_nir']) {
  pipeline.dirty = false;
  pipeline.abcNeedsInit = false;
  pipeline.setPreset(key);
  assert.equal(pipeline.diffuseBloom, true);
  assert.equal(pipeline.inputMode, key === 'aura' ? 'rgb' : 'nir');
  assert.equal(pipeline.abcNeedsInit, true);
  assert.equal(pipeline.ctx.P.abcMin.value, pipeline.ctx.P.abcMax.value,
    'dark framing must not trigger exposure pumping');
  for (const [field, value] of Object.entries(values(pipeline))) {
    for (const component of Array.isArray(value) ? value : [value]) {
      assert.ok(Number.isFinite(component), `${key}.${field} is finite`);
    }
  }
  pipeline.setPreset('white_phosphor');
}
pipeline.dispose();
baseline.dispose();

console.log('infrared-profile-smoke: OK (Oculography, Aura, preset isolation)');
