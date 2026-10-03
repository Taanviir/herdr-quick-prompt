"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test, after } = require("node:test");

// Exercise entrypoint handlers without starting a terminal, agent, or server.
function load(relative, mocks = {}, stop, env = {}) {
  const file = path.resolve(__dirname, "..", relative);
  const realRequire = createRequire(file);
  const context = vm.createContext({
    require: (name) => mocks[name] ?? realRequire(name),
    module: { exports: {} },
    __dirname: path.dirname(file),
    process: { env: { QUICK_PROMPT_CWD: "/tmp", ...env }, stdout: { write() {} } },
    setImmediate() {},
  });
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(stop ? source.slice(0, source.indexOf(stop)) : source, context);
  return { context, evaluate: (code) => vm.runInContext(code, context) };
}

test("structured readiness errors preserve their code and do not restart an agent", () => {
  const wrapper = load("lib/herdr.js", {
    "node:child_process": {
      spawnSync: () => ({ status: 1, stderr: JSON.stringify({
        error: { code: "agent_not_ready", message: "Agent needs attention" },
      }) }),
    },
  });
  const result = wrapper.context.module.exports.run(["agent", "start"], { check: false });
  assert.equal(result.code, "agent_not_ready");
  assert.equal(result.message, "Agent needs attention");
  let calls = 0;
  const launcher = load("bin/launch.js", {
    "../lib/herdr": { run: () => { calls++; return result; } },
  }, "try {\n  main();");
  const started = launcher.evaluate('startAgent("qp-test", "test", "pane", [])');
  assert.equal(started.started, true);
  assert.equal(started.ready, false);
  assert.equal(calls, 1);
});

// What a launch in a new tab sends Herdr, with `agent start` timing out the way
// it did for most launches in the wild: Herdr never registers the agent's name,
// so anything asked by name comes back agent_not_found.
function timedOutLaunch(prompt, { kind = "claude", inline = true } = {}) {
  const calls = [];
  const records = [];
  const notifications = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind, prompt }) },
    "../lib/state": { finishRequest: () => {} },
    "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), note: (fields) => records.push(fields), finish: (...args) => records.push(args) }) },
    "../lib/agents": { supportsInlinePrompt: () => inline },
    "../lib/herdr": {
      HerdrError: Error,
      notify: (...args) => notifications.push(args),
      run: (args) => {
        calls.push(args);
        if (args[0] === "tab") return { ok: true, result: { tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } } };
        if (args[1] === "start") return { ok: false, code: "timeout", message: "timed out waiting for the agent" };
        if (args[0] === "agent" && ["wait", "get", "prompt", "read"].includes(args[1]) && args[2] !== "w9:p1") {
          return { ok: false, code: "agent_not_found", message: `agent ${args[2]} not found` };
        }
        if (args[1] === "get") return { ok: true, result: { agent: { interactive_ready: true, agent_status: "working" } } };
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.context.process.exit = () => {};
  launcher.evaluate("sleep = () => {}");
  const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
  launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
  return { calls, records, notifications };
}

test("an agent start that times out is a slow agent, and it is followed by its pane", () => {
  const { calls, records, notifications } = timedOutLaunch("one\ntwo");
  const starts = calls.filter((args) => args[1] === "start");
  assert.equal(starts.length, 1, "a timeout is not retried into agent_pane_busy");
  assert.equal(starts[0][starts[0].indexOf("--timeout") + 1], "15000");
  const followed = calls.filter((args) => args[0] === "agent" && ["wait", "get", "prompt"].includes(args[1]));
  assert.ok(followed.length >= 3);
  assert.ok(followed.every((args) => args[2] === "w9:p1"), "never by a name Herdr may not have registered");
  assert.deepEqual(notifications, []);
  assert.deepEqual([...records.at(-1)], [true]);
  assert.deepEqual({ ...records[0] }, { inline: false });
});

test("an inline prompt gets a short start timeout, and a timeout there means it is at work", () => {
  const { calls, records, notifications } = timedOutLaunch("fix the login bug");
  const starts = calls.filter((args) => args[1] === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0][starts[0].indexOf("--timeout") + 1], "3000");
  assert.equal(starts[0].at(-1), "fix the login bug");
  assert.equal(calls.some((args) => args[1] === "prompt"), false, "nothing is typed on top of it");
  assert.deepEqual(notifications, []);
  assert.deepEqual({ ...records[0] }, { inline: true });
});

test("a prompt starting with a dash is typed in rather than handed to the CLI as an option", () => {
  const { calls } = timedOutLaunch("--help me with the build");
  const starts = calls.filter((args) => args[1] === "start");
  assert.equal(starts[0].includes("--help me with the build"), false);
  assert.ok(calls.some((args) => args[1] === "prompt" && args[3] === "--help me with the build"));
});

// A launch to `destination` whose agent start gets `startReply`.
function failedLaunch(destination, startReply, { deliver = () => {} } = {}) {
  const calls = [];
  const notifications = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "gemini", prompt: "Fix the login bug", destination, cwd: "/repo", pane: "w1:p1" }) },
    "../lib/state": { finishRequest: () => {} },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => false },
    "../lib/worktree": { branchName: () => "fix-the-login-bug", uniqueBranch: (_, name) => name },
    "../lib/herdr": {
      HerdrError: Error,
      notify: (...args) => notifications.push(args),
      run: (args) => {
        calls.push(args);
        if (args[0] === "tab") return { ok: true, result: { tab: { tab_id: "w1:t7" }, root_pane: { pane_id: "w1:p8" } } };
        if (args[0] === "workspace") return { ok: true, result: { workspace: { workspace_id: "w5" }, tab: { tab_id: "w5:t1" }, root_pane: { pane_id: "w5:p1" } } };
        if (args[0] === "worktree") return { ok: true, result: { workspace: { workspace_id: "w6" }, root_pane: { pane_id: "w6:p1" } } };
        if (args[0] === "pane" && args[1] === "split") return { ok: true, result: { pane: { pane_id: "w1:p9" } } };
        if (args[1] === "start") return startReply;
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.context.process.exit = () => {};
  launcher.evaluate("sleep = () => {}; waitInteractive = () => true");
  launcher.context.deliverPrompt = deliver;
  const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
  launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
  return { closed: calls.filter((args) => args[1] === "close").map((args) => args.join(" ")), notifications };
}

test("a launch whose agent never starts closes the tab, split or workspace it made", () => {
  const refused = { ok: false, code: "agent_exited", message: "gemini exited" };
  assert.deepEqual(failedLaunch("tab", refused).closed, ["tab close w1:t7"]);
  assert.deepEqual(failedLaunch("right", refused).closed, ["pane close w1:p9"]);
  assert.deepEqual(failedLaunch("workspace", refused).closed, ["workspace close w5"]);
});

test("a failed worktree launch keeps the worktree and names its branch", () => {
  const { closed, notifications } = failedLaunch("worktree", { ok: false, code: "agent_exited", message: "gemini exited" });
  assert.deepEqual(closed, []);
  assert.match(notifications[0][1], /gemini exited \(branch fix-the-login-bug is kept\)/);
});

test("an agent that started is left running when its prompt does not land", () => {
  const { closed, notifications } = failedLaunch("tab", { ok: true, result: {} }, {
    deliver: () => { throw new Error("gemini did not accept the prompt"); },
  });
  assert.deepEqual(closed, [], "the user may be looking at it");
  assert.match(notifications[0][1], /did not accept the prompt/);
});

test("a failed launch records why in startup.jsonl, without the prompt or the agent's title", () => {
  const records = [];
  const followUp = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "codex", prompt: "PRIVATE PROMPT", followUp: { target: "w1:p2", title: "PRIVATE TITLE" } }) },
    "../lib/state": { finishRequest: () => {} },
    "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), note() {}, finish: (...args) => records.push(args) }) },
    "../lib/herdr": { HerdrError: Error, notify: () => {}, run: () => ({ ok: false, code: "agent_blocked", message: "agent is blocked" }) },
  }, "try {\n  main();");
  followUp.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  followUp.context.process.exit = () => {};
  const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
  followUp.evaluate(source.slice(source.indexOf("try {\n  main();")));
  assert.equal(records[0][0], false);
  assert.match(records[0][1], /agent is blocked/);
  assert.doesNotMatch(records[0][1], /PRIVATE/);
});

// Temporary directories, removed once every test has run.
const scratch = [];
after(() => scratch.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// The real lib/state.js, keeping its files in a temporary directory.
function stateIn(prefix) {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), prefix));
  scratch.push(dir);
  const state = load("lib/state.js", {}, "const STATE_DIR =");
  state.context.process.env.HERDR_PLUGIN_STATE_DIR = dir;
  state.context.process.pid = process.pid;
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/state.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const STATE_DIR =")), state.context);
  return { dir, api: state.context.module.exports };
}

// The picker over a state directory of its own, starting from `draft` when
// given. `ui.state` reads and writes that directory as the picker does.
function picker(draft = null, {
  running = null, runningList = [], requests = [], recents = [], history = [], presets = [], dirs = {},
  installed = ["claude", "codex", "copilot", "cursor", "gemini"], prefs = { recents },
  env = {}, scratchpad = { available: () => false, save: () => ({ ok: true, message: "" }) },
} = {}) {
  const { dir, api } = stateIn("qp-picker-");
  fs.writeFileSync(path.join(dir, "prefs.json"), JSON.stringify(prefs));
  if (history.length) fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify(history));
  if (draft) api.saveDraft(draft);
  const ui = load("bin/picker.js", {
    "../lib/presets": {
      PRESETS: "/tmp/presets.json",
      readPresets: () => ({ presets, problems: [] }),
      composePrompt: require("../lib/presets").composePrompt,
    },
    "../lib/agents": {
      catalog: () => ["amp", "claude", "codex", "copilot", "cursor", "gemini"]
        .map((kind) => ({ kind, installed: installed.includes(kind) })),
      runningAgent: (pane) => (pane === "w1:p2" ? running : null),
    },
    "../lib/state": {
      ...api,
      writeRequest: (request) => {
        requests.push(request);
        return api.writeRequest(request);
      },
    },
    "../lib/running": { ...require("../lib/running"), runningAgents: () => runningList },
    "../lib/herdr": { spawnDetached: () => {}, notify: () => {} },
    "../lib/scratchpad": scratchpad,
    "../lib/dirs": {
      expand: (value) => value,
      isDirectory: (value) => ["/tmp/", "/tmp/child"].includes(value),
      complete: () => ["/tmp/child"],
      suggestions: () => [],
      ...dirs,
    },
    "../lib/worktree": { insideRepo: (dir) => dir === "/repo" },
  }, "/* ---------- boot ---------- */", { ...(running ? { QUICK_PROMPT_DUPLICATE: "1", QUICK_PROMPT_PANE: "w1:p2" } : {}), ...env });
  ui.evaluate("quit = () => {}");
  return Object.assign(ui, { dir, state: api, drafts: () => api.readDraft()?.draft ?? null });
}

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

test("the worktree destination branches from the prompt and starts the agent in its pane", () => {
  const calls = [];
  const worktree = load("lib/worktree.js", {
    "node:child_process": {
      // fix-the-login-bug already exists, so the launch takes the next name.
      spawnSync: (_, args) => ({ status: args.at(-1) === "refs/heads/fix-the-login-bug" ? 0 : 1, stdout: "" }),
    },
  }).context.module.exports;
  const launcher = load("bin/launch.js", {
    "../lib/worktree": worktree,
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "claude", prompt: "Fix the login bug", destination: "worktree", cwd: "/repo" }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => true },
    "../lib/herdr": {
      run: (args) => {
        calls.push(args);
        if (args[0] === "worktree") return { ok: true, result: { root_pane: { pane_id: "w2:p1" } } };
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  assert.doesNotThrow(() => launcher.evaluate("main()"));
  const created = calls.find((args) => args[0] === "worktree");
  assert.equal(created.join(" "), "worktree create --cwd /repo --branch fix-the-login-bug-2 --label fix-the-login-bug-2 --focus");
  const started = calls.find((args) => args[1] === "start");
  assert.equal(started[started.indexOf("--pane") + 1], "w2:p1");
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

  ui.evaluate("state.agent = agents.findIndex((a) => a.kind === 'amp')");
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

test("a preset's agent that is not installed is marked in the list", () => {
  const ui = picker(null, { presets: [{ name: "spike", agent: "amp", prefix: "x", postfix: "", task: "ask" }] });
  ui.evaluate("openPresets()");
  assert.match(ui.evaluate("presetsBody(71, 16).lines[1]"), /amp ○/);
});

test("directory viewport follows the cursor through a long Unicode path", () => {
  const { Editor } = require("../lib/editor");
  const { displayWidth } = require("../lib/text");
  const editor = new Editor("/projects/" + "界".repeat(40) + "/tail");
  let view = editor.viewport(20);
  assert.ok(view.text.endsWith("/tail"));
  assert.ok(displayWidth(view.text) <= 20);
  assert.ok(view.col < 20);
  editor.move(-editor.cursor);
  view = editor.viewport(20);
  assert.ok(view.text.startsWith("/projects/"));
  assert.equal(view.col, 0);
  const ui = picker();
  ui.evaluate("openDirectories(); state.overlay.input = new Editor('/projects/' + 'x'.repeat(100) + '/tail')");
  assert.match(ui.evaluate("dirsBody(71, 16).lines[1]"), /\/tail/);
});

test("vertical navigation keeps a preferred column through short and wrapped lines", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("abcdef\nx\nabcdef");
  editor.moveVertical(-1, 20);
  assert.equal(editor.cursor, 8);
  editor.moveVertical(-1, 20);
  assert.equal(editor.cursor, 6);
  editor.moveVertical(1, 20);
  editor.moveVertical(1, 20);
  assert.equal(editor.cursor, editor.cells.length);
  const wrapped = new Editor("abcdefghij");
  wrapped.moveVertical(-1, 4);
  assert.equal(wrapped.cursor, 6);
  wrapped.moveVertical(-1, 4);
  assert.equal(wrapped.cursor, 2);
  wrapped.moveVertical(1, 4);
  assert.equal(wrapped.cursor, 6);
  const wide = new Editor("界界\na");
  wide.moveVertical(-1, 20);
  assert.equal(wide.cursor, 0);
  const ui = picker();
  ui.evaluate("state.prompt = new Editor('one\\ntwo'); onMainKey('', {name: 'up'})");
  assert.equal(ui.evaluate("state.prompt.cursor"), 3);
});

test("state files are replaced whole, never rewritten in place", (t) => {
  const { dir, api } = stateIn("qp-atomic-test-");
  api.recordPrompt("first");
  const file = path.join(dir, "history.json");
  const before = fs.statSync(file).ino;
  api.recordPrompt("second");
  assert.notEqual(fs.statSync(file).ino, before, "a reader holding the old file still sees all of it");
  api.writeRequest({ kind: "codex", prompt: "x" });
  api.remember("codex", "tab", "/tmp", null);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

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

test("a multiline prompt is typed in, since Herdr refuses newlines in launch arguments", () => {
  const starts = [];
  const delivered = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "claude", prompt: "one\ntwo" }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => true },
    "../lib/herdr": {
      run: (args) => {
        if (args[0] === "tab") return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
        if (args[1] === "start") starts.push(args);
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.evaluate("waitInteractive = () => true");
  launcher.context.deliverPrompt = (_, __, prompt) => delivered.push(prompt);
  assert.doesNotThrow(() => launcher.evaluate("main()"));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].includes("--"), false);
  assert.deepEqual(delivered, ["one\ntwo"]);
});

test("a typed-in prompt waits for the agent to start on it, and only a stall is sent again", () => {
  const deliver = (replies) => {
    const calls = [];
    const slept = [];
    const launcher = load("bin/launch.js", {
      "../lib/herdr": {
        HerdrError: Error,
        run: (args) => {
          calls.push(args);
          return replies.shift() ?? { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.sleep = (ms) => slept.push(ms);
    let error = null;
    try {
      launcher.evaluate('deliverPrompt("w1:p1", "gemini", "fix it")');
    } catch (caught) {
      error = caught;
    }
    return { calls, slept, error };
  };

  const landed = deliver([]);
  assert.equal(landed.error, null);
  assert.deepEqual(landed.calls.map((args) => args.join(" ")),
    ["agent prompt w1:p1 fix it --wait --until working --until blocked --timeout 6000"]);
  assert.ok(landed.slept.reduce((a, b) => a + b, 0) <= 300, "one short settle, not fixed waits around the prompt");

  const stalled = { ok: false, code: "agent_prompt_stalled", message: "agent never started working" };
  const retried = deliver([stalled]);
  assert.equal(retried.error, null);
  assert.equal(retried.calls.length, 2);

  assert.match(deliver([stalled, stalled, stalled]).error.message, /gemini did not accept the prompt/);
  const refused = deliver([{ ok: false, code: "agent_blocked", message: "agent is blocked" }]);
  assert.match(refused.error.message, /could not send the prompt to gemini: agent is blocked/);
  assert.equal(refused.calls.length, 1);
});

test("a launch argument Herdr cannot encode is not retried", () => {
  let calls = 0;
  const launcher = load("bin/launch.js", {
    "../lib/herdr": {
      run: () => {
        calls++;
        return { ok: false, code: "invalid_agent_argument", message: "agent arguments cannot be encoded safely for the target shell" };
      },
    },
  }, "try {\n  main();");
  launcher.evaluate("sleep = () => {}");
  const started = launcher.evaluate('startAgent("qp-claude", "claude", "pane", ["do the thing"])');
  assert.equal(started.started, false);
  assert.equal(calls, 1);
});

test("launcher finalizes recovery correctly on success, startup failure, and delivery failure", () => {
  for (const scenario of ["success", "target-failure", "start-failure", "wait-failure", "delivery-failure"]) {
    const finished = [];
    const notifications = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "test", prompt: "keep me" }) },
      "../lib/state": { finishRequest: (file, success) => finished.push({ file, success }), logCrash: () => {} },
      "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), note() {}, finish() {} }) },
      "../lib/agents": { supportsInlinePrompt: () => scenario === "success" },
      "../lib/herdr": {
        HerdrError: Error,
        notify: (...args) => notifications.push(args),
        run: (args) => {
          if (args[0] === "tab") {
            if (scenario === "target-failure") throw new Error("Could not create tab");
            return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
          }
          if (args[1] === "start" && scenario === "start-failure") return { ok: false, message: "permission denied" };
          if (args[1] === "start" && scenario === "wait-failure") return { ok: false, code: "agent_not_ready", message: "Needs attention" };
          if (args[1] === "wait") return { ok: false, message: "timeout" };
          return { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    launcher.evaluate("waitInteractive = () => true; deliverPrompt = () => { throw new Error(\"test did not accept the prompt\") }");
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
    assert.equal(finished.length, 1, scenario);
    assert.equal(finished[0].success, scenario === "success", scenario);
    if (scenario !== "success") assert.match(notifications.at(-1)[1], /recover your draft/, scenario);
  }
});

test("startup timings record stages without prompt text", () => {
  const writes = [];
  const timing = load("lib/timing.js", {
    "./state": { appendLog: (name, text) => writes.push(text) },
  }).context.module.exports;
  const trace = timing.createTiming({ kind: "codex", prompt: "PRIVATE PROMPT", submittedAt: Date.now() - 20 });
  const result = { ok: false, code: "pane_not_ready", message: "PRIVATE ERROR" };
  assert.equal(trace.measure("agent start", () => result), result);
  assert.throws(() => trace.measure("tab create", () => { throw new Error("PRIVATE EXCEPTION"); }));
  trace.note({ inline: true });
  trace.finish(false, "agent did not start");
  const saved = JSON.parse(writes[0]);
  assert.equal(saved.inline, true);
  assert.equal(saved.error, "agent did not start");
  assert.equal(saved.steps[0].code, "pane_not_ready");
  assert.equal(saved.steps[1].ok, false);
  assert.ok(saved.dispatchMs >= 0);
  assert.ok(saved.workerMs >= 0);
  assert.equal(writes[0].includes("PRIVATE"), false);
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

test("the worker logs a bug to crash.log, and leaves Herdr refusing to startup.jsonl", () => {
  for (const [label, fail, logged] of [
    ["bug", () => { throw new TypeError("cannot read properties of undefined"); }, true],
    ["refusal", () => ({ ok: false, code: "agent_exited", message: "gemini exited" }), false],
  ]) {
    const crashes = [];
    class HerdrError extends Error {}
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "gemini", prompt: "x" }) },
      "../lib/state": { finishRequest: () => {}, logCrash: (error) => crashes.push(error) },
      "../lib/timing": { createTiming: () => null },
      "../lib/agents": { supportsInlinePrompt: () => false },
      "../lib/herdr": {
        HerdrError,
        notify: () => {},
        run: (args) => {
          if (args[0] === "tab") return { ok: true, result: { tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } } };
          if (args[1] === "start") return fail();
          return { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
    assert.equal(crashes.length, logged ? 1 : 0, label);
  }
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

test("directory suggestions only check the remembered directories, not every neighbour", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-dirs-"));
  scratch.push(root);
  for (const name of ["here", "other", "third", ".hidden"]) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, "file.txt"), "");
  const statted = [];
  const realFs = require("node:fs");
  const dirs = load("lib/dirs.js", {
    "node:fs": { ...realFs, statSync: (target) => { statted.push(target); return realFs.statSync(target); } },
  }).context.module.exports;
  const here = path.join(root, "here");
  const gone = path.join(root, "gone");
  assert.deepEqual([...dirs.suggestions(here, [gone, path.join(root, "third")])],
    [here, path.join(root, "third"), path.join(root, "other")]);
  assert.deepEqual(statted, [here, gone, path.join(root, "third")]);
});

test("setup detects both TOML quote styles and treats punctuation literally", () => {
  for (const key of ["prefix+shift+c", "prefix+.", "prefix+["]) {
    for (const quote of ['"', "'"]) {
      const setup = load("bin/setup.js", {
        "node:fs": { existsSync: () => true, readFileSync: () => "" },
        "node:child_process": { spawnSync: () => ({ stdout: "Config: /tmp/mock.toml" }) },
      }, "const key =");
      setup.context.process.env.QUICK_PROMPT_KEY = key;
      const source = fs.readFileSync(path.resolve(__dirname, "../bin/setup.js"), "utf8");
      vm.runInContext(source.slice(source.indexOf("const key ="), source.indexOf("if (existing.test(config))")), setup.context);
      const binding = `key = ${quote}${key}${quote}`;
      assert.equal(setup.evaluate(`existing.test(${JSON.stringify(binding)})`), true);
      if (key.endsWith(".")) {
        assert.equal(setup.evaluate('existing.test("key = \\\"prefix+x\\\"")'), false);
      }
    }
  }
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

  assert.deepEqual([...api.readHistory()], []);
  api.recordPrompt("first");
  api.recordPrompt("  second\n");
  api.recordPrompt("   ");
  api.recordPrompt("");
  assert.deepEqual([...api.readHistory()], ["second", "first"], "trimmed, and blank launches are not kept");

  api.recordPrompt("first");
  assert.deepEqual([...api.readHistory()], ["first", "second"], "a repeat moves to the front instead of appearing twice");

  for (let n = 0; n < 60; n += 1) api.recordPrompt(`prompt ${n}`);
  const history = api.readHistory();
  assert.equal(history.length, 50);
  assert.equal(history[0], "prompt 59");
  assert.equal(history[49], "prompt 10");

  fs.writeFileSync(path.join(dir, "history.json"), "{ not json");
  assert.deepEqual([...api.readHistory()], [], "a damaged history must not prevent opening the picker");
});

test("history walks back to the oldest entry and forward to the draft it set aside", () => {
  const { History } = require("../lib/history");
  const history = new History(["newest", "older"]);
  assert.equal(history.newer(), null, "nothing is newer than the draft");
  assert.equal(history.older("draft"), "newest");
  assert.equal(history.older("newest"), "older");
  assert.equal(history.older("older"), null, "the oldest entry is the end");
  assert.equal(history.newer(), "newest");
  assert.equal(history.newer(), "draft");
  assert.equal(history.newer(), null);
  assert.equal(new History([]).older("draft"), null);
});

test("up and down recall history only past the top and bottom of the prompt", () => {
  const ui = picker(null, { history: ["second\nline", "first"] });
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

test("launching records the prompt in history", () => {
  const recorded = [];
  const ui = load("bin/picker.js", {
    "../lib/agents": { catalog: () => [{ kind: "claude", installed: true }] },
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
  }, "/* ---------- boot ---------- */");
  ui.evaluate("quit = () => {}; state.prompt = new Editor('fix the bug'); launch()");
  assert.deepEqual(recorded, ["fix the bug"]);
});

test("a paste far larger than the call stack lands whole, at the cursor", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("ab");
  editor.move(-1);
  editor.insert("x".repeat(500000));
  assert.equal(editor.text.length, 500002);
  assert.equal(editor.text.at(-1), "b");
  assert.equal(editor.cursor, 500001);
});

test("word motion and deletion stop at whitespace from either side", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("fix  the bug");
  editor.wordLeft();
  assert.equal(editor.cursor, 9);
  editor.wordLeft();
  assert.equal(editor.cursor, 5);
  editor.wordRight();
  assert.equal(editor.cursor, 8);
  editor.deleteWordForward();
  assert.equal(editor.text, "fix  the");
  editor.deleteWord();
  assert.equal(editor.text, "fix  ");
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
  const ui = picker();
  ui.evaluate("launched = 0; launch = () => { launched += 1 }");
  ui.evaluate("state.prompt = new Editor('first\\\\'); onMainKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first\n");
  ui.evaluate("onMainKey(undefined, {name: 'return', meta: true})");
  ui.evaluate("onMainKey('\\n', {name: 'enter'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first\n\n\n");
  assert.equal(ui.evaluate("launched"), 0);
  ui.evaluate("onMainKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("launched"), 1);
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

test("opening the popup prunes old attachments once it has painted", () => {
  const { dir, api } = stateIn("qp-boot-test-");
  const attachments = path.join(dir, "attachments");
  fs.mkdirSync(attachments);
  const old = path.join(attachments, "old.png");
  const fresh = path.join(attachments, "fresh.png");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(fresh, "x");
  const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, weekAgo, weekAgo);

  const file = path.resolve(__dirname, "../bin/picker.js");
  const realRequire = createRequire(file);
  const mocks = {
    "../lib/state": api,
    "../lib/agents": { catalog: () => [{ kind: "claude", installed: true }], runningAgent: () => null },
    "../lib/herdr": { spawnDetached() {}, notify() {} },
  };
  const later = [];
  const painted = [];
  const tty = { isTTY: true, on() {}, setRawMode() {}, resume() {} };
  const context = vm.createContext({
    require: (name) => mocks[name] ?? realRequire(name),
    module: { exports: {} },
    __dirname: path.dirname(file),
    process: { env: { QUICK_PROMPT_CWD: "/tmp" }, stdin: tty, stdout: { write: (text) => painted.push(text), on() {} }, on() {} },
    setImmediate: (fn) => later.push(fn),
    Buffer,
  });
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  assert.ok(painted.length > 0);
  assert.equal(fs.existsSync(old), true, "nothing slows the first paint");
  later.forEach((fn) => fn());
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
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

test("model and effort become the CLI's own flags, and unknown choices none", () => {
  const { modelArgs } = require("../lib/models");
  assert.deepEqual(modelArgs("claude", { model: "opus", effort: "high" }), ["--model", "opus", "--effort", "high"]);
  assert.deepEqual(modelArgs("claude", { model: null, effort: "max" }), ["--effort", "max"]);
  assert.deepEqual(modelArgs("codex", { model: "gpt-6-sol", effort: "ultra" }),
    ["-m", "gpt-6-sol", "-c", "model_reasoning_effort=ultra"]);
  assert.deepEqual(modelArgs("codex", { model: "gpt-5.5", effort: "ultra" }), ["-m", "gpt-5.5"],
    "an effort the model does not take is dropped");
  assert.deepEqual(modelArgs("claude", { model: "retired-model", effort: "high" }), ["--effort", "high"]);
  assert.deepEqual(modelArgs("claude", null), []);
  assert.deepEqual(modelArgs("gemini", { model: "opus", effort: "high" }), []);
});

test("model flags go ahead of the inline prompt and survive falling back to typing it", () => {
  for (const prompt of ["one line", "one\ntwo"]) {
    const starts = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "codex", prompt, model: "gpt-5.5", effort: "low" }) },
      "../lib/timing": { createTiming: () => null },
      "../lib/agents": { supportsInlinePrompt: () => true },
      "../lib/herdr": {
        run: (args) => {
          if (args[0] === "tab") return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
          if (args[1] === "start") {
            starts.push([...args.slice(args.indexOf("--") + 1)]);
            if (starts.length === 1 && prompt === "one line") return { ok: false, message: "unexpected argument" };
          }
          return { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.evaluate("waitInteractive = () => true; deliverPrompt = () => {}");
    assert.doesNotThrow(() => launcher.evaluate("main()"));
    const flags = ["-m", "gpt-5.5", "-c", "model_reasoning_effort=low"];
    if (prompt === "one line") assert.deepEqual(starts, [[...flags, prompt], flags]);
    else assert.deepEqual(starts, [flags]);
  }
});

test("ctrl+o picks a model and effort for the selected agent only", () => {
  const { displayWidth } = require("../lib/text");
  const ui = picker();
  ui.evaluate("state.agent = agents.findIndex((a) => a.kind === 'codex')");
  assert.match(ui.evaluate("destinationRow(71)"), /default model/);
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

  ui.evaluate("state.agent = agents.findIndex((a) => a.kind === 'claude')");
  assert.match(ui.evaluate("destinationRow(71)"), /default model/, "each kind keeps its own choice");
  ui.evaluate("state.agent = agents.findIndex((a) => a.kind === 'gemini'); onMainKey('\\x0f', {ctrl: true, name: 'o'})");
  assert.equal(ui.evaluate("state.overlay"), null);
  assert.match(ui.evaluate("state.notice"), /no model choice for gemini/);
  assert.doesNotMatch(ui.evaluate("destinationRow(71)"), /model/);
});

test("a preset selects its agent, shows itself, and comes off when picked again or with ctrl+x", () => {
  const review = { name: "review", agent: "codex", prefix: "Review:", postfix: "", task: "ask" };
  const ui = picker(null, { presets: [review, { name: "plain", agent: null, prefix: "", postfix: "", task: "ask" }] });
  ui.evaluate("launched = 0; launch = () => { launched += 1 }");
  ui.evaluate("onMainKey('', {ctrl: true, name: 'p'}); onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.match(ui.evaluate("mainBody(71, 16).lines[2]"), /preset.*review/);
  assert.equal(ui.evaluate("launched"), 0, "an ask preset waits for the prompt");
  ui.evaluate("onMainKey('', {ctrl: true, name: 'p'}); onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.preset"), null);
  ui.evaluate("onMainKey('', {ctrl: true, name: 'p'}); onPresetsKey('l', {name: 'l'}); onPresetsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.preset.name"), "plain");
  ui.evaluate("onMainKey('', {ctrl: true, name: 'x'})");
  assert.equal(ui.evaluate("state.preset"), null);
  assert.equal(ui.evaluate("mainBody(71, 16).lines[2]"), "");
});

test("a skip preset launches over an empty prompt but not over a typed one", () => {
  const skip = { name: "tests", agent: "claude", prefix: "Run the tests.", postfix: "", task: "skip" };
  const ui = picker(null, { presets: [skip] });
  ui.evaluate("launched = 0; launch = () => { launched += 1 }");
  ui.evaluate("state.prompt = new Editor('only the auth ones'); applyPreset(presets[0])");
  assert.equal(ui.evaluate("launched"), 0);
  ui.evaluate("state.preset = null; state.prompt = new Editor(''); applyPreset(presets[0])");
  assert.equal(ui.evaluate("launched"), 1);
});

test("in a follow-up a preset only wraps the text: it neither switches agent nor sends", () => {
  const { parseAgents } = require("../lib/running");
  const requests = [];
  const skip = { name: "tests", agent: "claude", prefix: "Run the tests.", postfix: "", task: "skip" };
  const ui = picker(null, { presets: [skip], requests, runningList: parseAgents({ agents: LISTED }) });
  ui.evaluate("state.agent = agents.findIndex((a) => a.kind === 'codex')");
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

test("the launcher sends the preset's prefix and postfix around the typed prompt", () => {
  const delivered = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({
      kind: "gemini", prompt: "the auth module", preset: { name: "review", prefix: "Review:", postfix: "Be brief." },
    }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => false },
    "../lib/herdr": {
      run: (args) => args[0] === "tab"
        ? { ok: true, result: { root_pane: { pane_id: "test-pane" } } }
        : { ok: true, result: {} },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.evaluate("waitInteractive = () => true");
  launcher.context.deliverPrompt = (_, __, prompt) => delivered.push(prompt);
  assert.doesNotThrow(() => launcher.evaluate("main()"));
  assert.deepEqual(delivered, ["Review:\n\nthe auth module\n\nBe brief."]);
});

test("the agent in a pane is matched by pane id and reports its foreground directory", () => {
  const { agentInPane } = require("../lib/agents");
  const list = [
    { agent: "claude", pane_id: "w1:p1", cwd: "/repo", foreground_cwd: "/repo/worktree", focused: true },
    { agent: "codex", pane_id: "w1:p2", cwd: "/other" },
    { pane_id: "w1:p3", cwd: "/no-agent" },
  ];
  assert.deepEqual(agentInPane(list, "w1:p1"), { kind: "claude", cwd: "/repo/worktree" });
  assert.deepEqual(agentInPane(list, "w1:p2"), { kind: "codex", cwd: "/other" }, "falls back to the pane's cwd");
  assert.equal(agentInPane(list, "w1:p3"), null, "a pane without an agent kind is no match");
  assert.equal(agentInPane(list, "w9:p9"), null, "focus elsewhere is not a match");
  assert.equal(agentInPane(list, undefined), null);
  assert.equal(agentInPane(undefined, "w1:p1"), null);
});

test("the popup's own calls to herdr and git are bounded", () => {
  const options = [];
  const spawnSync = (_, args, opts) => { options.push(opts); return { status: null, stdout: "", error: new Error("ETIMEDOUT") }; };
  const agents = load("lib/agents.js", { "node:child_process": { spawnSync }, "./herdr": { BIN: "herdr", run() {} } }).context.module.exports;
  assert.ok(agents.kinds().includes("claude"), "a silent herdr leaves the built-in list");
  const worktree = load("lib/worktree.js", { "node:child_process": { spawnSync } }).context.module.exports;
  assert.equal(worktree.insideRepo("/repo"), false);
  assert.equal(options.length, 2);
  assert.ok(options.every((opts) => opts.timeout > 0));
});

test("looking up the running agent is bounded and gives up quietly", () => {
  const calls = [];
  const lookup = (reply) => load("lib/agents.js", {
    "./herdr": { BIN: "herdr", run: (args, options) => { calls.push({ args, options }); return reply; } },
  }).context.module.exports.runningAgent;

  const found = lookup({ ok: true, result: { agents: [{ agent: "pi", pane_id: "w1:p2", foreground_cwd: "/src" }] } });
  assert.deepEqual({ ...found("w1:p2") }, { kind: "pi", cwd: "/src" });
  assert.deepEqual([...calls[0].args], ["agent", "list"]);
  assert.ok(calls[0].options.timeout > 0, "a hung Herdr must not hold the popup open");

  assert.equal(lookup({ ok: false, message: "spawnSync herdr ETIMEDOUT" })("w1:p2"), null);
  assert.equal(lookup({ ok: true, result: {} })("w1:p2"), null);
  calls.length = 0;
  assert.equal(lookup({ ok: true, result: {} })(undefined), null);
  assert.equal(calls.length, 0, "no origin pane means nothing to ask");
});

// The draft files in a state directory with their contents, to see that none changed.
function draftsIn(dir) {
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => name.startsWith("draft-")).sort()
    .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
}

test("a prompt handed over by another plugin fills the box and leaves the drafts alone", () => {
  const draft = { kind: "amp", prompt: "my own half-typed thing", cwd: "/old" };
  const handoff = { QUICK_PROMPT_TEXT: "From my scratchpad:\n- [a1] fix it", QUICK_PROMPT_SOURCE: "Scratchpad" };
  const requests = [];
  const ui = picker(draft, { requests, env: handoff });
  assert.equal(ui.evaluate("state.prompt.text"), "From my scratchpad:\n- [a1] fix it");
  assert.equal(ui.evaluate("state.cwd"), "/tmp", "the draft's directory is not restored either");
  assert.match(ui.evaluate("state.notice"), /^From Scratchpad/);
  assert.equal(ui.evaluate("draftFile"), null, "it does not hold the draft it would replace or clear");
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

test("ctrl+s saves the prompt to Scratchpad from its directory and closes", () => {
  const saves = [];
  const scratchpad = { available: () => true, save: (text, where) => { saves.push({ text, ...where }); return { ok: true, message: "added a1b2c3" }; } };
  const ui = picker({ kind: "claude", prompt: "  look at the flaky test  ", cwd: "/repo" }, { scratchpad });
  assert.match(ui.evaluate("hints()"), /ctrl\+s note/);
  let quit = false;
  ui.context.quitHook = () => { quit = true; };
  ui.evaluate("quit = () => quitHook(); onMainKey('\x13', { ctrl: true, name: 's' })");
  assert.deepEqual(saves, [{ text: "look at the flaky test", cwd: "/repo", pane: undefined }]);
  assert.equal(ui.drafts(), null, "the draft is gone once it is a note");
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

test("duplicate selects the focused pane's agent and directory over recency and a draft", () => {
  const ui = picker(null, { running: { kind: "codex", cwd: "/work/tree" }, recents: ["gemini"] });
  assert.equal(ui.evaluate("agent().kind"), "codex");
  assert.equal(ui.evaluate("state.cwd"), "/work/tree");

  const draft = { kind: "amp", prompt: "x", cwd: "/old" };
  const withDraft = picker(draft, { running: { kind: "cursor", cwd: "/work/tree" } });
  assert.equal(withDraft.evaluate("agent().kind"), "cursor");
  assert.equal(withDraft.evaluate("state.cwd"), "/work/tree");
  assert.equal(withDraft.evaluate("state.prompt.text"), "x", "the draft's prompt is still restored");

  const unknown = picker(null, { running: { kind: "someday", cwd: null }, recents: ["gemini"] });
  assert.equal(unknown.evaluate("agent().kind"), "gemini", "a kind the catalog lacks falls back to recency");
  assert.equal(unknown.evaluate("state.cwd"), "/tmp");

  assert.equal(picker(null, { recents: ["gemini"] }).evaluate("agent().kind"), "gemini");
});

const LISTED = [
  { agent: "claude", agent_status: "working", pane_id: "w1:p1", cwd: "/work/api", terminal_title_stripped: "Refactor auth", state_change_seq: 9 },
  { agent: "codex", agent_status: "idle", pane_id: "w1:p2", cwd: "/work/web", terminal_title_stripped: "Fix the build", state_change_seq: 3 },
  { agent: "claude", agent_status: "blocked", pane_id: "w1:p3", cwd: "/work/api", terminal_title_stripped: "Trust dialog", state_change_seq: 12 },
  { agent: "gemini", agent_status: "done", pane_id: "w2:p1", foreground_cwd: "/work/docs/site", cwd: "/work/docs", terminal_title_stripped: "", state_change_seq: 7 },
  { agent: "pi", pane_id: "w2:p2", cwd: "/work/misc", state_change_seq: 1 },
  { agent: "claude", agent_status: "idle", cwd: "/nowhere" },
];

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
  ui.evaluate("quit = () => {}");

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

const FAILED_FOLLOW_UP = { kind: "codex", prompt: "again", failed: true, destination: "follow-up", preset: { name: "review", prefix: "Review:", postfix: "" },
  followUp: { target: "w1:p2", title: "Fix the build", kind: "codex", cwd: "/work/web" } };

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
    "./herdr": { run: (args, options) => { calls.push(options); return reply; } },
  }).context.module.exports.runningAgents();
  assert.equal(list({ ok: false, message: "spawnSync herdr ETIMEDOUT" }), null);
  assert.deepEqual([...list({ ok: true, result: { agents: [] } })], []);
  assert.ok(calls.every((options) => options.timeout > 0));
});

test("the worker sends a follow-up to the running agent without starting anything", () => {
  for (const ok of [true, false]) {
    const calls = [];
    const finished = [];
    const notifications = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({
        kind: "codex", prompt: "one\ntwo", destination: "follow-up",
        followUp: { target: "w1:p2", title: "Fix the build", kind: "codex", cwd: "/work/web" },
      }) },
      "../lib/state": { finishRequest: (file, success) => finished.push(success) },
      "../lib/timing": { createTiming: () => null },
      "../lib/herdr": {
        HerdrError: Error,
        notify: (...args) => notifications.push(args),
        run: (args) => {
          calls.push(args);
          return ok ? { ok: true, result: {} } : { ok: false, code: "agent_blocked", message: "agent is blocked" };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));

    assert.equal(calls.length, 1, "no tab, no agent start, no list");
    assert.deepEqual([...calls[0].slice(0, 4)], ["agent", "prompt", "w1:p2", "one\ntwo"]);
    assert.ok(calls[0].includes("--wait"));
    assert.deepEqual(finished, [ok]);
    if (!ok) assert.match(notifications[0][1], /Fix the build.*agent is blocked.*recover your draft/);
  }
});
