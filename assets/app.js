import { normalizeConfig, normalizeAutoSplats, normalizeSharedState, encodeShareState, decodeShareState, MAX_PALETTE } from "./config.js";
import createEngine from "./engines/lab.js";
import { createMusicPlayer } from "./music.js";
import { createResolutionMonitor, lowerResolutions } from "./resolution-monitor.js";
import { CONTROL_HELP, FIELD_HELP, SWATCH_HELP, VIEW_HELP } from "./help.js";
import {
  BOOL_FIELDS,
  DEFAULT_PRESET,
  NUMBER_FIELDS,
  PRESETS,
  PHYSICS_DEFAULTS,
  VIEWS,
  labDefault,
} from "./presets.js";

const STORAGE_KEY = "webgl-labs.fluid.state.v4";
const MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const MOBILE_CAP = {
  simResolution: 128,
  dyeResolution: 1024,
  pressureIterations: 20,
  bloomResolution: 256,
  sunraysResolution: 196,
};
const state = loadState();
const root = document.querySelector("#fluid-root");
const panel = document.querySelector("#panel");
const showPanel = document.querySelector("#show-panel");
const statusEl = document.querySelector("#status");
let sim;
let music;
let jetTimer = 0;
let contextLost = false;
let pointerTool = "paint";
let unbindCanvas;
const resolutionMonitor = createResolutionMonitor(() => {
  const current = liveConfig();
  const lowered = lowerResolutions(current);
  if (lowered.simResolution === current.simResolution && lowered.dyeResolution === current.dyeResolution) {
    return false;
  }
  applyConfig(lowered);
  setStatus("Resolution lowered for this device.");
  return true;
});

function clone(value) {
  return structuredClone(value);
}

function currentPreset() {
  return PRESETS[state.preset] ?? PRESETS[DEFAULT_PRESET];
}

function loadState() {
  const fallback = {
    config: { ...clone(labDefault), reduceFlashing: matchMedia("(prefers-reduced-motion: reduce)").matches },
    preset: DEFAULT_PRESET,
    autoSplats: 5,
    jet: Boolean(PRESETS[DEFAULT_PRESET].startJet),
  };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored) {
      return fallback;
    }
    return {
      config: fallback.config,
      preset: DEFAULT_PRESET,
      autoSplats: normalizeAutoSplats(stored.autoSplats),
      jet: Boolean(PRESETS[DEFAULT_PRESET].startJet),
    };
  } catch {
    return fallback;
  }
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ autoSplats: state.autoSplats }),
    );
    return true;
  } catch {
    return false;
  }
}

function setPanelHidden(hidden) {
  panel.classList.toggle("hidden", hidden);
  document.querySelector("#hide").setAttribute("aria-expanded", String(!hidden));
  showPanel.setAttribute("aria-expanded", String(!hidden));
  showPanel.classList.toggle("hidden", !hidden);
}

function liveConfig() {
  return runtimeConfig(state.config);
}

function runtimeConfig(partial) {
  const config = { ...partial };
  if (MOBILE) {
    for (const [key, cap] of Object.entries(MOBILE_CAP)) {
      if (config[key] !== undefined) {
        config[key] = Math.min(config[key], cap);
      }
    }
  }
  return config;
}

function pushConfig(partial) {
  if (sim && !contextLost) {
    sim.setConfig(partial ? runtimeConfig(partial) : liveConfig());
  }
  const saved = persist();
  syncForm();
  return saved;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function applyConfig(partial = {}, fullPush = false) {
  const normalized = normalizeConfig(partial);
  state.config = { ...state.config, ...normalized };
  return pushConfig(fullPush ? undefined : normalized);
}

function applyPreset(name) {
  if (!Object.hasOwn(PRESETS, name)) {
    return;
  }
  const preset = PRESETS[name];
  state.preset = name;
  state.config = normalizeConfig({
    ...PHYSICS_DEFAULTS,
    ...clone(preset.config),
    reduceFlashing: state.config.reduceFlashing,
    musicSensitivity: state.config.musicSensitivity,
  });
  pushConfig();
  if (sim && !contextLost) {
    sim.reset(preset.physics ?? {});
    sim.musicMapping = preset.music;
  }
  setJet(Boolean(preset.startJet));
  const capped = MOBILE && (preset.config.simResolution > MOBILE_CAP.simResolution || preset.config.dyeResolution > MOBILE_CAP.dyeResolution);
  setStatus(capped ? `${preset.note} Phone GPU cap is on.` : preset.note);
  resolutionMonitor.reset(document.hidden ? undefined : performance.now());
}

function exportConfig() {
  const saved = { preset: state.preset, config: state.config, jet: state.jet, autoSplats: state.autoSplats };
  const blob = new Blob([JSON.stringify(saved, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "fluid-config.json";
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Exported fluid-config.json");
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const shared = normalizeSharedState(JSON.parse(String(reader.result)));
      if (!shared) {
        throw new Error("not a settings file");
      }
      if (shared.preset !== undefined) {
        applyPreset(shared.preset);
      }
      const saved = applyConfig(keepReducedFlashing(shared.config), true);
      if (shared.preset !== undefined) {
        setJet(shared.jet);
      }
      if (shared.autoSplats !== undefined) {
        state.autoSplats = shared.autoSplats;
        persist();
        syncForm();
      }
      setStatus(saved ? `Imported ${file.name}` : `Imported ${file.name}, but could not save settings`);
    } catch {
      setStatus("Could not parse that JSON file");
    }
  };
  reader.readAsText(file);
}

function keepReducedFlashing(config) {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? { ...config, reduceFlashing: true } : config;
}

function copyShareLink() {
  const url = `${location.origin}${location.pathname}${encodeShareState(state)}`;
  const done = () => setStatus("Share URL copied");
  const fail = () => setStatus("Could not copy URL");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done, fail);
    return;
  }
  fail();
}

function applyHashState() {
  const decoded = decodeShareState(location.hash);
  if (!decoded) {
    return false;
  }
  if (decoded.preset !== undefined) {
    state.preset = decoded.preset;
  }
  if (decoded.config) {
    state.config = { ...PHYSICS_DEFAULTS, ...clone(currentPreset().config), reduceFlashing: state.config.reduceFlashing, ...keepReducedFlashing(decoded.config) };
  }
  if (decoded.autoSplats !== undefined) {
    state.autoSplats = decoded.autoSplats;
  }
  if (decoded.jet !== undefined) {
    state.jet = decoded.jet;
  }
  persist();
  return true;
}

function field(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

function setTool(tool) {
  pointerTool = tool;
  sim?.setTool(tool);
  document.querySelectorAll("[data-tool]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
  });
}

function buildControls() {
  for (const view of VIEWS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.view = view;
    button.textContent = view[0].toUpperCase() + view.slice(1);
    button.dataset.tip = VIEW_HELP[view];
    button.addEventListener("click", () => applyConfig({ view }));
    document.querySelector("#views").append(button);
  }
  const presets = document.querySelector("#preset");

  for (const [id, preset] of Object.entries(PRESETS)) {
    const option = document.createElement("button");
    option.type = "button";
    option.dataset.preset = id;
    option.addEventListener("click", () => applyPreset(id));
    option.textContent = preset.label;
    option.dataset.tip = preset.note;
    presets.append(option);
  }

  for (const [key, label, min, max, step, group] of NUMBER_FIELDS) {
    const row = field(`
      <div class="field">
        <label for="${key}">${label}</label>
        <div class="control">
          <input id="${key}" type="range" min="${min}" max="${max}" step="${step}" />
          <span class="value" data-for="${key}"></span>
        </div>
      </div>
    `);
    row.dataset.tip = FIELD_HELP[key];
    document.querySelector(`#${group}-fields`).append(row);
    row.querySelector("input").addEventListener("input", (event) => {
      applyConfig({ [key]: Number(event.target.value) });
    });
  }

  for (const [key, label, group] of BOOL_FIELDS) {
    const row = field(`<label class="toggle"><input id="${key}" type="checkbox" /> ${label}</label>`);
    row.dataset.tip = FIELD_HELP[key];
    document.querySelector(`#${group}-fields`).append(row);
    row.querySelector("input").addEventListener("change", (event) => {
      applyConfig({ [key]: event.target.checked });
    });
  }

  for (const [selector, text] of Object.entries(CONTROL_HELP)) {
    const control = document.querySelector(selector);
    (control.closest(".field, .toggle") ?? control).dataset.tip = text;
  }
}

function bindTooltips() {
  const tooltip = document.querySelector("#tooltip");
  let described = null;
  const hide = () => {
    tooltip.hidden = true;
    described?.removeAttribute("aria-describedby");
    described = null;
  };
  const show = (element, focused) => {
    const target = element instanceof Element ? element.closest("[data-tip]") : null;
    hide();
    if (!target) {
      return;
    }
    tooltip.textContent = target.dataset.tip;
    tooltip.hidden = false;
    if (focused) {
      described = element;
      described.setAttribute("aria-describedby", "tooltip");
    }
    const margin = 8;
    const box = target.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    const sheet = panel.contains(target) ? panel.getBoundingClientRect() : box;
    let left = sheet.left - size.width - margin;
    let top = box.top;
    if (left < margin) {
      left = box.left;
      top = sheet.top - size.height - margin;
    }
    tooltip.style.left = `${Math.max(margin, Math.min(left, innerWidth - size.width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(top, innerHeight - size.height - margin))}px`;
  };
  document.addEventListener("pointerover", event => show(event.target, false));
  document.addEventListener("focusin", event => show(event.target, true));
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", event => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-tip]")) {
      hide();
    }
  });
  panel.addEventListener("scroll", hide);
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      hide();
    }
  });
}

function syncForm() {
  document.querySelectorAll("[data-preset]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.preset === state.preset));
  });
  document.querySelectorAll("[data-view]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.config.view));
  });
  document.querySelector("#preset-note").textContent = PRESETS[state.preset]?.note ?? "";
  for (const [key] of NUMBER_FIELDS) {
    const input = document.querySelector(`#${key}`);
    if (!input) {
      continue;
    }
    input.value = state.config[key];
    const value = document.querySelector(`[data-for="${key}"]`);
    if (value) {
      value.textContent = String(state.config[key]);
    }
  }
  for (const [key] of BOOL_FIELDS) {
    const input = document.querySelector(`#${key}`);
    if (input) {
      input.checked = Boolean(state.config[key]);
    }
  }
  document.querySelector("#backgroundColor").value = state.config.backgroundColor;
  syncPalette();
  document.querySelector("#autoSplats").value = String(state.autoSplats);
  document.querySelector("[data-for=\"autoSplats\"]").textContent = String(state.autoSplats);
  document.querySelector("#jet").checked = state.jet;
}

function pulseJet() {
  if (!state.jet || contextLost || !sim) {
    return;
  }
  const canvas = sim.canvas;
  if (!canvas) {
    return;
  }
  const jet = currentPreset().jet ?? {};
  const x = canvas.clientWidth * (jet.x ?? 0.2);
  const y = canvas.clientHeight * (jet.y ?? 0.5);
  const scale = MOBILE ? 0.7 : 1;
  const dx = (jet.force ?? 400) * scale + (Math.random() - 0.5) * (jet.jitter ?? 40);
  const dy = (jet.dy ?? 0) + (Math.random() - 0.5) * (jet.jitter ?? 40) * 0.4;
  sim.splat(x, y, dx, dy);
}

function stopJetTimer() {
  clearInterval(jetTimer);
  jetTimer = 0;
}

function startJetTimer() {
  stopJetTimer();
  if (state.jet && sim && !document.hidden && !contextLost) {
    jetTimer = setInterval(pulseJet, currentPreset().jet?.interval ?? 80);
  }
}

function setJet(enabled) {
  state.jet = enabled;
  persist();
  startJetTimer();
  document.querySelector("#jet").checked = state.jet;
}

function togglePause() {
  if (!sim) {
    return;
  }
  const paused = sim.togglePause(true);
  const button = document.querySelector("#pause");
  button.textContent = paused ? "Resume" : "Pause";
  button.setAttribute("aria-pressed", String(paused));
  setStatus(paused ? "Paused (you can still paint)" : "Running");
}

function syncPalette() {
  const container = document.querySelector("#colorPalette");
  const palette = state.config.colorPalette || [];
  container.replaceChildren();
  palette.forEach((color, index) => {
    const input = document.createElement("input");
    input.type = "color";
    input.setAttribute("aria-label", "Colour " + (index + 1));
    input.value = color;
    input.addEventListener("change", () => {
      const next = [...palette];
      next[index] = input.value;
      applyConfig({ colorPalette: next });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.setAttribute("aria-label", "Remove colour " + (index + 1));
    remove.addEventListener("click", () => applyConfig({ colorPalette: palette.filter((_, i) => i !== index) }));
    const item = document.createElement("div");
    item.dataset.tip = SWATCH_HELP;
    item.append(input, remove);
    container.append(item);
  });
  document.querySelector("#add-swatch").disabled = palette.length >= MAX_PALETTE;
}

function dismissHint() {
  document.querySelector("#paint-hint").classList.add("dismissed");
}

function updateMeters(features) {
  for (const key of ["bass", "mid", "treble"]) {
    const meter = document.querySelector(`#level-${key}`);
    if (meter) {
      meter.value = features?.[key] ?? 0;
    }
  }
}

function bindMusic() {
  const play = document.querySelector("#track-play");
  const stop = document.querySelector("#music-stop");
  const demo = document.querySelector("#demo-beat");
  const tab = document.querySelector("#tab-audio");
  const picker = document.querySelector("#track-file");
  const sourceLine = document.querySelector("#music-source");
  const loopLabel = document.querySelector("#track-loop-label");
  const musicStatus = document.querySelector("#music-status");
  music = createMusicPlayer(document.querySelector("#music-audio"), ({ source, name, playing }) => {
    sourceLine.textContent = name;
    play.hidden = source !== "track";
    play.textContent = playing ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(playing));
    stop.disabled = !source;
    loopLabel.hidden = source !== "track";
    demo.setAttribute("aria-pressed", String(source === "demo"));
    if (!playing) {
      updateMeters(null);
      if (sim) {
        sim.musicDisplayConfig = undefined;
      }
    }
  }, message => {
    musicStatus.textContent = message;
  });
  tab.hidden = !navigator.mediaDevices?.getDisplayMedia;
  tab.addEventListener("click", () => music.useTab());
  demo.addEventListener("click", () => music.demo());
  play.addEventListener("click", () => music.playTrack());
  stop.addEventListener("click", () => music.stop());
  document.querySelector("#choose-track").addEventListener("click", () => picker.click());
  document.querySelector("#track-loop").addEventListener("change", event => music.setLoop(event.target.checked));
  const choose = file => {
    if (!sim) {
      return;
    }
    music.chooseTrack(file);
    music.setLoop(document.querySelector("#track-loop").checked);
    document.querySelector("#music-section").open = true;
    setPanelHidden(false);
  };
  picker.addEventListener("change", event => {
    if (event.target.files?.[0]) {
      choose(event.target.files[0]);
    }
    picker.value = "";
  });
  window.addEventListener("dragover", event => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
    }
  });
  window.addEventListener("drop", event => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) {
      choose(file);
    }
  });
  window.addEventListener("pagehide", () => music.stop());
}

function bindActions() {
  bindMusic();
  bindTooltips();
  setTimeout(dismissHint, 6000);
  document.querySelectorAll("[data-preset], [data-tool], [data-view]").forEach(button => {
    button.addEventListener("click", dismissHint);
  });
  document.querySelectorAll("[data-tool]").forEach(button => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });
  document.querySelector("#clear-walls").addEventListener("click", () => {
    if (!contextLost) {
      sim?.clearWalls();
    }
  });
  document.querySelector("#reset").addEventListener("click", () => {
    applyPreset(state.preset);
  });
  document.querySelector("#pause").addEventListener("click", () => {
    togglePause();
  });
  document.querySelector("#splats").addEventListener("click", () => {
    if (!contextLost) {
      sim?.multipleSplats(state.autoSplats);
    }
  });
  document.querySelector("#shot").addEventListener("click", () => {
    if (!contextLost) {
      sim?.screenshot();
    }
  });
  document.querySelector("#export").addEventListener("click", exportConfig);
  document.querySelector("#copy-link").addEventListener("click", copyShareLink);
  document.querySelector("#import").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) {
      importConfig(file);
    }
    event.target.value = "";
  });
  document.querySelector("#hide").addEventListener("click", () => setPanelHidden(true));
  showPanel.addEventListener("click", () => setPanelHidden(false));
  document.querySelector("#backgroundColor").addEventListener("change", (event) => {
    applyConfig({ backgroundColor: event.target.value });
  });
  document.querySelector("#add-swatch").addEventListener("click", () => {
    if (state.config.colorPalette.length < MAX_PALETTE) {
      applyConfig({ colorPalette: [...state.config.colorPalette, "#ffffff"] });
    }
  });
  document.querySelector("#random-colours").addEventListener("click", () => applyConfig({ colorPalette: [] }));
  document.querySelector("#autoSplats").addEventListener("input", (event) => {
    state.autoSplats = Number(event.target.value);
    persist();
    document.querySelector("[data-for=\"autoSplats\"]").textContent = String(state.autoSplats);
  });
  document.querySelector("#jet").addEventListener("change", (event) => {
    setJet(event.target.checked);
  });

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }
    if (
      event.target instanceof HTMLInputElement
      || event.target instanceof HTMLTextAreaElement
      || event.target instanceof HTMLSelectElement
      || event.target instanceof HTMLButtonElement
      || event.target.closest("summary, a")
    ) {
      return;
    }
    const tools = { KeyW: "wall", KeyE: "erase", KeyD: "paint" };
    if (Object.hasOwn(tools, event.code)) {
      setTool(tools[event.code]);
    }
    if (event.code === "KeyV") {
      applyConfig({ view: VIEWS[(VIEWS.indexOf(state.config.view) + 1) % VIEWS.length] });
    }
    if (event.code === "KeyH") {
      setPanelHidden(!panel.classList.contains("hidden"));
    }
    if (event.code === "Space") {
      event.preventDefault();
      if (!contextLost) {
        sim?.multipleSplats(state.autoSplats);
      }
    }
    if (event.code === "KeyP") {
      togglePause();
    }
    if (event.code === "KeyM" && !event.repeat) {
      document.querySelector("#demo-beat")?.click();
    }
    if (event.code === "KeyJ") {
      setJet(!state.jet);
    }
  });

  document.addEventListener("visibilitychange", () => {
    resolutionMonitor.suspend();
    startJetTimer();
  });
}

function bindCanvas(canvas) {
  canvas.addEventListener("pointerdown", dismissHint, { once: true });
  canvas.addEventListener("touchstart", dismissHint, { once: true, passive: true });
  const lockScroll = (event) => event.preventDefault();
  const handleContextLost = (event) => {
    event.preventDefault();
    contextLost = true;
    resolutionMonitor.suspend();
    sim?.stop();
    stopJetTimer();
    setStatus("WebGL context lost. Waiting for the graphics driver to recover.");
  };
  const handleContextRestored = () => {
    contextLost = false;
    setStatus("WebGL restored. Restarting the simulation.");
    const paused = sim?.paused;
    unbindCanvas?.();
    sim?.destroy();
    if (startSimulation() && paused) {
      sim.togglePause(true);
    }
  };
  canvas.addEventListener("touchstart", lockScroll, { passive: false });
  canvas.addEventListener("touchmove", lockScroll, { passive: false });
  canvas.addEventListener("webglcontextlost", handleContextLost);
  canvas.addEventListener("webglcontextrestored", handleContextRestored);
  return () => {
    canvas.removeEventListener("touchstart", lockScroll);
    canvas.removeEventListener("touchmove", lockScroll);
    canvas.removeEventListener("webglcontextlost", handleContextLost);
    canvas.removeEventListener("webglcontextrestored", handleContextRestored);
  };
}

function startSimulation() {
  try {
    sim = createEngine(root, liveConfig());
    sim.musicMapping = currentPreset().music;
    sim.readMusic = time => {
      const features = music?.read(time) ?? null;
      updateMeters(features);
      return features;
    };
    sim.onFrame = timestamp => resolutionMonitor.frame(timestamp, document.hidden);
    sim.onError = error => {
      stopJetTimer();
      setStatus(`The simulation stopped: ${error instanceof Error ? error.message : String(error)}`);
    };
    sim.reset(currentPreset().physics ?? {});
    sim.setTool(pointerTool);
    unbindCanvas = bindCanvas(sim.canvas);
    sim.start();
    startJetTimer();
    return true;
  } catch (error) {
    try {
      sim?.destroy();
    } catch {
      // Preserve the original initialization error for the fallback message.
    }
    const message = error instanceof Error ? error.message : String(error);
    sim = undefined;
    showWebGLUnavailable(message);
    return false;
  }
}

function showWebGLUnavailable(detail = "") {
  root.replaceChildren();
  panel.innerHTML = `
    <header class="panel-head"><h1>WebGL unavailable</h1></header>
    <p role="alert">This fluid simulation needs WebGL2 with floating-point render targets, but this browser or device could not provide them.</p>
  `;
  if (detail) {
    const detailEl = document.createElement("p");
    detailEl.textContent = detail;
    panel.append(detailEl);
  }
  panel.classList.remove("hidden");
  showPanel.classList.add("hidden");
}

function bootstrap() {
  const hashIsValid = applyHashState();
  buildControls();
  bindActions();
  syncForm();
  const started = startSimulation();
  if (!sim) {
    return;
  }
  if (state.jet) {
    startJetTimer();
  }
  setPanelHidden(MOBILE || matchMedia("(max-width: 640px)").matches);
  if (!hashIsValid) {
    setStatus("Share hash was invalid");
  } else if (started) {
    setStatus(MOBILE ? "Swipe to paint. Tap Lab for controls." : currentPreset().note);
  }
  resolutionMonitor.reset(document.hidden ? undefined : performance.now());
}

bootstrap();
