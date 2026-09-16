import { FRAGMENT_SHADERS, FULLSCREEN_VERTEX_SHADER } from "./lab/shaders.js";

const MAX_TIME_STEP = 0.016666;

const DEFAULT_CONFIG = Object.freeze({
  simResolution: 128,
  dyeResolution: 1024,
  captureResolution: 512,
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
    };
    this.running = false;
    this.destroyed = false;
    this.paused = false;
    this.drawWhilePaused = false;
    this.animationFrame = null;
    this.lastTimestamp = 0;
    this.colorTimer = 0;
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
    const program = this.programs.get(name);
    this.gl.useProgram(program.handle);
    return program;
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
  }

  ensureEffectTargets() {
    if (this.config.bloom) {
      const size = this.resolution(this.config.bloomResolution);
      const base = this.targets.bloom[0];
      if (!base || base.width !== size.width || base.height !== size.height) {
        this.allocateBloomTargets(size);
      }
    } else if (this.targets.bloom.length > 0) {
      this.deleteBloomTargets();
    }

    if (this.config.sunrays) {
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

    this.canvas.style.filter = this.config.inverted ? "invert(1)" : "none";
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

  generateColor() {
    const palette = Array.isArray(this.config?.colorPalette) ? this.config.colorPalette : [];
    let hue = Math.random();
    let saturation = 1;
    if (palette.length > 0) {
      const selected = palette[Math.floor(Math.random() * palette.length)];
      [hue, saturation] = rgbToHsv(parseHexColor(selected));
    }
    const color = hsvToRgb(hue, saturation, Number(this.config?.brightness ?? DEFAULT_CONFIG.brightness));
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
    this.movePointer(this.mousePointer, event.clientX, event.clientY, Boolean(this.config.hover));
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
      this.injectNormalized(
        pointer.x,
        pointer.y,
        pointer.dx * this.config.splatForce,
        pointer.dy * this.config.splatForce,
        pointer.color,
      );
    }
  }

  injectNormalized(x, y, dx, dy, color) {
    if (!this.targets.velocity || !this.targets.dye) return;
    const { gl } = this;
    const aspect = this.canvas.width / this.canvas.height;
    let radius = this.config.splatRadius / 100;
    if (aspect > 1) radius *= aspect;
    gl.disable(gl.BLEND);

    let program = this.use("splat");
    this.bindTexture(program, "targetField", this.targets.velocity.read, 0);
    gl.uniform2f(this.uniform(program, "center"), x, y);
    gl.uniform3f(this.uniform(program, "amount"), dx, dy, 0);
    gl.uniform1f(this.uniform(program, "aspectRatio"), aspect);
    gl.uniform1f(this.uniform(program, "radius"), radius);
    this.drawTo(this.targets.velocity.write);
    this.targets.velocity.swap();

    program = this.use("splat");
    this.bindTexture(program, "targetField", this.targets.dye.read, 0);
    gl.uniform2f(this.uniform(program, "center"), x, y);
    gl.uniform3f(this.uniform(program, "amount"), color[0], color[1], color[2]);
    gl.uniform1f(this.uniform(program, "aspectRatio"), aspect);
    gl.uniform1f(this.uniform(program, "radius"), radius);
    this.drawTo(this.targets.dye.write);
    this.targets.dye.swap();
  }

  splat(x, y, dx, dy, color) {
    if (this.destroyed || !this.targets.velocity) return;
    const bounds = this.canvas.getBoundingClientRect();
    const dye = color ?? this.generateColor().map((channel) => channel * 10);
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
        1000 * (Math.random() - 0.5),
        1000 * (Math.random() - 0.5),
        color,
      );
    }
  }

  togglePause(drawWhilePaused = false) {
    this.paused = !this.paused;
    if (this.paused) this.drawWhilePaused = Boolean(drawWhilePaused);
    return this.paused;
  }

  advect(source, destination, velocity, dissipation, dt) {
    const { gl } = this;
    const program = this.use("advect");
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

    let program = this.use("curl");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    this.drawTo(curl);

    program = this.use("vorticity");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    this.bindTexture(program, "curlField", curl, 1);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    gl.uniform1f(this.uniform(program, "strength"), this.config.curl);
    gl.uniform1f(this.uniform(program, "timeStep"), dt);
    this.drawTo(velocity.write);
    velocity.swap();

    program = this.use("divergence");
    this.bindTexture(program, "velocityField", velocity.read, 0);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    this.drawTo(divergence);

    program = this.use("pressureDecay");
    this.bindTexture(program, "pressureField", pressure.read, 0);
    gl.uniform1f(this.uniform(program, "retention"), this.config.pressure);
    this.drawTo(pressure.write);
    pressure.swap();

    program = this.use("pressureSolve");
    this.bindTexture(program, "divergenceField", divergence, 1);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    const iterations = Math.max(0, Math.floor(this.config.pressureIterations));
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      this.bindTexture(program, "pressureField", pressure.read, 0);
      this.drawTo(pressure.write);
      pressure.swap();
    }

    program = this.use("project");
    this.bindTexture(program, "pressureField", pressure.read, 0);
    this.bindTexture(program, "velocityField", velocity.read, 1);
    gl.uniform2f(this.uniform(program, "texel"), velocity.texelX, velocity.texelY);
    this.drawTo(velocity.write);
    velocity.swap();
  }

  renderBloom() {
    const { gl } = this;
    const chain = this.targets.bloom;
    if (!this.config.bloom || chain.length === 0) return null;

    gl.disable(gl.BLEND);
    let program = this.use("bloomPrefilter");
    this.bindTexture(program, "dyeField", this.targets.dye.read, 0);
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
    this.ensureEffectTargets();
    const bloom = this.renderBloom();
    const sunrays = this.renderSunrays();
    const program = this.use("display");
    const background = parseHexColor(this.config.backgroundColor);
    gl.disable(gl.BLEND);
    this.bindTexture(program, "dyeField", this.targets.dye.read, 0);
    gl.uniform2f(
      this.uniform(program, "texel"),
      this.targets.dye.texelX,
      this.targets.dye.texelY,
    );
    if (bloom) this.bindTexture(program, "bloomField", bloom, 1);
    if (sunrays) this.bindTexture(program, "sunraysField", sunrays, 2);
    gl.uniform3f(this.uniform(program, "background"), background[0], background[1], background[2]);
    gl.uniform1f(this.uniform(program, "bloomIntensity"), this.config.bloomIntensity);
    gl.uniform1f(this.uniform(program, "sunraysWeight"), this.config.sunraysWeight);
    gl.uniform1i(this.uniform(program, "useShading"), this.config.shading ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useTransparency"), this.config.transparent ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useBloom"), bloom ? 1 : 0);
    gl.uniform1i(this.uniform(program, "useSunrays"), sunrays ? 1 : 0);
    this.drawTo(null);
  }

  frame(timestamp) {
    if (!this.running || this.destroyed) return;
    const dt = Math.min(Math.max((timestamp - this.lastTimestamp) / 1000, 0), MAX_TIME_STEP);
    this.lastTimestamp = timestamp;
    this.resizeCanvas();
    this.ensureTargets();
    this.updatePointerColors(dt);
    this.applyPointerInputs();
    if (!this.paused) this.step(dt);
    this.render();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  screenshot() {
    if (this.destroyed || !this.targets.dye) return;
    this.render();

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

    if (!this.config.inverted) {
      this.canvas.toBlob(downloadBlob, "image/png");
      return;
    }

    const copy = document.createElement("canvas");
    copy.width = this.canvas.width;
    copy.height = this.canvas.height;
    const context = copy.getContext("2d");
    if (!context) {
      this.canvas.toBlob(downloadBlob, "image/png");
      return;
    }
    context.filter = "invert(1)";
    context.drawImage(this.canvas, 0, 0);
    copy.toBlob(downloadBlob, "image/png");
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
