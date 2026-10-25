"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { after } = require("node:test");
const { Editor } = require("../../lib/shared/editor");

const ROOT = path.resolve(__dirname, "../..");
const PICKER = path.join(ROOT, "lib", "picker");

// Exercise entrypoint handlers without starting a terminal, agent, or server.
// The picker's own modules run in the same context as the file loaded, so the
// mocks reach them too, and `evaluate` sees everything they export.
function load(relative, mocks = {}, stop, env = {}, globals = {}) {
  const file = path.resolve(ROOT, relative);
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.dirname(file),
    process: { env: { QUICK_PROMPT_CWD: "/tmp", ...env }, stdout: { write() {} } },
    setImmediate() {},
    ...globals,
  });
  const resolved = (name, from) => (name.startsWith(".") ? path.resolve(path.dirname(from), name).replace(/\.js$/, "") : name);
  const mocked = new Map(Object.entries(mocks).map(([name, mock]) => [resolved(name, file), mock]));
  const modules = new Map();

  const requireFrom = (from) => {
    const realRequire = createRequire(from);
    return (name) => {
      const target = resolved(name, from);
      if (mocked.has(target)) return mocked.get(target);
      if (path.dirname(target) === PICKER) return run(`${target}.js`);
      return realRequire(name);
    };
  };
  const run = (target) => {
    if (!modules.has(target)) {
      const module = { exports: {} };
      modules.set(target, module);
      const wrapped = `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(target, "utf8")}\n})`;
      vm.runInContext(wrapped, context, { filename: target })(module.exports, requireFrom(target), module, target, path.dirname(target));
    }
    return modules.get(target).exports;
  };

  context.require = requireFrom(file);
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(stop ? source.slice(0, source.indexOf(stop)) : source, context);
  for (const module of modules.values()) Object.assign(context, module.exports);
  return { context, evaluate: (code) => vm.runInContext(code, context) };
}

// The picker short of booting. Quitting exits a process that is not there.
function loadPicker(mocks, env = {}) {
  const ui = load("bin/picker.js", mocks, "/* ---------- boot ---------- */", env);
  Object.assign(ui.context.process, { stdin: {}, exit() {} });
  ui.context.Editor = Editor;
  return ui;
}

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
  const source = fs.readFileSync(path.join(ROOT, "lib/state.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const STATE_DIR =")), state.context);
  return { dir, api: state.context.module.exports };
}

// The picker over a state directory of its own, starting from `draft` when
// given. `ui.state` reads and writes that directory as the picker does.
function picker(draft = null, {
  running = null, runningList = [], requests = [], recents = [], history = [], presets = [], dirs = {}, clipboard = async () => null,
  installed = ["claude", "codex", "copilot", "cursor", "gemini"], prefs = { recents },
  env = {}, scratchpad = { available: () => false, save: () => ({ ok: true, message: "" }) },
} = {}) {
  const { dir, api } = stateIn("qp-picker-");
  fs.writeFileSync(path.join(dir, "prefs.json"), JSON.stringify(prefs));
  if (history.length) fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify(history));
  if (draft) api.saveDraft(draft);
  const ui = loadPicker({
    "../lib/presets": {
      PRESETS: "/tmp/presets.json",
      readPresets: () => ({ presets, problems: [] }),
      composePrompt: require("../../lib/presets").composePrompt,
    },
    "../lib/agents": {
      catalog: () => ["amp", "claude", "codex", "copilot", "cursor", "gemini"]
        .map((kind) => ({ kind, installed: installed.includes(kind) })),
      cachedCatalog: () => null,
      runningAgent: async (pane) => (pane === "w1:p2" ? running : null),
    },
    "../lib/state": {
      ...api,
      writeRequest: (request) => {
        requests.push(request);
        return api.writeRequest(request);
      },
    },
    "../lib/running": { ...require("../../lib/running"), runningAgents: () => runningList },
    "../lib/shared/herdr": { spawnDetached: () => {}, notify: () => {} },
    "../lib/scratchpad": scratchpad,
    "../lib/dirs": {
      expand: (value) => value,
      isDirectory: (value) => ["/tmp/", "/tmp/child"].includes(value),
      complete: () => ["/tmp/child"],
      suggestions: () => [],
      ...dirs,
    },
    "../lib/worktree": { ...require("../../lib/worktree"), insideRepo: (dir) => dir === "/repo" },
    "../lib/shared/clipboard": { readClipboard: () => clipboard() },
  }, { ...(running ? { QUICK_PROMPT_DUPLICATE: "1", QUICK_PROMPT_PANE: "w1:p2" } : {}), ...env });
  return Object.assign(ui, { dir, state: api, drafts: () => api.readDraft()?.draft ?? null });
}

// What a launch in a new tab sends Herdr, with `agent start` timing out the way
// it did for most launches in the wild: Herdr never registers the agent's name,
// so anything asked by name comes back agent_not_found.
function timedOutLaunch(prompt, { kind = "claude", inline = true, promptFile = false, busyStarts = 0 } = {}) {
  const calls = [];
  const saved = [];
  const records = [];
  const notifications = [];
  const finished = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind, prompt }) },
    "../lib/state": {
      finishRequest: (_, success) => { finished.push(success); return !success; },
      writePromptFile: (text) => { saved.push(text); return "/state/prompts/prompt-1.md"; },
    },
    "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), note: (fields) => records.push(fields), finish: (...args) => records.push(args) }) },
    "../lib/agents": {
      supportsInlinePrompt: () => inline,
      readsPromptFile: () => promptFile,
      promptFileArgs: (_, file) => ["--add-dir=/state/prompts", `read ${file}`],
    },
    "../lib/shared/herdr": {
      HerdrError: Error,
      notify: (...args) => notifications.push(args),
      run: (args) => {
        calls.push(args);
        if (args[0] === "tab") return { ok: true, result: { tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } } };
        if (args[1] === "start") {
          if (busyStarts-- > 0) return { ok: false, code: "agent_pane_busy", message: "pane is not at a shell prompt" };
          return { ok: false, code: "timeout", message: "timed out waiting for the agent" };
        }
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
  const source = fs.readFileSync(path.join(ROOT, "bin/launch.js"), "utf8");
  launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
  return { calls, records, notifications, finished, saved };
}

// A launch to `destination` whose agent start gets `startReply`.
function failedLaunch(destination, startReply, { deliver = () => {} } = {}) {
  const calls = [];
  const notifications = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "gemini", prompt: "Fix the login bug", destination, cwd: "/repo", pane: "w1:p1" }) },
    "../lib/state": { finishRequest: () => {} },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => false },
    "../lib/worktree": { branchName: () => "fix-the-login-bug", uniqueBranch: (_, name) => name, worktreeBase: () => null },
    "../lib/shared/herdr": {
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
  const source = fs.readFileSync(path.join(ROOT, "bin/launch.js"), "utf8");
  launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
  return { closed: calls.filter((args) => args[1] === "close").map((args) => args.join(" ")), notifications };
}

// A worktree launch of `request` in a repository whose origin/HEAD is
// `originHead`, and where fix-the-login-bug is already taken.
function worktreeLaunch(request, { originHead = null, env = {} } = {}) {
  const calls = [];
  const worktree = load("lib/worktree.js", {
    "node:child_process": {
      spawnSync: (_, args) => {
        if (args.includes("symbolic-ref")) return { status: originHead ? 0 : 1, stdout: originHead ? `${originHead}\n` : "" };
        if (args.includes("rev-parse")) return { status: 0, stdout: `${args.at(-1).replace("^{commit}", "")}@commit\n` };
        return { status: args.at(-1) === "refs/heads/fix-the-login-bug" ? 0 : 1, stdout: "" };
      },
    },
  }, null, env).context.module.exports;
  const launcher = load("bin/launch.js", {
    "../lib/worktree": worktree,
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "claude", destination: "worktree", cwd: "/repo", ...request }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => true },
    "../lib/shared/herdr": {
      run: (args) => {
        calls.push(args);
        if (args[0] === "worktree") return { ok: true, result: { root_pane: { pane_id: "w2:p1" } } };
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.evaluate("waitInteractive = () => true; deliverPrompt = () => {}");
  assert.doesNotThrow(() => launcher.evaluate("main()"));
  return calls;
}

// The calls and notifications of a launch of `request` that goes through.
function launchOf(request) {
  const calls = [];
  const notifications = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify(request) },
    "../lib/state": { finishRequest: () => {} },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => true },
    "../lib/worktree": { branchName: () => "fix-it", uniqueBranch: (_, name) => name, worktreeBase: () => null },
    "../lib/shared/herdr": {
      HerdrError: Error,
      notify: (...args) => notifications.push(args),
      run: (args) => {
        calls.push(args);
        if (args[0] === "tab" || args[0] === "worktree") return { ok: true, result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p5" } } };
        if (args[0] === "pane") return { ok: true, result: { pane: { pane_id: "w1:p6" } } };
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.context.process.exit = () => {};
  const source = fs.readFileSync(path.join(ROOT, "bin/launch.js"), "utf8");
  launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
  return { calls, notifications };
}

// The draft files in a state directory with their contents, to see that none changed.
function draftsIn(dir) {
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => name.startsWith("draft-")).sort()
    .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
}

const LISTED = [
  { agent: "claude", agent_status: "working", pane_id: "w1:p1", cwd: "/work/api", terminal_title_stripped: "Refactor auth", state_change_seq: 9 },
  { agent: "codex", agent_status: "idle", pane_id: "w1:p2", cwd: "/work/web", terminal_title_stripped: "Fix the build", state_change_seq: 3 },
  { agent: "claude", agent_status: "blocked", pane_id: "w1:p3", cwd: "/work/api", terminal_title_stripped: "Trust dialog", state_change_seq: 12 },
  { agent: "gemini", agent_status: "done", pane_id: "w2:p1", foreground_cwd: "/work/docs/site", cwd: "/work/docs", terminal_title_stripped: "", state_change_seq: 7 },
  { agent: "pi", pane_id: "w2:p2", cwd: "/work/misc", state_change_seq: 1 },
  { agent: "claude", agent_status: "idle", cwd: "/nowhere" },
];

const FAILED_FOLLOW_UP = { kind: "codex", prompt: "again", failed: true, destination: "follow-up", preset: { name: "review", prefix: "Review:", postfix: "" },
  followUp: { target: "w1:p2", title: "Fix the build", kind: "codex", cwd: "/work/web" } };

module.exports = { load, loadPicker, picker, stateIn, scratch, timedOutLaunch, failedLaunch, worktreeLaunch, launchOf, draftsIn, LISTED, FAILED_FOLLOW_UP };
