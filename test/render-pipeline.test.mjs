// The RenderPipeline pass adapters are the README's default workflow, but no
// in-repo page exercises them (the demo drives renderTexture directly). This
// pins the adapter contract: factory argument normalization, the
// updateBefore -> effect.renderTexture bridge, sizing, frame bookkeeping,
// renderer-state restoration, and each pass class's default effect wiring.

import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three/webgpu";
import { texture } from "three/tsl";

import {
  EffectPassNode,
  FilmPassNode,
  InfraredPassNode,
  NightshotPassNode,
  PowerShotPassNode,
  SolarFlarePassNode,
  effectPass,
  filmPass,
  infraredPass,
  nightshotPass,
  powerShotPass,
} from "../src/render-pipeline.js";
import { FilmPipeline } from "../src/film.js";
import { InfraredPipeline } from "../src/infrared.js";
import { NightshotPipeline } from "../src/nightshot.js";
import { Pipeline } from "../src/pipeline.js";

function makeInputNode(w = 320, h = 240) {
  const tex = new THREE.Texture();
  tex.image = { width: w, height: h };
  return texture(tex);
}

function makeStubEffect() {
  return {
    calls: [],
    sizedTo: null,
    setSize(w, h) { this.sizedTo = [w, h]; },
    renderTexture(tex, frame, options) {
      this.calls.push({ tex, frame, options });
      return true;
    },
  };
}

function makeFakeRenderer() {
  return {
    hasFeature: () => false,
    toneMapping: THREE.AgXToneMapping,
    toneMappingExposure: 1.25,
    outputColorSpace: THREE.SRGBColorSpace,
    targets: [],
    getRenderTarget: () => "PREVIOUS_TARGET",
    setRenderTarget(t) { this.targets.push(t); },
    getDrawingBufferSize: (v) => v.set(640, 480),
  };
}

// ── factory argument normalization ──────────────────────────────────

test("pass factories accept an effect instance or an options object", () => {
  const input = makeInputNode();
  const stub = makeStubEffect();

  const withInstance = powerShotPass(input, stub);
  assert.equal(withInstance.effect, stub);

  const withOptions = powerShotPass(input, { resolutionScale: 0.5 });
  assert.equal(withOptions.effect, null);
  assert.equal(withOptions.resolutionScale, 0.5);

  const viaOptionsEffect = effectPass(input, { pipeline: stub, autoSize: false });
  assert.equal(viaOptionsEffect.effect, stub);
  assert.equal(viaOptionsEffect.autoSize, false);

  assert.equal(nightshotPass(input, stub).effect, stub);
  assert.equal(filmPass(input, stub).effect, stub);
  assert.equal(infraredPass(input, stub).effect, stub);
});

test("every pass class lazily creates its own pipeline type", () => {
  const renderer = makeFakeRenderer();
  const cases = [
    [PowerShotPassNode, Pipeline],
    [FilmPassNode, FilmPipeline],
    [InfraredPassNode, InfraredPipeline],
    [NightshotPassNode, NightshotPipeline],
  ];
  for (const [PassClass, PipelineClass] of cases) {
    const node = new PassClass(makeInputNode());
    const effect = node._ensureEffect(renderer);
    assert.ok(effect instanceof PipelineClass, `${PassClass.name} creates ${PipelineClass.name}`);
    assert.equal(node.ownsEffect, true);
  }
});

// ── updateBefore: the bridge the README workflow rides on ───────────

test("updateBefore drives renderTexture with frame, dt, and the output target", () => {
  const stub = makeStubEffect();
  const node = powerShotPass(makeInputNode(), stub);
  const renderer = makeFakeRenderer();

  assert.equal(node.updateBefore({ renderer, deltaTime: 1 / 50 }), true);
  assert.equal(node.updateBefore({ renderer, deltaTime: 1 / 50 }), true);

  assert.equal(stub.calls.length, 2);
  const [first, second] = stub.calls;
  assert.equal(first.frame, 0);
  assert.equal(second.frame, 1); // internal counter advances
  assert.equal(first.options.outputTarget, node.outputTarget);
  assert.equal(first.options.dt, 1 / 50);
  assert.equal(first.tex, node.inputTextureNode.value);
});

test("updateBefore prefers frame.frameId, then an explicit frame provider", () => {
  const stub = makeStubEffect();
  const node = powerShotPass(makeInputNode(), stub);
  const renderer = makeFakeRenderer();

  node.updateBefore({ renderer, frameId: 41 });
  assert.equal(stub.calls[0].frame, 41);

  const provided = powerShotPass(makeInputNode(), stub, { frame: () => 7 });
  provided.updateBefore({ renderer, frameId: 41 });
  assert.equal(stub.calls[1].frame, 7);
});

test("auto-sizing follows the source through resolutionScale; autoSize:false opts out", () => {
  const renderer = makeFakeRenderer();

  const auto = powerShotPass(makeInputNode(320, 240), makeStubEffect(), { resolutionScale: 0.5 });
  auto.updateBefore({ renderer });
  assert.deepEqual(auto.effect.sizedTo, [160, 120]);
  assert.equal(auto.outputTarget.width, 160);
  assert.equal(auto.outputTarget.height, 120);

  const manual = powerShotPass(makeInputNode(320, 240), makeStubEffect(), { autoSize: false });
  manual.updateBefore({ renderer });
  assert.equal(manual.effect.sizedTo, null);
  assert.equal(manual.outputTarget.width, 320); // output still tracks the source
});

test("renderer state is restored after the effect runs", () => {
  const renderer = makeFakeRenderer();
  const node = powerShotPass(makeInputNode(), makeStubEffect());

  node.updateBefore({ renderer });

  assert.equal(renderer.toneMapping, THREE.AgXToneMapping);
  assert.equal(renderer.toneMappingExposure, 1.25);
  assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace);
  assert.equal(renderer.targets.at(-1), "PREVIOUS_TARGET");
});

test("updateBefore bails cleanly without a renderer or a source texture", () => {
  const stub = makeStubEffect();
  const node = powerShotPass(makeInputNode(), stub);
  assert.equal(node.updateBefore({}), false);

  const bare = new THREE.Texture(); // no image, no dimensions
  const empty = powerShotPass(texture(bare), stub);
  empty.inputTextureNode.value = null;
  assert.equal(empty.updateBefore({ renderer: makeFakeRenderer() }), false);
  assert.equal(stub.calls.length, 0);
});

test("configureEffect runs once; dispose releases only owned effects", () => {
  const renderer = makeFakeRenderer();
  let configured = 0;
  const stub = makeStubEffect();
  const node = effectPass(makeInputNode(), {
    createEffect: () => stub,
    configureEffect: () => { configured += 1; },
  });

  node.updateBefore({ renderer });
  node.updateBefore({ renderer });
  assert.equal(configured, 1);
  assert.equal(node.ownsEffect, true);

  let disposed = 0;
  stub.dispose = () => { disposed += 1; };
  node.dispose();
  assert.equal(disposed, 1);

  const borrowed = powerShotPass(makeInputNode(), makeStubEffect());
  borrowed.effect.dispose = () => { throw new Error("must not dispose a borrowed effect"); };
  borrowed.dispose(); // ownsEffect false — no throw
});

// ── solar flare node: transports camera / sun / depth ───────────────

test("SolarFlarePassNode resolves camera, sun, depth, and callable options per frame", () => {
  const camera = new THREE.PerspectiveCamera(49, 1, 0.1, 100);
  const sun = new THREE.DirectionalLight();
  const depth = new THREE.Texture();
  const stub = makeStubEffect();

  const node = new SolarFlarePassNode(makeInputNode(), stub, {
    camera,
    sun,
    depthTexture: () => depth,
    visibility: () => 0.5,
    sourceRadiance: 9,
  });

  const options = node.renderOptions({}, node, stub);
  assert.equal(options.camera, camera);
  assert.equal(options.sun, sun);
  assert.equal(options.depthTexture, depth);
  assert.equal(options.visibility, 0.5);
  assert.equal(options.sourceRadiance, 9);
});
