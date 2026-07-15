import assert from "node:assert/strict";
import test from "node:test";

import {
  createNirBand,
  NIR_BAND_RANGES,
  NIR_BAND_WEIGHTS,
} from "../src/nir_band.js";
import { photocathodeResponseJS } from "speedball-gi/spectral-traverse";

const color = (r, g, b) => ({ isColor: true, r, g, b });
const material = (nirAlbedo) => ({
  name: "green_paint",
  color: color(0.01, 0.05, 0.005),
  roughness: 1,
  metalness: 0,
  transmission: 0,
  userData: { nirAlbedo },
});
const light = (emitterClass, intensity = 1, rgb = color(0, 0, 0)) => ({
  color: rgb,
  intensity,
  userData: { emitterClass },
});

function sensorMean(fn, from = 550, to = 900) {
  const steps = Math.round((to - from) * 4);
  const dl = (to - from) / steps;
  let value = 0, response = 0;
  for (let i = 0; i < steps; i += 1) {
    const wavelength = from + (i + 0.5) * dl;
    const weight = photocathodeResponseJS(wavelength) * dl;
    value += fn(wavelength) * weight;
    response += weight;
  }
  return value / response;
}

test("photocathode band weights cover the NV domain and sum to one", () => {
  assert.deepEqual(NIR_BAND_RANGES, [[550, 650], [650, 800], [800, 900]]);
  assert.ok(Math.abs(NIR_BAND_WEIGHTS.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const expected = [0.20652874, 0.49934764, 0.29412361];
  NIR_BAND_WEIGHTS.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < 1e-7);
  });
});

test("authored NIR albedo starts at the same 700 nm red edge as the tracer", () => {
  const band = createNirBand();
  const dark = band.reflectanceBands(material(0.07));
  const bright = band.reflectanceBands(material(0.55));

  assert.ok(Math.abs(dark[0] - bright[0]) < 1e-12);
  assert.ok(bright[1] > dark[1] * 5);
  assert.ok(Math.abs(dark[2] - 0.07) < 1e-12);
  assert.ok(Math.abs(bright[2] - 0.55) < 1e-12);
});

test("three bands preserve material/emitter correlation better than one scalar", () => {
  const reflectance = (wavelength) => 0.08 + 0.62
    * Math.max(0, Math.min(1, (wavelength - 690) / 70));
  const emitter = (wavelength) => Math.exp(-0.5 * ((wavelength - 850) / 15) ** 2);
  const reference = sensorMean((wavelength) => reflectance(wavelength) * emitter(wavelength));
  const legacy = sensorMean(reflectance) * sensorMean(emitter);
  const threeBand = NIR_BAND_RANGES.reduce((sum, [from, to], i) => (
    sum + NIR_BAND_WEIGHTS[i]
      * sensorMean(reflectance, from, to)
      * sensorMean(emitter, from, to)
  ), 0);

  assert.ok(Math.abs(threeBand - reference) < Math.abs(legacy - reference) * 0.1);
});

test("narrowband emitters land in the expected raster channels", () => {
  const band = createNirBand();
  const ir = band.lightBands(light("ir"));
  const sodium = band.lightBands(light("sodium", 1, color(1, 0.3, 0.05)));

  assert.ok(ir[2] > ir[1] * 1000);
  assert.ok(ir[1] > ir[0]);
  assert.ok(sodium[0] > 0.3);
  assert.ok(sodium[0] > sodium[1] * 1e20);
});

test("three-band lighting preserves an NIR metamer pair", () => {
  const band = createNirBand();
  const emitter = band.lightBands(light("ir"));
  const direct = (reflectance) => band.collapse(
    reflectance.map((value, i) => value * emitter[i]),
  );

  const paint = direct(band.reflectanceBands(material(0.07)));
  const foliage = direct(band.reflectanceBands(material(0.55)));
  assert.ok(foliage > paint * 5);
  assert.ok(Math.abs(band.collapse([1, 1, 1]) - 1) < 1e-12);
});
