export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

out vec2 uv;

void main() {
  vec2 corners[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  vec2 position = corners[gl_VertexID];
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const HALF_FLOAT_ROUNDING = `
vec4 roundToHalf(vec4 value, float threshold) {
  vec4 unit = exp2(floor(log2(max(abs(value), vec4(0.00001)))) - 10.0);
  return floor(value / unit + threshold) * unit * 1.00001;
}
`;

const flameColor = `
uniform sampler2D temperatureField;
uniform bool flameShading;

float flameTemperature(vec2 position) {
  vec2 size = vec2(textureSize(temperatureField, 0));
  vec2 grid = position * size - 0.5;
  vec2 cell = floor(grid);
  vec2 weight = fract(grid);
  vec2 a = (cell + 0.5) / size;
  vec2 d = 1.0 / size;
  float bottom = mix(texture(temperatureField, a).r, texture(temperatureField, a + vec2(d.x, 0.0)).r, weight.x);
  float top = mix(texture(temperatureField, a + vec2(0.0, d.y)).r, texture(temperatureField, a + d).r, weight.x);
  return max(mix(bottom, top, weight.y), 0.0);
}

vec3 shadeFlame(vec3 fuel, vec2 position) {
  float heat = flameTemperature(position);
  float density = max(fuel.r, max(fuel.g, fuel.b));
  float opacity = 1.0 - exp(-density * 2.0);
  vec3 ramp = mix(vec3(0.25, 0.005, 0.0), vec3(1.2, 0.18, 0.005), smoothstep(0.2, 0.6, heat));
  ramp = mix(ramp, vec3(1.6, 1.0, 0.08), smoothstep(0.6, 1.1, heat));
  ramp = mix(ramp, vec3(1.9, 1.8, 1.5), smoothstep(1.1, 1.6, heat));
  ramp = mix(ramp, vec3(0.25, 0.6, 1.7), smoothstep(2.2, 3.0, heat));
  ramp = mix(ramp, vec3(0.55, 0.85, 1.9), smoothstep(3.2, 4.4, heat));
  return mix(vec3(0.24), ramp, smoothstep(0.12, 0.35, heat)) * opacity;
}
`;

export const FRAGMENT_SHADERS = {
  advect: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D velocityField;
uniform sampler2D quantityField;
uniform vec2 velocityTexel;
uniform vec2 quantityTexel;
uniform float timeStep;
uniform float dissipation;
uniform bool keepPrecision;
${HALF_FLOAT_ROUNDING}
vec4 sampleLinear(sampler2D field, vec2 position, vec2 texel) {
  vec2 gridPosition = position / texel - 0.5;
  vec2 cell = floor(gridPosition);
  vec2 weight = fract(gridPosition);
  vec2 lowerLeft = (cell + 0.5) * texel;
  vec4 bottom = mix(
    texture(field, lowerLeft),
    texture(field, lowerLeft + vec2(texel.x, 0.0)),
    weight.x
  );
  vec4 top = mix(
    texture(field, lowerLeft + vec2(0.0, texel.y)),
    texture(field, lowerLeft + texel),
    weight.x
  );
  return mix(bottom, top, weight.y);
}

void main() {
  vec2 velocity = sampleLinear(velocityField, uv, velocityTexel).xy;
  vec2 departurePoint = uv - timeStep * velocity * velocityTexel;
  vec4 transported = sampleLinear(quantityField, departurePoint, quantityTexel) / (1.0 + dissipation * timeStep);
  outputColor = keepPrecision ? roundToHalf(transported, 0.5) : transported;
}
`,

  curl: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D velocityField;
uniform vec2 texel;

void main() {
  float velocityYLeft = texture(velocityField, uv - vec2(texel.x, 0.0)).y;
  float velocityYRight = texture(velocityField, uv + vec2(texel.x, 0.0)).y;
  float velocityXBottom = texture(velocityField, uv - vec2(0.0, texel.y)).x;
  float velocityXTop = texture(velocityField, uv + vec2(0.0, texel.y)).x;
  float rotation = 0.5 * (
    velocityYRight - velocityYLeft - velocityXTop + velocityXBottom
  );
  outputColor = vec4(rotation, 0.0, 0.0, 1.0);
}
`,

  vorticity: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D velocityField;
uniform sampler2D curlField;
uniform vec2 texel;
uniform float strength;
uniform float timeStep;
uniform float velocityScale;

void main() {
  float leftMagnitude = abs(texture(curlField, uv - vec2(texel.x, 0.0)).r);
  float rightMagnitude = abs(texture(curlField, uv + vec2(texel.x, 0.0)).r);
  float bottomMagnitude = abs(texture(curlField, uv - vec2(0.0, texel.y)).r);
  float topMagnitude = abs(texture(curlField, uv + vec2(0.0, texel.y)).r);
  float localCurl = texture(curlField, uv).r;

  vec2 magnitudeGradient = 0.5 * vec2(
    topMagnitude - bottomMagnitude,
    rightMagnitude - leftMagnitude
  );
  magnitudeGradient /= length(magnitudeGradient) + 0.0001;

  vec2 force = strength * localCurl * vec2(magnitudeGradient.x, -magnitudeGradient.y);
  vec2 velocity = texture(velocityField, uv).xy + force * timeStep;
  outputColor = vec4(clamp(velocity, vec2(-1000.0 * velocityScale), vec2(1000.0 * velocityScale)), 0.0, 1.0);
}
`,

  divergence: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D velocityField;
uniform vec2 texel;
uniform bool wrapX;

void main() {
  vec2 center = texture(velocityField, uv).xy;
  vec2 leftUv = uv - vec2(texel.x, 0.0);
  vec2 rightUv = uv + vec2(texel.x, 0.0);
  vec2 bottomUv = uv - vec2(0.0, texel.y);
  vec2 topUv = uv + vec2(0.0, texel.y);

  float left = !wrapX && leftUv.x < 0.0 ? -center.x : texture(velocityField, leftUv).x;
  float right = !wrapX && rightUv.x > 1.0 ? -center.x : texture(velocityField, rightUv).x;
  float bottom = bottomUv.y < 0.0 ? -center.y : texture(velocityField, bottomUv).y;
  float top = topUv.y > 1.0 ? -center.y : texture(velocityField, topUv).y;

  outputColor = vec4(0.5 * (right - left + top - bottom), 0.0, 0.0, 1.0);
}
`,

  pressureDecay: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D pressureField;
uniform float retention;

void main() {
  outputColor = vec4(texture(pressureField, uv).r * retention, 0.0, 0.0, 1.0);
}
`,

  pressureSolve: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D pressureField;
uniform sampler2D divergenceField;
uniform vec2 texel;

void main() {
  float left = texture(pressureField, uv - vec2(texel.x, 0.0)).r;
  float right = texture(pressureField, uv + vec2(texel.x, 0.0)).r;
  float bottom = texture(pressureField, uv - vec2(0.0, texel.y)).r;
  float top = texture(pressureField, uv + vec2(0.0, texel.y)).r;
  float divergence = texture(divergenceField, uv).r;
  float nextPressure = 0.25 * (left + right + bottom + top - divergence);
  outputColor = vec4(nextPressure, 0.0, 0.0, 1.0);
}
`,

  project: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D pressureField;
uniform sampler2D velocityField;
uniform vec2 texel;

void main() {
  float left = texture(pressureField, uv - vec2(texel.x, 0.0)).r;
  float right = texture(pressureField, uv + vec2(texel.x, 0.0)).r;
  float bottom = texture(pressureField, uv - vec2(0.0, texel.y)).r;
  float top = texture(pressureField, uv + vec2(0.0, texel.y)).r;
  vec2 velocity = texture(velocityField, uv).xy;
  velocity -= vec2(right - left, top - bottom);
  outputColor = vec4(velocity, 0.0, 1.0);
}
`,

  splat: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D targetField;
uniform vec2 center;
uniform vec3 amount;
uniform bool inkMode;
uniform float radius;
uniform float aspectRatio;
uniform bool wrapX;
uniform float cover;
uniform float swirl;

void main() {
  vec2 offset = uv - center;
  if (wrapX) {
    offset.x = fract(offset.x + 0.5) - 0.5;
  }
  offset.x *= aspectRatio;
  float influence = exp(-dot(offset, offset) / radius);
  vec3 existing = texture(targetField, uv).rgb;
  vec3 push = amount + vec3(swirl * vec2(-offset.y, offset.x) / sqrt(radius), 0.0);
  vec3 value = cover > 0.0 ? mix(existing, amount, min(1.0, influence * cover)) : existing + push * influence;
  outputColor = vec4(value, inkMode ? texture(targetField, uv).a + influence : 1.0);
}
`,

  bloomPrefilter: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D dyeField;
uniform float threshold;
uniform float softKnee;
${flameColor}

void main() {
  vec3 source = max(texture(dyeField, uv).rgb, vec3(0.0));
  if (flameShading) {
    source = shadeFlame(source, uv);
  }
  float peak = max(source.r, max(source.g, source.b));
  float kneeWidth = max(threshold * softKnee, 0.0001);
  float transition = clamp(
    (peak - threshold + kneeWidth) / (2.0 * kneeWidth),
    0.0,
    1.0
  );
  float softContribution = transition * transition * kneeWidth;
  float hardContribution = max(peak - threshold, 0.0);
  float contribution = max(softContribution, hardContribution) / max(peak, 0.0001);
  outputColor = vec4(source * contribution, 1.0);
}
`,

  bloomDownsample: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D sourceField;
uniform vec2 sourceTexel;

void main() {
  vec3 sum = texture(sourceField, uv).rgb * 0.25;
  sum += texture(sourceField, uv + vec2(sourceTexel.x, 0.0)).rgb * 0.125;
  sum += texture(sourceField, uv - vec2(sourceTexel.x, 0.0)).rgb * 0.125;
  sum += texture(sourceField, uv + vec2(0.0, sourceTexel.y)).rgb * 0.125;
  sum += texture(sourceField, uv - vec2(0.0, sourceTexel.y)).rgb * 0.125;
  sum += texture(sourceField, uv + sourceTexel).rgb * 0.0625;
  sum += texture(sourceField, uv - sourceTexel).rgb * 0.0625;
  sum += texture(sourceField, uv + vec2(sourceTexel.x, -sourceTexel.y)).rgb * 0.0625;
  sum += texture(sourceField, uv + vec2(-sourceTexel.x, sourceTexel.y)).rgb * 0.0625;
  outputColor = vec4(sum, 1.0);
}
`,

  bloomUpsample: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D baseField;
uniform sampler2D lowerField;
uniform vec2 lowerTexel;

void main() {
  vec3 expanded = texture(lowerField, uv).rgb * 4.0;
  expanded += texture(lowerField, uv + vec2(lowerTexel.x, 0.0)).rgb * 2.0;
  expanded += texture(lowerField, uv - vec2(lowerTexel.x, 0.0)).rgb * 2.0;
  expanded += texture(lowerField, uv + vec2(0.0, lowerTexel.y)).rgb * 2.0;
  expanded += texture(lowerField, uv - vec2(0.0, lowerTexel.y)).rgb * 2.0;
  expanded += texture(lowerField, uv + lowerTexel).rgb;
  expanded += texture(lowerField, uv - lowerTexel).rgb;
  expanded += texture(lowerField, uv + vec2(lowerTexel.x, -lowerTexel.y)).rgb;
  expanded += texture(lowerField, uv + vec2(-lowerTexel.x, lowerTexel.y)).rgb;
  expanded /= 16.0;
  outputColor = vec4(texture(baseField, uv).rgb + expanded, 1.0);
}
`,

  sunraysMask: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D dyeField;

void main() {
  vec3 dye = max(texture(dyeField, uv).rgb, vec3(0.0));
  float density = max(dye.r, max(dye.g, dye.b));
  float transmittance = 1.0 - min(density * 8.0, 0.85);
  outputColor = vec4(transmittance, 0.0, 0.0, 1.0);
}
`,

  sunrays: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D maskField;

void main() {
  const int sampleCount = 24;
  vec2 rayStep = (vec2(0.5) - uv) * (0.65 / float(sampleCount));
  vec2 sampleUv = uv;
  float decay = 1.0;
  float light = 0.0;
  float normalization = 0.0;

  for (int index = 0; index < sampleCount; index += 1) {
    light += texture(maskField, sampleUv).r * decay;
    normalization += decay;
    decay *= 0.96;
    sampleUv += rayStep;
  }

  outputColor = vec4(light / max(normalization, 0.0001), 0.0, 0.0, 1.0);
}
`,

  display: `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;
out vec4 outputColor;

uniform sampler2D dyeField;
uniform sampler2D bloomField;
uniform sampler2D sunraysField;
uniform vec2 texel;
uniform vec3 background;
uniform float bloomIntensity;
uniform float sunraysWeight;
uniform bool useInk;
uniform bool warmSmoke;
uniform bool useShading;
uniform bool useTransparency;
uniform bool useBloom;
uniform bool useSunrays;
${flameColor}

void main() {
  vec2 picture = uv;
  vec3 color = max(texture(dyeField, picture).rgb, vec3(0.0));
  float fuelAlpha = 1.0 - exp(-max(color.r, max(color.g, color.b)) * 2.0);

  if (useInk) {
    float density = max(texture(dyeField, picture).a, 0.0);
    vec3 absorption = color / max(density, 0.00001);
    outputColor = vec4(background * exp(-absorption * (1.0 - exp(-density))), 1.0);
    return;
  }
  if (warmSmoke) {
    float warmth = clamp(texture(temperatureField, picture).r, 0.0, 1.0);
    color *= mix(vec3(0.85, 0.88, 0.92), vec3(1.0, 0.68, 0.38), warmth);
  }
  if (flameShading) {
    color = shadeFlame(color, picture);
  }

  if (useShading) {
    float left = length(texture(dyeField, picture - vec2(texel.x, 0.0)).rgb);
    float right = length(texture(dyeField, picture + vec2(texel.x, 0.0)).rgb);
    float bottom = length(texture(dyeField, picture - vec2(0.0, texel.y)).rgb);
    float top = length(texture(dyeField, picture + vec2(0.0, texel.y)).rgb);
    vec3 surfaceNormal = normalize(vec3(right - left, top - bottom, length(texel)));
    float light = clamp(surfaceNormal.z + 0.7, 0.7, 1.0);
    color *= light;
  }

  if (useBloom) {
    color += max(texture(bloomField, picture).rgb, vec3(0.0)) * bloomIntensity;
  }

  if (useSunrays) {
    float radialLight = max(texture(sunraysField, picture).r, 0.0);
    color += color * radialLight * sunraysWeight;
  }

  float alpha = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
  if (flameShading) {
    alpha = max(fuelAlpha, useBloom ? clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0) : 0.0);
  }
  if (useTransparency) {
    outputColor = vec4(color, alpha);
  } else {
    outputColor = vec4(color + background * (1.0 - alpha), 1.0);
  }
}
`,
};
