"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { load, stateIn } = require("./support/helpers");

test("state files are replaced whole, never rewritten in place", (t) => {
  const { dir, api } = stateIn("qp-atomic-test-");
  api.recordPrompt({ text: "first" });
  const file = path.join(dir, "history.json");
  const before = fs.statSync(file).ino;
  api.recordPrompt({ text: "second" });
  assert.notEqual(fs.statSync(file).ino, before, "a reader holding the old file still sees all of it");
  api.writeRequest({ kind: "codex", prompt: "x" });
  api.remember("codex", "tab", "/tmp");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("two launches that fail together each come back, newest first", () => {
  const { api } = stateIn("qp-two-failures-test-");
  const first = api.writeRequest({ kind: "claude", prompt: "first" });
  const second = api.writeRequest({ kind: "codex", prompt: "second" });
  const earlier = (Date.now() - 1000) / 1000;
  fs.utimesSync(first, earlier, earlier);
  api.finishRequest(first, false);
  api.finishRequest(second, false);

  const newest = api.readDraft();
  assert.equal(newest.draft.prompt, "second");
  api.clearDraft(newest.file);
  assert.equal(api.readDraft().draft.prompt, "first");
});

test("a saved draft round-trips and one older than a day is removed", () => {
  const { api } = stateIn("qp-draft-test-");
  const draft = { kind: "claude", prompt: "keep me\nplease", destination: "tab", cwd: "/tmp" };
  const file = api.saveDraft(draft);
  assert.deepEqual({ ...api.readDraft().draft }, draft);
  assert.equal(api.readDraft().file, file);

  const old = Date.now() - 25 * 60 * 60 * 1000;
  fs.utimesSync(file, old / 1000, old / 1000);
  assert.equal(api.readDraft(), null);
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, "{ not json");
  assert.equal(api.readDraft(), null, "a malformed draft must not stop the picker opening");
  assert.equal(fs.existsSync(file), false);
});

test("logs keep one previous file, and a log that cannot be written is no error", () => {
  const { dir, api } = stateIn("qp-log-test-");
  const file = path.join(dir, "crash.log");
  fs.writeFileSync(file, "x".repeat(300 * 1024));
  api.logCrash(new TypeError("boom"));
  assert.equal(fs.readFileSync(`${file}.previous`, "utf8").length, 300 * 1024);
  assert.match(fs.readFileSync(file, "utf8"), /TypeError: boom\n\s+at /, "the stack, not just the message");
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.doesNotThrow(() => api.appendLog("crash.log", "unwritable"));
});

test("requests abandoned by a killed worker become drafts, live ones are left", () => {
  const { dir, api } = stateIn("qp-stale-test-");

  const orphan = path.join(dir, "request-1000000000000-1.json");
  const ancient = path.join(dir, "request-1000000000000-2.json");
  const live = path.join(dir, "request-2000000000000-3.json");
  fs.writeFileSync(orphan, JSON.stringify({ kind: "codex", prompt: "orphan" }));
  fs.writeFileSync(ancient, JSON.stringify({ kind: "codex", prompt: "ancient" }));
  fs.writeFileSync(live, JSON.stringify({ kind: "codex", prompt: "live" }));

  const hours = (n) => (Date.now() - n * 60 * 60 * 1000) / 1000;
  fs.utimesSync(orphan, hours(2), hours(2));
  fs.utimesSync(ancient, hours(30), hours(30));

  api.sweepStaleRequests();
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(live), true, "a request that could still be in flight is left alone");
  const recovered = api.readDraft();
  assert.equal(recovered.draft.prompt, "orphan", "the prompt of a killed launch comes back as a failure");
  assert.equal(recovered.draft.failed, true);
  api.clearDraft(recovered.file);
  assert.equal(api.readDraft(), null, "one older than a draft lives is not resurrected as new");
});

test("prompt history keeps the last fifty launches, newest first and without repeats", (t) => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-history-test-"));
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });

  const state = load("lib/state.js", {}, "const STATE_DIR =");
  state.context.process.env.HERDR_PLUGIN_STATE_DIR = dir;
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/state.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const STATE_DIR =")), state.context);
  const api = state.context.module.exports;

  const texts = () => [...api.readHistory()].map((entry) => entry.text);
  assert.deepEqual(texts(), []);
  api.recordPrompt({ text: "first" });
  api.recordPrompt({ text: "  second\n", kind: "codex", preset: "review", model: { model: "gpt-5.5", effort: null } });
  api.recordPrompt({ text: "   " });
  api.recordPrompt({ text: "" });
  assert.deepEqual(texts(), ["second", "first"], "trimmed, and blank launches are not kept");
  assert.deepEqual({ ...api.readHistory()[0], model: { ...api.readHistory()[0].model } },
    { text: "second", kind: "codex", preset: "review", model: { model: "gpt-5.5", effort: null } });

  api.recordPrompt({ text: "first" });
  assert.deepEqual(texts(), ["first", "second"], "a repeat moves to the front instead of appearing twice");

  for (let n = 0; n < 60; n += 1) api.recordPrompt({ text: `prompt ${n}` });
  const history = texts();
  assert.equal(history.length, 50);
  assert.equal(history[0], "prompt 59");
  assert.equal(history[49], "prompt 10");

  fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify(["a plain string from before"]));
  assert.deepEqual(texts(), [], "entries without their launch settings are dropped");

  fs.writeFileSync(path.join(dir, "history.json"), "{ not json");
  assert.deepEqual([...api.readHistory()], [], "a damaged history must not prevent opening the picker");
});

test("a workspace or worktree launch is not kept as the next popup's destination", () => {
  const { dir, api } = stateIn("qp-sticky-test-");
  const destination = () => JSON.parse(fs.readFileSync(path.join(dir, "prefs.json"), "utf8")).destination;
  api.remember("codex", "right", "/tmp");
  assert.equal(destination(), "right");
  api.remember("codex", "worktree", "/repo");
  assert.equal(destination(), "right");
  api.remember("codex", "workspace", "/tmp");
  assert.equal(destination(), "right");
  api.remember("codex", "tab", "/tmp");
  assert.equal(destination(), "tab");
});
