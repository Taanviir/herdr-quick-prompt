"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { readPresets, composePrompt } = require("../lib/presets");

function presetsFile(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-presets-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "presets.json");
  if (body !== undefined) fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

test("a missing presets file is not a problem", (t) => {
  assert.deepEqual(readPresets(presetsFile(t)), { presets: [], problems: [] });
});

test("presets fill in their defaults and keep their order", (t) => {
  const { presets, problems } = readPresets(presetsFile(t, [
    { name: " review ", agent: "codex", prefix: "Review this:", task: "skip" },
    { name: "explain" },
  ]));
  assert.deepEqual(problems, []);
  assert.deepEqual(presets, [
    { name: "review", agent: "codex", prefix: "Review this:", postfix: "", task: "skip" },
    { name: "explain", agent: null, prefix: "", postfix: "", task: "ask" },
  ]);
});

test("a broken preset is skipped and named, and the rest still load", (t) => {
  const { presets, problems } = readPresets(presetsFile(t, [
    { name: "good" },
    { agent: "codex" },
    { name: "good" },
    { name: "bad task", task: "later" },
    { name: "bad prefix", prefix: ["a"] },
    { name: "bad agent", agent: "" },
    "just text",
  ]));
  assert.deepEqual(presets.map((p) => p.name), ["good"]);
  assert.equal(problems.length, 6);
  assert.match(problems[0], /preset 2 has no name/);
  assert.match(problems[1], /"good" is defined twice/);
  assert.match(problems[2], /task must be "ask" or "skip"/);
  assert.match(problems[3], /prefix and postfix must be text/);
  assert.match(problems[4], /agent must be an agent kind/);
  assert.match(problems[5], /preset 7 is not an object/);
});

test("a file that is not a list of presets says so instead of crashing", (t) => {
  assert.match(readPresets(presetsFile(t, "{ nope")).problems[0], /^presets\.json: /);
  assert.match(readPresets(presetsFile(t, { name: "x" })).problems[0], /must be a list/);
});

test("the prompt is prefix, text and postfix, with empty parts dropped", () => {
  const preset = { prefix: "Before.\n", postfix: "  After." };
  assert.equal(composePrompt(preset, "middle"), "Before.\n\nmiddle\n\nAfter.");
  assert.equal(composePrompt(preset, "  "), "Before.\n\nAfter.");
  assert.equal(composePrompt({ prefix: "", postfix: "After." }, "middle"), "middle\n\nAfter.");
  assert.equal(composePrompt(null, "just this"), "just this");
  assert.equal(composePrompt(null, ""), "");
});
