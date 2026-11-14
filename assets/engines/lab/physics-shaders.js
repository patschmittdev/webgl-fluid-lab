import { HALF_FLOAT_ROUNDING } from "./shaders.js";

const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;
uniform sampler2D obstacleField;
uniform bool hasSolids;
uniform vec2 simTexel;
uniform float inflow;
uniform float velocityScale;
uniform bool wrapX;

const float WALL_REACH = 8.0;

bool solid(vec2 p) {
  return hasSolids && textureLod(obstacleField, clamp(p, vec2(0.0), vec2(1.0)), 0.0).r > 0.5;
}

bool wall(vec2 p) {
  return p.y < 0.0 || p.y > 1.0
    || (inflow <= 0.0 && !wrapX && (p.x < 0.0 || p.x > 1.0)) || solid(p);
}

bool clearPath(vec2 start, vec2 finish) {
  if (!hasSolids) {
    return true;
  }
  vec2 a = clamp(start / simTexel, vec2(0.001), 1.0 / simTexel - 0.001);
  vec2 b = clamp(finish / simTexel, vec2(0.001), 1.0 / simTexel - 0.001);
  vec2 cell = floor(a);
  if (textureLod(obstacleField, (cell + 0.5) * simTexel, 0.0).g < 0.5
    && all(lessThan(abs(b - a), vec2(WALL_REACH - 1.0)))) {
    return true;
  }
  vec2 goal = floor(b);
  vec2 delta = b - a;
  vec2 direction = sign(delta);
  vec2 stride = 1.0 / max(abs(delta), vec2(0.0000001));
  vec2 edge = cell + step(vec2(0.0), delta);
  vec2 crossing = abs(edge - a) * stride;
  if (abs(delta.x) < 0.0000001) {
    crossing.x = 1e20;
  }
  if (abs(delta.y) < 0.0000001) {
    crossing.y = 1e20;
  }
  int count = int(abs(goal.x - cell.x) + abs(goal.y - cell.y)) + 1;
  for (int i = 0; i < count; i += 1) {
    if (solid((cell + 0.5) * simTexel)) {
      return false;
    }
    if (all(equal(cell, goal))) {
      return true;
    }
    if (abs(crossing.x - crossing.y) < 0.000001) {
      if (solid((cell + vec2(direction.x, 0.0) + 0.5) * simTexel)
        || solid((cell + vec2(0.0, direction.y) + 0.5) * simTexel)) {
        return false;
      }
      cell += direction;
      crossing += stride;
    } else if (crossing.x < crossing.y) {
      cell.x += direction.x;
      crossing.x += stride.x;
    } else {
      cell.y += direction.y;
      crossing.y += stride.y;
    }
  }
  return false;
}

vec2 boundedVelocity(vec2 value) {
  if (solid(uv)) {
    return vec2(0.0);
  }
  if (wall(uv - vec2(simTexel.x, 0.0)) || wall(uv + vec2(simTexel.x, 0.0))) {
    value.x = 0.0;
  }
  if (wall(uv - vec2(0.0, simTexel.y)) || wall(uv + vec2(0.0, simTexel.y))) {
    value.y = 0.0;
  }
  if (inflow > 0.0 && uv.x < simTexel.x) {
    value = vec2(inflow, 0.0);
    if (solid(uv + vec2(simTexel.x, 0.0))) {
      value.x = 0.0;
    }
  }
  if (inflow > 0.0 && uv.x > 1.0 - simTexel.x) {
    value.x = max(value.x, 0.0);
  }
  return clamp(value, vec2(-1000.0 * velocityScale), vec2(1000.0 * velocityScale));
}
`;

const planet = `
uniform float aspectRatio;
uniform vec3 spot;
uniform vec2 spotSize;
uniform float timeStep;
uniform bool initialize;
uniform float seed;
uniform vec2 view;

float latitude(float y) {
  return view.x + (y - 0.5) * view.y;
}

float bump(float lat, float centre, float halfWidth) {
  float d = (lat - centre) / halfWidth;
  return exp(-d * d);
}

float jet(float lat) {
  return bump(lat, 0.0, 8.0)
    - 0.35 * bump(lat, 16.5, 3.0) + 0.9 * bump(lat, 23.5, 2.6) - 0.3 * bump(lat, 31.0, 3.0)
    + 0.4 * bump(lat, 36.5, 2.5) - 0.2 * bump(lat, 42.0, 2.5) + 0.25 * bump(lat, 47.0, 2.5)
    - 0.55 * bump(lat, -16.5, 3.2) + 0.5 * bump(lat, -28.5, 3.0) - 0.25 * bump(lat, -34.5, 2.6)
    + 0.4 * bump(lat, -39.5, 2.5) - 0.2 * bump(lat, -44.5, 2.5) + 0.25 * bump(lat, -49.0, 2.5);
}

vec2 spotOffset(vec2 p) {
  return vec2((fract(p.x - spot.x + 0.5) - 0.5) * aspectRatio, p.y - spot.y) / spotSize;
}

float planetHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + seed) * 43758.5453);
}

float planetNoise(vec2 p, float period) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(cell.x, period);
  float x1 = mod(cell.x + 1.0, period);
  float bottom = mix(planetHash(vec2(x0, cell.y)), planetHash(vec2(x1, cell.y)), f.x);
  float top = mix(planetHash(vec2(x0, cell.y + 1.0)), planetHash(vec2(x1, cell.y + 1.0)), f.x);
  return mix(bottom, top, f.y);
}
`;

const plain = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;
`;

const pressureNeighbors = `
uniform sampler2D pressureField;

float pressureAt(vec2 p, float center) {
  if (wall(p)) {
    return center;
  }
  if (inflow > 0.0 && p.x > 1.0 - simTexel.x) {
    return 0.0;
  }
  return texture(pressureField, p).r;
}
`;

export const PHYSICS_SHADERS = {
  transport: header + `
uniform sampler2D velocityField;
uniform sampler2D quantityField;
uniform vec2 quantityTexel;
uniform float timeStep;
uniform float dissipation;
uniform bool velocityMode;
uniform bool keepPrecision;
${HALF_FLOAT_ROUNDING}
vec4 sampleQuantity(vec2 position) {
  vec2 grid = position / quantityTexel - 0.5;
  vec2 cell = floor(grid);
  vec2 fraction = fract(grid);
  vec4 value = vec4(0.0);
  float total = 0.0;
  for (int y = 0; y < 2; y += 1) {
    for (int x = 0; x < 2; x += 1) {
      vec2 point = (cell + vec2(x, y) + 0.5) * quantityTexel;
      if (clearPath(uv, point)) {
        float weight = (x == 0 ? 1.0 - fraction.x : fraction.x)
          * (y == 0 ? 1.0 - fraction.y : fraction.y);
        ivec2 size = textureSize(quantityField, 0);
        ivec2 index = ivec2(floor(point / quantityTexel));
        if (wrapX) {
          index.x = int(mod(float(index.x), float(size.x)));
        }
        index = clamp(index, ivec2(0), size - 1);
        if (!(wrapX && solid((vec2(index) + 0.5) * quantityTexel))) {
          value += texelFetch(quantityField, index, 0) * weight;
          total += weight;
        }
      }
    }
  }
  return total > 0.000001 ? value / total : vec4(0.0);
}

void main() {
  if (solid(uv)) {
    outputColor = vec4(0.0);
    return;
  }
  vec2 velocity = texture(velocityField, uv).xy;
  vec2 departure = uv - timeStep * velocity * simTexel;
  if (!clearPath(uv, departure)) {
    departure = uv;
  }
  vec4 value = sampleQuantity(departure) / (1.0 + dissipation * timeStep);
  if (inflow > 0.0 && departure.x < 0.0 && !velocityMode) {
    value = vec4(0.0);
  }
  if (velocityMode) {
    value.xy = boundedVelocity(value.xy);
  }
  outputColor = keepPrecision ? roundToHalf(value, 0.5) : value;
}
`,
  forces: header + `
uniform sampler2D velocityField;
uniform sampler2D temperatureField;
uniform float buoyancy;
uniform float timeStep;
uniform bool hasTemperature;
uniform bool initialize;
uniform bool wakeSeed;
uniform vec2 nozzle;
uniform float jetMomentum;
uniform float jetSpeed;

void main() {
  vec2 value = initialize ? vec2(inflow, 0.0) : texture(velocityField, uv).xy;
  if (initialize && wakeSeed) {
    vec2 offset = (uv - vec2(0.32, 0.515)) * vec2(simTexel.y / simTexel.x, 1.0);
    value.y += 0.075 * velocityScale * exp(-dot(offset, offset) / 0.0004);
  }
  if (hasTemperature) {
    value.y += buoyancy * texture(temperatureField, uv).r * timeStep;
  }
  float height = uv.y - nozzle.y;
  float width = 0.009 + max(height, 0.0) * 0.045;
  float cone = (1.0 - smoothstep(width, width * 1.6, abs(uv.x - nozzle.x) * simTexel.y / simTexel.x))
    * step(0.0, height) * (1.0 - smoothstep(0.22, 0.34, height));
  float alignment = 1.0 - exp(-jetMomentum * cone * 90.0 * timeStep);
  value.x *= 1.0 - alignment;
  value.y = mix(value.y, max(value.y, jetSpeed * 0.55), alignment);
  if (!initialize && inflow > 0.0 && uv.x > 1.0 - simTexel.x) {
    value = texture(velocityField, uv - vec2(simTexel.x, 0.0)).xy;
  }
  outputColor = vec4(boundedVelocity(value), 0.0, 1.0);
}
`,
  wallDivergence: header + `
uniform sampler2D velocityField;

void main() {
  vec2 center = texture(velocityField, uv).xy;
  vec2 l = uv - vec2(simTexel.x, 0.0);
  vec2 r = uv + vec2(simTexel.x, 0.0);
  vec2 b = uv - vec2(0.0, simTexel.y);
  vec2 t = uv + vec2(0.0, simTexel.y);
  float left = wall(l) ? -center.x : texture(velocityField, l).x;
  float right = wall(r) ? -center.x : texture(velocityField, r).x;
  float bottom = wall(b) ? -center.y : texture(velocityField, b).y;
  float top = wall(t) ? -center.y : texture(velocityField, t).y;
  if (inflow > 0.0 && l.x < 0.0) {
    left = 2.0 * inflow - center.x;
  }
  float value = solid(uv) ? 0.0 : 0.5 * (right - left + top - bottom);
  outputColor = vec4(value, 0.0, 0.0, 1.0);
}
`,
  wallPressure: header + pressureNeighbors + `
uniform sampler2D divergenceField;

void main() {
  float center = texture(pressureField, uv).r;
  float left = pressureAt(uv - vec2(simTexel.x, 0.0), center);
  float right = pressureAt(uv + vec2(simTexel.x, 0.0), center);
  float bottom = pressureAt(uv - vec2(0.0, simTexel.y), center);
  float top = pressureAt(uv + vec2(0.0, simTexel.y), center);
  float value = 0.25 * (left + right + bottom + top - texture(divergenceField, uv).r);
  if (solid(uv) || (inflow > 0.0 && uv.x > 1.0 - simTexel.x)) {
    value = 0.0;
  }
  outputColor = vec4(value, 0.0, 0.0, 1.0);
}
`,
  wallProject: header + pressureNeighbors + `
uniform sampler2D velocityField;

void main() {
  float center = texture(pressureField, uv).r;
  float left = pressureAt(uv - vec2(simTexel.x, 0.0), center);
  float right = pressureAt(uv + vec2(simTexel.x, 0.0), center);
  float bottom = pressureAt(uv - vec2(0.0, simTexel.y), center);
  float top = pressureAt(uv + vec2(0.0, simTexel.y), center);
  vec2 value = texture(velocityField, uv).xy - vec2(right - left, top - bottom);
  if (inflow > 0.0 && uv.x > 1.0 - simTexel.x) {
    value = texture(velocityField, uv - vec2(simTexel.x, 0.0)).xy;
  }
  outputColor = vec4(boundedVelocity(value), 0.0, 1.0);
}
`,
  wallPaint: header + `
uniform sampler2D previousMask;
uniform vec2 startPoint;
uniform vec2 endPoint;
uniform float radius;
uniform float value;
uniform float aspectRatio;

void main() {
  vec2 scale = vec2(aspectRatio, 1.0);
  vec2 segment = (endPoint - startPoint) * scale;
  vec2 offset = (uv - startPoint) * scale;
  float along = clamp(dot(offset, segment) / max(dot(segment, segment), 0.0000001), 0.0, 1.0);
  float distanceToStroke = length(offset - along * segment);
  float mask = texture(previousMask, uv).r;
  outputColor = vec4(distanceToStroke <= radius ? value : mask, 0.0, 0.0, 1.0);
}
`,
  planetFlow: plain + planet + `
uniform sampler2D velocityField;
uniform float jetSpeed;
uniform vec2 hold;

void main() {
  vec2 velocity = texture(velocityField, uv).xy;
  vec2 target = vec2(jet(latitude(uv.y)) * jetSpeed, 0.0);
  vec2 d = spotOffset(uv);
  float q = length(d);
  vec2 swirl = spot.z * 2.02 * exp(-pow(q / 0.9, 4.0)) * vec2(-d.y, d.x * spotSize.y / spotSize.x);
  float inside = 1.0 - smoothstep(0.9, 1.3, q);
  target = mix(target, swirl, inside);
  if (initialize) {
    velocity = target;
    velocity.y += 0.08 * jetSpeed * (planetNoise(uv * vec2(24.0, 14.0), 24.0) - 0.5);
  } else {
    velocity += (target - velocity) * (1.0 - exp(-mix(hold.x, hold.y, inside) * timeStep));
  }
  outputColor = vec4(velocity, 0.0, 1.0);
}
`,
  planetDye: plain + planet + HALF_FLOAT_ROUNDING + `
uniform sampler2D dyeField;
uniform vec2 renewal;
uniform float dither;
uniform float clock;
uniform float stream;

vec3 layer(vec3 colour, float lat, float centre, float halfWidth, vec3 tint) {
  float d = (lat - centre) / halfWidth;
  return mix(colour, tint, exp(-d * d * d * d));
}

vec3 clouds(float lat) {
  vec3 colour = vec3(0.93, 0.87, 0.74);
  colour = mix(colour, vec3(0.84, 0.80, 0.72), 0.6 * bump(lat, 0.0, 5.0));
  colour = layer(colour, lat, 12.0, 5.0, vec3(0.62, 0.36, 0.21));
  colour = layer(colour, lat, -12.0, 5.5, vec3(0.58, 0.37, 0.24));
  colour = layer(colour, lat, 27.5, 3.0, vec3(0.70, 0.50, 0.34));
  colour = layer(colour, lat, -32.0, 3.2, vec3(0.66, 0.50, 0.38));
  colour = layer(colour, lat, 38.5, 2.6, vec3(0.62, 0.52, 0.42));
  colour = layer(colour, lat, -41.0, 2.6, vec3(0.60, 0.52, 0.44));
  colour = mix(colour, vec3(0.50, 0.45, 0.41), smoothstep(40.0, 54.0, abs(lat)));
  float stripes = 0.5 * sin(lat * 1.9) + 0.3 * sin(lat * 4.3 + 1.0) + 0.2 * sin(lat * 9.1 + 2.0);
  colour *= 1.0 + 0.09 * stripes;
  return colour * mix(vec3(1.0), vec3(1.05, 0.97, 0.88), 0.5 + 0.5 * sin(lat * 2.7 + 0.6));
}

vec3 weather(vec2 p, float lat, float age) {
  float x = p.x - jet(lat) * stream * age;
  float streaks = planetNoise(vec2(x * 5.0, p.y * 46.0), 5.0) - 0.5;
  float grain = planetNoise(vec2(x * 18.0, p.y * 150.0), 18.0) - 0.5;
  float threads = planetNoise(vec2(x * 9.0, p.y * 84.0), 9.0) - 0.5;
  return clouds(lat + 0.035 * view.y * streaks + 0.012 * view.y * threads) * (1.0 + 0.3 * grain + 0.2 * threads + 0.12 * streaks);
}

vec2 eddies(vec2 p) {
  for (float index = 0.0; index < 14.0; index += 1.0) {
    vec2 centre = vec2(planetHash(vec2(index, 1.0)), 0.08 + 0.84 * planetHash(vec2(index, 2.0)));
    float size = 0.025 + 0.05 * planetHash(vec2(index, 3.0));
    vec2 offset = vec2((fract(p.x - centre.x + 0.5) - 0.5) * aspectRatio, p.y - centre.y);
    float turn = (planetHash(vec2(index, 4.0)) < 0.5 ? -5.0 : 5.0) * exp(-dot(offset, offset) / (size * size));
    vec2 turned = vec2(cos(turn) * offset.x - sin(turn) * offset.y, sin(turn) * offset.x + cos(turn) * offset.y);
    p = vec2(centre.x + turned.x / aspectRatio, centre.y + turned.y);
  }
  return p;
}

void main() {
  vec3 dye = texture(dyeField, uv).rgb;
  vec2 d = spotOffset(uv);
  float q = length(d);
  float body = 1.0 - smoothstep(0.6, 0.85, q);
  float core = exp(-q * q * 6.0);
  float collar = smoothstep(0.92, 1.05, q) * (1.0 - smoothstep(1.15, 1.4, q));
  vec3 cream = vec3(0.95, 0.91, 0.82);
  vec3 salmon = vec3(0.85, 0.50, 0.33);
  vec3 red = vec3(0.70, 0.27, 0.15);
  if (initialize) {
    vec2 p = eddies(uv);
    float lat = latitude(p.y);
    float blotch = planetNoise(vec2(p.x * 26.0, p.y * 30.0), 26.0) - 0.5;
    vec3 sky = weather(p, lat + 0.02 * view.y * blotch, 0.0);
    float rings = 0.5 + 0.5 * sin(3.0 * atan(d.y, d.x) + 11.0 * q);
    vec3 storm = mix(mix(salmon, red, exp(-q * q * 4.0)), red, 0.35 * rings * smoothstep(0.15, 0.5, q));
    sky = mix(sky, cream, collar);
    dye = mix(sky, storm, 1.0 - smoothstep(0.8, 0.95, q));
  } else {
    float lat = latitude(uv.y);
    float first = fract(clock / 40.0);
    float second = fract(clock / 40.0 + 0.5);
    vec3 sky = mix(weather(uv, lat, second * 40.0), weather(uv, lat, first * 40.0), abs(1.0 - 2.0 * second));
    vec2 off = abs(d) - vec2(0.42, 0.0);
    float arm = exp(-dot(off, off) * 22.0);
    bool dark = fract(clock / 2.6 + (d.x < 0.0 ? 0.5 : 0.0)) < 0.5;
    vec3 pulse = dark ? vec3(0.52, 0.16, 0.09) : vec3(0.94, 0.66, 0.46);
    vec3 target = mix(mix(mix(mix(sky, cream, collar), salmon, body), red, core), pulse, arm);
    float rate = mix(renewal.x, 0.5 * renewal.y, collar);
    rate = mix(mix(mix(rate, 0.25 * renewal.y, body), renewal.y, core), 2.0 * renewal.y, arm);
    dye += (target - dye) * (1.0 - exp(-rate * timeStep));
  }
  float threshold = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + dither) * 43758.5453);
  outputColor = roundToHalf(vec4(dye, 1.0), threshold);
}
`,
  wallReach: header + `
uniform vec2 axis;

void main() {
  vec2 current = texture(obstacleField, uv).rg;
  bool first = axis.x > 0.5;
  float reach = first ? current.r : current.g;
  for (float step = 1.0; step <= WALL_REACH; step += 1.0) {
    vec2 ahead = texture(obstacleField, uv + axis * simTexel * step).rg;
    vec2 behind = texture(obstacleField, uv - axis * simTexel * step).rg;
    reach = max(reach, first ? max(ahead.r, behind.r) : max(ahead.g, behind.g));
  }
  outputColor = vec4(current.r, reach, 0.0, 1.0);
}
`,
  maskedSplat: header + `
uniform sampler2D targetField;
uniform vec2 center;
uniform vec3 amount;
uniform bool inkMode;
uniform float radius;
uniform float aspectRatio;
uniform float cover;
uniform float swirl;

void main() {
  vec2 offset = uv - center;
  if (wrapX) {
    offset.x = fract(offset.x + 0.5) - 0.5;
  }
  offset.x *= aspectRatio;
  float influence = exp(-dot(offset, offset) / radius);
  if (influence < 0.00001 || !clearPath(center, uv)) {
    influence = 0.0;
  }
  vec3 existing = texture(targetField, uv).rgb;
  vec3 push = amount + vec3(swirl * vec2(-offset.y, offset.x) / sqrt(radius), 0.0);
  vec3 value = cover > 0.0 ? mix(existing, amount, min(1.0, influence * cover)) : existing + push * influence;
  outputColor = solid(uv) ? vec4(0.0) : vec4(value, inkMode ? texture(targetField, uv).a + influence : 1.0);
}
`,
  sources: header + `
uniform sampler2D targetField;
uniform int sourceMode;
uniform vec2 center;
uniform vec2 sourceExtent;
uniform float radius;
uniform vec3 amount;
uniform float timeStep;
uniform float streamCount;
uniform float aspectRatio;

void main() {
  vec3 value = texture(targetField, uv).rgb;
  if (sourceMode == 0 || sourceMode == 4) {
    vec2 offset = (uv - center) * vec2(aspectRatio, 1.0);
    vec2 segment = sourceExtent * vec2(aspectRatio, 1.0);
    if (sourceMode == 4) {
      offset -= segment * clamp(dot(offset, segment) / max(dot(segment, segment), 0.0000001), 0.0, 1.0);
    }
    float weight = exp(-dot(offset, offset) / (radius * radius));
    if (weight > 0.00001 && clearPath(center, uv)) {
      if (sourceMode == 4) {
        if (length(offset) <= radius) {
          value = amount;
        }
      } else {
        value += amount * weight * timeStep;
      }
    }
  } else if (sourceMode == 2 && uv.x < 2.0 * simTexel.x) {
    float distanceToStream = abs(fract(uv.y * streamCount) - 0.5) / streamCount;
    float stripe = 1.0 - smoothstep(0.001, max(0.002, 0.65 * simTexel.y), distanceToStream);
    value = mix(vec3(0.15, 0.8, 1.0), vec3(1.0, 0.55, 0.15), uv.y) * stripe * 1.35;
  }
  outputColor = solid(uv) ? vec4(0.0) : vec4(value, 1.0);
}
`,
  maskQuantity: header + `
uniform sampler2D targetField;

void main() {
  outputColor = solid(uv) ? vec4(0.0) : texture(targetField, uv);
}
`,
  fieldDisplay: header + `
uniform sampler2D field;
uniform int view;
uniform vec3 background;

float solidCoverage() {
  if (!hasSolids) return 0.0;
  vec2 size = vec2(textureSize(obstacleField, 0));
  vec2 grid = uv * size - 0.5;
  vec2 cell = floor(grid);
  vec2 f = fract(grid);
  vec2 a = (cell + 0.5) / size;
  vec2 d = 1.0 / size;
  float bottom = mix(texture(obstacleField, a).r, texture(obstacleField, a + vec2(d.x, 0.0)).r, f.x);
  float top = mix(texture(obstacleField, a + vec2(0.0, d.y)).r, texture(obstacleField, a + d).r, f.x);
  return smoothstep(0.2, 0.8, mix(bottom, top, f.y));
}

vec4 overlaySolid(vec4 color) {
  float light = dot(background, vec3(0.2126, 0.7152, 0.0722));
  return mix(color, vec4(vec3(light > 0.4 ? 0.18 : 0.65), 1.0), solidCoverage());
}

vec3 sampleField(vec2 position) {
  vec2 grid = position / simTexel - 0.5;
  vec2 cell = floor(grid);
  vec2 weight = fract(grid);
  vec2 a = (cell + 0.5) * simTexel;
  vec3 bottom = mix(texture(field, a).rgb, texture(field, a + vec2(simTexel.x, 0.0)).rgb, weight.x);
  vec3 top = mix(texture(field, a + vec2(0.0, simTexel.y)).rgb, texture(field, a + simTexel).rgb, weight.x);
  return mix(bottom, top, weight.y);
}

void main() {
  vec3 value = sampleField(uv);
  if (view == 2) {
    float downstream = inflow > 0.0 ? smoothstep(0.38, 0.75, uv.x) : 0.0;
    float spacing = mix(0.65, 1.5, downstream);
    value = vec3(0.0);
    float total = 0.0;
    for (int y = -2; y <= 2; y += 1) {
      for (int x = -2; x <= 2; x += 1) {
        float weight = float((3 - abs(x)) * (3 - abs(y)));
        vec2 p = uv + vec2(x, y) * simTexel * spacing;
        value += sampleField(p) * weight;
        total += weight;
      }
    }
    value /= total;
    value.r = sign(value.r) * max(abs(value.r) - mix(0.75, 1.8, downstream), 0.0);
  }
  if (view == 1 || view == 3) {
    value /= velocityScale;
  }
  vec3 color;
  if (view == 1) {
    float hue = atan(value.y, value.x) / 6.2831853 + 0.5;
    vec3 wheel = clamp(abs(fract(hue + vec3(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    color = mix(background, 0.15 + 0.85 * wheel, 1.0 - exp(-length(value.xy) * 0.693147 / max(inflow / velocityScale, 45.0)));
  } else {
    float scale = view == 2 ? 18.0 : (view == 3 ? 25.0 : 0.6);
    float weight = 1.0 - exp(-abs(value.r) / scale);
    vec3 hot = view == 4 ? mix(vec3(0.9, 0.18, 0.03), vec3(1.0, 0.93, 0.55), weight) : vec3(1.0, 0.35, 0.12);
    color = mix(background, value.r < 0.0 ? vec3(0.12, 0.55, 1.0) : hot, weight);
  }
  outputColor = overlaySolid(vec4(color, 1.0));
}
`,
};

export function withSolidMask(source) {
  return source.replace("void main() {", `
uniform sampler2D obstacleField;
uniform bool hasSolids;

void main() {
  if (hasSolids && texture(obstacleField, uv).r > 0.5) {
    outputColor = vec4(0.0);
    return;
  }`);
}

export function withSolidDisplay(source) {
  return source.replace("void main() {", `
uniform sampler2D obstacleField;
uniform bool hasSolids;

float solidCoverage() {
  if (!hasSolids) return 0.0;
  vec2 size = vec2(textureSize(obstacleField, 0));
  vec2 grid = uv * size - 0.5;
  vec2 cell = floor(grid);
  vec2 f = fract(grid);
  vec2 a = (cell + 0.5) / size;
  vec2 d = 1.0 / size;
  float bottom = mix(texture(obstacleField, a).r, texture(obstacleField, a + vec2(d.x, 0.0)).r, f.x);
  float top = mix(texture(obstacleField, a + vec2(0.0, d.y)).r, texture(obstacleField, a + d).r, f.x);
  return smoothstep(0.2, 0.8, mix(bottom, top, f.y));
}

vec4 overlaySolid(vec4 color) {
  float light = dot(background, vec3(0.2126, 0.7152, 0.0722));
  return mix(color, vec4(vec3(light > 0.4 ? 0.18 : 0.65), 1.0), solidCoverage());
}

void displayFluid() {`).replace(/}\s*$/, `}
void main() {
  displayFluid();
  outputColor = overlaySolid(outputColor);
}
`);
}
