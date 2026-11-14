// Paths of light around a black hole that does not spin, in a plane through
// its centre. Lengths are in units of the hole's radius.

// A ray whose impact parameter is below this falls in. One just above it
// circles the hole at 1.5 radii before leaving.
export const CAPTURE = 1.5 * Math.sqrt(3);

// The impact parameter of a ray at (x, y) heading along +x.
export function impact(x, y) {
  const r = Math.hypot(x, y);
  return Math.abs(y) / Math.sqrt(1 - y * y / (r * r * r));
}

// The starting height at which a ray from x heading along +x has this impact parameter.
export function offsetFor(x, target) {
  let y = target;
  for (let pass = 0; pass < 40; pass += 1) {
    const r = Math.hypot(x, y);
    y = target * Math.sqrt(1 - y * y / (r * r * r));
  }
  return y;
}

// Follows a ray from (x, y) heading along +x until it falls in, leaves the
// bounds or has turned too far. A photon's path obeys r'' = -1.5 h² r / |r|^5,
// where h is its angular momentum.
export function traceRay(x, y, bounds, { step = 0.04, bend = 0.012, gap = 2, turns = 6 } = {}) {
  let vx = 1;
  let vy = 0;
  const h2 = y * y;
  const points = [x, y];
  let closest = Math.hypot(x, y);
  let captured = false;
  let turned = 0;
  let heading = 0;
  let travelled = 0;
  const pull = (px, py) => {
    const r2 = px * px + py * py;
    const k = -1.5 * h2 / (r2 * r2 * Math.sqrt(r2));
    return [k * px, k * py];
  };
  while (turned < turns * 2 * Math.PI) {
    const r = Math.hypot(x, y);
    const ds = step * Math.min(Math.max(r - 0.9, 0.25), 8);
    const [a1x, a1y] = pull(x, y);
    const [a2x, a2y] = pull(x + vx * ds / 2, y + vy * ds / 2);
    const [a3x, a3y] = pull(x + vx * ds / 2 + a1x * ds * ds / 4, y + vy * ds / 2 + a1y * ds * ds / 4);
    const [a4x, a4y] = pull(x + vx * ds + a2x * ds * ds / 2, y + vy * ds + a2y * ds * ds / 2);
    const nx = x + vx * ds + (a1x + a2x + a3x) * ds * ds / 6;
    const ny = y + vy * ds + (a1y + a2y + a3y) * ds * ds / 6;
    const nvx = vx + (a1x + 2 * a2x + 2 * a3x + a4x) * ds / 6;
    const nvy = vy + (a1y + 2 * a2y + 2 * a3y + a4y) * ds / 6;
    const nr = Math.hypot(nx, ny);
    if (nr <= 1) {
      const part = (r - 1) / (r - nr);
      points.push(x + (nx - x) * part, y + (ny - y) * part);
      closest = 1;
      captured = true;
      break;
    }
    const angle = Math.atan2(nvy, nvx);
    let change = angle - Math.atan2(vy, vx);
    change -= 2 * Math.PI * Math.round(change / (2 * Math.PI));
    turned += Math.abs(change);
    heading += change;
    travelled += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
    vx = nvx;
    vy = nvy;
    closest = Math.min(closest, nr);
    const outside = x < bounds.left || x > bounds.right || y < bounds.bottom || y > bounds.top;
    if (outside || Math.abs(heading) >= bend || travelled >= gap) {
      points.push(x, y);
      heading = 0;
      travelled = 0;
    }
    if (outside) {
      break;
    }
  }
  return { points, captured, closest, direction: Math.atan2(vy, vx) };
}

// Parallel rays entering from the left edge, as triangles for the ray shader.
// Screen positions run 0 to 1 both ways; lengths are in screen heights.
// Eight numbers per corner: position, the direction across the line, which
// side of the line, distance travelled, where the ray started (0 at the
// bottom, 1 at the top), and how far it gets before something solid stops it.
export function buildRays({ aspect, x, y, radius, spacing, margin = 0.004, blocked = () => false }) {
  const startX = -x * aspect / radius;
  const edge = offsetFor(startX, CAPTURE * (1 + margin));
  const gap = edge / Math.max(1, Math.round(edge * radius / spacing));
  const bounds = {
    left: startX - 1 / radius,
    right: startX + (aspect + 1) / radius,
    bottom: (-0.5 - y) / radius,
    top: (1.5 - y) / radius,
  };
  const reachUp = Math.floor((1.35 - y) / radius / gap);
  const reachDown = Math.floor((y + 0.35) / radius / gap);
  const corners = [];
  let rays = 0;
  for (let index = -reachDown; index <= reachUp; index += 1) {
    const offset = index * gap;
    const { points } = traceRay(startX, offset, bounds);
    const count = points.length / 2;
    const px = [];
    const py = [];
    const travelled = [0];
    for (let point = 0; point < count; point += 1) {
      px.push((points[2 * point] - startX) * radius);
      py.push(y + points[2 * point + 1] * radius);
      if (point > 0) {
        travelled.push(travelled[point - 1] + Math.hypot(px[point] - px[point - 1], py[point] - py[point - 1]));
      }
    }
    let stop = 1e9;
    for (let point = 0; point + 1 < count && stop === 1e9; point += 1) {
      const length = travelled[point + 1] - travelled[point];
      const samples = Math.ceil(length / 0.004);
      for (let sample = 0; sample < samples; sample += 1) {
        const part = sample / samples;
        const sx = px[point] + (px[point + 1] - px[point]) * part;
        const sy = py[point] + (py[point + 1] - py[point]) * part;
        if (blocked(sx / aspect, sy)) {
          stop = travelled[point] + length * part;
          break;
        }
      }
    }
    const tint = Math.min(1, Math.max(0, py[0]));
    const corner = (point, side) => {
      const before = Math.max(point - 1, 0);
      const after = Math.min(point + 1, count - 1);
      const dx = px[after] - px[before];
      const dy = py[after] - py[before];
      const length = Math.hypot(dx, dy) || 1;
      corners.push(
        px[point] / aspect,
        py[point],
        -dy / length / aspect,
        dx / length,
        side,
        travelled[point],
        tint,
        stop,
      );
    };
    for (let point = 0; point + 1 < count; point += 1) {
      corner(point, -1);
      corner(point, 1);
      corner(point + 1, -1);
      corner(point + 1, -1);
      corner(point, 1);
      corner(point + 1, 1);
    }
    rays += 1;
  }
  return { corners: new Float32Array(corners), rays };
}
