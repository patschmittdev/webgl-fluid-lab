import { NUMBER_FIELDS, BOOL_FIELDS, PRESETS, VIEWS } from "./presets.js";
const PRESET_ALIASES = Object.freeze({
  __proto__: null,
  wick: "flame",
  paper: "ink",
});
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const NUMBER_RANGES = new Map(
  NUMBER_FIELDS.map(([key, , min, max]) => [key, { min, max }]),
);
export const EXTRA_NUMBER_RANGE_KEYS = {
  bloomIterations: "pressureIterations",
  bloomResolution: "simResolution",
  bloomSoftKnee: "pressure",
  sunraysResolution: "simResolution",
  throttle: "pressure",
};
const NUMBER_KEYS = new Set([...NUMBER_RANGES.keys(), ...Object.keys(EXTRA_NUMBER_RANGE_KEYS)]);
const BOOL_KEYS = new Set(BOOL_FIELDS.map(([key]) => key));

export function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    if (NUMBER_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      const range = NUMBER_RANGES.get(EXTRA_NUMBER_RANGE_KEYS[key] ?? key);
      normalized[key] = Math.min(range.max, Math.max(range.min, value));
      if (key === "symmetry") {
        normalized[key] = Math.round(normalized[key]);
        if (normalized[key] === 1) {
          normalized[key] = 0;
        }
      }
      continue;
    }
    if (BOOL_KEYS.has(key)) {
      normalized[key] = Boolean(value);
      continue;
    }
    if (key === "view") {
      if (VIEWS.includes(value)) {
        normalized.view = value;
      }
      continue;
    }
    if (key === "backgroundColor") {
      if (typeof value === "string" && HEX_COLOR.test(value)) {
        normalized[key] = value;
      }
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

export function normalizeAutoSplats(value, fallback = 5) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(20, Math.max(0, numeric)) : fallback;
}

export function encodeShareState(state) {
  try {
    return "#s=" + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(state)))));
  } catch {
    return null;
  }
}

export function decodeShareState(hashString) {
  try {
    if (typeof hashString !== "string") {
      return null;
    }
    const hash = new URLSearchParams(hashString.replace(/^#/, ""));
    const encoded = hash.get("s") || hash.get("c");
    if (!encoded) {
      return hash.has("s") || hash.has("c") ? null : {};
    }
    const parsed = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.config) {
      return { config: normalizeConfig(parsed) };
    }
    const result = { config: normalizeConfig(parsed.config), jet: Boolean(parsed.jet) };
    parsed.preset = PRESET_ALIASES[parsed.preset] ?? parsed.preset;
    if (typeof parsed.preset === "string" && Object.hasOwn(PRESETS, parsed.preset)) {
      result.preset = parsed.preset;
    }
    if (parsed.autoSplats !== undefined) {
      result.autoSplats = normalizeAutoSplats(parsed.autoSplats);
    }
    return result;
  } catch {
    return null;
  }
}
