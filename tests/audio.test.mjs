import test from "node:test";
import assert from "node:assert/strict";
import { spectrumLevels, followEnvelope, createBeatDetector, createAudioAnalysis, modulateConfig, createMusicResponse } from "../assets/audio.js";
import { normalizeConfig, encodeShareState, decodeShareState, NUMBER_RANGES, EXTRA_NUMBER_RANGE_KEYS } from "../assets/config.js";
import { PRESETS, PHYSICS_DEFAULTS } from "../assets/presets.js";

function spectrum(from, to) {
  return Uint8Array.from({ length: 1024 }, (_, i) => {
    const hz = i * 48000 / 2048;
    return hz >= from && hz < to ? 255 : 0;
  });
}

test("synthetic bass, treble and silence produce bounded band levels and centroid", () => {
  const silence = spectrumLevels(new Uint8Array(1024), 48000);
  assert.deepEqual(silence, { bass: 0, mid: 0, treble: 0, overall: 0, brightness: 0 });
  const bass = spectrumLevels(spectrum(20, 250), 48000);
  const treble = spectrumLevels(spectrum(2000, 16000), 48000);
  assert.equal(bass.bass, 1);
  assert.equal(bass.mid, 0);
  assert.equal(bass.treble, 0);
  assert.equal(treble.bass, 0);
  assert.equal(treble.mid, 0);
  assert.equal(treble.treble, 1);
  assert.ok(treble.brightness > bass.brightness);
  assert.ok(bass.overall > 0);
  for (const levels of [bass, treble, silence, spectrumLevels([], 48000)]) {
    assert.ok(Object.values(levels).every(value => value >= 0 && value <= 1));
  }
});

test("envelopes attack quickly, release slowly and do not depend on frame subdivision", () => {
  const attack = followEnvelope(0, 1, 0.025);
  const release = followEnvelope(1, 0, 0.025);
  assert.ok(attack > 0.6 && attack < 0.7);
  assert.ok(release > 0.9 && release < 1);
  assert.equal(followEnvelope(0.4, 1, 0), 0.4);
  const subdivided = followEnvelope(followEnvelope(0, 1, 0.01), 1, 0.015);
  assert.ok(Math.abs(subdivided - attack) < 1e-12);
  assert.ok(followEnvelope(1, 0, 0.3) < release);
});

test("104 BPM bass pulses fire once per pulse and expose elapsed beat time", () => {
  const detect = createBeatDetector();
  const beats = [];
  const period = 60 / 104;
  const dt = 1 / 240;
  const count = 16;
  let result;
  for (let i = 0; i < (0.2 + count * period) / dt; i += 1) {
    const time = i * dt;
    const phase = (time - 0.2) % period;
    const bass = time >= 0.2 && phase < 0.09 ? 0.85 : 0.01;
    result = detect(bass, time, dt);
    if (result.beat) {
      beats.push(time);
      assert.equal(result.timeSinceBeat, 0);
    }
  }
  assert.equal(beats.length, count);
  for (let i = 1; i < beats.length; i += 1) {
    assert.ok(Math.abs(beats[i] - beats[i - 1] - period) <= dt);
  }
  assert.ok(result.timeSinceBeat > 0.5);
});

test("steady tones and silence never trigger and refractory rejects close onsets", () => {
  for (const level of [0, 0.2, 0.95]) {
    const detect = createBeatDetector();
    for (let i = 0; i < 600; i += 1) {
      assert.equal(detect(level, i / 60, 1 / 60).beat, false);
    }
  }
  const detect = createBeatDetector(0.3);
  detect(0, 0, 0.01);
  assert.equal(detect(0.9, 0.1, 0.01).beat, true);
  detect(0, 0.15, 0.05);
  assert.equal(detect(0.9, 0.2, 0.05).beat, false);
  detect(0, 0.3, 0.1);
  assert.equal(detect(0.9, 0.41, 0.11).beat, true);
});

test("analysis follows levels while detecting the unsmoothed onset", () => {
  const analyse = createAudioAnalysis();
  analyse(spectrum(0, 0), 48000, 0, 1 / 60);
  const onset = analyse(spectrum(20, 250), 48000, 0.1, 1 / 60);
  assert.equal(onset.beat, true);
  assert.ok(onset.bass > 0 && onset.bass < 1);
  const tail = analyse(spectrum(0, 0), 48000, 0.2, 0.1);
  assert.equal(tail.beat, false);
  assert.ok(tail.bass > 0 && tail.bass < onset.bass);
});

test("every preset modulation stays in config ranges without changing saved settings", () => {
  for (const preset of Object.values(PRESETS)) {
    assert.ok(preset.music);
    for (const sensitivity of [0, 1, 2]) {
      for (const level of [0, 0.1, 0.5, 1]) {
        const config = { ...PHYSICS_DEFAULTS, ...preset.config, musicSensitivity: sensitivity };
        const before = structuredClone(config);
        const features = { bass: level, mid: level, treble: level, overall: level, brightness: level, timeSinceBeat: 0 };
        for (const key of ["curl", "inflow", "heat", "bloomIntensity", "throttle"]) {
          config[key] = NUMBER_RANGES.get(EXTRA_NUMBER_RANGE_KEYS[key] ?? key).max;
        }
        const saved = structuredClone(config);
        const result = modulateConfig(config, preset.music, features, level);
        assert.deepEqual(result, normalizeConfig(result));
        assert.deepEqual(config, saved);
        assert.deepEqual(modulateConfig(before, preset.music, null), before);
        assert.equal(result.brightness, config.brightness);
      }
    }
  }
});

test("preset mappings respond to the intended bands", () => {
  const levels = { bass: 1, mid: 1, overall: 1, timeSinceBeat: 1 };
  for (const [id, key] of [["flame", "throttle"], ["smoke", "curl"], ["ink", "curl"], ["pavel", "curl"], ["plume", "heat"]]) {
    const preset = PRESETS[id];
    const config = { ...PHYSICS_DEFAULTS, ...preset.config };
    assert.ok(modulateConfig(config, preset.music, levels)[key] > config[key], id);
  }
});

test("flashing limits cap bursts and bloom updates and stopping removes modulation", () => {
  for (const reduceFlashing of [false, true]) {
    const response = createMusicResponse();
    const config = { ...PHYSICS_DEFAULTS, ...PRESETS.pavel.config, reduceFlashing };
    const burstTimes = [];
    const glowTimes = [];
    let glow;
    for (let i = 0; i < 300; i += 1) {
      const time = i / 60;
      const result = response(config, PRESETS.pavel.music, {
        bass: 1, mid: 1, treble: i % 2, overall: 1, brightness: 1, beat: true, timeSinceBeat: 0,
      }, time);
      if (result.burst) {
        burstTimes.push(time);
      }
      if (glow !== result.config.bloomIntensity) {
        glowTimes.push(time);
        glow = result.config.bloomIntensity;
      }
      if (reduceFlashing) {
        assert.equal(glow, config.bloomIntensity);
      }
    }
    for (let i = 1; i < burstTimes.length; i += 1) {
      assert.ok(burstTimes[i] - burstTimes[i - 1] >= (reduceFlashing ? 0.5 : 1 / 3));
    }
    for (let i = 1; i < glowTimes.length; i += 1) {
      assert.ok(glowTimes[i] - glowTimes[i - 1] >= 1 / 3);
    }
    assert.deepEqual(response(config, {}, null, 6), { config, burst: false, hue: 0, spin: 1, energy: 0 });
  }
});

test("music and symmetry config validate and source data is discarded on import", () => {
  assert.deepEqual(normalizeConfig({ symmetry: 1, symmetrySpin: 4, musicSensitivity: -1, reduceFlashing: 1 }), {
    symmetry: 0, symmetrySpin: 1, musicSensitivity: 0, reduceFlashing: true,
  });
  for (const [input, output] of [[-4, 0], [0.6, 0], [1.6, 2], [8.4, 8], [8.5, 9], [99, 16]]) {
    assert.equal(normalizeConfig({ symmetry: input }).symmetry, output);
  }
  assert.deepEqual(normalizeConfig({ symmetry: Infinity, musicSensitivity: NaN, symmetrySpin: "1" }), {});
  const config = { symmetry: 8, symmetrySpin: -0.2, musicSensitivity: 2, reduceFlashing: true };
  const decoded = decodeShareState(encodeShareState({ preset: "collide", config: { ...config, audioSource: "tab", track: "private.mp3" }, source: "demo" }));
  assert.deepEqual(decoded, { preset: "collide", config, jet: false });
});

test("zero sensitivity returns the settings untouched for every preset", () => {
  const features = { bass: 1, mid: 1, treble: 1, overall: 1, brightness: 1, beat: true, timeSinceBeat: 0 };
  for (const preset of Object.values(PRESETS)) {
    const config = { ...PHYSICS_DEFAULTS, ...preset.config, musicSensitivity: 0 };
    assert.deepEqual(modulateConfig(config, preset.music, features, 1, 1), config);
    const respond = createMusicResponse();
    const response = respond(config, preset.music, features, 1);
    assert.deepEqual(response.config, config);
    assert.equal(response.burst, false);
  }
});
