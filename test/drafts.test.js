"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { picker, stateIn, draftsIn } = require("./support/helpers");

test("a failed launch becomes a draft and a successful one leaves nothing", () => {
  const { dir, api } = stateIn("qp-recovery-test-");
  const request = { kind: "gemini", prompt: "recover this", cwd: "/tmp/", destination: "down" };
  const file = api.writeRequest(request);
  assert.equal(api.readDraft(), null, "in-flight launches must not be restored");
  api.finishRequest(file, false);
  assert.equal(fs.existsSync(file), false);
  const saved = api.readDraft().draft;
  assert.equal(saved.failed, true);
  const ui = picker(saved);
  assert.equal(ui.evaluate("state.prompt.text"), request.prompt);
  assert.equal(ui.evaluate("state.prompt.cursor"), request.prompt.length);
  assert.equal(ui.evaluate("agent().kind"), request.kind);
  assert.equal(ui.evaluate("destination().id"), request.destination);
  assert.equal(ui.evaluate("state.cwd"), request.cwd);
  assert.match(ui.evaluate("state.notice"), /Recovered failed launch/);
  assert.ok(ui.drafts(), "opening must not consume the draft");
  api.clearDraft(api.readDraft().file);
  const success = api.writeRequest(request);
  api.finishRequest(success, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("esc keeps a typed prompt as the draft, and an empty box forgets it", () => {
  const ui = picker();
  ui.evaluate("state.agent = 2; state.destination = 1; state.cwd = '/tmp/child'; state.prompt = new Editor('half a thought')");
  ui.evaluate('onMainKey("", { name: "escape" })');
  assert.deepEqual({ ...ui.drafts() }, { kind: "codex", model: null, effort: null, prompt: "half a thought", preset: null, followUp: null, destination: "right", cwd: "/tmp/child" });

  const reopened = picker(ui.drafts());
  reopened.evaluate("state.prompt = new Editor('  \\n')");
  reopened.evaluate("onEscape()");
  assert.equal(reopened.drafts(), null, "whitespace is not worth keeping, and the draft it opened goes");
});

test("a kept draft reopens where it left off and launching clears it", () => {
  const ui = picker({ kind: "codex", prompt: "carry on", destination: "workspace", cwd: "/tmp/child" });
  assert.equal(ui.evaluate("state.prompt.text"), "carry on");
  assert.equal(ui.evaluate("state.prompt.cursor"), "carry on".length);
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.equal(ui.evaluate("destination().id"), "workspace");
  assert.match(ui.evaluate("state.notice"), /^Restored draft/);

  ui.evaluate("launch()");
  assert.equal(ui.drafts(), null);
  assert.equal(fs.readdirSync(ui.dir).filter((name) => name.startsWith("request-")).length, 1,
    "the prompt is in the request before the draft goes");
});

test("a launch that fails while the popup is open is not cleared by it", () => {
  const failLaunch = (ui, prompt) => ui.state.finishRequest(ui.state.writeRequest({ kind: "claude", prompt }), false);

  const empty = picker();
  failLaunch(empty, "careful prompt");
  empty.evaluate("onEscape()");
  assert.equal(empty.drafts()?.prompt, "careful prompt", "an empty esc forgets only what it opened with");

  const launching = picker({ kind: "codex", prompt: "old draft" });
  failLaunch(launching, "failed meanwhile");
  launching.evaluate("launch()");
  assert.equal(launching.drafts()?.prompt, "failed meanwhile", "launching clears only the draft it opened with");

  const editing = picker({ kind: "codex", prompt: "old draft" });
  failLaunch(editing, "failed meanwhile");
  editing.evaluate("state.prompt = new Editor('old draft, edited'); onEscape()");
  const prompts = [];
  for (let next = editing.state.readDraft(); next; next = editing.state.readDraft()) {
    prompts.push(next.draft.prompt);
    editing.state.clearDraft(next.file);
  }
  assert.deepEqual(prompts.sort(), ["failed meanwhile", "old draft, edited"], "esc replaces the draft it opened, nothing else");
});

test("a crash in the popup keeps what was typed without clearing the draft it opened", () => {
  const ui = picker({ kind: "codex", prompt: "opened with" });
  ui.context.process.exit = () => {};
  ui.evaluate("state.prompt = new Editor('typed before the crash'); reportCrash(new Error('boom'))");
  assert.equal(ui.drafts().prompt, "typed before the crash");
  assert.match(fs.readFileSync(path.join(ui.dir, "crash.log"), "utf8"), /Error: boom/);

  const empty = picker({ kind: "codex", prompt: "opened with" });
  empty.context.process.exit = () => {};
  empty.evaluate("state.prompt = new Editor(''); reportCrash(new Error('boom'))");
  assert.equal(empty.drafts().prompt, "opened with", "an empty box at crash time is not a deliberate clear");
});

test("ctrl+y puts back what ctrl+u cleared, at the cursor", () => {
  const ui = picker();
  ui.evaluate("state.prompt = new Editor('fix the login bug'); onMainKey('', {ctrl: true, name: 'u'})");
  assert.equal(ui.evaluate("state.prompt.text"), "");
  ui.evaluate("onMainKey('', {ctrl: true, name: 'u'})");
  ui.evaluate("state.prompt = new Editor('please '); onMainKey('', {ctrl: true, name: 'y'})");
  assert.equal(ui.evaluate("state.prompt.text"), "please fix the login bug", "clearing an empty box keeps the earlier text");

  const restored = picker({ kind: "codex", prompt: "lost work" });
  restored.evaluate("onMainKey('', {ctrl: true, name: 'u'})");
  assert.match(restored.evaluate("state.notice"), /ctrl\+y brings it back/);
  restored.evaluate("onMainKey('', {ctrl: true, name: 'y'})");
  assert.equal(restored.evaluate("state.prompt.text"), "lost work");
});

test("clearing a restored draft throws it away instead of emptying the buffer", () => {
  const ui = picker({ kind: "codex", prompt: "lost work", failed: true });

  assert.equal(ui.evaluate("state.prompt.text"), "lost work");
  ui.evaluate('onMainKey("", { ctrl: true, name: "u" })');

  assert.equal(ui.evaluate("state.prompt.text"), "");
  assert.equal(ui.drafts(), null, "the notice offers ctrl+u as the way to be rid of it");
  assert.match(ui.evaluate("state.notice"), /discarded/);

  ui.state.saveDraft({ kind: "claude", prompt: "failed meanwhile", failed: true });
  ui.evaluate('onMainKey("", { ctrl: true, name: "u" })');
  assert.equal(ui.drafts()?.prompt, "failed meanwhile", "a second clear must not discard anything again");
});

test("a prompt handed over by another plugin fills the box and leaves the drafts alone", () => {
  const draft = { kind: "amp", prompt: "my own half-typed thing", cwd: "/old" };
  const handoff = { QUICK_PROMPT_TEXT: "From my scratchpad:\n- [a1] fix it", QUICK_PROMPT_SOURCE: "Scratchpad" };
  const requests = [];
  const ui = picker(draft, { requests, env: handoff });
  assert.equal(ui.evaluate("state.prompt.text"), "From my scratchpad:\n- [a1] fix it");
  assert.equal(ui.evaluate("state.cwd"), "/tmp", "the draft's directory is not restored either");
  assert.match(ui.evaluate("state.notice"), /^From Scratchpad/);
  assert.equal(ui.evaluate("state.draftFile"), null, "it does not hold the draft it would replace or clear");
  const before = draftsIn(ui.dir);

  ui.evaluate("close()");
  assert.deepEqual(draftsIn(ui.dir), before, "closing neither saves the handoff nor clears the draft");

  ui.evaluate("state.prompt = new Editor('')");
  ui.evaluate("close()");
  assert.deepEqual(draftsIn(ui.dir), before, "nor does closing it emptied");

  ui.evaluate("state.prompt = new Editor('From my scratchpad')");
  ui.evaluate("launch()");
  assert.equal(requests.at(-1).prompt, "From my scratchpad");
  assert.deepEqual({ ...ui.drafts() }, draft, "launching does not clear the draft");

  const followUp = picker(draft, { env: handoff });
  followUp.evaluate("state.followUp = { target: 'w1:p3', title: 'busy', kind: 'claude', cwd: '/tmp' }; sendFollowUp()");
  assert.deepEqual({ ...followUp.drafts() }, draft, "nor does following up with it");

  const [launched] = fs.readdirSync(ui.dir).filter((name) => name.startsWith("request-"));
  assert.equal(ui.state.finishRequest(path.join(ui.dir, launched), false), false);
  assert.deepEqual(draftsIn(ui.dir), before, "a failed launch of it does not become a draft");
  const abandoned = ui.state.writeRequest({ ...requests.at(-1) });
  fs.utimesSync(abandoned, new Date(0), new Date(0));
  ui.state.sweepStaleRequests();
  assert.deepEqual(draftsIn(ui.dir), before, "nor does one the sweep finds abandoned");

  const crashed = picker(draft, { env: handoff });
  crashed.context.process.exit = () => {};
  const atCrash = draftsIn(crashed.dir);
  crashed.evaluate("reportCrash(new Error('boom'))");
  assert.deepEqual(draftsIn(crashed.dir), atCrash, "nor does a crash keep it");
});

test("after a handed-over prompt launches and stays, the next one is yours", () => {
  const scratchpad = { available: () => true, save: () => ({ ok: true, message: "" }) };
  const ui = picker({ kind: "amp", prompt: "my own draft" }, { scratchpad, env: { QUICK_PROMPT_TEXT: "from notes" } });
  ui.evaluate("onMainKey('\\x0c', {ctrl: true, name: 'l'})");
  assert.equal(ui.evaluate("state.prompt.text"), "");
  ui.evaluate("state.prompt = new Editor('typed next')");
  assert.match(ui.evaluate("hints(80)"), /ctrl\+s note/);
  ui.evaluate("onEscape()");
  const drafts = fs.readdirSync(ui.dir).filter((name) => name.startsWith("draft-"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(ui.dir, name), "utf8")).prompt).sort();
  assert.deepEqual(drafts, ["my own draft", "typed next"], "kept beside the draft it never touched");
});
