const STALL_MS = 250;
const ALLOWED_STALLS = 3;

export function createResolutionMonitor(lowerResolution) {
  let active = false;
  let last = null;
  let elapsed = 0;
  let frames = 0;
  let stalls = 0;

  function reset(timestamp) {
    active = true;
    last = timestamp ?? null;
    elapsed = 0;
    frames = 0;
    stalls = 0;
  }

  return {
    reset,
    suspend() {
      last = null;
    },
    frame(timestamp, hidden = false) {
      if (hidden || !active) {
        last = null;
        return;
      }
      if (last !== null) {
        const gap = Math.max(0, timestamp - last);
        if (gap > STALL_MS && stalls < ALLOWED_STALLS) {
          stalls += 1;
        } else {
          elapsed += gap;
          frames += 1;
        }
      }
      last = timestamp;
      if (elapsed >= 2000) {
        active = false;
        if (frames * 1000 / elapsed < 30 && lowerResolution() === true) {
          reset(timestamp);
        }
      }
    },
  };
}

export function lowerResolutions(config) {
  return {
    simResolution: Math.min(config.simResolution, Math.max(128, config.simResolution / 2)),
    dyeResolution: Math.min(config.dyeResolution, Math.max(512, config.dyeResolution / 2)),
  };
}
