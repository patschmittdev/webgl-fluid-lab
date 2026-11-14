import test from "node:test";
import assert from "node:assert/strict";
import { OPTIONAL_SHADERS } from "../assets/engines/lab.js";
import { FRAGMENT_SHADERS, FULLSCREEN_VERTEX_SHADER } from "../assets/engines/lab/shaders.js";

const TYPES = "void|bool|int|float|vec2|vec3|vec4|ivec2|ivec3|ivec4|mat2|mat3|mat4";
const LANGUAGE = new Set([
  ...TYPES.split("|"),
  "if", "for", "while", "return", "layout",
  "abs", "all", "any", "atan", "clamp", "cos", "cross", "distance", "dot", "equal", "exp", "floor", "fract",
  "length", "lessThan", "log", "max", "min", "mix", "mod", "normalize", "pow", "sign", "sin", "smoothstep", "sqrt", "step",
  "texelFetch", "texture", "textureLod", "textureSize",
]);

function undefinedCalls(source) {
  const code = source.replace(/\/\/.*$/gm, "");
  const defined = new Set(
    [...code.matchAll(new RegExp(`^\\s*(?:${TYPES})\\s+(\\w+)\\s*\\(`, "gm"))].map(match => match[1]),
  );
  const called = new Set([...code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(match => match[1]));
  return [...called].filter(name => !defined.has(name) && !LANGUAGE.has(name));
}

test("every shader defines the functions it calls", () => {
  const sources = { vertex: FULLSCREEN_VERTEX_SHADER, ...FRAGMENT_SHADERS, ...OPTIONAL_SHADERS };
  for (const [name, source] of Object.entries(sources)) {
    assert.deepEqual(undefinedCalls(source), [], `${name} calls a function it does not define`);
    assert.match(source, /void\s+main\s*\(/, `${name} has an entry point`);
  }
});

test("the check notices a call to a function that is not there", () => {
  assert.deepEqual(undefinedCalls("void main() {\n  outputColor = missing(uv) * mix(a, b, 0.5);\n}"), ["missing"]);
});
