import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONTROL_HELP, FIELD_HELP, SWATCH_HELP, VIEW_HELP } from "../assets/help.js";
import { BOOL_FIELDS, NUMBER_FIELDS, PRESETS, VIEWS } from "../assets/presets.js";

const page = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("every slider, toggle and view has help text, and nothing else does", () => {
  const keys = [...NUMBER_FIELDS, ...BOOL_FIELDS].map(([key]) => key);
  assert.deepEqual(Object.keys(FIELD_HELP).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(VIEW_HELP), [...VIEWS]);
});

test("help for fixed controls points at elements that are on the page", () => {
  for (const selector of Object.keys(CONTROL_HELP)) {
    const id = /^#([\w-]+)$/.exec(selector)?.[1];
    const tool = /^\[data-tool="(\w+)"\]$/.exec(selector)?.[1];
    const name = /^\.([\w-]+)$/.exec(selector)?.[1];
    const found = id
      ? page.includes(`id="${id}"`)
      : tool
        ? page.includes(`data-tool="${tool}"`)
        : page.includes(`class="${name}"`);
    assert.ok(found, selector);
  }
});

test("help text and preset notes are short, plain sentences", () => {
  const texts = [
    ...Object.values(FIELD_HELP),
    ...Object.values(VIEW_HELP),
    ...Object.values(CONTROL_HELP),
    SWATCH_HELP,
    ...Object.values(PRESETS).map(preset => preset.note),
  ];
  for (const text of texts) {
    assert.match(text, /^[A-Z].*\.$/, text);
    assert.ok(text.length <= 130, text);
  }
});
