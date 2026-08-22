import assert from 'node:assert/strict';

import { INFRARED_PRESETS, INFRARED_PRESET_KEYS } from '../src/infrared.js';

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

console.log('infrared-profile-smoke: OK');
