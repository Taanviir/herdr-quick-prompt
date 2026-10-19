"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { picker, LISTED } = require("./support/helpers");

test("a preset's agent that is not installed is marked in the list", () => {
  const ui = picker(null, { presets: [{ name: "spike", agent: "amp", prefix: "x", postfix: "", task: "ask" }] });
  ui.evaluate("openPresets()");
  assert.match(ui.evaluate("presetsBody(71, 16).lines[1]"), /amp ○/);
});

test("directory arrows override typed parent, while direct Enter uses the typed path", () => {
  const ui = picker();
  const open = "state.overlay = {type: 'dirs', input: new Editor('/tmp/'), index: 0}";
  ui.evaluate(open);
  ui.evaluate("onDirsKey('', {name: 'down'}); onDirsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.cwd"), "/tmp/child");
  ui.evaluate(open);
  ui.evaluate("onDirsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.cwd"), "/tmp/");
  ui.evaluate(open);
  ui.evaluate("onDirsKey('', {name: 'down'}); insertPasted('child')");
  assert.equal(ui.evaluate("state.overlay.selectionMoved"), false);
});

test("the directory list is read once per edit, not once per key or frame", () => {
  const listed = [];
  const ui = picker(null, { dirs: {
    suggestions: () => { listed.push("suggestions"); return ["/tmp", "/tmp/a", "/tmp/b"]; },
    complete: (text) => { listed.push(`complete ${text}`); return ["/usr/bin"]; },
  } });
  ui.evaluate("openDirectories()");
  ui.evaluate("dirsBody(71, 16); onDirsKey('', {name: 'down'}); dirsBody(71, 16); onDirsKey('', {name: 'down'}); dirsBody(71, 16)");
  assert.deepEqual(listed, ["suggestions"]);
  ui.evaluate("onDirsKey('a', {name: 'a'}); dirsBody(71, 16); onDirsKey('', {name: 'up'}); dirsBody(71, 16)");
  assert.deepEqual(listed, ["suggestions"], "filtering reuses the suggestions it already has");
  assert.deepEqual([...ui.evaluate("directoryEntries()")], ["/tmp/a"]);
  ui.evaluate("onDirsKey('', {ctrl: true, name: 'u'}); onDirsKey('/', {name: '/'}); dirsBody(71, 16); onDirsKey('', {name: 'down'})");
  assert.deepEqual(listed, ["suggestions", "complete /"]);
});

test("the key that opens a list closes it, and esc clears a filter before closing", () => {
  const { parseAgents } = require("../lib/running");
  const ui = picker(null, { runningList: parseAgents({ agents: LISTED }), presets: [{ name: "review", agent: null, prefix: "x", postfix: "", task: "ask" }] });
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'codex')");
  for (const letter of ["k", "d", "o", "p", "r"]) {
    const press = `onKey('', {ctrl: true, name: '${letter}'})`;
    ui.evaluate(press);
    assert.ok(ui.evaluate("state.overlay"), `ctrl+${letter} opens`);
    ui.evaluate(press);
    assert.equal(ui.evaluate("state.overlay"), null, `ctrl+${letter} closes`);
  }
  for (const letter of ["k", "p", "r"]) {
    ui.evaluate(`onKey('', {ctrl: true, name: '${letter}'}); onKey('x', {name: 'x'})`);
    ui.context.onData(Buffer.from([0x1b]));
    assert.equal(ui.evaluate("state.overlay.filter"), "", `ctrl+${letter}: esc clears the filter`);
    ui.context.onData(Buffer.from([0x1b]));
    assert.equal(ui.evaluate("state.overlay"), null, `ctrl+${letter}: a second esc closes`);
  }
  ui.evaluate("onKey('', {ctrl: true, name: 'd'}); onKey('t', {name: 't'})");
  ui.context.onData(Buffer.from([0x1b]));
  assert.equal(ui.evaluate("state.overlay.input.text"), "");
  ui.context.onData(Buffer.from([0x1b]));
  assert.equal(ui.evaluate("state.overlay"), null);
});

test("ctrl+o picks a model and effort for the selected agent only", () => {
  const { displayWidth } = require("../lib/text");
  const ui = picker();
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'codex')");
  assert.doesNotMatch(ui.evaluate("destinationRow(71)"), /model|ctrl+o/, "the default model leaves the row to the path");
  ui.evaluate("onMainKey('\\x0f', {ctrl: true, name: 'o'})");
  assert.equal(ui.evaluate("state.overlay.type"), "model");
  ui.evaluate("onModelKey('', {name: 'down'}); onModelKey('', {name: 'right'}); onModelKey('', {name: 'right'})");
  assert.equal(ui.evaluate("state.overlay.effort"), "medium");
  for (let i = 0; i < 4; i += 1) ui.evaluate("onModelKey('', {name: 'right'})");
  assert.equal(ui.evaluate("state.overlay.effort"), "ultra");
  ui.evaluate("onModelKey('', {name: 'down'}); onModelKey('', {name: 'down'}); onModelKey('', {name: 'down'})");
  assert.equal(ui.evaluate("state.overlay.effort"), null, "gpt-6-luna has no ultra");
  ui.evaluate("onModelKey('', {name: 'up'}); onModelKey('', {name: 'right'}); onModelKey('\\r', {name: 'return'})");
  assert.deepEqual({ ...ui.evaluate("choice()") }, { model: "gpt-6-sol", effort: "low" });

  ui.evaluate("state.destination = 1; state.cwd = '/home/someone/projects/a-rather-long-project-name'");
  const row = ui.evaluate("destinationRow(71)");
  assert.match(row, /gpt-6-sol · low/);
  assert.ok(displayWidth(row) <= 71, "a long model name must not push the row past the popup");

  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'claude')");
  assert.doesNotMatch(ui.evaluate("destinationRow(71)"), /gpt|model/, "each kind keeps its own choice");
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'gemini'); onMainKey('\\x0f', {ctrl: true, name: 'o'})");
  assert.equal(ui.evaluate("state.overlay"), null);
  assert.match(ui.evaluate("state.notice"), /no model choice for gemini/);
  assert.doesNotMatch(ui.evaluate("destinationRow(71)"), /model/);
});

test("a preset selects its agent, shows itself, and comes off when picked again or with ctrl+x", () => {
  const review = { name: "review", agent: "codex", prefix: "Review:", postfix: "", task: "ask" };
  const requests = [];
  const ui = picker(null, { presets: [review, { name: "plain", agent: null, prefix: "", postfix: "", task: "ask" }], requests });
  ui.evaluate("onMainKey('', {ctrl: true, name: 'p'}); onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.match(ui.evaluate("mainBody(71, 16).lines[2]"), /preset.*review/);
  assert.equal(requests.length, 0, "an ask preset waits for the prompt");
  ui.evaluate("onMainKey('', {ctrl: true, name: 'p'}); onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.preset"), null);
  ui.evaluate("onMainKey('', {ctrl: true, name: 'p'}); onPresetsKey('l', {name: 'l'}); onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.preset.name"), "plain");
  ui.evaluate("onMainKey('', {ctrl: true, name: 'x'})");
  assert.equal(ui.evaluate("state.preset"), null);
  assert.equal(ui.evaluate("mainBody(71, 16).lines[2]"), "");
});

test("a preset can choose the model and destination, and the list shows what it sends", () => {
  const { displayWidth } = require("../lib/text");
  const fast = { name: "fast", agent: "claude", prefix: "Be quick about this one, and do not overthink it.", postfix: "Reply in one line.",
    task: "ask", model: "sonnet", effort: "low", destination: "right" };
  const tree = { name: "tree", agent: null, prefix: "", postfix: "", task: "ask", model: null, effort: null, destination: "worktree" };
  const requests = [];
  const ui = picker(null, { presets: [fast, tree], requests });
  ui.evaluate("openPresets()");
  const body = ui.evaluate("presetsBody(71, 16)").lines;
  assert.match(body[1], /claude · sonnet low · right/);
  const preview = body[14].replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(preview, /^Be quick about this one.* ‹prompt› Reply in one line\.$/);
  assert.ok(displayWidth(preview) <= 71);

  ui.evaluate("onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("destination().id"), "right");
  assert.deepEqual({ ...ui.evaluate("choice()") }, { model: "sonnet", effort: "low" });
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'codex')");
  assert.deepEqual({ ...ui.evaluate("choice()") }, { model: null, effort: null }, "only for the preset's own agent");
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'claude'); openModels(); onModelKey('', {name: 'up'}); onModelKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("choice().model"), "opus", "a model picked by hand wins over the preset's");

  ui.evaluate("state.prompt = new Editor('go'); launch()");
  assert.equal(requests[0].destination, "right");
  assert.equal(JSON.parse(fs.readFileSync(path.join(ui.dir, "prefs.json"), "utf8")).destination, "tab",
    "the preset's destination does not become the default");

  const outside = picker(null, { presets: [tree] });
  outside.evaluate("applyPreset(presets[0])");
  assert.equal(outside.evaluate("destination().id"), "tab");
  assert.match(outside.evaluate("state.notice"), /no worktree outside a git repository/);
});

test("a skip preset launches over an empty prompt but not over a typed one", () => {
  const skip = { name: "tests", agent: "claude", prefix: "Run the tests.", postfix: "", task: "skip" };
  const requests = [];
  const ui = picker(null, { presets: [skip], requests });
  ui.evaluate("state.prompt = new Editor('only the auth ones'); applyPreset(presets[0])");
  assert.equal(requests.length, 0);
  ui.evaluate("state.preset = null; state.prompt = new Editor(''); applyPreset(presets[0])");
  assert.equal(requests.length, 1);
});

test("a model picked with ctrl+o is kept even when the popup closes without launching", () => {
  const ui = picker();
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'codex'); openModels()");
  ui.evaluate("onModelKey('', {name: 'down'}); onModelKey('', {name: 'right'}); onModelKey('\\r', {name: 'return'}); onEscape()");
  const saved = JSON.parse(fs.readFileSync(path.join(ui.dir, "prefs.json"), "utf8")).models.codex;
  assert.deepEqual(saved, { model: "gpt-6.1-sol", effort: "low" });
  assert.deepEqual({ ...picker(null, { prefs: { recents: ["codex"], models: { codex: saved } } }).evaluate("choice()") }, saved);
});
