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

const float WALL_REACH = 8.0;

bool solid(vec2 p) {
  return hasSolids && textureLod(obstacleField, clamp(p, vec2(0.0), vec2(1.0)), 0.0).r > 0.5;
}

bool wall(vec2 p) {
  return p.y < 0.0 || p.y > 1.0
    || (inflow <= 0.0 && (p.x < 0.0 || p.x > 1.0)) || solid(p);
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
        ivec2 index = clamp(ivec2(floor(point / quantityTexel)), ivec2(0), size - 1);
        value += texelFetch(quantityField, index, 0) * weight;
        total += weight;
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
  outputColor = value;
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

void main() {
  vec2 offset = (uv - center) * vec2(aspectRatio, 1.0);
  float influence = exp(-dot(offset, offset) / radius);
  if (influence < 0.00001 || !clearPath(center, uv)) {
    influence = 0.0;
  }
  vec3 value = texture(targetField, uv).rgb + amount * influence;
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
