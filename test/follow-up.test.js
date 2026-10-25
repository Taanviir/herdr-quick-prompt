"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load, picker, LISTED, FAILED_FOLLOW_UP } = require("./support/helpers");

test("in a follow-up a preset only wraps the text: it neither switches agent nor sends", () => {
  const { parseAgents } = require("../lib/running");
  const requests = [];
  const skip = { name: "tests", agent: "claude", prefix: "Run the tests.", postfix: "", task: "skip" };
  const ui = picker(null, { presets: [skip], requests, runningList: parseAgents({ agents: LISTED }) });
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'codex')");
  ui.evaluate("openRunning(); onRunningKey('\\r', {name: 'return'})");
  assert.ok(ui.evaluate("state.followUp"));
  ui.evaluate("applyPreset(presets[0])");
  assert.equal(requests.length, 0, "nothing is sent until Enter");
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.equal(ui.evaluate("state.preset.name"), "tests");
  ui.evaluate("onMainKey('\\r', {name: 'return'})");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].preset.name, "tests");
});

test("running agents waiting on you come first, newest change first, blocked ones last", () => {
  const { parseAgents } = require("../lib/running");
  const parsed = parseAgents({ agents: LISTED });
  assert.deepEqual(parsed.map((entry) => entry.target), ["w2:p1", "w1:p2", "w1:p1", "w2:p2", "w1:p3"],
    "an agent without a pane cannot be prompted and is left out");
  assert.deepEqual(parsed[0], {
    target: "w2:p1", title: "gemini", kind: "gemini", status: "done", cwd: "/work/docs/site", changed: 7,
  }, "an untitled agent goes by its kind, and by the directory it is working in");
  assert.equal(parsed[3].status, "unknown");
  assert.deepEqual(parseAgents({}), []);
  assert.deepEqual(parseAgents(undefined), []);
});

test("the running list filters on title, kind and directory", () => {
  const { parseAgents, matches } = require("../lib/running");
  const parsed = parseAgents({ agents: LISTED });
  const filtered = (text) => parsed.filter((entry) => matches(entry, text)).map((entry) => entry.target);
  assert.deepEqual(filtered("AUTH"), ["w1:p1"]);
  assert.deepEqual(filtered("codex"), ["w1:p2"]);
  assert.deepEqual(filtered("docs/site"), ["w2:p1"]);
  assert.deepEqual(filtered(""), parsed.map((entry) => entry.target));
});

test("a follow-up goes to the chosen agent, and esc backs out one step at a time", () => {
  const { parseAgents } = require("../lib/running");
  const requests = [];
  const ui = picker(null, { runningList: parseAgents({ agents: LISTED }), requests });

  ui.evaluate("onMainKey('\\x12', {ctrl: true, name: 'r'})");
  assert.equal(ui.evaluate("state.overlay.type"), "running");
  assert.match(ui.evaluate("runningBody(71, 16).lines[1]"), /gemini · done/);
  ui.evaluate("onRunningKey('', {name: 'escape'})");
  assert.equal(ui.evaluate("state.overlay"), null, "esc in the list goes back to the prompt");
  assert.equal(ui.evaluate("state.followUp"), null);

  ui.evaluate("openRunning(); onRunningKey('f', {name: 'f'}); onRunningKey('i', {name: 'i'}); onRunningKey('x', {name: 'x'})");
  ui.evaluate("onRunningKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.followUp.target"), "w1:p2");
  assert.match(ui.evaluate("mainBody(71, 16).lines[1]"), /→.*Fix the build/);

  const agentBefore = ui.evaluate("state.agent");
  ui.evaluate("onMainKey('\\t', {name: 'tab'}); onMainKey('\\x14', {ctrl: true, name: 't'}); onMainKey('\\x0b', {ctrl: true, name: 'k'})");
  assert.equal(ui.evaluate("state.agent"), agentBefore, "the agent is fixed in a follow-up");
  assert.equal(ui.evaluate("destination().id"), "tab");
  assert.equal(ui.evaluate("state.overlay"), null);
  assert.equal(ui.evaluate("state.notice"), "following up · esc to launch a new agent instead", "the key is not just ignored");

  ui.evaluate("onMainKey('\\r', {name: 'return'})");
  assert.equal(requests.length, 0, "an empty follow-up is not sent");
  ui.evaluate("state.prompt = new Editor('also update the tests'); onMainKey('\\r', {name: 'return'})");
  const sent = requests[0];
  assert.equal(sent.prompt, "also update the tests");
  assert.equal(sent.followUp.target, "w1:p2");
  assert.equal(sent.workspace, undefined, "a follow-up creates nothing, so it has nowhere to go");

  ui.evaluate("onMainKey('', {name: 'escape'})");
  assert.equal(ui.evaluate("state.followUp"), null, "esc leaves follow-up mode before it closes the picker");
});

test("in a narrow running list the title keeps its room and the path goes", () => {
  const { parseAgents } = require("../lib/running");
  const ui = picker(null, { runningList: parseAgents({ agents: LISTED }) });
  ui.evaluate("openRunning()");
  const plain = (width) => ui.evaluate(`runningBody(${width}, 8)`).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(plain(40)[3], /Refactor auth +claude · working $/);
  assert.match(plain(71)[3], /Refactor auth +claude · working · \/work\/api $/);
});

test("a blocked agent is marked in the running list and cannot be chosen", () => {
  const { parseAgents } = require("../lib/running");
  const ui = picker(null, { runningList: parseAgents({ agents: LISTED }) });
  ui.evaluate("openRunning(); onRunningKey('t', {name: 't'}); onRunningKey('r', {name: 'r'}); onRunningKey('u', {name: 'u'})");
  assert.match(ui.evaluate("runningBody(71, 16).lines[1]"), /Trust dialog.*blocked/);
  ui.evaluate("onRunningKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.followUp"), null);
  assert.equal(ui.evaluate("state.overlay.type"), "running", "the list stays open to pick another");
  assert.match(ui.evaluate("runningBody(71, 16).lines[15]"), /Trust dialog is blocked · answer it in its pane first/);
  ui.evaluate("onRunningKey('', {name: 'backspace'})");
  assert.doesNotMatch(ui.evaluate("runningBody(71, 16).lines[15]"), /blocked/);
});

test("a recovered follow-up reopens aimed at the same agent", () => {
  const { parseAgents } = require("../lib/running");
  const followUp = { target: "w1:p2", title: "Fix the build", kind: "codex", cwd: "/work/web" };
  const ui = picker({ kind: "codex", prompt: "again", followUp, failed: true }, { runningList: parseAgents({ agents: LISTED }) });
  assert.equal(ui.evaluate("state.followUp.target"), "w1:p2");
  assert.match(ui.evaluate("state.notice"), /follow-up/);
  assert.match(ui.evaluate("mainBody(71, 16).lines[1]"), /Fix the build.*codex/);
});

test("a recovered follow-up does not reset the saved model or destination", () => {
  const prefs = { recents: ["claude"], destination: "right", directories: [], models: { codex: { model: "gpt-5.5", effort: "high" } } };
  const ui = picker(FAILED_FOLLOW_UP, { prefs, runningList: [] });
  assert.equal(ui.evaluate("state.followUp"), null, "its agent is gone, so this is a launch now");
  assert.equal(ui.evaluate("destination().id"), "right");
  assert.deepEqual({ ...ui.evaluate("choice()") }, { model: "gpt-5.5", effort: "high" });

  const launch = picker({ kind: "codex", prompt: "x", model: "gpt-6-sol", effort: null, destination: "down" }, { prefs });
  assert.equal(launch.evaluate("destination().id"), "down");
  assert.deepEqual({ ...launch.evaluate("choice()") }, { model: "gpt-6-sol", effort: null }, "a launch draft still brings its own");
});

test("esc out of a recovered follow-up takes its notice along", () => {
  const { parseAgents } = require("../lib/running");
  const ui = picker(FAILED_FOLLOW_UP, { runningList: parseAgents({ agents: LISTED }) });
  assert.match(ui.evaluate("state.notice"), /Recovered failed follow-up/);
  ui.evaluate("onEscape()");
  assert.equal(ui.evaluate("state.followUp"), null);
  assert.equal(ui.evaluate("state.notice"), null);
});

test("ctrl+u on a restored draft also drops the follow-up and preset it brought", () => {
  const { parseAgents } = require("../lib/running");
  const ui = picker(FAILED_FOLLOW_UP, { runningList: parseAgents({ agents: LISTED }) });
  ui.evaluate('onMainKey("", { ctrl: true, name: "u" })');
  assert.equal(ui.evaluate("state.followUp"), null);
  assert.equal(ui.evaluate("state.preset"), null);

  const chosen = picker(FAILED_FOLLOW_UP, { runningList: parseAgents({ agents: LISTED }) });
  chosen.evaluate("openRunning(); onRunningKey('\\r', {name: 'return'})");
  chosen.evaluate('onMainKey("", { ctrl: true, name: "u" })');
  assert.equal(chosen.evaluate("state.followUp.target"), "w2:p1", "a follow-up picked since is the user's, not the draft's");
});

test("a recovered follow-up whose agent has gone opens as a launch instead", () => {
  const { parseAgents } = require("../lib/running");
  const draft = { kind: "codex", prompt: "again", failed: true, destination: "follow-up",
    followUp: { target: "w1:p2", title: "Fix the build", kind: "codex", cwd: "/work/web" } };
  const replaced = parseAgents({ agents: [{ agent: "claude", agent_status: "idle", pane_id: "w1:p2" }] });
  for (const runningList of [[], replaced]) {
    const ui = picker(draft, { runningList });
    assert.equal(ui.evaluate("state.followUp"), null);
    assert.match(ui.evaluate("state.notice"), /Fix the build is no longer running · ⏎ launches a new codex/);
    assert.equal(ui.evaluate("agent().kind"), "codex");
  }
  const unknown = picker(draft, { runningList: null });
  assert.equal(unknown.evaluate("state.followUp.target"), "w1:p2", "kept when Herdr does not answer");
  unknown.evaluate("openRunning()");
  assert.match(unknown.evaluate("runningBody(71, 16).lines[1]"), /herdr did not answer/);
});

test("listing running agents is bounded and tells a silent Herdr from an empty list", () => {
  const calls = [];
  const list = (reply) => load("lib/running.js", {
    "./shared/herdr": { run: (args, options) => { calls.push(options); return reply; } },
  }).context.module.exports.runningAgents();
  assert.equal(list({ ok: false, message: "spawnSync herdr ETIMEDOUT" }), null);
  assert.deepEqual([...list({ ok: true, result: { agents: [] } })], []);
  assert.ok(calls.every((options) => options.timeout > 0));
});
