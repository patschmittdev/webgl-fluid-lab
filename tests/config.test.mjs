import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeAutoSplats, normalizeSharedState, encodeShareState, decodeShareState, MAX_PALETTE } from "../assets/config.js";
import { PRESETS, PHYSICS_DEFAULTS, VIEWS } from "../assets/presets.js";

test("unknown and prototype-shaped keys are dropped", () => {
  const input = JSON.parse("{\"unknown\":1,\"__proto__\":{\"polluted\":true},\"constructor\":{},\"pressure\":0.5}");
  assert.deepEqual(normalizeConfig(input), { pressure: 0.5 });
  assert.equal({}.polluted, undefined);
});
test("numbers clamp and non-finite values are dropped", () => {
  assert.deepEqual(normalizeConfig({ pressure: 9, curl: -2, brightness: Infinity, splatForce: NaN, dyeResolution: "512" }), { pressure: 1, curl: 0 });
  assert.equal(normalizeAutoSplats(30), 20);
  assert.equal(normalizeAutoSplats(-1), 0);
  assert.equal(normalizeAutoSplats(Infinity), 5);
});
test("colours require six hex digits and palettes are filtered", () => {
  assert.deepEqual(normalizeConfig({ backgroundColor: "red", colorPalette: ["#ABCDEF", "#123456", "#fff", 123, "red"] }), { colorPalette: ["#ABCDEF", "#123456"] });
  assert.deepEqual(normalizeConfig({ backgroundColor: "#abcdef", colorPalette: [] }), { backgroundColor: "#abcdef", colorPalette: [] });
});
test("share state round trips", () => {
  const state = { config: { pressure: 0.5, colorPalette: ["#abcdef"] }, preset: "smoke", autoSplats: 8, jet: false };
  assert.deepEqual(decodeShareState(encodeShareState(state)), state);
});
test("legacy config hashes load", () => {
  const hash = encodeShareState({ pressure: 0.4 }).replace("#s=", "#c=");
  assert.deepEqual(decodeShareState(hash), { config: { pressure: 0.4 } });
});
test("malformed hashes and invalid inputs do not throw", () => {
  for (const hash of ["#s=garbage", "#s=", "#s=%", encodeShareState(null), encodeShareState([]), null]) {
    assert.equal(decodeShareState(hash), null);
  }
  assert.deepEqual(normalizeConfig(null), {});
});
test("unknown and inherited preset names are discarded", () => {
  for (const preset of ["missing", "__proto__", "constructor"]) {
    const decoded = decodeShareState(encodeShareState({ config: { pressure: 0.2 }, preset }));
    assert.equal(Object.hasOwn(decoded, "preset"), false);
    assert.deepEqual(decoded.config, { pressure: 0.2 });
  }
});

test("view accepts only the five field names", () => {
  assert.deepEqual(VIEWS, ["dye", "speed", "vorticity", "pressure", "temperature"]);
  for (const view of VIEWS) {
    assert.deepEqual(normalizeConfig({ view }), { view });
  }
  for (const view of ["", "Dye", "curl", "__proto__", "<img src=x>", 0, true, null, [], {}, ["dye"]]) {
    assert.deepEqual(normalizeConfig({ view }), {});
  }
});

test("physics numbers clamp and reject nonnumeric values", () => {
  const maximums = { inflow: 200, buoyancy: 150, cooling: 4, heat: 5, throttle: 1 };
  for (const [key, maximum] of Object.entries(maximums)) {
    assert.deepEqual(normalizeConfig({ [key]: -1 }), { [key]: 0 });
    assert.deepEqual(normalizeConfig({ [key]: maximum + 1 }), { [key]: maximum });
    assert.deepEqual(normalizeConfig({ [key]: maximum / 2 }), { [key]: maximum / 2 });
    for (const value of [NaN, Infinity, -Infinity, "1", null, true, [], {}]) {
      assert.deepEqual(normalizeConfig({ [key]: value }), {});
    }
  }
});

test("old full share payloads decode without adding physics keys", () => {
  for (const preset of ["pavel", "smoke", "ink"]) {
    const config = structuredClone(PRESETS[preset].config);
    const state = { config, preset, autoSplats: 5, jet: PRESETS[preset].startJet };
    for (const key of Object.keys(PHYSICS_DEFAULTS)) {
      assert.equal(Object.hasOwn(config, key), false);
    }
    assert.deepEqual(decodeShareState(encodeShareState(state)), state);
    assert.deepEqual(decodeShareState(encodeShareState(config).replace("#s=", "#c=")), { config });
  }
});

test("new share payloads validate physics and omit tool and wall data", () => {
  const decoded = decodeShareState(encodeShareState({
    config: {
      view: "temperature",
      heat: 100,
      inflow: -3,
      buoyancy: 70,
      cooling: 0.5,
      tool: "wall",
      obstacles: [{ x: 0.2, y: 0.5, radius: 0.1 }],
    },
    preset: "blackhole",
  }));
  assert.deepEqual(decoded, {
    config: { view: "temperature", heat: 5, inflow: 0, buoyancy: 70, cooling: 0.5 },
    preset: "blackhole",
    jet: false,
  });
});

test("renamed presets preserve legacy share links and validation", () => {
  for (const [oldId, preset] of [["wick", "flame"], ["paper", "ink"]]) {
    const decoded = decodeShareState(encodeShareState({ preset: oldId, config: { pressure: 9, unknown: true } }));
    assert.equal(decoded.preset, preset);
    assert.deepEqual(decoded.config, { pressure: 1 });
  }
});

test("flame shading coerces to boolean and Flame settings survive sharing", () => {
  for (const value of [0, 1, "", "false", null, [], {}]) {
    assert.deepEqual(normalizeConfig({ flameShading: value }), { flameShading: Boolean(value) });
  }
  const state = { preset: "flame", config: PRESETS.flame.config, jet: false };
  assert.deepEqual(decodeShareState(encodeShareState(state)), state);
});

test("every preset starts at the resolution maximums", () => {
  for (const preset of Object.values(PRESETS)) {
    assert.equal(preset.config.simResolution, 512);
    assert.equal(preset.config.dyeResolution, 2048);
    assert.ok(preset.config.pressureIterations <= 50);
  }
});

test("imported palettes are cut to the number of swatches the panel allows", () => {
  const palette = normalizeConfig({ colorPalette: Array.from({ length: 100000 }, () => "#ffffff") }).colorPalette;
  assert.equal(palette.length, MAX_PALETTE);
  assert.deepEqual(normalizeConfig({ colorPalette: ["red", "#000000"] }), { colorPalette: ["#000000"] });
});

test("exported settings files load with their preset, and older flat files still load", () => {
  const saved = { preset: "flame", config: { pressure: 0.5, flameShading: true }, jet: true, autoSplats: 3 };
  assert.deepEqual(normalizeSharedState(JSON.parse(JSON.stringify(saved))), saved);
  assert.deepEqual(normalizeSharedState({ pressure: 9, unknown: 1 }), { config: { pressure: 1 } });
  assert.deepEqual(normalizeSharedState({ preset: "wick", config: {} }), { preset: "flame", config: {}, jet: false });
  for (const preset of ["missing", "toString", "__proto__", 4, {}, null]) {
    assert.equal(normalizeSharedState({ preset, config: {} }).preset, undefined);
  }
  for (const input of [null, [], "text", 4]) {
    assert.equal(normalizeSharedState(input), null);
  }
});
