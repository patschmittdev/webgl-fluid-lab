import { FRAGMENT_SHADERS, FULLSCREEN_VERTEX_SHADER } from "./lab/shaders.js";

import { PHYSICS_SHADERS, withSolidMask, withSolidDisplay } from "./lab/physics-shaders.js";
import { PHYSICS_DEFAULTS, MUSIC_DEFAULTS, VIEWS } from "../presets.js";
import { createMusicResponse } from "../audio.js";

export const OPTIONAL_SHADERS = {
  ...PHYSICS_SHADERS,
  wallCurl: withSolidMask(FRAGMENT_SHADERS.curl),
  wallVorticity: withSolidMask(FRAGMENT_SHADERS.vorticity),
  wallDisplay: withSolidDisplay(FRAGMENT_SHADERS.display),
};

const MAX_TIME_STEP = 0.016666;

const DEFAULT_CONFIG = Object.freeze({
  ...PHYSICS_DEFAULTS,
  ...MUSIC_DEFAULTS,
  simResolution: 128,
  dyeResolution: 1024,
  densityDissipation: 1,
  velocityDissipation: 0.2,
  pressure: 0.8,
  pressureIterations: 20,
  curl: 30,
  splatRadius: 0.25,
  splatForce: 6000,
  shading: true,
  colorful: true,
  colorUpdateSpeed: 10,
  colorPalette: [],
  hover: true,
  backgroundColor: "#000000",
  transparent: false,
  inverted: false,
  brightness: 0.5,
  bloom: true,
  bloomIterations: 8,
  bloomResolution: 256,
  bloomIntensity: 0.8,
  bloomThreshold: 0.6,
  bloomSoftKnee: 0.7,
  sunrays: true,
  sunraysResolution: 196,
  sunraysWeight: 1,
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Could not create the ${label} shader.`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || "unknown shader compiler error";
    gl.deleteShader(shader);
    throw new Error(`Could not compile the ${label} shader: ${detail}`);
  }
  return shader;
}

function createProgram(gl, fragmentSource, label) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER, `${label} vertex`);
  let fragment;
  let program;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);
    program = gl.createProgram();
    if (!program) throw new Error(`Could not create the ${label} program.`);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const detail = gl.getProgramInfoLog(program) || "unknown program linker error";
      throw new Error(`Could not link the ${label} program: ${detail}`);
    }

    const uniforms = new Map();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let index = 0; index < count; index += 1) {
      const info = gl.getActiveUniform(program, index);
      if (info) uniforms.set(info.name, gl.getUniformLocation(program, info.name));
    }
    return { handle: program, uniforms };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function parseHexColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || "");
  if (!match) return [0, 0, 0];
  const packed = Number.parseInt(match[1], 16);
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255];
}

function rgbToHsv([red, green, blue]) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const range = maximum - minimum;
  let hue = 0;
  if (range !== 0) {
    if (maximum === red) hue = ((green - blue) / range + 6) % 6;
    else if (maximum === green) hue = (blue - red) / range + 2;
    else hue = (red - green) / range + 4;
    hue /= 6;
  }
  return [hue, maximum === 0 ? 0 : range / maximum, maximum];
}

function hsvToRgb(hue, saturation, value) {
  const sector = Math.floor(hue * 6);
  const fraction = hue * 6 - sector;
  const low = value * (1 - saturation);
  const falling = value * (1 - fraction * saturation);
  const rising = value * (1 - (1 - fraction) * saturation);
  switch (sector % 6) {
    case 0: return [value, rising, low];
    case 1: return [falling, value, low];
    case 2: return [low, value, rising];
    case 3: return [low, falling, value];
    case 4: return [rising, low, value];
    default: return [value, low, falling];
  }
}

function makePointer(color) {
  return {
    down: false,
    initialized: false,
    moved: false,
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    color,
  };
}

class LabEngine {
  constructor(host, canvas, gl, config) {
    this.host = host;
    this.canvas = canvas;
    this.gl = gl;
    this.config = { ...DEFAULT_CONFIG, colorPalette: [] };
    this.programs = new Map();
    this.targets = {
      velocity: null,
      dye: null,
      pressure: null,
      divergence: null,
      curl: null,
      bloom: [],
      sunrays: null,
      obstacles: null,
      temperature: null,
    };
    this.scene = {};
    this.tool = "paint";
    this.wallsRequested = false;
    this.seedWalls = false;
    this.initializePhysics = false;
    this.running = false;
    this.destroyed = false;
    this.paused = false;
    this.drawWhilePaused = false;
    this.animationFrame = null;
    this.lastTimestamp = 0;
    this.colorTimer = 0;
    this.musicResponse = createMusicResponse();
    this.musicMapping = {};
    this.musicHue = null;
    this.musicHeat = 0;
    this.musicPuff = 0;
    this.symmetryAngle = 0;
    this.automaticTime = 1;
    this.wispTime = 0;
    this.edgeTurn = false;
    this.musicEnergy = null;
    this.touchPointers = new Map();
    this.mousePointer = makePointer(this.generateColor());

    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);
    this.onTouchStart = this.handleTouchStart.bind(this);
    this.onTouchMove = this.handleTouchMove.bind(this);
    this.onTouchEnd = this.handleTouchEnd.bind(this);
    this.frame = this.frame.bind(this);

    this.vao = gl.createVertexArray();
    if (!this.vao) throw new Error("WebGL2 could not create the solver vertex array.");
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    try {
      for (const [name, source] of Object.entries(FRAGMENT_SHADERS)) {
        this.programs.set(name, createProgram(gl, source, name));
      }
      this.setConfig(config);
      this.mousePointer.color = this.generateColor();
      this.resizeCanvas();
      this.ensureTargets();
      this.render();
    } catch (error) {
      this.deleteSimulationTargets();
      this.deleteDyeTargets();
      this.deleteBloomTargets();
      this.deleteSunraysTargets();
      this.deletePrograms();
      gl.deleteVertexArray(this.vao);
      throw error;
    }
  }

  uniform(program, name) {
    return program.uniforms.get(name) ?? null;
  }

  use(name) {
    if (!this.programs.has(name)) {
      this.programs.set(name, createProgram(this.gl, OPTIONAL_SHADERS[name], name));
    }
    const program = this.programs.get(name);
    this.gl.useProgram(program.handle);
    if (program.uniforms.has("obstacleField")) {
      this.bindTexture(program, "obstacleField", this.targets.obstacles?.read ?? this.targets.velocity.read, 7);
      this.gl.uniform1i(this.uniform(program, "hasSolids"), this.targets.obstacles ? 1 : 0);
      this.gl.uniform2f(this.uniform(program, "simTexel"), this.targets.velocity.texelX, this.targets.velocity.texelY);
      this.gl.uniform1f(this.uniform(program, "inflow"), this.config.inflow * this.velocityScale());
    }
    this.gl.uniform1f(this.uniform(program, "velocityScale"), this.velocityScale());
    return program;
  }

  velocityScale() {
    return this.targets.velocity.height / 128;
  }

  bindTexture(program, uniformName, target, unit) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(this.uniform(program, uniformName), unit);
  }

  drawTo(target) {
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(
      0,
      0,
      target ? target.width : gl.drawingBufferWidth,
      target ? target.height : gl.drawingBufferHeight,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  createTarget(width, height, internalFormat, format, filter = this.gl.NEAREST) {
    const { gl } = this;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      throw new Error("WebGL2 could not allocate a fluid simulation target.");
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error("WebGL2 could not render to the required floating-point texture format.");
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      framebuffer,
      width,
      height,
      texelX: 1 / width,
      texelY: 1 / height,
    };
  }

  createDoubleTarget(width, height, internalFormat, format, filter = this.gl.NEAREST) {
    let read;
    try {
      read = this.createTarget(width, height, internalFormat, format, filter);
      const write = this.createTarget(width, height, internalFormat, format, filter);
      return {
        read,
        write,
        width,
        height,
        texelX: 1 / width,
        texelY: 1 / height,
        swap() {
          const previousRead = this.read;
          this.read = this.write;
          this.write = previousRead;
        },
      };
    } catch (error) {
      if (read) this.deleteTarget(read);
      throw error;
    }
  }

  deleteTarget(target) {
    if (!target) return;
    this.gl.deleteTexture(target.texture);
    this.gl.deleteFramebuffer(target.framebuffer);
  }

  deleteDoubleTarget(target) {
    if (!target) return;
    this.deleteTarget(target.read);
    this.deleteTarget(target.write);
  }

  deleteSimulationTargets() {
    this.deleteDoubleTarget(this.targets.obstacles);
    this.deleteDoubleTarget(this.targets.temperature);
    this.targets.obstacles = null;
    this.targets.temperature = null;
    this.deleteDoubleTarget(this.targets.velocity);
    this.deleteDoubleTarget(this.targets.pressure);
    this.deleteTarget(this.targets.divergence);
    this.deleteTarget(this.targets.curl);
    this.targets.velocity = null;
    this.targets.pressure = null;
    this.targets.divergence = null;
    this.targets.curl = null;
  }

  deleteDyeTargets() {
    this.deleteDoubleTarget(this.targets.dye);
    this.targets.dye = null;
  }

  deleteBloomTargets() {
    for (const level of this.targets.bloom) this.deleteDoubleTarget(level);
    this.targets.bloom = [];
  }

  deleteSunraysTargets() {
    if (!this.targets.sunrays) return;
    this.deleteTarget(this.targets.sunrays.mask);
    this.deleteTarget(this.targets.sunrays.rays);
    this.targets.sunrays = null;
  }

  deletePrograms() {
    for (const program of this.programs.values()) this.gl.deleteProgram(program.handle);
    this.programs.clear();
  }

  resolution(shortAxis) {
    const { drawingBufferWidth: width, drawingBufferHeight: height } = this.gl;
    let aspect = width / height;
    if (aspect < 1) aspect = 1 / aspect;
    const shortSize = Math.max(1, Math.round(shortAxis));
    const longSize = Math.max(1, Math.round(shortAxis * aspect));
    return width > height
      ? { width: longSize, height: shortSize }
      : { width: shortSize, height: longSize };
  }

  allocateSimulationTargets(size) {
    const { gl } = this;
    this.deleteSimulationTargets();
    this.wallsRequested = Boolean(this.seedWalls && this.scene.obstacles?.length);
    this.initializePhysics = true;
    try {
      this.targets.velocity = this.createDoubleTarget(size.width, size.height, gl.RG16F, gl.RG);
      this.targets.pressure = this.createDoubleTarget(size.width, size.height, gl.R16F, gl.RED);
      this.targets.divergence = this.createTarget(size.width, size.height, gl.R16F, gl.RED);
      this.targets.curl = this.createTarget(size.width, size.height, gl.R16F, gl.RED);
    } catch (error) {
      this.deleteSimulationTargets();
      throw error;
    }
  }

  allocateDyeTargets(size) {
    const { gl } = this;
    this.deleteDyeTargets();
    try {
      this.targets.dye = this.createDoubleTarget(size.width, size.height, gl.RGBA16F, gl.RGBA, gl.LINEAR);
    } catch (error) {
      this.deleteDyeTargets();
      throw error;
    }
  }

  allocateBloomTargets(size) {
    const { gl } = this;
    this.deleteBloomTargets();
    try {
      let width = size.width;
      let height = size.height;
      while (width >= 2 && height >= 2) {
        this.targets.bloom.push(this.createDoubleTarget(width, height, gl.RGBA16F, gl.RGBA, gl.LINEAR));
        width = Math.floor(width / 2);
        height = Math.floor(height / 2);
      }
    } catch (error) {
      this.deleteBloomTargets();
      throw error;
    }
  }

  allocateSunraysTargets(size) {
    const { gl } = this;
    this.deleteSunraysTargets();
    let mask;
    try {
      mask = this.createTarget(size.width, size.height, gl.R16F, gl.RED, gl.LINEAR);
      const rays = this.createTarget(size.width, size.height, gl.R16F, gl.RED, gl.LINEAR);
      this.targets.sunrays = { mask, rays };
    } catch (error) {
      if (mask) this.deleteTarget(mask);
      this.targets.sunrays = null;
      throw error;
    }
  }

  ensureTargets() {
    const simSize = this.resolution(this.config.simResolution);
    const dyeSize = this.resolution(this.config.dyeResolution);
    const velocity = this.targets.velocity;
    const dye = this.targets.dye;
    if (!velocity || velocity.width !== simSize.width || velocity.height !== simSize.height) {
      this.allocateSimulationTargets(simSize);
    }
    if (!dye || dye.width !== dyeSize.width || dye.height !== dyeSize.height) {
      this.allocateDyeTargets(dyeSize);
    }
    this.ensurePhysicsTargets();
  }

  ensureEffectTargets() {
    if (!this.config.inverted && this.config.bloom && this.config.view === "dye") {
      const size = this.resolution(this.config.bloomResolution);
      const base = this.targets.bloom[0];
      if (!base || base.width !== size.width || base.height !== size.height) {
        this.allocateBloomTargets(size);
      }
    } else if (this.targets.bloom.length > 0) {
      this.deleteBloomTargets();
    }

    if (!this.config.inverted && this.config.sunrays && this.config.view === "dye") {
      const size = this.resolution(this.config.sunraysResolution);
      const rays = this.targets.sunrays?.rays;
      if (!rays || rays.width !== size.width || rays.height !== size.height) {
        this.allocateSunraysTargets(size);
      }
    } else if (this.targets.sunrays) {
      this.deleteSunraysTargets();
    }
  }

  resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  setConfig(partial = {}) {
    if (!partial || typeof partial !== "object" || this.destroyed) return;
    this.musicDisplayConfig = undefined;
    let resolutionMayHaveChanged = false;
    let bloomResolutionChanged = false;
    let sunraysResolutionChanged = false;
    for (const [key, value] of Object.entries(partial)) {
      if (!CONFIG_KEYS.has(key)) continue;
      if (key === "colorPalette") {
        if (Array.isArray(value)) this.config.colorPalette = value.slice();
        continue;
      }
      if (
        key === "simResolution"
        || key === "dyeResolution"
        || key === "bloomResolution"
        || key === "sunraysResolution"
      ) {
        if (Number.isFinite(value) && value > 0 && value !== this.config[key]) {
          this.config[key] = value;
          if (key === "simResolution" || key === "dyeResolution") resolutionMayHaveChanged = true;
          if (key === "bloomResolution") bloomResolutionChanged = true;
          if (key === "sunraysResolution") sunraysResolutionChanged = true;
        }
        continue;
      }
      this.config[key] = value;
    }

    if (!this.config.bloom) this.deleteBloomTargets();
    if (!this.config.sunrays) this.deleteSunraysTargets();
    if (resolutionMayHaveChanged && this.targets.velocity) this.ensureTargets();
    if (bloomResolutionChanged && this.targets.bloom.length > 0) {
      this.allocateBloomTargets(this.resolution(this.config.bloomResolution));
    }
    if (sunraysResolutionChanged && this.targets.sunrays) {
      this.allocateSunraysTargets(this.resolution(this.config.sunraysResolution));
    }
  }

  start() {
    if (this.running || this.destroyed) return;
    this.resizeCanvas();
    this.ensureTargets();
    this.addInputListeners();
    this.running = true;
    this.lastTimestamp = performance.now();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.removeInputListeners();
    this.mousePointer.down = false;
    this.mousePointer.moved = false;
    this.touchPointers.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.deleteSimulationTargets();
    this.deleteDyeTargets();
    this.deleteBloomTargets();
    this.deleteSunraysTargets();
    this.deletePrograms();
    this.gl.deleteVertexArray(this.vao);
    this.touchPointers.clear();
    this.canvas.remove();
  }

  addInputListeners() {
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
    this.canvas.addEventListener("touchmove", this.onTouchMove, { passive: false });
    window.addEventListener("touchend", this.onTouchEnd);
    window.addEventListener("touchcancel", this.onTouchEnd);
  }

  removeInputListeners() {
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("touchstart", this.onTouchStart);
    this.canvas.removeEventListener("touchmove", this.onTouchMove);
    window.removeEventListener("touchend", this.onTouchEnd);
    window.removeEventListener("touchcancel", this.onTouchEnd);
  }

  generateColor(saturationScale = 1) {
    const palette = Array.isArray(this.config?.colorPalette) ? this.config.colorPalette : [];
    let hue = Math.random();
    let saturation = 1;
    if (palette.length > 0) {
      const selected = palette[Math.floor(Math.random() * palette.length)];
      if (this.config.inverted) return parseHexColor(selected);
      [hue, saturation] = rgbToHsv(parseHexColor(selected));
    }
    if (this.musicHue !== null) {
      hue = (hue * 0.25 + this.musicHue) % 1;
    }
    const color = hsvToRgb(hue, saturation * saturationScale, Number(this.config?.brightness ?? DEFAULT_CONFIG.brightness));
    return color.map((channel) => channel * 0.15);
  }

  canvasPosition(clientX, clientY) {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left) / Math.max(bounds.width, 1),
      y: 1 - (clientY - bounds.top) / Math.max(bounds.height, 1),
    };
  }

  beginPointer(pointer, clientX, clientY) {
    const position = this.canvasPosition(clientX, clientY);
    pointer.down = true;
    pointer.initialized = true;
    pointer.moved = false;
    pointer.x = position.x;
    pointer.y = position.y;
    pointer.dx = 0;
    pointer.dy = 0;
    pointer.color = this.generateColor();
    pointer.strokeX = position.x;
    pointer.strokeY = position.y;
    pointer.moved = this.tool !== "paint";
  }

  movePointer(pointer, clientX, clientY, hover) {
    const position = this.canvasPosition(clientX, clientY);
    if (!pointer.initialized) {
      pointer.initialized = true;
      pointer.x = position.x;
      pointer.y = position.y;
      return;
    }

    const aspect = this.canvas.width / this.canvas.height;
    let dx = position.x - pointer.x;
    let dy = position.y - pointer.y;
    if (aspect < 1) dx *= aspect;
    if (aspect > 1) dy /= aspect;
    pointer.x = position.x;
    pointer.y = position.y;
    pointer.dx = dx;
    pointer.dy = dy;
    pointer.moved = (hover || pointer.down) && (Math.abs(dx) > 0 || Math.abs(dy) > 0);
  }

  handleMouseDown(event) {
    this.beginPointer(this.mousePointer, event.clientX, event.clientY);
  }

  handleMouseMove(event) {
    this.movePointer(this.mousePointer, event.clientX, event.clientY, Boolean(this.config.hover) && this.tool === "paint");
  }

  handleMouseUp() {
    this.mousePointer.down = false;
  }

  handleTouchStart(event) {
    event.preventDefault();
    for (const touch of event.changedTouches) {
      const pointer = makePointer(this.generateColor());
      this.beginPointer(pointer, touch.clientX, touch.clientY);
      this.touchPointers.set(touch.identifier, pointer);
    }
  }

  handleTouchMove(event) {
    event.preventDefault();
    for (const touch of event.changedTouches) {
      const pointer = this.touchPointers.get(touch.identifier);
      if (pointer) this.movePointer(pointer, touch.clientX, touch.clientY, false);
    }
  }

  handleTouchEnd(event) {
    for (const touch of event.changedTouches) this.touchPointers.delete(touch.identifier);
  }

  updatePointerColors(dt) {
    if (!this.config.colorful) return;
    this.colorTimer += dt * this.config.colorUpdateSpeed;
    if (this.colorTimer < 1) return;
    this.colorTimer %= 1;
    this.mousePointer.color = this.generateColor();
    for (const pointer of this.touchPointers.values()) pointer.color = this.generateColor();
  }

  applyPointerInputs() {
    const pointers = [this.mousePointer, ...this.touchPointers.values()];
    for (const pointer of pointers) {
      if (!pointer.moved) continue;
      pointer.moved = false;
      if (this.paused && !this.drawWhilePaused) continue;
      if (this.tool !== "paint") {
        this.paintWall(pointer.strokeX ?? pointer.x, pointer.strokeY ?? pointer.y, pointer.x, pointer.y, this.tool === "wall");
        pointer.strokeX = pointer.x;
        pointer.strokeY = pointer.y;
        continue;
      }
      this.injectNormalized(
        pointer.x,
        pointer.y,
        pointer.dx * this.config.splatForce,
        pointer.dy * this.config.splatForce,
        pointer.color,
      );
    }
  }

  injectNormalized(x, y, dx, dy, color, phase = 0) {
    const copies = Math.floor(this.config.symmetry);
    if (copies < 2) {
      this.injectOne(x, y, dx, dy, Array.isArray(color[0]) ? color[0] : color);
      return;
    }
    const aspect = this.canvas.width / this.canvas.height;
    const px = (x - 0.5) * aspect;
    const py = y - 0.5;
    for (const mirror of [1, -1]) {
      for (let index = 0; index < copies; index += 1) {
        const angle = index * 2 * Math.PI / copies + phase;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const sx = mirror * px;
        const sdx = mirror * dx;
        this.injectOne(
          (sx * cos - py * sin) / aspect + 0.5,
          sx * sin + py * cos + 0.5,
          sdx * cos - dy * sin,
          sdx * sin + dy * cos,
          Array.isArray(color[0]) ? color[index % color.length] : color,
        );
      }
    }
  }

  injectOne(x, y, dx, dy, color) {
    if (!this.targets.velocity || !this.targets.dye) return;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const { gl } = this;
    const aspect = this.canvas.width / this.canvas.height;
    let radius = this.config.splatRadius / 100;
    if (aspect > 1) radius *= aspect;
    gl.disable(gl.BLEND);

    let program = this.use(this.targets.obstacles ? "maskedSplat" : "splat");
    this.bindTexture(program, "targetField", this.targets.velocity.read, 0);
    gl.uniform2f(this.uniform(program, "center"), x, y);
    gl.uniform3f(this.uniform(program, "amount"), dx * this.velocityScale(), dy * this.velocityScale(), 0);
    gl.uniform1f(this.uniform(program, "aspectRatio"), aspect);
    gl.uniform1f(this.uniform(program, "radius"), radius);
    gl.uniform1i(this.uniform(program, "inkMode"), 0);
    this.drawTo(this.targets.velocity.write);
    this.targets.velocity.swap();

    program = this.use(this.targets.obstacles ? "maskedSplat" : "splat");
    this.bindTexture(program, "targetField", this.targets.dye.read, 0);
    gl.uniform2f(this.uniform(program, "center"), x, y);
    const page = parseHexColor(this.config.backgroundColor);
    const ink = this.config.inverted;
    const amount = this.config.flameShading ? [1, 1, 1] : ink ? color.map((channel, i) => -Math.log(Math.max(0.001, Math.min(1, channel / Math.max(page[i], 0.001))))) : color;
    gl.uniform1i(this.uniform(program, "inkMode"), ink ? 1 : 0);
    gl.uniform3f(this.uniform(program, "amount"), ...amount);
    gl.uniform1f(this.uniform(program, "aspectRatio"), aspect);
    gl.uniform1f(this.uniform(program, "radius"), radius);
    this.drawTo(this.targets.dye.write);
    this.targets.dye.swap();
    if (this.config.heat > 0) {
      this.ensurePhysicsTargets();
      this.addSplat(this.targets.temperature, x, y, [this.config.heat, 0, 0], radius);
    }
  }

  splat(x, y, dx, dy, color) {
    if (this.destroyed || !this.targets.velocity) return;
    const bounds = this.canvas.getBoundingClientRect();
    const dye = color ?? this.generateColor().map((channel) => this.config.inverted ? channel : channel * 10);
    this.injectNormalized(
      x / Math.max(bounds.width, 1),
      1 - y / Math.max(bounds.height, 1),
      dx,
      -dy,
      dye,
    );
  }

  multipleSplats(count) {
    if (this.destroyed || !this.targets.velocity) return;
    for (let index = 0; index < count; index += 1) {
      const color = this.generateColor().map((channel) => channel * 10);
      this.injectNormalized(
        Math.random(),
        Math.random(),
        this.config.splatForce / 6 * (Math.random() - 0.5),
        this.config.splatForce / 6 * (Math.random() - 0.5),
        color,
      );
    }
  }

  burstSplats(count, soft = false) {
    if (!this.musicMapping.radial) {
      this.multipleSplats(count);
      return;
    }
    if (this.destroyed || !this.targets.velocity) return;
    const aspect = this.canvas.width / this.canvas.height;
    const energy = this.musicEnergy;
    const spread = Math.min(1, 0.07 / Math.max(this.config.splatRadius, 0.01));
    const gain = (energy === null ? 9 : 3 + 6 * energy) * spread * (soft ? 0.7 : 1);
    const saturation = energy === null ? 1 : 0.45 + 0.55 * energy;
    for (let index = 0; index < count; index += 1) {
      const angle = Math.PI / 2 + 0.24 + Math.random() * 0.1;
      const distance = 0.2 + Math.random() * 0.06;
      const speed = this.config.splatForce / 6 * (0.8 + 0.4 * Math.random()) * (soft ? 0.45 : 1);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      this.injectNormalized(
        0.5 + distance * cos / aspect,
        0.5 + distance * sin,
        speed * (0.5 * cos + 0.85 * sin),
        speed * (0.5 * sin - 0.85 * cos),
        [0, 1].map(() => this.generateColor(saturation).map((channel) => channel * gain)),
        this.symmetryAngle,
      );
    }
  }

  edgeSplats(soft = false) {
    if (this.destroyed || !this.targets.velocity) return;
    const aspect = this.canvas.width / this.canvas.height;
    const energy = this.musicEnergy;
    const spread = Math.min(1, 0.07 / Math.max(this.config.splatRadius, 0.01));
    const gain = (energy === null ? 9 : 3 + 6 * energy) * spread * 0.6 * (soft ? 0.7 : 1);
    const saturation = energy === null ? 1 : 0.45 + 0.55 * energy;
    const speed = this.config.splatForce / 6 * (soft ? 0.45 : 1);
    const along = 0.08 + Math.random() * 0.34;
    const base = Math.random() < 0.5 ? [0.03, along] : [along, 0.03];
    const color = this.generateColor(saturation).map((channel) => channel * gain);
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        const x = flipX ? 1 - base[0] : base[0];
        const y = flipY ? 1 - base[1] : base[1];
        const towardX = (0.5 - x) * aspect;
        const towardY = 0.5 - y;
        const length = Math.hypot(towardX, towardY);
        this.injectOne(x, y, speed * towardX / length, speed * towardY / length, color);
      }
    }
  }

  nextWisp(soft) {
    this.edgeTurn = !this.edgeTurn;
    if (this.edgeTurn && this.musicMapping.edges) {
      this.edgeSplats(soft);
    } else {
      this.burstSplats(1, soft);
    }
  }

  reset(scene = this.scene) {
    this.scene = structuredClone(scene);
    this.sourceTime = 0;
    this.wallsRequested = Boolean(this.scene.obstacles?.length);
    this.seedWalls = this.wallsRequested;
    this.deleteSimulationTargets();
    this.deleteDyeTargets();
    this.deleteBloomTargets();
    this.deleteSunraysTargets();
    this.ensureTargets();
    this.mousePointer.moved = false;
    this.touchPointers.clear();
  }

  togglePause(drawWhilePaused = false) {
    this.paused = !this.paused;
    if (this.paused) this.drawWhilePaused = Boolean(drawWhilePaused);
    return this.paused;
  }

  advect(source, destination, velocity, dissipation, dt) {
    const { gl } = this;
    const physical = this.hasBoundaries();
    const program = this.use(physical ? "transport" : "advect");
    gl.uniform1i(this.uniform(program, "velocityMode"), source === this.targets.velocity.read ? 1 : 0);
    this.bindTexture(program, "velocityField", velocity, 0);
    this.bindTexture(program, "quantityField", source, 1);
    gl.uniform2f(this.uniform(program, "velocityTexel"), this.targets.velocity.texelX, this.targets.velocity.texelY);
    gl.uniform2f(this.uniform(program, "quantityTexel"), 1 / source.width, 1 / source.height);
    gl.uniform1f(this.uniform(program, "timeStep"), dt);
    gl.uniform1f(this.uniform(program, "dissipation"), dissipation);
    this.drawTo(destination);
  }

  step(dt) {
    const { gl } = this;
    const { velocity, dye, curl, divergence, pressure } = this.targets;
    gl.disable(gl.BLEND);

    this.advect(velocity.read, velocity.write, velocity.read, this.config.velocityDissipation, dt);
    velocity.swap();

    this.advect(dye.read, dye.write, velocity.read, this.config.densityDissipation, dt);
    dye.swap();

    const temperature = this.targets.temperature;
    if (temperature) {
      this.advect(temperature.read, temperature.write, velocity.read, this.config.cooling, dt);
      temperature.swap();
    }
    this.applySources(dt);

    let program = this.use(this.targets.obstacles ? "wallCurl" : "curl");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    this.drawTo(curl);

    program = this.use(this.targets.obstacles ? "wallVorticity" : "vorticity");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    this.bindTexture(program, "curlField", curl, 1);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    const flicker = this.scene.emitters?.some(emitter => emitter.throttle) ? 1 - 0.9 * this.config.throttle : 1;
    gl.uniform1f(this.uniform(program, "strength"), this.config.curl * this.velocityScale() * flicker);
    gl.uniform1f(this.uniform(program, "timeStep"), dt);
    this.drawTo(velocity.write);
    velocity.swap();

    if (this.hasBoundaries() || (temperature && this.config.buoyancy > 0)) {
      this.applyForces(dt);
    }

    program = this.use(this.hasBoundaries() ? "wallDivergence" : "divergence");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    this.drawTo(divergence);

    program = this.use("pressureDecay");
    this.bindTexture(program, "pressureField", pressure.read, 0);
    gl.uniform1f(this.uniform(program, "retention"), this.config.pressure);
    this.drawTo(pressure.write);
    pressure.swap();

    program = this.use(this.hasBoundaries() ? "wallPressure" : "pressureSolve");
    this.bindTexture(program, "divergenceField", divergence, 1);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    const iterations = Math.max(0, Math.floor(this.config.pressureIterations));
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      this.bindTexture(program, "pressureField", pressure.read, 0);
      this.drawTo(pressure.write);
      pressure.swap();
    }

    program = this.use(this.hasBoundaries() ? "wallProject" : "project");
    this.bindTexture(program, "pressureField", pressure.read, 0);
    this.bindTexture(program, "velocityField", velocity.read, 1);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    this.drawTo(velocity.write);
    velocity.swap();
  }

  hasBoundaries() {
    return Boolean(this.targets.obstacles) || this.config.inflow > 0;
  }

  ensurePhysicsTargets() {
    const { gl } = this;
    const size = this.targets.velocity;
    if (!size) {
      return;
    }
    if (this.wallsRequested && !this.targets.obstacles) {
      this.targets.obstacles = this.createDoubleTarget(size.width, size.height, gl.RG8, gl.RG);
      if (this.seedWalls) {
        for (const shape of this.scene.obstacles ?? []) {
          this.drawWall(shape.x, shape.y, shape.x, shape.y, shape.radius, true);
        }
        this.spreadWallReach();
      }
    }
    const needsTemperature = this.config.heat > 0 || this.config.buoyancy > 0
      || this.config.flameShading || this.config.view === "temperature" || this.scene.emitters?.length;
    if (needsTemperature && !this.targets.temperature) {
      this.targets.temperature = this.createDoubleTarget(size.width, size.height, gl.R16F, gl.RED);
    } else if (!needsTemperature && this.targets.temperature) {
      this.deleteDoubleTarget(this.targets.temperature);
      this.targets.temperature = null;
    }
    if (this.initializePhysics) {
      this.initializePhysics = false;
      if (this.config.inflow > 0) {
        this.applyForces(0, true);
      }
    }
  }

  setTool(tool) {
    if (["paint", "wall", "erase"].includes(tool)) {
      this.tool = tool;
      this.mousePointer.moved = false;
      this.mousePointer.strokeX = this.mousePointer.x;
      this.mousePointer.strokeY = this.mousePointer.y;
    }
  }

  clearWalls() {
    this.deleteDoubleTarget(this.targets.obstacles);
    this.targets.obstacles = null;
    this.wallsRequested = false;
    this.seedWalls = false;
  }

  drawWall(x0, y0, x1, y1, radius, value) {
    const { gl } = this;
    const mask = this.targets.obstacles;
    const program = this.use("wallPaint");
    this.bindTexture(program, "previousMask", mask.read, 0);
    gl.uniform2f(this.uniform(program, "startPoint"), x0, y0);
    gl.uniform2f(this.uniform(program, "endPoint"), x1, y1);
    gl.uniform1f(this.uniform(program, "radius"), Math.max(radius, mask.texelY));
    gl.uniform1f(this.uniform(program, "value"), value ? 1 : 0);
    gl.uniform1f(this.uniform(program, "aspectRatio"), this.canvas.width / this.canvas.height);
    this.drawTo(mask.write);
    mask.swap();
  }

  spreadWallReach() {
    const mask = this.targets.obstacles;
    for (const axis of [[1, 0], [0, 1]]) {
      const program = this.use("wallReach");
      this.gl.uniform2f(this.uniform(program, "axis"), ...axis);
      this.drawTo(mask.write);
      mask.swap();
    }
  }

  paintWall(x0, y0, x1, y1, value) {
    if (!value && !this.targets.obstacles) {
      return;
    }
    this.wallsRequested = true;
    this.ensurePhysicsTargets();
    this.drawWall(x0, y0, x1, y1, 0.01 + this.config.splatRadius * 0.03, value);
    this.spreadWallReach();
    for (const target of [this.targets.velocity, this.targets.dye, this.targets.temperature, this.targets.pressure]) {
      if (!target) {
        continue;
      }
      const program = this.use("maskQuantity");
      this.bindTexture(program, "targetField", target.read, 0);
      this.drawTo(target.write);
      target.swap();
    }
  }

  addSplat(target, x, y, amount, radius) {
    const { gl } = this;
    const program = this.use(this.targets.obstacles ? "maskedSplat" : "splat");
    this.bindTexture(program, "targetField", target.read, 0);
    gl.uniform1i(this.uniform(program, "inkMode"), 0);
    gl.uniform2f(this.uniform(program, "center"), x, y);
    gl.uniform3f(this.uniform(program, "amount"), ...amount);
    gl.uniform1f(this.uniform(program, "aspectRatio"), this.canvas.width / this.canvas.height);
    gl.uniform1f(this.uniform(program, "radius"), radius);
    this.drawTo(target.write);
    target.swap();
  }

  applySource(target, mode, source, dt) {
    const { gl } = this;
    const program = this.use("sources");
    this.bindTexture(program, "targetField", target.read, 0);
    gl.uniform1i(this.uniform(program, "sourceMode"), mode);
    gl.uniform2f(this.uniform(program, "center"), source.x ?? 0, source.y ?? 0);
    const velocity = source.velocity ?? [0, 0];
    const travel = velocity.map((value, index) => value * this.velocityScale() * dt * (index === 0 ? this.targets.velocity.texelX : this.targets.velocity.texelY));
    const length = Math.hypot(travel[0] * this.canvas.width / this.canvas.height, travel[1]);
    const cap = Math.min(1, 0.1 / Math.max(length, 0.000001));
    gl.uniform2f(this.uniform(program, "sourceExtent"), travel[0] * cap, travel[1] * cap);
    gl.uniform1f(this.uniform(program, "radius"), source.radius ?? 0.02);
    gl.uniform3f(this.uniform(program, "amount"), ...(source.amount ?? [source.heat ?? 0, 0, 0]));
    gl.uniform1f(this.uniform(program, "timeStep"), dt);
    gl.uniform1f(this.uniform(program, "streamCount"), this.scene.streaklines ?? 0);
    gl.uniform1f(this.uniform(program, "aspectRatio"), this.canvas.width / this.canvas.height);
    this.drawTo(target.write);
    target.swap();
  }

  applySources(dt) {
    this.sourceTime = (this.sourceTime ?? 0) + dt;
    for (const emitter of this.scene.emitters ?? []) {
      let source = this.emitterSource(emitter);
      if (!emitter.throttle && this.musicMapping.heat) {
        source = {
          ...source,
          heat: Math.min(5, source.heat + this.musicHeat),
          dye: source.dye?.map(value => value * (1 + this.musicPuff * 20)),
        };
      }
      const mode = emitter.throttle ? 4 : 0;
      this.applySource(this.targets.temperature, mode, source, dt);
      if (source.dye) {
        this.applySource(this.targets.dye, mode, { ...source, amount: source.dye }, dt);
      }
      if (source.velocity) {
        const amount = [...source.velocity.map(value => value * this.velocityScale()), 0];
        this.applySource(this.targets.velocity, mode, { ...source, amount }, dt);
      }
    }
    if (this.config.inflow > 0 && this.scene.streaklines) {
      this.applySource(this.targets.dye, 2, {}, dt);
    }
  }

  emitterSource(emitter) {
    if (!emitter.throttle) {
      return emitter;
    }
    const throttle = this.config.throttle;
    const lazy = (1 - throttle) ** 2;
    const flicker = Math.sin(this.sourceTime * 9) * Math.sin(this.sourceTime * 5.3);
    return {
      ...emitter,
      radius: emitter.radius * (1 - 0.68 * throttle),
      heat: emitter.heat * (0.13 + 0.87 * throttle ** 2) * (1 + 0.08 * lazy * flicker),
      dye: emitter.dye.map(value => value * (1 - 0.65 * throttle)),
      velocity: [emitter.velocity[0] + 4 * lazy * flicker, emitter.velocity[1] * (0.04 + 0.96 * throttle ** 2)],
    };
  }

  applyForces(dt, initialize = false) {
    const { gl } = this;
    const { velocity, temperature } = this.targets;
    const program = this.use("forces");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    this.bindTexture(program, "temperatureField", temperature?.read ?? velocity.read, 1);
    gl.uniform1i(this.uniform(program, "hasTemperature"), temperature ? 1 : 0);
    gl.uniform1i(this.uniform(program, "initialize"), initialize ? 1 : 0);
    gl.uniform1i(this.uniform(program, "wakeSeed"), this.scene.wakeSeed ? 1 : 0);
    const nozzle = this.scene.emitters?.find(emitter => emitter.throttle);
    gl.uniform2f(this.uniform(program, "nozzle"), nozzle?.x ?? 0, nozzle?.y ?? 0);
    gl.uniform1f(this.uniform(program, "jetMomentum"), nozzle ? this.config.throttle ** 3 : 0);
    gl.uniform1f(this.uniform(program, "jetSpeed"), nozzle ? this.emitterSource(nozzle).velocity[1] * this.velocityScale() : 0);
    gl.uniform1f(this.uniform(program, "buoyancy"), this.config.buoyancy * this.velocityScale());
    gl.uniform1f(this.uniform(program, "timeStep"), dt);
    this.drawTo(velocity.write);
    velocity.swap();
  }

  renderField() {
    const { gl } = this;
    const fields = {
      speed: this.targets.velocity.read,
      vorticity: this.targets.curl,
      pressure: this.targets.pressure.read,
      temperature: this.targets.temperature?.read,
    };
    const program = this.use("fieldDisplay");
    this.bindTexture(program, "field", fields[this.config.view] ?? this.targets.pressure.read, 0);
    gl.uniform1i(this.uniform(program, "view"), VIEWS.indexOf(this.config.view));
    gl.uniform3f(this.uniform(program, "background"), ...parseHexColor(this.config.backgroundColor));
    this.drawTo(null);
  }

  renderBloom() {
    const { gl } = this;
    const chain = this.targets.bloom;
    if (!this.config.bloom || chain.length === 0) return null;

    gl.disable(gl.BLEND);
    let program = this.use("bloomPrefilter");
    this.bindTexture(program, "dyeField", this.targets.dye.read, 0);
    this.bindTexture(program, "temperatureField", this.targets.temperature?.read ?? this.targets.dye.read, 3);
    gl.uniform1i(this.uniform(program, "flameShading"), this.config.flameShading ? 1 : 0);
    gl.uniform1f(this.uniform(program, "threshold"), this.config.bloomThreshold);
    gl.uniform1f(this.uniform(program, "softKnee"), this.config.bloomSoftKnee);
    this.drawTo(chain[0].read);

    const steps = Math.min(
      Math.max(0, Math.floor(this.config.bloomIterations)),
      chain.length - 1,
    );
    program = this.use("bloomDownsample");
    for (let index = 1; index <= steps; index += 1) {
      const source = chain[index - 1].read;
      this.bindTexture(program, "sourceField", source, 0);
      gl.uniform2f(this.uniform(program, "sourceTexel"), source.texelX, source.texelY);
      this.drawTo(chain[index].read);
    }

    program = this.use("bloomUpsample");
    for (let index = steps - 1; index >= 0; index -= 1) {
      const base = chain[index];
      const lower = chain[index + 1].read;
      this.bindTexture(program, "baseField", base.read, 0);
      this.bindTexture(program, "lowerField", lower, 1);
      gl.uniform2f(this.uniform(program, "lowerTexel"), lower.texelX, lower.texelY);
      this.drawTo(base.write);
      base.swap();
    }

    return chain[0].read;
  }

  renderSunrays() {
    const { gl } = this;
    const targets = this.targets.sunrays;
    if (!this.config.sunrays || !targets) return null;

    gl.disable(gl.BLEND);
    let program = this.use("sunraysMask");
    this.bindTexture(program, "dyeField", this.targets.dye.read, 0);
    this.drawTo(targets.mask);

    program = this.use("sunrays");
    this.bindTexture(program, "maskField", targets.mask, 0);
    this.drawTo(targets.rays);
    return targets.rays;
  }

  render() {
    const { gl } = this;
    this.ensurePhysicsTargets();
    this.ensureEffectTargets();
    if (this.config.view !== "dye") {
      this.renderField();
      return;
    }
    const bloom = this.config.inverted ? null : this.renderBloom();
    const sunrays = this.config.inverted ? null : this.renderSunrays();
    const program = this.use(this.targets.obstacles ? "wallDisplay" : "display");
    const background = parseHexColor(this.config.backgroundColor);
    gl.disable(gl.BLEND);
    this.bindTexture(program, "dyeField", this.targets.dye.read, 0);
    gl.uniform2f(
      this.uniform(program, "texel"),
      this.targets.dye.texelX,
      this.targets.dye.texelY,
    );
    this.bindTexture(program, "bloomField", bloom ?? this.targets.dye.read, 1);
    this.bindTexture(program, "sunraysField", sunrays ?? this.targets.dye.read, 2);
    gl.uniform3f(this.uniform(program, "background"), background[0], background[1], background[2]);
    gl.uniform1f(this.uniform(program, "bloomIntensity"), this.config.bloomIntensity);
    gl.uniform1f(this.uniform(program, "sunraysWeight"), this.config.sunraysWeight);
    gl.uniform1i(this.uniform(program, "useInk"), this.config.inverted ? 1 : 0);
    this.bindTexture(program, "temperatureField", this.targets.temperature?.read ?? this.targets.dye.read, 3);
    gl.uniform1i(this.uniform(program, "warmSmoke"), this.scene.emitters?.length && !this.config.flameShading ? 1 : 0);
    gl.uniform1i(this.uniform(program, "flameShading"), this.config.flameShading ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useShading"), this.config.shading ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useTransparency"), this.config.transparent ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useBloom"), bloom ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useSunrays"), sunrays ? 1 : 0);
    this.drawTo(null);
  }

  runFrame(dt, time) {
    const settings = this.config;
    const features = this.readMusic?.(time) ?? null;
    const response = this.musicResponse(settings, this.musicMapping, features, time);
    this.config = response.config;
    this.musicHue = features && settings.musicSensitivity > 0 ? response.hue : null;
    this.musicHeat = this.config.heat - settings.heat;
    this.musicPuff = features ? Math.max(0, this.musicPuff - dt) : 0;
    try {
      this.ensureTargets();
      this.updatePointerColors(dt);
      this.applyPointerInputs();
      if (!this.paused) {
        this.symmetryAngle = (this.symmetryAngle + dt * this.config.symmetrySpin * 0.4 * response.spin
          + (response.burst ? this.config.symmetrySpin * 0.035 : 0)) % (Math.PI * 2);
        this.musicEnergy = features && this.musicMapping.energy ? response.energy : null;
        if (response.burst && this.musicMapping.bursts) {
          const radius = this.config.splatRadius;
          this.config.splatRadius = Math.max(0.01, Math.min(1, radius * (0.6 + features.bass * settings.musicSensitivity)));
          this.burstSplats(this.musicMapping.bursts + (this.musicEnergy === null ? 0 : Math.round(2 * this.musicEnergy)));
          this.config.splatRadius = radius;
        }
        if (this.musicEnergy !== null) {
          this.wispTime += dt;
          if (this.wispTime >= 0.5 + 1.5 * this.musicEnergy) {
            this.wispTime = 0;
            const radius = this.config.splatRadius;
            this.config.splatRadius = Math.min(1, radius * 1.8);
            if (this.musicMapping.edges) {
              this.edgeSplats(true);
            } else {
              this.burstSplats(1, true);
            }
            this.config.splatRadius = radius;
          }
        }
        if (response.burst && this.musicMapping.puff) {
          this.musicPuff = 0.2;
        }
        if (!features && this.musicMapping.automatic) {
          this.automaticTime += dt;
          if (this.automaticTime >= (this.musicMapping.interval ?? 1.1)) {
            this.automaticTime = 0;
            this.nextWisp(false);
          }
        }
        this.step(dt);
      }
      this.render();
      this.musicDisplayConfig = response.config;
    } finally {
      this.config = settings;
    }
  }

  frame(timestamp) {
    if (!this.running || this.destroyed) return;
    const dt = Math.min(Math.max((timestamp - this.lastTimestamp) / 1000, 0), MAX_TIME_STEP);
    this.lastTimestamp = timestamp;
    try {
      this.resizeCanvas();
      this.runFrame(dt, timestamp / 1000);
    } catch (error) {
      this.stop();
      if (!this.onError) throw error;
      this.onError(error);
      return;
    }
    this.onFrame?.(timestamp);
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  screenshot() {
    if (this.destroyed || !this.targets.dye) return;
    const settings = this.config;
    try {
      this.config = this.musicDisplayConfig ?? settings;
      this.render();
    } finally {
      this.config = settings;
    }

    const downloadBlob = (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = "fluid.png";
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    };

    this.canvas.toBlob(downloadBlob, "image/png");
  }
}

/**
 * Creates the repository's WebGL2 solver inside `host`.
 * The returned object owns its canvas and GPU resources. `setConfig` accepts
 * partial updates and reallocates only the target group whose resolution changes.
 */
export default function createEngine(host, config = {}) {
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  host.appendChild(canvas);

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    canvas.remove();
    throw new Error("This browser or device does not provide WebGL2.");
  }
  if (!gl.getExtension("EXT_color_buffer_float")) {
    canvas.remove();
    throw new Error("WebGL2 is available, but EXT_color_buffer_float is missing.");
  }

  try {
    return new LabEngine(host, canvas, gl, config);
  } catch (error) {
    canvas.remove();
    throw error;
  }
}
