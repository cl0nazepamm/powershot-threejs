import assert from "node:assert/strict";
import test from "node:test";

import { InfraredPipeline, makeInfraredUniforms } from "../src/infrared.js";

test("relative-electron controls have conservative defaults", () => {
  const ctx = makeInfraredUniforms();
  assert.equal(ctx.P.electronsPerUnit.value, 1024);
});

test("electron model is opt-in, configurable, and reversible", () => {
  const pipeline = Object.create(InfraredPipeline.prototype);
  pipeline.electronModel = false;
  pipeline.ctx = makeInfraredUniforms();
  pipeline.dirty = false;
  let clears = 0;
  pipeline.clearHistory = () => { clears += 1; };

  pipeline.setElectronModel({ electronsPerUnit: 512 });
  assert.deepEqual(pipeline.getElectronModel(), {
    enabled: true,
    electronsPerUnit: 512,
  });
  assert.equal(pipeline.dirty, true);
  assert.equal(clears, 1);

  pipeline.dirty = false;
  pipeline.setElectronModel(false);
  assert.equal(pipeline.getElectronModel().enabled, false);
  assert.equal(pipeline.dirty, true);
  assert.equal(clears, 2);
});
