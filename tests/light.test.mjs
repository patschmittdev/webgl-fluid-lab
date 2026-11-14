import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURE, impact, offsetFor, traceRay, buildRays } from "../assets/engines/lab/light.js";

const wide = { left: -400, right: 400, bottom: -400, top: 400 };

test("a distant ray bends by twice the hole's radius over its distance", () => {
  for (const distance of [100, 400]) {
    const ray = traceRay(-50000, distance, { left: -1e6, right: 50000, bottom: -1e6, top: 1e6 });
    assert.ok(!ray.captured);
    const bend = -ray.direction;
    assert.ok(Math.abs(bend / (2 / distance) - 1) < 0.02, `${distance}: ${bend}`);
  }
});

test("rays aimed inside the capture distance fall in and the rest escape", () => {
  for (const start of [-12, -300]) {
    const inside = traceRay(start, offsetFor(start, CAPTURE * 0.998), wide);
    const outside = traceRay(start, offsetFor(start, CAPTURE * 1.002), wide);
    assert.ok(inside.captured, `from ${start}`);
    assert.equal(inside.closest, 1);
    assert.ok(!outside.captured, `from ${start}`);
    assert.ok(outside.closest > 1.5 && outside.closest < 1.6, `turns just outside 1.5 radii: ${outside.closest}`);
    assert.ok(Math.abs(impact(start, offsetFor(start, CAPTURE)) / CAPTURE - 1) < 1e-9);
  }
});

test("rays above and below the hole mirror each other", () => {
  const up = traceRay(-12, 3.4, wide);
  const down = traceRay(-12, -3.4, wide);
  assert.equal(up.points.length, down.points.length);
  for (let index = 0; index < up.points.length; index += 2) {
    assert.ok(Math.abs(up.points[index] - down.points[index]) < 1e-9);
    assert.ok(Math.abs(up.points[index + 1] + down.points[index + 1]) < 1e-9);
  }
  assert.ok(Math.abs(up.direction + down.direction) < 1e-9);
});

test("the ray set has one ray on each side that loops the hole, and solids cut rays short", () => {
  for (const [aspect, radius] of [[16 / 9, 0.065], [0.5, 0.0325]]) {
    const options = { aspect, x: 0.4, y: 0.5, radius, spacing: 0.024 };
    const { corners, rays } = buildRays(options);
    assert.equal(corners.length % 48, 0);
    assert.ok(rays > 30, `${rays} rays`);
    const start = -0.4 * aspect / radius;
    const starts = new Set();
    for (let index = 0; index < corners.length; index += 8) {
      if (corners[index + 5] === 0) {
        starts.add(Math.round((corners[index + 1] - 0.5) / radius * 1e4) / 1e4);
      }
      const across = Math.hypot(corners[index + 2] * aspect, corners[index + 3]);
      assert.ok(Math.abs(across - 1) < 1e-5, "the direction across the line has unit length on screen");
    }
    const loopers = [...starts].filter(offset => {
      const ratio = impact(start, offset) / CAPTURE;
      return ratio > 1 && ratio < 1.01;
    });
    assert.equal(loopers.length, 2, `near-critical rays at ${aspect}: ${loopers}`);
    assert.ok(Math.abs(loopers[0] + loopers[1]) < 1e-3);
    assert.ok(starts.has(0), "one ray is aimed straight at the hole");

    const shaded = buildRays({ ...options, blocked: (u, v) => u > 0.1 && u < 0.12 && v > 0.5 });
    let cut = 0;
    for (let index = 0; index < shaded.corners.length; index += 8) {
      const stop = shaded.corners[index + 7];
      if (stop < 1e9) {
        cut += 1;
        assert.ok(stop >= 0.1 * aspect - 0.01 && stop < 0.13 * aspect + 0.01, `stops at the wall: ${stop}`);
        assert.ok(shaded.corners[index + 6] > 0.5, "only rays that start behind the wall");
      }
    }
    assert.ok(cut > 0);
  }
});
