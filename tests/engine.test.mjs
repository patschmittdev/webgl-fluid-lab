import test from "node:test";
import assert from "node:assert/strict";
import createEngine from "../assets/engines/lab.js";
import { PRESETS, PHYSICS_DEFAULTS, VIEWS } from "../assets/presets.js";
import { FRAGMENT_SHADERS } from "../assets/engines/lab/shaders.js";
import { normalizeConfig } from "../assets/config.js";

function fixture(t, config) {
  const live = new Set();
  const draws = [];
  const uniforms = [];
  const textures = new Map();
  let framebuffer;
  let program;
  let unit = 0;
  const allocate = kind => {
    const resource = { kind };
    live.add(resource);
    return resource;
  };
  const release = resource => {
    assert.ok(live.delete(resource), "resource deleted once");
  };
  const canvas = {
    style: {},
    width: 640,
    height: 480,
    clientWidth: 640,
    clientHeight: 480,
    addEventListener() {
    },
    removeEventListener() {
    },
    remove() {
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
  };
  const api = {
    TEXTURE0: 100,
    createShader: () => allocate("shader"),
    createProgram: () => allocate("program"),
    createTexture: () => allocate("texture"),
    createFramebuffer: () => allocate("framebuffer"),
    createVertexArray: () => allocate("vao"),
    deleteShader: release,
    deleteProgram: release,
    deleteTexture: release,
    deleteFramebuffer: release,
    deleteVertexArray: release,
    getExtension: () => ({}),
    getShaderParameter: () => true,
    shaderSource(shader, source) {
      assert.equal(typeof source, "string");
      shader.source = source;
    },
    attachShader(target, shader) {
      target.source = (target.source ?? "") + shader.source;
    },
    linkProgram(target) {
      target.uniforms = [...target.source.matchAll(/uniform\s+(\w+)\s+(\w+);/g)]
        .map(([, type, name]) => ({ type, name, value: 0 }));
    },
    getProgramParameter: (target, parameter) => parameter === "ACTIVE_UNIFORMS" ? target.uniforms.length : true,
    getActiveUniform: (target, index) => target.uniforms[index],
    getUniformLocation: (target, name) => target.uniforms.find(uniform => uniform.name === name),
    uniform1i(location, value) {
      if (location) {
        location.value = value;
      }
    },
    uniform1f(location, value) {
      if (location) {
        location.value = value;
        uniforms.push({ name: location.name, value });
      }
    },
    uniform2f(location, ...value) {
      if (location) {
        location.value = value;
        uniforms.push({ name: location.name, value });
      }
    },
    uniform3f(location, ...value) {
      if (location) {
        location.value = value;
        uniforms.push({ name: location.name, value });
      }
    },
    useProgram(target) {
      program = target;
    },
    activeTexture(value) {
      unit = value - 100;
    },
    bindTexture(type, texture) {
      textures.set(unit, texture);
    },
    bindFramebuffer(type, target) {
      framebuffer = target;
    },
    framebufferTexture2D(type, attachment, textureType, texture) {
      framebuffer.texture = texture;
    },
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    drawArrays() {
      assert.ok(live.has(program), "program is live");
      if (framebuffer) {
        assert.ok(live.has(framebuffer), "framebuffer is live");
        assert.ok(live.has(framebuffer.texture), "attachment is live");
      }
      for (const uniform of program.uniforms.filter(item => item.type === "sampler2D")) {
        const texture = textures.get(uniform.value);
        assert.ok(live.has(texture), "sampled texture is live: " + uniform.name);
        assert.notEqual(texture, framebuffer?.texture, "no framebuffer feedback: " + uniform.name);
      }
      draws.push(program);
    },
  };
  const noop = () => {
  };
  const gl = new Proxy(api, {
    get(target, key) {
      if (key === "drawingBufferWidth") {
        return canvas.width;
      }
      if (key === "drawingBufferHeight") {
        return canvas.height;
      }
      return target[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : noop);
    },
  });
  canvas.getContext = () => gl;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = { createElement: () => canvas };
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });
  const host = {
    appendChild() {
    },
  };
  const engine = createEngine(host, { ...PHYSICS_DEFAULTS, ...config });
  t.after(() => {
    engine.destroy();
    assert.equal(live.size, 0, "all GPU resources released");
  });
  return { engine, canvas, draws, live, uniforms };
}

test("original presets allocate no physics targets and keep their solver pass count", t => {
  const { engine, draws } = fixture(t, PRESETS.pavel.config);
  for (const name of ["pavel", "smoke", "ink"]) {
    engine.setConfig({ ...PHYSICS_DEFAULTS, ...PRESETS[name].config });
    engine.reset({});
    draws.length = 0;
    engine.step(1 / 60);
    assert.equal(draws.length, PRESETS[name].config.pressureIterations + 7);
    assert.equal(engine.targets.obstacles, null);
    assert.equal(engine.targets.temperature, null);
    assert.ok(draws.every(program => !program.source.includes("obstacleField")));
  }
});

test("all new presets and views draw without resource feedback", t => {
  const { engine } = fixture(t, PRESETS.tunnel.config);
  for (const name of ["tunnel", "plume", "flame"]) {
    engine.setConfig(PRESETS[name].config);
    engine.reset(PRESETS[name].physics);
    engine.step(1 / 60);
    for (const view of VIEWS) {
      engine.setConfig({ view });
      engine.ensureTargets();
      engine.step(1 / 60);
      engine.render();
      if (view !== "dye") {
        assert.equal(engine.targets.bloom.length, 0);
        assert.equal(engine.targets.sunrays, null);
      }
    }
  }
});

test("walls, heat, resize, resolution changes, and reset release replaced targets", t => {
  const { engine, canvas, live } = fixture(t, PRESETS.pavel.config);
  engine.paintWall(0.4, 0.1, 0.4, 0.9, true);
  engine.setConfig({ heat: 2, buoyancy: 30 });
  engine.injectNormalized(0.2, 0.5, 10, 0, [1, 0, 0]);
  engine.step(1 / 60);
  const oldMask = engine.targets.obstacles.read.texture;
  const oldTemperature = engine.targets.temperature.read.texture;
  canvas.clientWidth = 800;
  engine.resizeCanvas();
  engine.ensureTargets();
  assert.equal(live.has(oldMask), false);
  assert.equal(live.has(oldTemperature), false);
  assert.equal(engine.targets.obstacles, null);
  assert.equal(engine.targets.temperature.height, engine.targets.velocity.height);
  const previousTemperature = engine.targets.temperature.read.texture;
  engine.setConfig({ simResolution: 64 });
  assert.equal(live.has(previousTemperature), false);
  assert.equal(engine.targets.temperature.height, 64);
  engine.clearWalls();
  assert.equal(engine.targets.obstacles, null);
  engine.setConfig({ ...PHYSICS_DEFAULTS, ...PRESETS.pavel.config });
  engine.reset({});
  assert.equal(engine.targets.temperature, null);
  assert.equal(engine.targets.obstacles, null);
});

test("seeded walls return on reset and temperature view does not retain an unused field", t => {
  const { engine, canvas, live } = fixture(t, PRESETS.tunnel.config);
  engine.reset(PRESETS.tunnel.physics);
  assert.ok(engine.targets.obstacles);
  const oldMask = engine.targets.obstacles.read.texture;
  canvas.clientWidth = 800;
  engine.resizeCanvas();
  engine.ensureTargets();
  assert.equal(live.has(oldMask), false);
  assert.equal(engine.targets.obstacles.width, engine.targets.velocity.width);
  engine.clearWalls();
  assert.equal(engine.targets.obstacles, null);
  engine.reset();
  assert.ok(engine.targets.obstacles);
  engine.setConfig({ ...PHYSICS_DEFAULTS, ...PRESETS.smoke.config, view: "temperature" });
  engine.reset({});
  assert.ok(engine.targets.temperature);
  engine.setConfig({ view: "dye" });
  engine.ensureTargets();
  assert.equal(engine.targets.temperature, null);
});

test("ink uses the display shader and skips glow even when enabled", t => {
  const { engine, canvas, draws } = fixture(t, { ...PRESETS.ink.config, bloom: true, sunrays: true });
  engine.splat(200, 200, 0, 0);
  draws.length = 0;
  engine.render();
  assert.equal(draws.length, 1);
  assert.equal(engine.targets.bloom.length, 0);
  assert.equal(engine.targets.sunrays, null);
  assert.equal(canvas.style.filter, undefined);
  assert.equal(draws[0].uniforms.find(item => item.name === "useInk").value, 1);
  let captured = false;
  canvas.toBlob = () => { captured = true; };
  engine.screenshot();
  assert.equal(captured, true);
});

test("each preset adds a fixed number of solver passes", t => {
  const { engine, draws } = fixture(t, PRESETS.pavel.config);
  const overhead = { pavel: 7, smoke: 7, ink: 7, tunnel: 9, plume: 11 };
  for (const [name, passes] of Object.entries(overhead)) {
    engine.setConfig({ ...PHYSICS_DEFAULTS, ...PRESETS[name].config });
    engine.reset(PRESETS[name].physics ?? {});
    draws.length = 0;
    engine.step(1 / 60);
    assert.equal(engine.config.flameShading, false);
    assert.equal(draws.length, engine.config.pressureIterations + passes, name);
  }
});

test("splat, inlet, buoyancy, curl and safety limits scale with simulation height", t => {
  const { engine, canvas, uniforms } = fixture(t, PRESETS.pavel.config);
  for (const [width, height] of [[640, 480], [480, 800]]) {
    canvas.clientWidth = width;
    canvas.clientHeight = height;
    engine.resizeCanvas();
    for (const simResolution of [32, 128, 256, 512]) {
      engine.setConfig({ simResolution, inflow: 40, buoyancy: 30, heat: 1, curl: 5 });
      engine.ensureTargets();
      const scale = engine.targets.velocity.height / 128;
      uniforms.length = 0;
      engine.injectNormalized(0.4, 0.5, 100, -50, [1, 1, 1]);
      assert.deepEqual(uniforms.find(item => item.name === "amount").value, [100 * scale, -50 * scale, 0]);
      engine.step(1 / 60);
      assert.ok(uniforms.some(item => item.name === "inflow" && item.value === 40 * scale));
      assert.ok(uniforms.some(item => item.name === "buoyancy" && item.value === 30 * scale));
      assert.ok(uniforms.some(item => item.name === "strength" && item.value === 5 * scale));
      assert.ok(uniforms.filter(item => item.name === "velocityScale").every(item => item.value === scale));
    }
  }
});

test("preset force tuning retains the previous screen-space input speeds", () => {
  const inputs = [
    ["pavel", "splatForce", 6000, 128],
    ["smoke", "splatForce", 6000, 384],
    ["ink", "splatForce", 6000, 384],
    ["tunnel", "inflow", 80, 256],
    ["plume", "buoyancy", 65, 192],
    ["smoke", "curl", 8, 384],
    ["ink", "curl", 10, 384],
    ["plume", "curl", 6, 192],
  ];
  for (const [name, key, previous, resolution] of inputs) {
    const expected = previous / resolution;
    assert.ok(Math.abs(PRESETS[name].config[key] / 128 - expected) <= expected * 0.05, `${name} ${key}`);
  }
});

test("Flame emitter narrows, heats and accelerates with throttle and emits three fields every step", t => {
  const { engine, draws, uniforms } = fixture(t, PRESETS.flame.config);
  engine.reset(PRESETS.flame.physics);
  const emitter = engine.scene.emitters[0];
  const samples = [];
  for (const throttle of [0.1, 0.2, 0.5, 0.8, 1]) {
    engine.setConfig({ throttle });
    const source = engine.emitterSource(emitter);
    samples.push(source);
    draws.length = 0;
    uniforms.length = 0;
    engine.step(1 / 60);
    assert.equal(draws.length, engine.config.pressureIterations + 12);
    const amounts = uniforms.filter(item => item.name === "amount").map(item => item.value);
    assert.equal(amounts.length, 3);
    assert.ok(amounts[0][0] > 0, "heat is emitted");
    assert.ok(amounts[1].every(value => value > 0), "fuel is emitted");
    assert.equal(amounts[2][1], source.velocity[1] * engine.velocityScale());
    const extent = uniforms.find(item => item.name === "sourceExtent").value;
    const travel = source.velocity[1] / 128 / 60;
    assert.ok(extent[1] >= Math.min(travel, 0.099), "capsule spans the frame travel up to its cap");
    assert.ok(Math.hypot(extent[0] * 640 / 480, extent[1]) <= 0.100001);
  }
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index].radius < samples[index - 1].radius);
    assert.ok(samples[index].heat > samples[index - 1].heat);
    assert.ok(samples[index].velocity[1] > samples[index - 1].velocity[1]);
    assert.ok(samples[index].dye[0] < samples[index - 1].dye[0], "higher throttle burns cleaner");
  }
  const ramps = [...FRAGMENT_SHADERS.display.matchAll(/ramp = mix\(ramp, vec3\(([^)]+)\), smoothstep\(([\d.]+), ([\d.]+), heat\)\)/g)]
    .map(([, color, start, end]) => ({ color: color.split(",").map(Number), start: Number(start), end: Number(end) }));
  const [, white, blue, blueWhite] = ramps;
  assert.ok(white.start < blue.start && blue.end < blueWhite.end, "heat bands progress from white through blue to blue-white");
  assert.ok(samples[1].heat < white.start, "low throttle stays below white and blue bands");
  assert.ok(samples[2].heat > white.start && samples[2].heat < blue.start, "middle throttle reaches white but stays below blue");
  assert.ok(samples[4].heat >= blueWhite.end, "full throttle reaches the blue-white band");
  for (const ramp of [blue, blueWhite]) {
    assert.ok(ramp.color[0] < 1 && ramp.color[1] < 1, "hottest colours retain blue without clipping red and green");
  }
  uniforms.length = 0;
  engine.injectNormalized(0.5, 0.5, 10, 10, [1, 0, 0]);
  const amounts = uniforms.filter(item => item.name === "amount").map(item => item.value);
  assert.deepEqual(amounts[1], [1, 1, 1]);
  assert.deepEqual(amounts[2], [engine.config.heat, 0, 0]);
  draws.length = 0;
  engine.render();
  const flamePasses = draws.filter(program => program.uniforms.some(item => item.name === "flameShading" && item.value === 1));
  assert.equal(flamePasses.length, 2, "display and bloom both use heat shading");
});

test("Flame targets survive resolution changes and release on reset and recreation", t => {
  const { engine, live } = fixture(t, PRESETS.flame.config);
  engine.reset(PRESETS.flame.physics);
  engine.step(1 / 60);
  engine.render();
  const temperature = engine.targets.temperature.read.texture;
  const dye = engine.targets.dye.read.texture;
  engine.setConfig({ simResolution: 256, dyeResolution: 1024 });
  assert.equal(live.has(temperature), false);
  assert.equal(live.has(dye), false);
  engine.step(1 / 60);
  engine.render();
  engine.setConfig({ ...PHYSICS_DEFAULTS, ...PRESETS.smoke.config });
  engine.reset({});
  assert.equal(engine.targets.temperature, null);
  engine.render();
  engine.destroy();
  assert.equal(live.size, 0);
  const restored = fixture(t, PRESETS.flame.config);
  restored.engine.reset(PRESETS.flame.physics);
  restored.engine.step(1 / 60);
  restored.engine.render();
  assert.ok(restored.engine.targets.temperature);
});

test("heat shading alone allocates and releases its temperature field", t => {
  const { engine, live } = fixture(t, PRESETS.smoke.config);
  engine.setConfig({ flameShading: true });
  engine.ensureTargets();
  const temperature = engine.targets.temperature.read.texture;
  engine.step(1 / 60);
  engine.render();
  engine.setConfig({ flameShading: false });
  engine.ensureTargets();
  assert.equal(engine.targets.temperature, null);
  assert.equal(live.has(temperature), false);
});

test("music modulation reaches the solver while settings and scene remain unchanged", t => {
  const { engine, uniforms } = fixture(t, PRESETS.pavel.config);
  engine.musicMapping = PRESETS.pavel.music;
  engine.setConfig({ splatRadius: 0.01 });
  const settings = structuredClone(engine.config);
  const original = engine.config;
  const scene = structuredClone(engine.scene);
  engine.readMusic = () => ({ bass: 0, mid: 1, treble: 1, overall: 1, brightness: 0.5, beat: true, timeSinceBeat: 0 });
  uniforms.length = 0;
  engine.runFrame(1 / 60, 1);
  assert.equal(engine.config, original);
  assert.deepEqual(engine.config, settings);
  assert.deepEqual(engine.scene, scene);
  assert.deepEqual(engine.musicDisplayConfig, normalizeConfig(engine.musicDisplayConfig));
  assert.ok(uniforms.some(item => item.name === "strength" && item.value > settings.curl * engine.velocityScale()));
  assert.ok(uniforms.some(item => item.name === "bloomIntensity" && item.value > settings.bloomIntensity));
  assert.ok(uniforms.filter(item => item.name === "radius").every(item => item.value >= 0.01 / 100));
  engine.readMusic = () => null;
  uniforms.length = 0;
  engine.runFrame(1 / 60, 2);
  assert.deepEqual(engine.musicDisplayConfig, settings);
  assert.ok(uniforms.some(item => item.name === "strength" && item.value === settings.curl * engine.velocityScale()));
  assert.equal(engine.musicHue, null);
});

test("music heats the Plume emitter, puffs on a beat, and restores it when stopped", t => {
  const preset = PRESETS.plume;
  const { engine, uniforms } = fixture(t, preset.config);
  engine.setConfig(preset.config);
  engine.reset(preset.physics);
  engine.musicMapping = preset.music;
  const scene = structuredClone(engine.scene);
  const heat = scene.emitters[0].heat;
  engine.readMusic = () => ({ bass: 1, mid: 0, treble: 0, overall: 1, brightness: 0, beat: true, timeSinceBeat: 0 });
  uniforms.length = 0;
  engine.runFrame(1 / 60, 1);
  const amounts = uniforms.filter(item => item.name === "amount").map(item => item.value);
  assert.ok(amounts[0][0] > heat && amounts[0][0] <= 5);
  assert.ok(amounts[1][0] > scene.emitters[0].dye[0], "beat adds a smoke puff");
  assert.deepEqual(engine.scene, scene);
  engine.readMusic = () => null;
  uniforms.length = 0;
  engine.runFrame(1 / 60, 2);
  assert.equal(uniforms.find(item => item.name === "amount").value[0], heat);
});

test("symmetry injects rotated and mirrored copies in the solver, not the display", t => {
  const { engine, uniforms, draws, live } = fixture(t, PRESETS.pavel.config);
  const count = live.size;
  engine.setConfig({ symmetry: 4 });
  uniforms.length = 0;
  draws.length = 0;
  engine.injectNormalized(0.6, 0.55, 10, 0, [1, 0, 0]);
  assert.equal(live.size, count, "no extra targets");
  assert.equal(draws.length, 16, "eight copies, each a velocity and a dye splat");
  const centres = uniforms.filter(item => item.name === "center").map(item => item.value);
  const distinct = new Set(centres.map(([x, y]) => x.toFixed(4) + "," + y.toFixed(4)));
  assert.equal(distinct.size, 8);
  const mean = centres.reduce((sum, [x, y]) => [sum[0] + x / centres.length, sum[1] + y / centres.length], [0, 0]);
  assert.ok(Math.abs(mean[0] - 0.5) < 1e-9 && Math.abs(mean[1] - 0.5) < 1e-9, "copies are centred on the screen");
  const pushes = uniforms.filter(item => item.name === "amount").map(item => item.value).filter((_, index) => index % 2 === 0);
  const net = pushes.reduce((sum, [dx, dy]) => [sum[0] + dx, sum[1] + dy], [0, 0]);
  assert.ok(Math.hypot(...net) < 1e-6, "mirrored pushes cancel");
  engine.setConfig({ symmetry: 0 });
  draws.length = 0;
  engine.injectNormalized(0.6, 0.55, 10, 0, [1, 0, 0]);
  assert.equal(draws.length, 2);
  draws.length = 0;
  engine.step(1 / 60);
  assert.equal(draws.length, engine.config.pressureIterations + 7);
  uniforms.length = 0;
  engine.render();
  assert.ok(uniforms.every(item => item.name !== "mirrors"));
});

test("edge sources are mirrored four ways and aimed at the centre", t => {
  const { engine, uniforms } = fixture(t, PRESETS.collide.config);
  uniforms.length = 0;
  engine.edgeSplats();
  const centres = uniforms.filter(item => item.name === "center").map(item => item.value);
  const pushes = uniforms.filter(item => item.name === "amount").map(item => item.value);
  assert.equal(centres.length, 8, "four copies, each a velocity and a dye splat");
  for (let index = 0; index < centres.length; index += 2) {
    const [x, y] = centres[index];
    assert.ok(Math.min(x, 1 - x, y, 1 - y) < 0.05, "starts at a screen edge");
    assert.ok((0.5 - x) * pushes[index][0] + (0.5 - y) * pushes[index][1] > 0, "pushed toward the centre");
  }
  const mean = centres.reduce((sum, [x, y]) => [sum[0] + x / centres.length, sum[1] + y / centres.length], [0, 0]);
  assert.ok(Math.abs(mean[0] - 0.5) < 1e-9 && Math.abs(mean[1] - 0.5) < 1e-9);
});

test("Collide alternates ring and edge sources without music and respects pause", t => {
  const { engine, uniforms } = fixture(t, PRESETS.collide.config);
  engine.musicMapping = PRESETS.collide.music;
  uniforms.length = 0;
  engine.burstSplats(1);
  const centres = uniforms.filter(item => item.name === "center").map(item => item.value);
  const pushes = uniforms.filter(item => item.name === "amount").map(item => item.value);
  assert.equal(centres.length, 4 * PRESETS.collide.config.symmetry);
  for (let index = 0; index < centres.length; index += 2) {
    const offset = [(centres[index][0] - 0.5) * 640 / 480, centres[index][1] - 0.5];
    assert.ok(offset[0] * pushes[index][0] + offset[1] * pushes[index][1] > 0, "each copy is pushed away from the centre");
  }
  let splats = 0;
  let edges = 0;
  engine.burstSplats = count => { splats += count; };
  engine.edgeSplats = () => { edges += 1; };
  for (let i = 0; i < 80; i += 1) {
    engine.runFrame(1 / 60, i / 60);
  }
  assert.equal(splats + edges, 2);
  assert.equal(edges, 1, "edge and ring sources take turns");
  engine.readMusic = () => ({ bass: 0, mid: 0, treble: 0, overall: 1, brightness: 0, beat: false, timeSinceBeat: Infinity });
  const angle = engine.symmetryAngle;
  engine.runFrame(1 / 60, 2);
  assert.ok(engine.symmetryAngle - angle > 1 / 60 * engine.config.symmetrySpin * 0.4);
  assert.equal(splats + edges, 2);
  engine.togglePause();
  engine.readMusic = () => null;
  for (let i = 0; i < 80; i += 1) {
    engine.runFrame(1 / 60, 3 + i / 60);
  }
  assert.equal(splats + edges, 2);
});

test("a frame that throws stops the loop and reports the error once", t => {
  const { engine } = fixture(t, PRESETS.pavel.config);
  const requested = [];
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => requested.push(callback);
  globalThis.cancelAnimationFrame = () => {
  };
  globalThis.window.addEventListener = () => {
  };
  globalThis.window.removeEventListener = () => {
  };
  t.after(() => {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  });
  const reported = [];
  engine.onError = error => reported.push(error.message);
  engine.start();
  assert.equal(requested.length, 1);
  engine.frame(16);
  assert.equal(requested.length, 2, "a healthy frame asks for the next one");
  engine.render = () => {
    throw new Error("shader failed");
  };
  engine.frame(32);
  assert.deepEqual(reported, ["shader failed"]);
  assert.equal(engine.running, false);
  assert.equal(requested.length, 2, "no further frame is requested");
  engine.frame(48);
  assert.deepEqual(reported, ["shader failed"]);

  engine.onError = undefined;
  engine.start();
  assert.throws(() => engine.frame(64), /shader failed/);
  assert.equal(engine.running, false);
});

test("drawing or erasing a wall refreshes the wall-reach mask in both directions", t => {
  const { engine, draws, uniforms } = fixture(t, PRESETS.pavel.config);
  for (const value of [true, false]) {
    draws.length = 0;
    uniforms.length = 0;
    engine.paintWall(0.4, 0.1, 0.4, 0.9, value);
    const reach = draws.filter(program => program.uniforms.some(item => item.name === "axis"));
    assert.equal(reach.length, 2);
    assert.deepEqual(uniforms.filter(item => item.name === "axis").map(item => item.value), [[1, 0], [0, 1]]);
    assert.ok(draws.indexOf(reach[0]) > draws.findIndex(program => program.uniforms.some(item => item.name === "startPoint")));
  }
  engine.reset(PRESETS.tunnel.physics);
  draws.length = 0;
  engine.setConfig(PRESETS.tunnel.config);
  engine.reset(PRESETS.tunnel.physics);
  assert.equal(draws.filter(program => program.uniforms.some(item => item.name === "axis")).length, 2, "seeded shapes get a reach mask too");
});

test("Jupiter wraps left to right, holds jets and a storm, and scales with resolution", t => {
  const preset = PRESETS.jupiter;
  const { engine, draws, uniforms } = fixture(t, preset.config);
  engine.setConfig(preset.config);
  engine.reset(preset.physics);
  const named = name => program => program.uniforms.some(item => item.name === name);
  const value = (program, name) => program.uniforms.find(item => item.name === name).value;

  draws.length = 0;
  uniforms.length = 0;
  engine.step(1 / 60);
  assert.equal(draws.length, preset.config.pressureIterations + 9);
  const flow = draws.find(named("jetSpeed"));
  const dye = draws.find(named("renewal"));
  assert.ok(draws.indexOf(dye) < draws.indexOf(flow), "dye is renewed before the jets are held");
  assert.equal(value(flow, "initialize"), 0);
  assert.equal(value(draws.find(program => named("wrapX")(program) && named("velocityField")(program) && !named("jetSpeed")(program)), "wrapX"), 1);
  assert.equal(value(draws[0], "keepPrecision"), 1);
  const fullSpeed = uniforms.find(item => item.name === "jetSpeed").value;
  assert.equal(fullSpeed, preset.physics.planet.speed * engine.velocityScale());

  uniforms.length = 0;
  draws.length = 0;
  engine.setConfig({ simResolution: 128 });
  assert.equal(value(draws.find(named("jetSpeed")), "initialize"), 1, "a new grid starts with the jets running");
  engine.step(1 / 60);
  assert.equal(uniforms.findLast(item => item.name === "jetSpeed").value, fullSpeed / 4);

  engine.setConfig({ ...PHYSICS_DEFAULTS, ...PRESETS.pavel.config });
  engine.reset({});
  draws.length = 0;
  engine.step(1 / 60);
  assert.ok(!draws.some(named("jetSpeed")) && !draws.some(named("renewal")));
  assert.equal(value(draws[0], "keepPrecision"), 0);
});

test("Jupiter paints pigment over the clouds, and its storms stir without always adding colour", t => {
  const preset = PRESETS.jupiter;
  const { engine, draws, uniforms } = fixture(t, preset.config);
  engine.setConfig(preset.config);
  engine.reset(preset.physics);
  uniforms.length = 0;
  engine.injectOne(0.5, 0.5, 10, 0, [0.03, 0.06, 0.15]);
  assert.deepEqual(uniforms.filter(item => item.name === "cover").map(item => item.value), [0, 0.7]);
  const painted = uniforms.filter(item => item.name === "amount").at(-1).value;
  assert.ok(Math.abs(Math.max(...painted) - 0.92) < 1e-9, "painted colour is a full-strength pigment");

  const random = Math.random;
  t.after(() => {
    Math.random = random;
  });
  for (const [roll, passes] of [[0.9, 1], [0.1, 2]]) {
    Math.random = () => roll;
    draws.length = 0;
    engine.planetStorm();
    assert.equal(draws.length, passes);
  }
  Math.random = random;
  assert.equal(engine.config.splatRadius, preset.config.splatRadius);

  engine.readMusic = () => ({ bass: 1, mid: 1, treble: 1, overall: 1, brightness: 0.4, beat: true, timeSinceBeat: 0 });
  engine.musicMapping = preset.music;
  engine.runFrame(1 / 60, 1);
  assert.equal(engine.musicHue, null, "music does not recolour the planet");
});
