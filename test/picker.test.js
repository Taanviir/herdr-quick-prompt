"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { load, loadPicker, picker, stateIn, LISTED } = require("./support/helpers");

test("ctrl+t offers a worktree only inside a git repository, and launch refuses one outside", () => {
  const requests = [];
  const ui = picker(null, { requests });
  const cycle = () => {
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      ui.evaluate("cycleDestination()");
      seen.push(ui.evaluate("destination().id"));
    }
    return seen;
  };
  assert.equal(cycle().includes("worktree"), false);
  ui.evaluate("state.cwd = '/repo'");
  assert.equal(cycle().includes("worktree"), true);
  ui.evaluate("state.destination = DESTINATIONS.findIndex((d) => d.id === 'worktree'); state.cwd = '/tmp'");
  ui.evaluate("launch()");
  assert.match(ui.evaluate("state.notice"), /git repository/);
  assert.equal(requests.length, 0, "nothing was launched");
});

test("the destination row shows the branch a worktree will get", () => {
  const ui = picker();
  const row = () => ui.evaluate("destinationRow(71)").replace(/\x1b\[[0-9;]*m/g, "");
  ui.evaluate("state.cwd = '/repo'; state.destination = DESTINATIONS.findIndex((d) => d.id === 'worktree')");
  assert.match(row(), /new worktree · random branch \(ctrl\+t\)/);
  ui.evaluate("state.prompt = new Editor('Fix the login bug')");
  assert.match(row(), /new worktree · fix-the-login-bug \(ctrl\+t\)/);
  ui.evaluate("state.prompt = new Editor(''); state.preset = { name: 'nightly', prefix: 'x', postfix: '', task: 'skip' }");
  assert.match(row(), /new worktree · nightly/);
});

test("an agent outside the first five remains selected and visible", () => {
  const ui = picker();
  ui.evaluate("state.agent = 5");
  assert.equal(ui.evaluate("chipAgents().includes(agent())"), true);
  assert.match(ui.evaluate("chipRow(40)"), /gemini/);
  assert.match(ui.evaluate("chipRow(71)"), /gemini/);
  ui.evaluate("cycleAgent(1); cycleAgent(-1)");
  assert.equal(ui.evaluate("agent().kind"), "gemini");
});

test("only installed agents get chips, and one that is not is marked and needs a second Enter", () => {
  const requests = [];
  const ui = picker(null, { installed: ["claude", "codex"], requests });
  const row = ui.evaluate("chipRow(71)").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(row, /1 claude +2 codex/);
  assert.doesNotMatch(row, /amp|copilot|cursor/, "no padding with agents that are not there");

  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'amp')");
  assert.match(ui.evaluate("chipRow(71)"), /amp ○/);
  ui.evaluate("state.prompt = new Editor('fix it'); onMainKey('\\r', {name: 'return'})");
  assert.match(ui.evaluate("state.notice"), /amp is not on PATH .* ctrl\+k/);
  assert.equal(requests.length, 0);
  ui.evaluate("onMainKey('', {name: 'left'}); onMainKey('\\r', {name: 'return'})");
  assert.equal(requests.length, 0, "only an Enter straight after the notice confirms it");
  ui.evaluate("onMainKey('\\r', {name: 'return'})");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "amp");
});

test("with nothing installed the chip row says so and points at ctrl+k", () => {
  const ui = picker(null, { installed: [] });
  assert.match(ui.evaluate("chipRow(71)"), /no agent found on PATH · ctrl\+k/);
});

test("the hint line suits the moment: ways to fill an empty prompt, ways to send a typed one", () => {
  const { displayWidth } = require("../lib/text");
  const { parseAgents } = require("../lib/running");
  const ui = picker(null, { runningList: parseAgents({ agents: LISTED }) });
  assert.equal(ui.evaluate("hints(71)"), "ctrl+p presets · ctrl+r follow up · ctrl+g keys");
  const withHistory = picker(null, { history: [{ text: "older" }] });
  assert.equal(withHistory.evaluate("hints(71)"), "↑ history · ctrl+p presets · ctrl+r follow up · ctrl+g keys");
  ui.evaluate("state.prompt = new Editor('fix it')");
  assert.equal(ui.evaluate("hints(71)"), "⏎ launch · ctrl+l launch & stay · \\⏎ newline · esc close");
  assert.equal(ui.evaluate("hints(30)"), "⏎ launch · esc close", "a narrow popup keeps the first and last");
  const scratchpad = { available: () => true, save: () => assert.fail("not saved") };
  const notes = picker(null, { scratchpad });
  notes.evaluate("state.prompt = new Editor('fix it')");
  assert.equal(notes.evaluate("hints(80)"), "⏎ launch · ctrl+l launch & stay · ctrl+s note · \\⏎ newline · esc close");
  assert.equal(notes.evaluate("hints(60)"), "⏎ launch · ctrl+l launch & stay · ctrl+s note · esc close", "the note outlasts the newline");
  const handedOver = picker(null, { scratchpad, env: { QUICK_PROMPT_TEXT: "from notes" } });
  assert.doesNotMatch(handedOver.evaluate("hints(80)"), /ctrl\+s/, "a handed-over prompt is a note already");
  ui.evaluate("openRunning(); onRunningKey('\\r', {name: 'return'})");
  assert.match(ui.evaluate("hints(71)"), /^⏎ send · ctrl\+r other agent .* esc back · ctrl\+g keys$/);
  for (const width of [40, 71]) {
    for (const line of [...ui.evaluate(`mainBody(${width}, 16)`).lines]) assert.ok(displayWidth(line) <= width);
  }
});

test("ctrl+g lists every key, and closes again", () => {
  const { displayWidth } = require("../lib/text");
  const ui = picker();
  ui.evaluate("onKey('\\x07', {ctrl: true, name: 'g'})");
  assert.equal(ui.evaluate("state.overlay.type"), "help");
  const text = ui.evaluate("helpBody(71, 16)").lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  for (const key of ["ctrl+l", "ctrl+s", "shift+⏎", "ctrl+k", "ctrl+t", "ctrl+d", "ctrl+o", "ctrl+p", "ctrl+x", "ctrl+r", "ctrl+v", "ctrl+u", "ctrl+y", "alt+1", "esc"]) {
    assert.ok(text.includes(key), key);
  }
  ui.evaluate("onKey('', {name: 'down'}); onKey('', {name: 'down'})");
  const narrow = [...ui.evaluate("helpBody(40, 16)").lines];
  assert.ok(narrow.every((line) => displayWidth(line) <= 40));
  assert.match(narrow[2], /new line/, "one column scrolls");
  ui.evaluate("onKey('\\x07', {ctrl: true, name: 'g'})");
  assert.equal(ui.evaluate("state.overlay"), null);
});

test("the rows around the prompt say where you are in history and what is scrolled away", () => {
  const ui = picker(null, { history: [{ text: Array.from({ length: 14 }, (_, n) => `line ${n + 1}`).join("\n") }, { text: "older" }] });
  const plain = () => [...ui.evaluate("mainBody(71, 16)").lines].map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(plain()[2], "");
  ui.evaluate("onMainKey(undefined, {name: 'up'})");
  assert.match(plain()[2], /history 1\/2 · ↑ 4 more$/);
  for (let i = 0; i < 13; i += 1) ui.evaluate("onMainKey(undefined, {name: 'up'})");
  assert.match(plain()[2], /^ +history 1\/2$/);
  assert.match(plain()[13], /─ ↓ 4 more ──$/);
  ui.evaluate("onMainKey(undefined, {name: 'up'})");
  assert.match(plain()[2], /history 2\/2$/);
});

test("the chip row says how many more agents ctrl+k has", () => {
  const ui = picker(null, { installed: ["claude", "codex"] });
  assert.match(ui.evaluate("chipRow(71)").replace(/\x1b\[[0-9;]*m/g, ""), /\+4 more · ctrl\+k$/);
});

test("up and down recall history only past the top and bottom of the prompt", () => {
  const ui = picker(null, { history: [{ text: "second\nline" }, { text: "first" }] });
  const press = (name) => ui.evaluate(`onMainKey(undefined, {name: '${name}'}); state.prompt.text`);

  ui.evaluate("state.prompt = new Editor('draft')");
  assert.equal(press("up"), "second\nline");
  assert.equal(press("up"), "second\nline", "a recalled multi-line prompt is walked line by line first");
  assert.equal(ui.evaluate("state.prompt.cursor"), 4);
  assert.equal(press("up"), "first");
  assert.equal(press("up"), "first");
  assert.equal(press("down"), "second\nline");
  assert.equal(press("down"), "draft", "walking past the newest entry gives back what was being typed");
  assert.equal(press("down"), "draft");

  ui.evaluate("state.prompt = new Editor('one\\ntwo')");
  assert.equal(press("up"), "one\ntwo", "up inside a multi-line draft still moves between its lines");
  assert.equal(ui.evaluate("state.prompt.cursor"), 3);
});

test("recalling a prompt brings back its agent, preset and model, and walking back restores yours", () => {
  const review = { name: "review", agent: null, prefix: "Review:", postfix: "", task: "ask" };
  const ui = picker(null, {
    presets: [review],
    history: [{ text: "check the diff", kind: "codex", preset: "review", model: { model: "gpt-5.5", effort: "high" } }],
  });
  ui.evaluate("state.agent = state.agents.findIndex((a) => a.kind === 'claude'); state.prompt = new Editor('mine')");
  ui.evaluate("onMainKey(undefined, {name: 'up'})");
  assert.equal(ui.evaluate("state.prompt.text"), "check the diff");
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.equal(ui.evaluate("state.preset.name"), "review");
  assert.deepEqual({ ...ui.evaluate("choice()") }, { model: "gpt-5.5", effort: "high" });
  assert.equal(ui.evaluate("state.history.position"), 1);
  ui.evaluate("onMainKey(undefined, {name: 'down'})");
  assert.equal(ui.evaluate("state.prompt.text"), "mine");
  assert.equal(ui.evaluate("agent().kind"), "claude");
  assert.equal(ui.evaluate("state.preset"), null);
  assert.equal(ui.evaluate("state.history.position"), null);
});

test("launching records the prompt in history", () => {
  const recorded = [];
  const ui = loadPicker({
    "../lib/agents": { cachedCatalog: () => null, catalog: () => [{ kind: "claude", installed: true }] },
    "../lib/state": {
      STATE_DIR: path.join(require("node:os").tmpdir(), "qp-unused"),
      readPrefs: () => ({ recents: [], directories: [] }),
      readHistory: () => [],
      recordPrompt: (prompt) => recorded.push(prompt),
      remember: () => {},
      writeRequest: () => "/tmp/request.json",
      readDraft: () => null,
      clearDraft: () => null,
      sweepStaleRequests: () => {},
    },
    "../lib/herdr": { spawnDetached: () => {}, notify: () => {} },
  });
  ui.evaluate("state.prompt = new Editor('fix the bug'); launch()");
  assert.deepEqual(recorded.map((entry) => ({ ...entry, model: { ...entry.model } })),
    [{ text: "fix the bug", kind: "claude", preset: null, model: { model: null, effort: null } }]);
});

test("modifier keys from Linux, Windows and macOS terminals edit by word", () => {
  const ui = picker();
  const keys = (list) => ui.evaluate(`state.prompt = new Editor('one two three'); ${list}; state.prompt`);
  const cursorAfter = (list) => keys(list).cursor;
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'left', ctrl: true})"), 8);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'left', meta: true})"), 8);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'b', meta: true})"), 8);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'home'}); onMainKey(undefined, {name: 'f', meta: true})"), 3);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'home'}); onMainKey(undefined, {name: 'right', ctrl: true})"), 3);
  assert.equal(keys("onMainKey(undefined, {name: 'backspace', meta: true})").text, "one two ");
  assert.equal(keys("onMainKey('\\b', {name: 'backspace'})").text, "one two ");
  assert.equal(keys("onMainKey(undefined, {name: 'home'}); onMainKey(undefined, {name: 'd', meta: true})").text, " two three");
  ui.evaluate("openDirectories(); state.overlay.input = new Editor('/tmp/a b')");
  ui.evaluate("onDirsKey(undefined, {name: 'backspace', meta: true})");
  assert.equal(ui.evaluate("state.overlay.input.text"), "/tmp/a ");
});

test("backslash-Enter, alt+Enter and ctrl+j add a newline while plain Enter launches", () => {
  const requests = [];
  const ui = picker(null, { requests });
  ui.evaluate("state.prompt = new Editor('first\\\\'); onMainKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first\n");
  ui.evaluate("onMainKey(undefined, {name: 'return', meta: true})");
  ui.evaluate("onMainKey('\\n', {name: 'enter'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first\n\n\n");
  assert.equal(requests.length, 0);
  ui.evaluate("onMainKey('\\r', {name: 'return'})");
  assert.equal(requests.length, 1);
});

test("a pasted drop lands in the prompt as its copy, and the directory field gets it as typed", (t) => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-drop-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = path.join(dir, "my photo.png");
  fs.writeFileSync(image, "pixels");
  const pasted = image.replace(/ /g, "\\ ");

  const ui = picker();
  ui.evaluate(`insertPasted(${JSON.stringify(pasted)})`);
  assert.equal(ui.evaluate("state.prompt.text"), path.join(ui.dir, "attachments", "my-photo.png"));

  ui.evaluate("openDirectories()");
  ui.evaluate(`insertPasted(${JSON.stringify(pasted)})`);
  assert.equal(ui.evaluate("state.overlay.input.text"), pasted);
});

test("a lone esc acts at once and is kept from readline, so the next key survives", () => {
  const ui = picker();
  ui.evaluate("onMainKey('\\x0b', {ctrl: true, name: 'k'})");
  assert.equal(ui.evaluate("state.overlay.type"), "agents");
  assert.equal(ui.context.onData(Buffer.from([0x1b])), true, "readline must not see the ESC");
  assert.equal(ui.evaluate("state.overlay"), null);
  assert.equal(ui.context.onData(Buffer.from("x")), false);
  assert.equal(ui.context.onData(Buffer.from("\x1b[A")), false, "an escape sequence still goes to readline");
});

test("opening the popup prunes old attachments and checks the agents once it has painted", async () => {
  const { dir, api } = stateIn("qp-boot-test-");
  const attachments = path.join(dir, "attachments");
  fs.mkdirSync(attachments);
  const old = path.join(attachments, "old.png");
  const fresh = path.join(attachments, "fresh.png");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(fresh, "x");
  const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, weekAgo, weekAgo);

  const mocks = {
    "../lib/state": api,
    "../lib/agents": {
      cachedCatalog: () => [{ kind: "claude", installed: true }],
      catalog: () => assert.fail("a usable cache is painted from"),
      refreshCatalog: async () => {
        refreshed += 1;
        return [{ kind: "claude", installed: true }, { kind: "codex", installed: true }];
      },
      runningAgent: async () => assert.fail("only the duplicate action asks for the running agent"),
    },
    "../lib/herdr": { spawnDetached() {}, notify() {} },
  };
  let refreshed = 0;
  const later = [];
  const painted = [];
  const tty = { isTTY: true, on() {}, setRawMode() {}, resume() {} };
  load("bin/picker.js", mocks, null, {}, {
    process: { env: { QUICK_PROMPT_CWD: "/tmp" }, stdin: tty, stdout: { write: (text) => painted.push(text), on() {} }, on() {} },
    setImmediate: (fn) => later.push(fn),
    Buffer,
  });
  assert.ok(painted.length > 0);
  assert.equal(fs.existsSync(old), true, "nothing slows the first paint");
  assert.equal(refreshed, 0);
  const frames = painted.length;
  later.splice(0).forEach((fn) => fn());
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(refreshed, 1);
  await new Promise((resolve) => setImmediate(resolve));
  later.splice(0).forEach((fn) => fn());
  assert.equal(painted.length, frames + 1, "a catalog that changed is repainted");
  assert.match(painted.at(-1), /codex/);
});

test("kitty protocol keys come back as the legacy bytes readline knows", () => {
  const { legacyKeys } = require("../lib/keys");
  assert.equal(legacyKeys("\x1b[13;2u"), "\n");
  assert.equal(legacyKeys("\x1b[13;5u"), "\n");
  assert.equal(legacyKeys("\x1b[13u"), "\r");
  assert.equal(legacyKeys("\x1b[99;5u"), "\x03");
  assert.equal(legacyKeys("\x1b[27u"), "\x1b");
  assert.equal(legacyKeys("\x1b[49;3u"), "\x1b1");
  assert.equal(legacyKeys("\x1b[127;5u"), "\b");
  assert.equal(legacyKeys("\x1b[9;2u"), "\x1b[Z");
  assert.equal(legacyKeys("a\x1b[1;5Db"), "a\x1b[1;5Db");
});

test("ctrl+v says it is pasting without freezing, and pastes at the cursor as it is then", async () => {
  let deliver;
  const ui = picker(null, { clipboard: () => new Promise((resolve) => { deliver = resolve; }) });
  ui.evaluate("state.prompt = new Editor('ab')");
  const pasted = ui.evaluate("onKey('\\x16', {ctrl: true, name: 'v'})");
  assert.equal(ui.evaluate("state.notice"), "pasting…");
  ui.evaluate("onKey('', {name: 'left'})");
  deliver("XY");
  await pasted;
  assert.equal(ui.evaluate("state.prompt.text"), "aXYb");
  assert.equal(ui.evaluate("state.notice"), null);
});

test("ctrl+s saves the prompt to Scratchpad from its directory and closes", () => {
  const saves = [];
  const scratchpad = { available: () => true, save: (text, where) => { saves.push({ text, ...where }); return { ok: true, message: "added a1b2c3" }; } };
  const ui = picker({ kind: "claude", prompt: "  look at the flaky test  ", cwd: "/repo" }, { scratchpad });
  assert.match(ui.evaluate("hints()"), /ctrl\+s note/);
  let quit = false;
  ui.context.process.exit = () => { quit = true; };
  ui.evaluate("onMainKey('\x13', { ctrl: true, name: 's' })");
  assert.deepEqual(saves, [{ text: "look at the flaky test", cwd: "/repo", pane: undefined }]);
  assert.equal(ui.drafts(), null, "the draft is gone once it is a note");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.state.readHistory()[0])), { text: "look at the flaky test", kind: "claude", preset: null, model: { model: null, effort: null } },
    "it is in history like a launch");
  assert.equal(quit, true);
});

test("ctrl+s explains itself when it cannot save, and keeps the prompt", () => {
  const failing = { available: () => true, save: () => ({ ok: false, message: "notes are locked" }) };
  const ui = picker(null, { scratchpad: failing });
  ui.evaluate("state.prompt.insert('keep me'); onMainKey('\x13', { ctrl: true, name: 's' })");
  assert.equal(ui.evaluate("state.notice"), "not saved: notes are locked");
  assert.equal(ui.evaluate("state.prompt.text"), "keep me");

  const missing = picker(null);
  assert.doesNotMatch(missing.evaluate("hints()"), /ctrl\+s/);
  missing.evaluate("state.prompt.insert('x'); onMainKey('\x13', { ctrl: true, name: 's' })");
  assert.match(missing.evaluate("state.notice"), /needs Scratchpad/);

  const handedOver = picker(null, { scratchpad: { available: () => true, save: () => assert.fail("saved a handoff") }, env: { QUICK_PROMPT_TEXT: "from notes" } });
  handedOver.evaluate("onMainKey('\x13', { ctrl: true, name: 's' })");
  assert.match(handedOver.evaluate("state.notice"), /already a note/);
});

test("duplicate selects the focused pane's agent and directory over recency and a draft", async () => {
  const ui = picker(null, { running: { kind: "codex", cwd: "/work/tree" }, recents: ["gemini"] });
  assert.equal(ui.evaluate("agent().kind"), "gemini", "the first paint does not wait for Herdr");
  await ui.evaluate("lookUpDuplicate()");
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.equal(ui.evaluate("state.cwd"), "/work/tree");

  const draft = { kind: "amp", prompt: "x", cwd: "/old" };
  const withDraft = picker(draft, { running: { kind: "cursor", cwd: "/work/tree" } });
  await withDraft.evaluate("lookUpDuplicate()");
  assert.equal(withDraft.evaluate("agent().kind"), "cursor");
  assert.equal(withDraft.evaluate("state.cwd"), "/work/tree");
  assert.equal(withDraft.evaluate("state.prompt.text"), "x", "the draft's prompt is still restored");

  const unknown = picker(null, { running: { kind: "someday", cwd: null }, recents: ["gemini"] });
  await unknown.evaluate("lookUpDuplicate()");
  assert.equal(unknown.evaluate("agent().kind"), "gemini", "a kind the catalog lacks falls back to recency");
  assert.equal(unknown.evaluate("state.cwd"), "/tmp");

  const empty = picker(null, { recents: ["gemini"] });
  await empty.evaluate("lookUpDuplicate()");
  assert.equal(empty.evaluate("agent().kind"), "gemini");
  assert.equal(empty.evaluate("state.notice"), "no agent here · starting from your last agent");

  const changed = picker(null, { running: { kind: "codex", cwd: "/work/tree" }, recents: ["gemini"] });
  const pending = changed.evaluate("lookUpDuplicate()");
  changed.evaluate("cycleAgent(1)");
  await pending;
  assert.equal(changed.evaluate("agent().kind"), "claude", "a choice made while Herdr answered stands");
  assert.equal(changed.evaluate("state.cwd"), "/tmp");
});

test("the popup paints from the cached catalog and repaints only if a fresh one differs", () => {
  const ui = picker(null, { installed: ["claude", "codex"], recents: ["codex"] });
  const same = ui.evaluate("state.agents").map((item) => ({ ...item }));
  assert.equal(ui.evaluate("useCatalog")(same), false);
  const fresh = [{ kind: "amp", installed: true }, ...same.map((item) => ({ ...item }))];
  assert.equal(ui.evaluate("useCatalog")(fresh), true);
  assert.equal(ui.evaluate("agent().kind"), "codex", "the selected agent stays selected");
  assert.match(ui.evaluate("chipRow(71)").replace(/\x1b\[[0-9;]*m/g, ""), /1 amp +2 claude +3 codex/);
});

test("a remembered worktree outside a repository opens on a new tab", () => {
  const prefs = { recents: [], destination: "worktree", directories: [], models: {} };
  assert.equal(picker(null, { prefs }).evaluate("destination().id"), "tab");
  const inRepo = picker({ kind: "claude", prompt: "x", destination: "worktree", cwd: "/repo" }, { prefs });
  assert.equal(inRepo.evaluate("destination().id"), "worktree", "a draft made in a repository keeps it");
});

test("ctrl+l launches without leaving the popup, ready for the next prompt", () => {
  const requests = [];
  const ui = picker(null, { requests });
  let quits = 0;
  ui.context.process.exit = () => { quits += 1; };
  ui.evaluate("state.prompt = new Editor('first job'); onMainKey('\\x0c', {ctrl: true, name: 'l'})");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stay, true);
  assert.equal(quits, 0);
  assert.equal(ui.evaluate("state.prompt.text"), "");
  assert.match(ui.evaluate("state.notice"), /claude is opening in a new tab/);
  ui.evaluate("onMainKey('', {name: 'up'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first job", "it is in history already");

  ui.evaluate("state.prompt = new Editor('second job'); onMainKey('\\r', {name: 'return'})");
  assert.equal(requests[1].stay, false);
  assert.equal(quits, 1);
});
