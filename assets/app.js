import createEngine from "./engines/lab.js";
import {
  BOOL_FIELDS,
  DEFAULT_PRESET,
  NUMBER_FIELDS,
  PRESETS,
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
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const NUMBER_RANGES = new Map(
  NUMBER_FIELDS.map(([key, , min, max]) => [key, { min, max }]),
);
const EXTRA_NUMBER_RANGE_KEYS = {
  captureResolution: "dyeResolution",
  bloomIterations: "pressureIterations",
  bloomResolution: "simResolution",
  bloomSoftKnee: "pressure",
  sunraysResolution: "simResolution",
};
const NUMBER_KEYS = new Set([...NUMBER_RANGES.keys(), ...Object.keys(EXTRA_NUMBER_RANGE_KEYS)]);
const BOOL_KEYS = new Set(BOOL_FIELDS.map(([key]) => key));
const state = loadState();
const root = document.querySelector("#fluid-root");
const panel = document.querySelector("#panel");
const showPanel = document.querySelector("#show-panel");
const statusEl = document.querySelector("#status");
let sim;
let jetTimer = 0;
let contextLost = false;

function clone(value) {
  return structuredClone(value);
}

function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    if (NUMBER_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const range = NUMBER_RANGES.get(EXTRA_NUMBER_RANGE_KEYS[key] ?? key);
      normalized[key] = Math.min(range.max, Math.max(range.min, value));
      continue;
    }
    if (BOOL_KEYS.has(key)) {
      normalized[key] = Boolean(value);
      continue;
    }
    if (key === "backgroundColor") {
      if (typeof value === "string" && HEX_COLOR.test(value)) normalized[key] = value;
      continue;
    }
    if (key === "colorPalette" && Array.isArray(value)) {
      normalized[key] = value.filter(
        (color) => typeof color === "string" && HEX_COLOR.test(color),
      );
    }
  }
  return normalized;
}

function normalizeAutoSplats(value, fallback = 5) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(20, Math.max(0, numeric)) : fallback;
}

function currentPreset() {
  return PRESETS[state.preset] ?? PRESETS[DEFAULT_PRESET];
}

function loadState() {
  const fallback = {
    config: clone(labDefault),
    preset: DEFAULT_PRESET,
    autoSplats: 5,
    jet: Boolean(PRESETS[DEFAULT_PRESET].startJet),
  };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored) return fallback;
    return {
      config: clone(labDefault),
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
  showPanel.classList.toggle("hidden", !hidden);
}

function liveConfig() {
  return runtimeConfig(state.config);
}

function runtimeConfig(partial) {
  const config = { ...partial };
  if (MOBILE) {
    for (const [key, cap] of Object.entries(MOBILE_CAP)) {
      if (config[key] !== undefined) config[key] = Math.min(config[key], cap);
    }
  }
  return config;
}

function pushConfig(partial) {
  sim.setConfig(partial ? runtimeConfig(partial) : liveConfig());
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
  if (!Object.hasOwn(PRESETS, name)) return;
  const preset = PRESETS[name];
  state.preset = name;
  state.config = clone(preset.config);
  pushConfig();
  setJet(Boolean(preset.startJet));
  const capped = MOBILE && (preset.config.simResolution > MOBILE_CAP.simResolution || preset.config.dyeResolution > MOBILE_CAP.dyeResolution);
  setStatus(capped ? `${preset.note} Phone GPU cap is on.` : preset.note);
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(state.config, null, 2)], {
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
      const config = JSON.parse(String(reader.result));
      const saved = applyConfig(config, true);
      setStatus(saved ? `Imported ${file.name}` : `Imported ${file.name}, but could not save settings`);
    } catch {
      setStatus("Could not parse that JSON file");
    }
  };
  reader.readAsText(file);
}

function copyShareLink() {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
  const url = `${location.origin}${location.pathname}#s=${encodeURIComponent(payload)}`;
  const done = () => setStatus("Share URL copied");
  const fail = () => setStatus("Could not copy URL");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done, fail);
    return;
  }
  fail();
}

function applyHashState() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const encoded = hash.get("s") || hash.get("c");
  if (!encoded) return true;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    if (parsed.config) {
      state.config = { ...labDefault, ...normalizeConfig(parsed.config) };
      state.preset = Object.hasOwn(PRESETS, parsed.preset) ? parsed.preset : state.preset;
      state.autoSplats = normalizeAutoSplats(parsed.autoSplats, state.autoSplats);
      state.jet = Boolean(parsed.jet);
    } else {
      state.config = { ...labDefault, ...normalizeConfig(parsed) };
    }
    persist();
    return true;
  } catch {
    setStatus("Share hash was invalid");
    return false;
  }
}

function field(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

function buildControls() {
  const numbers = document.querySelector("#number-fields");
  const bools = document.querySelector("#bool-fields");
  const presets = document.querySelector("#preset");

  for (const [id, preset] of Object.entries(PRESETS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = preset.label;
    presets.append(option);
  }

  for (const [key, label, min, max, step] of NUMBER_FIELDS) {
    const row = field(`
      <div class="field">
        <label for="${key}">${label}</label>
        <div class="control">
          <input id="${key}" type="range" min="${min}" max="${max}" step="${step}" />
          <span class="value" data-for="${key}"></span>
        </div>
      </div>
    `);
    numbers.append(row);
    row.querySelector("input").addEventListener("input", (event) => {
      applyConfig({ [key]: Number(event.target.value) });
    });
  }

  for (const [key, label] of BOOL_FIELDS) {
    const row = field(`<label class="toggle"><input id="${key}" type="checkbox" /> ${label}</label>`);
    bools.append(row);
    row.querySelector("input").addEventListener("change", (event) => {
      applyConfig({ [key]: event.target.checked });
    });
  }
}

function syncForm() {
  document.querySelector("#preset").value = state.preset;
  document.querySelector("#preset-note").textContent = PRESETS[state.preset]?.note ?? "";
  for (const [key] of NUMBER_FIELDS) {
    const input = document.querySelector(`#${key}`);
    if (!input) continue;
    input.value = state.config[key];
    const value = document.querySelector(`[data-for="${key}"]`);
    if (value) value.textContent = String(state.config[key]);
  }
  for (const [key] of BOOL_FIELDS) {
    const input = document.querySelector(`#${key}`);
    if (input) input.checked = Boolean(state.config[key]);
  }
  document.querySelector("#backgroundColor").value = state.config.backgroundColor;
  document.querySelector("#colorPalette").value = (state.config.colorPalette || []).join(", ");
  document.querySelector("#autoSplats").value = String(state.autoSplats);
  document.querySelector('[data-for="autoSplats"]').textContent = String(state.autoSplats);
  document.querySelector("#jet").checked = state.jet;
}

function pulseJet() {
  if (!state.jet || contextLost || !sim) return;
  const canvas = sim.canvas;
  if (!canvas) return;
  const jet = currentPreset().jet ?? {};
  const x = canvas.clientWidth * (jet.x ?? 0.2);
  const y = canvas.clientHeight * (jet.y ?? 0.5);
  const scale = MOBILE ? 0.7 : 1;
  const dx = (jet.force ?? 400) * scale + (Math.random() - 0.5) * (jet.jitter ?? 40);
  const dy = (jet.dy ?? 0) + (Math.random() - 0.5) * (jet.jitter ?? 40) * 0.4;
  const smoke = jet.smokeTip && Math.random() < 0.38;
  sim.splat(x, y, dx, dy, smoke ? [0.52, 0.5, 0.47] : undefined);
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
  document.querySelector("#jet").checked = enabled;
}

function bindActions() {
  document.querySelector("#preset").addEventListener("change", (event) => {
    applyPreset(event.target.value);
  });
  document.querySelector("#reset").addEventListener("click", () => {
    applyPreset(DEFAULT_PRESET);
  });
  document.querySelector("#pause").addEventListener("click", () => {
    const paused = sim.togglePause(true);
    setStatus(paused ? "Paused (you can still paint)" : "Running");
  });
  document.querySelector("#splats").addEventListener("click", () => {
    sim.multipleSplats(state.autoSplats);
  });
  document.querySelector("#shot").addEventListener("click", () => sim.screenshot());
  document.querySelector("#export").addEventListener("click", exportConfig);
  document.querySelector("#copy-link").addEventListener("click", copyShareLink);
  document.querySelector("#import").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importConfig(file);
    event.target.value = "";
  });
  document.querySelector("#hide").addEventListener("click", () => setPanelHidden(true));
  showPanel.addEventListener("click", () => setPanelHidden(false));
  document.querySelector("#backgroundColor").addEventListener("change", (event) => {
    applyConfig({ backgroundColor: event.target.value });
  });
  document.querySelector("#colorPalette").addEventListener("change", (event) => {
    applyConfig({
      colorPalette: event.target.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
    });
  });
  document.querySelector("#autoSplats").addEventListener("input", (event) => {
    state.autoSplats = Number(event.target.value);
    persist();
    document.querySelector('[data-for="autoSplats"]').textContent = String(state.autoSplats);
  });
  document.querySelector("#jet").addEventListener("change", (event) => {
    setJet(event.target.checked);
  });

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      event.target instanceof HTMLInputElement
      || event.target instanceof HTMLTextAreaElement
      || event.target instanceof HTMLSelectElement
      || event.target instanceof HTMLButtonElement
    ) {
      return;
    }
    if (event.code === "KeyH") setPanelHidden(!panel.classList.contains("hidden"));
    if (event.code === "Space") {
      event.preventDefault();
      sim?.multipleSplats(state.autoSplats);
    }
    if (event.code === "KeyP") sim?.togglePause(true);
    if (event.code === "KeyJ") setJet(!state.jet);
  });

  document.addEventListener("visibilitychange", startJetTimer);
}

function bindCanvas(canvas) {
  const lockScroll = (event) => event.preventDefault();
  const handleContextLost = (event) => {
    event.preventDefault();
    contextLost = true;
    stopJetTimer();
    setStatus("WebGL context lost. Waiting for the graphics driver to recover.");
  };
  const handleContextRestored = () => {
    contextLost = false;
    setStatus("WebGL restored. Restarting the simulation.");
    setTimeout(() => location.reload(), 250);
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
    bindCanvas(sim.canvas);
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
  if (!sim) return;
  if (state.jet) startJetTimer();
  if (MOBILE) setPanelHidden(true);
  if (!hashIsValid) {
    setStatus("Share hash was invalid");
  } else if (started) {
    setStatus(MOBILE ? "Swipe to paint. Tap Lab for controls." : currentPreset().note);
  }
}

bootstrap();
