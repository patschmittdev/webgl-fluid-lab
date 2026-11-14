import test from "node:test";
import assert from "node:assert/strict";
import { createResolutionMonitor, lowerResolutions } from "../assets/resolution-monitor.js";

test("a slow device keeps halving until the floors, then stops asking", () => {
  let config = { simResolution: 512, dyeResolution: 2048 };
  const history = [];
  let calls = 0;
  const monitor = createResolutionMonitor(() => {
    calls += 1;
    const lowered = lowerResolutions(config);
    if (lowered.simResolution === config.simResolution && lowered.dyeResolution === config.dyeResolution) {
      return false;
    }
    config = lowered;
    history.push(config.simResolution);
    return true;
  });
  monitor.reset(0);
  for (let time = 50; time < 20000; time += 50) {
    monitor.frame(time);
    if (time < 2000) {
      assert.equal(calls, 0);
    }
  }
  assert.deepEqual(history, [256, 128]);
  assert.deepEqual(config, { simResolution: 128, dyeResolution: 512 });
  assert.equal(calls, 3);
});

test("a few long stalls, such as shader compilation, do not lower the resolution", () => {
  let changes = 0;
  const monitor = createResolutionMonitor(() => changes += 1);
  monitor.reset(0);
  let time = 0;
  for (const gap of [1500, 16, 16, 900, 16, 400]) {
    time += gap;
    monitor.frame(time);
  }
  while (time < 6000) {
    time += 16;
    monitor.frame(time);
  }
  assert.equal(changes, 0);

  monitor.reset(10000);
  for (time = 11000; time <= 20000; time += 1000) {
    monitor.frame(time);
  }
  assert.equal(changes, 1, "a device that stalls on every frame is still lowered");
});

test("fast startup does not lower resolutions later", () => {
  let changes = 0;
  const monitor = createResolutionMonitor(() => changes += 1);
  monitor.reset(0);
  for (let time = 20; time <= 2000; time += 20) {
    monitor.frame(time);
  }
  monitor.frame(10000);
  assert.equal(changes, 0);
});

test("hidden frames and gaps do not contribute time or frame counts", () => {
  let changes = 0;
  const monitor = createResolutionMonitor(() => changes += 1);
  monitor.reset(0);
  for (let time = 50; time <= 1000; time += 50) {
    monitor.frame(time);
  }
  monitor.suspend();
  for (let time = 1001; time <= 2000; time += 1) {
    monitor.frame(time, true);
  }
  monitor.suspend();
  monitor.frame(100000);
  assert.equal(changes, 0);
  for (let time = 100050; time < 101000; time += 50) {
    monitor.frame(time);
  }
  assert.equal(changes, 0);
  monitor.frame(101000);
  assert.equal(changes, 1);
});

test("fallback respects phone floors and never increases a custom resolution", () => {
  assert.deepEqual(lowerResolutions({ simResolution: 128, dyeResolution: 1024 }), { simResolution: 128, dyeResolution: 512 });
  assert.deepEqual(lowerResolutions({ simResolution: 128, dyeResolution: 512 }), { simResolution: 128, dyeResolution: 512 });
  assert.deepEqual(lowerResolutions({ simResolution: 64, dyeResolution: 256 }), { simResolution: 64, dyeResolution: 256 });
});
