import { normalizeConfig } from "./config.js";

const unit = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function spectrumLevels(spectrum, sampleRate) {
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  let energy = 0;
  let weight = 0;
  let centroid = 0;
  for (let i = 0; i < spectrum.length; i += 1) {
    const hz = i * sampleRate / (2 * spectrum.length);
    if (hz < 20 || hz > 16000) {
      continue;
    }
    const value = unit(spectrum[i] / 255);
    const band = hz < 250 ? 0 : hz < 2000 ? 1 : 2;
    sums[band] += value * value;
    counts[band] += 1;
    energy += value * value;
    weight += value;
    centroid += hz * value;
  }
  const levels = sums.map((sum, i) => Math.sqrt(sum / Math.max(counts[i], 1)));
  return {
    bass: levels[0],
    mid: levels[1],
    treble: levels[2],
    overall: Math.sqrt(energy / Math.max(counts.reduce((a, b) => a + b, 0), 1)),
    brightness: weight ? unit(centroid / weight / Math.min(sampleRate / 2, 16000)) : 0,
  };
}

export function followEnvelope(previous, target, dt, attack = 0.025, release = 0.3) {
  const time = target > previous ? attack : release;
  return unit(previous + (unit(target) - previous) * (1 - Math.exp(-Math.max(dt, 0) / Math.max(time, 0.0001))));
}

export function createBeatDetector(refractory = 0.3) {
  let average;
  let previous = 0;
  let lastBeat = -Infinity;
  let armed = true;
  return (bass, time, dt) => {
    bass = unit(bass);
    if (average === undefined) {
      average = bass;
      previous = bass;
    }
    if (bass < average * 1.15 + 0.015 || bass < previous * 0.7) {
      armed = true;
    }
    const beat = armed && bass > average * 1.65 + 0.035 && bass - previous > 0.025
      && time - lastBeat >= refractory;
    if (beat) {
      lastBeat = time;
      armed = false;
    }
    average += (bass - average) * (1 - Math.exp(-Math.max(dt, 0) / 0.8));
    previous = bass;
    return { beat, timeSinceBeat: time - lastBeat };
  };
}

export function createAudioAnalysis() {
  const detect = createBeatDetector();
  let levels = { bass: 0, mid: 0, treble: 0, overall: 0, brightness: 0 };
  return (spectrum, sampleRate, time, dt) => {
    const raw = spectrumLevels(spectrum, sampleRate);
    const onset = detect(raw.bass, time, dt);
    levels = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, followEnvelope(levels[key], value, dt)]));
    return { ...levels, ...onset };
  };
}

export function modulateConfig(config, mapping, features, bloomLevel = 0, energy = 0) {
  if (!features) {
    return { ...config };
  }
  const sensitivity = config.musicSensitivity ?? 1;
  const bass = unit(features.bass * sensitivity);
  const mid = unit(features.mid * sensitivity);
  const overall = unit(features.overall * sensitivity);
  const kick = Math.max(0, 1 - features.timeSinceBeat / 0.16) * sensitivity;
  const changes = {};
  if (mapping.energy) {
    const [calm, punch] = mapping.energy;
    const amount = unit(energy);
    for (const key of Object.keys(calm)) {
      if (key === "bloomIntensity" && config.reduceFlashing) {
        continue;
      }
      changes[key] = calm[key] + (punch[key] - calm[key]) * amount;
    }
  }
  if (mapping.throttle) {
    changes.throttle = mapping.throttle[0] + bass * (mapping.throttle[1] - mapping.throttle[0]) + kick * 0.12;
    if (sensitivity === 0) {
      changes.throttle = config.throttle;
    }
  }
  if (mapping.curl) {
    changes.curl = (changes.curl ?? config.curl) + mid * mapping.curl;
  }
  if (mapping.inflow) {
    changes.inflow = Math.min(Math.max(config.inflow, mapping.inflow[1]), config.inflow + bass * mapping.inflow[0]);
  }
  if (mapping.heat) {
    changes.heat = config.heat + bass * mapping.heat;
  }
  changes.bloomIntensity = (changes.bloomIntensity ?? config.bloomIntensity) + unit(bloomLevel * sensitivity) * 0.25;
  return { ...config, ...normalizeConfig(changes) };
}

export function createMusicResponse() {
  let lastBurst = -Infinity;
  let lastGlow = -Infinity;
  let bloomLevel = 0;
  let lastTime = null;
  let beatDensity = 0;
  let energy = 0;
  return (config, mapping, features, time) => {
    if (!features) {
      lastBurst = -Infinity;
      lastGlow = -Infinity;
      bloomLevel = 0;
      lastTime = null;
      beatDensity = 0;
      energy = 0;
      return { config: { ...config }, burst: false, hue: 0, spin: 1, energy: 0 };
    }
    const dt = lastTime === null ? 0 : Math.min(0.1, Math.max(0, time - lastTime));
    lastTime = time;
    beatDensity = beatDensity * Math.exp(-dt / 2) + (features.beat ? 1 : 0);
    const drive = unit((0.55 * features.overall + 0.45 * Math.min(1, beatDensity / 4)) * config.musicSensitivity);
    energy = followEnvelope(energy, drive, dt, 0.8, 2.5);
    if (time - lastGlow >= 1 / 3) {
      bloomLevel = config.reduceFlashing ? 0 : features.treble;
      lastGlow = time;
    }
    const burst = features.beat && config.musicSensitivity > 0
      && time - lastBurst >= (config.reduceFlashing ? 0.5 : 1 / 3);
    if (burst) {
      lastBurst = time;
    }
    return {
      config: modulateConfig(config, mapping, features, config.reduceFlashing ? 0 : bloomLevel, energy),
      burst,
      hue: unit(features.brightness * config.musicSensitivity),
      spin: 1 + unit(features.overall * config.musicSensitivity) * 2,
      energy,
    };
  };
}
