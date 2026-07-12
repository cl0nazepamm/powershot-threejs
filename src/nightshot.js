// PowerSHOT NightShot mode - Sony Handycam "NightShot" camcorder emulation.
//
// TRUTH MODEL: NightShot is NOT an image intensifier. It is a consumer
// interline-transfer CCD with the IR-cut filter mechanically flipped out of
// the optical path, plus a weak built-in ~850 nm LED illuminator mounted next
// to the lens (usable range of a few metres). There is no photocathode, no
// MCP, no phosphor screen - the sensor sees NIR directly and the camera
// compensates with slow shutter + high AGC. The signature artifacts follow
// from that chain:
//   - global AGC breathing (gentle: consumer gain ceiling is FAR below a
//     Gen-3 tube's MCP - "uses infrared, but not as much as the tube"),
//   - heavy shot/gain luma noise, hot-pixel pops (not MCP scintillation),
//   - field lag / slow-shutter ghosting,
//   - hot retro-reflections (the LED bounces straight back off glasses,
//     jewellery, tapetum),
//   - interline VERTICAL SMEAR columns under bright NIR speculars,
//   - the camera's green monochrome rendering with a lifted murky floor,
//   - and finally the camcorder's analog tape/signal path.
//
// COMPOSITION, not reimplementation: the InfraredPipeline already owns NIR
// image formation (flux prepass from RGB or a true-NIR render, analysis,
// temporal ABC, persistence, retro-flare, tinted display) - a NightShot
// preset re-purposes it as the CCD (chicken-wire off, scintillation ~ off,
// local adaptation ~ off, gentle global ABC, green display chroma). Its
// developed frame passes a dedicated interline-smear stage (below), then the
// classic Pipeline in ANALOG mode renders the tape path at NTSC-class
// resolution (stage-1 input IS the downsample; the output blit upscales).

import * as THREE from "three/webgpu";
import {
  vec2, vec3, vec4, float, uniform, texture, screenUV,
  dot, smoothstep,
} from "three/tsl";
import { InfraredPipeline, INFRARED_PRESETS, applyInfraredPreset } from "./infrared.js";
import { Pipeline, applyPreset as applyCameraPreset } from "./pipeline.js";
import { PRESETS } from "./presets.js";

const LUM709 = vec3(0.2126, 0.7152, 0.0722);

// ── Presets ─────────────────────────────────────────────────────────
// `ir` is a complete InfraredPipeline preset (applyInfraredPreset reads every
// field, so it spreads the shipped tube preset and overrides the CCD deltas).
// `cam` is a complete classic-ISP preset for the analog back end.

export const NIGHTSHOT_PRESETS = {
  nightshot_plus: {
    name: "Sony NightShot Plus",
    smear: 0.9,
    smear_threshold: 0.72,
    ir: {
      ...INFRARED_PRESETS.white_phosphor_nir,
      name: "NightShot CCD sensor",
      exposure: 0.0,
      // silicon sees the same NIR flux the tube path resolves; the difference
      // is everything downstream of the sensor:
      photocathode_gamma: 1.0,
      ebi: 0.02,             // consumer CCD dark floor - lifted, murky
      middle_grey: 0.3,      // AGC aims brighter than a tube operator would
      local_gain: 0.08,      // CCD AGC is global - almost no local shading
      min_gain: 0.7,
      max_gain: 2.6,         // gain ceiling far below an MCP
      abc_attack: 0.15,      // consumer AGC loop is slower than a tube ABC
      abc_recover: 0.55,
      abc_min: 0.5,
      abc_max: 2.2,
      gain: 2.2,             // vs 6.5 on the Gen-3 tube
      max_output: 0.96,
      glow_threshold: 0.55,  // mild lens/CCD bloom, not an intensifier halo
      glow_strength: 0.28,
      glow_radius: 1.3,
      glow_saturate: 1.1,
      eye_strength: 0.9,     // LED retro-reflections: glasses/jewellery burn hot
      psf_sigma: 1.35,       // consumer optics
      chicken_amp: 0.0,      // no multifibre hex pattern on a CCD
      noise_amount: 0.5,
      scint_density: 0.002,  // rare hot-pixel pops only...
      scint_gain: 0.3,
      scint_sharp: 5.0,
      scint_dark_boost: 1.2,
      shot_strength: 0.075,  // ...the NightShot grain is shot/AGC luma noise
      scint_floor: 0.6,
      phosphor_chroma: [0.47, 0.98, 0.58],  // the camera's green rendering
      highlight_white: [0.86, 1.0, 0.88],   // highlights stay green-white
      screen_black: 0.045,   // lifted green-grey floor
      screen_gain: 1.05,
      screen_shoulder: 0.78,
      phosphor_gamma: 1.02,
      highlight_desat: 0.35,
      vignette: 0.3,
      hotspot: 0.5,          // the LED sits beside the lens: centre-hot field
      persistence: 0.5,      // field lag / slow-shutter ghosting
    },
    cam: {
      ...PRESETS.cybershot,  // Sony DSP heritage for anything the analog pass reads
      name: "NightShot camcorder path",
      analog_vhs_strength: 1.15,
      analog_tracking: 0.45,
      analog_chroma_bleed: 0.15, // mono green - nothing to bleed
      analog_ringing: 0.95,      // camcorder edge sharpening rings on luma
      analog_tape_noise: 0.85,
      analog_band_mask: 0.3,
      analog_edge_wave: 0.3,
      analog_dropouts: 0.35,
      analog_scanlines: 0.75,
      analog_head_switch: 0.5,
    },
  },
};

export const NIGHTSHOT_PRESET_KEYS = Object.keys(NIGHTSHOT_PRESETS);

export function applyNightshotPreset(pipeline, preset) {
  applyInfraredPreset(pipeline.ir.ctx, preset.ir);
  applyCameraPreset(pipeline.cam.ctx, preset.cam);
  pipeline.ctx.P.smear.value = preset.smear ?? 0.9;
  pipeline.ctx.P.smearThreshold.value = preset.smear_threshold ?? 0.72;
}

// ── Pipeline ────────────────────────────────────────────────────────

export class NightshotPipeline {
  constructor(renderer) {
    this.renderer = renderer;

    // sensor front end: NIR image formation with the tube character preset-ed
    // away (see NIGHTSHOT_PRESETS.nightshot_plus.ir).
    this.ir = new InfraredPipeline(renderer);
    this.ir.outputEncoding = "srgb"; // developed sensor image, display-ready

    // camcorder back end: analog tape/signal path at NTSC-class resolution.
    this.cam = new Pipeline(renderer);
    this.cam.setMode("analog");
    this.cam.setInputEncoding("srgb");

    this.ctx = {
      power: uniform(1),
      P: {
        smear: uniform(0.9),          // interline vertical-smear strength
        smearThreshold: uniform(0.72), // luma knee where columns start bleeding
      },
    };
    // texel of the quarter-height smear target (streak tap spacing)
    this._smearTexel = uniform(new THREE.Vector2(1, 1));

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.rtSensor = new THREE.RenderTarget(1, 1, opts);
    this.rtSensorSmeared = new THREE.RenderTarget(1, 1, { ...opts });
    // quarter-height pair for the column streak (full width - smear is
    // per-column, so horizontal resolution must survive)
    this.rtSmearA = new THREE.RenderTarget(1, 1, { ...opts });
    this.rtSmearB = new THREE.RenderTarget(1, 1, { ...opts });

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.mesh.frustumCulled = false;
    this.quadScene.add(this.mesh);

    this.size = { w: 0, h: 0 };
    this._smearMats = null;
  }

  _mat(colorNode) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = colorNode;
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    return m;
  }

  setInputEncoding(mode) {
    this.ir.setInputEncoding(mode);
  }

  setInputExposure(stops = 0) {
    this.ir.setInputExposure?.(stops);
  }

  setOutputColorGrading(grading) {
    this.cam.setOutputColorGrading?.(grading);
  }

  setSource(tex) {
    this.ir.setSource(tex);
  }

  setSize(w, h) {
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.ir.setSize(w, h);
    this.rtSensor.setSize(w, h);
    this.rtSensorSmeared.setSize(w, h);
    const sh = Math.max(1, Math.round(h / 4));
    this.rtSmearA.setSize(w, sh);
    this.rtSmearB.setSize(w, sh);
    this._smearTexel.value.set(1 / Math.max(1, w), 1 / sh);
    // The camcorder DSP + tape path run at NTSC-class resolution; the
    // Pipeline's mandatory input pass performs the downsample by sampling the
    // (larger) sensor image, and its output blit upscales to the canvas.
    const fit = Math.min(1, 720 / Math.max(1, w), 480 / Math.max(1, h));
    this.cam.setSize(Math.max(1, Math.round(w * fit)), Math.max(1, Math.round(h * fit)));
  }

  _ensureSmearMats() {
    if (this._smearMats) return this._smearMats;
    const P = this.ctx.P;

    // 1) extract: energy above the smear knee, luma-weighted, into the
    //    quarter-height target (vertical pre-average of the column charge).
    const src = texture(this.rtSensor.texture, screenUV);
    const luma = dot(src.rgb, LUM709);
    const charge = smoothstep(P.smearThreshold, float(1.0), luma).mul(luma);
    const extract = this._mat(vec4(vec3(charge), 1.0));

    // 2) streak: interline readout bleeds the column - a wide vertical tent
    //    on the quarter target (25 taps x 3-texel spacing ~ 300 full-res rows).
    const weights = [];
    let wsum = 0;
    for (let i = -12; i <= 12; i += 1) {
      const wgt = 1 / (1 + Math.abs(i) * 0.55);
      weights.push({ i, wgt });
      wsum += wgt;
    }
    let acc = null;
    for (const { i, wgt } of weights) {
      const tap = texture(this.rtSmearA.texture, screenUV.add(vec2(0.0, i * 3).mul(this._smearTexel)));
      const term = tap.r.mul(wgt / wsum);
      acc = acc === null ? term : acc.add(term);
    }
    const streak = this._mat(vec4(vec3(acc), 1.0));

    // 3) composite: add the streak back over the sensor image. Slightly
    //    green-white - smear saturates the column toward the display tint.
    const base = texture(this.rtSensor.texture, screenUV);
    const smeared = texture(this.rtSmearB.texture, screenUV).r;
    const column = vec3(0.85, 1.0, 0.9).mul(smeared).mul(P.smear);
    const composite = this._mat(vec4(base.rgb.add(column).clamp(0.0, 1.0), base.a));

    this._smearMats = { extract, streak, composite };
    return this._smearMats;
  }

  renderTexture(inputTexture, frame = 0, { outputTarget = null, dt = 1 / 60 } = {}) {
    if (!inputTexture) return false;
    // Amount rides both halves: the sensor develop mixes NV against the
    // source frame, and the camcorder output mix uses the same weight.
    this.ir.ctx.power.value = this.ctx.power.value;
    this.cam.ctx.power.value = this.ctx.power.value;

    if (!this.ir.renderTexture(inputTexture, frame, { outputTarget: this.rtSensor, dt })) {
      return false;
    }

    let camSource = this.rtSensor;
    if (this.ctx.P.smear.value > 1e-4) {
      const mats = this._ensureSmearMats();
      const r = this.renderer;
      const previousTarget = r.getRenderTarget?.() ?? null;
      try {
        this.mesh.material = mats.extract;
        r.setRenderTarget(this.rtSmearA);
        r.render(this.quadScene, this.quadCam);
        this.mesh.material = mats.streak;
        r.setRenderTarget(this.rtSmearB);
        r.render(this.quadScene, this.quadCam);
        this.mesh.material = mats.composite;
        r.setRenderTarget(this.rtSensorSmeared);
        r.render(this.quadScene, this.quadCam);
      } finally {
        r.setRenderTarget(previousTarget);
      }
      camSource = this.rtSensorSmeared;
    }

    return this.cam.renderTexture(camSource.texture, frame, { outputTarget }) === true;
  }

  async render(frame, options = {}) {
    return this.renderTexture(this.ir.source, frame, options);
  }

  clearHistory() {
    this.ir.clearHistory();
  }

  dispose() {
    this.ir.dispose();
    this.cam.dispose();
    if (this._smearMats) {
      this._smearMats.extract.dispose();
      this._smearMats.streak.dispose();
      this._smearMats.composite.dispose();
      this._smearMats = null;
    }
    this.rtSensor.dispose();
    this.rtSensorSmeared.dispose();
    this.rtSmearA.dispose();
    this.rtSmearB.dispose();
    this.mesh.geometry.dispose();
  }
}
