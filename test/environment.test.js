"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { load, scratch } = require("./support/helpers");

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
  const written = [];
  const agents = load("lib/agents.js", {
    "node:child_process": { spawnSync },
    "./herdr": { BIN: "/usr/bin/herdr", runAsync() {} },
    "./executables": { pathDirs: () => [], executablesOnPath: () => new Set() },
    "./state": { readCache: () => null, writeCache: (...args) => written.push(args) },
  }).context.module.exports;
  assert.ok(agents.catalog().some((item) => item.kind === "claude"), "a silent herdr leaves the built-in list");
  assert.deepEqual(written, [], "and that list is not kept for the next popup");
  const worktree = load("lib/worktree.js", { "node:child_process": { spawnSync } }).context.module.exports;
  assert.equal(worktree.insideRepo("/repo"), false);
  assert.equal(options.length, 2);
  assert.ok(options.every((opts) => opts.timeout > 0));
});

test("the agent catalog is kept until Herdr or PATH changes, and a fresh look replaces it", async () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-catalog-"));
  scratch.push(root);
  const bin = path.join(root, "herdr");
  const tools = path.join(root, "bin");
  fs.mkdirSync(tools);
  fs.writeFileSync(bin, "v1");
  fs.writeFileSync(path.join(tools, "codex"), "");
  const help = "--kind <KIND>  [possible values: claude, codex, gemini]";
  const cache = {};
  let spawned = 0;
  const open = (PATH) => load("lib/agents.js", {
    "./executables": load("lib/executables.js", {}, null, { PATH }).context.module.exports,
    "./herdr": { BIN: bin, runAsync() {} },
    "./state": { readCache: (name) => cache[name] ?? null, writeCache: (name, value) => { cache[name] = JSON.parse(JSON.stringify(value)); } },
    "node:child_process": {
      spawnSync: () => { spawned += 1; return { status: 0, stdout: help }; },
      execFile: (_, __, ___, done) => { spawned += 1; done(null, help); },
    },
  }, null, { PATH }).context.module.exports;
  const PATH = `${tools}:${tools}:/nonexistent`;
  const installed = (items) => [...items].filter((item) => item.installed).map((item) => item.kind);

  assert.equal(open(PATH).cachedCatalog(), null, "nothing to paint from on the first run");
  assert.deepEqual(installed(open(PATH).catalog()), ["codex"]);
  assert.deepEqual(installed(open(PATH).cachedCatalog()), ["codex"]);

  spawned = 0;
  open(PATH).cachedCatalog();
  assert.equal(spawned, 0, "a cache hit asks Herdr nothing");
  assert.equal(open(`${tools}:/elsewhere`).cachedCatalog(), null, "PATH changed");
  fs.writeFileSync(bin, "version two");
  assert.equal(open(PATH).cachedCatalog(), null, "Herdr was replaced");

  fs.writeFileSync(path.join(tools, "gemini"), "");
  const agents = open(PATH);
  assert.deepEqual(installed(await agents.refreshCatalog()), ["codex", "gemini"]);
  assert.deepEqual(installed(agents.cachedCatalog()), ["codex", "gemini"], "the fresh look is kept for next time");
});

test("PATH is swept once per directory however often it repeats", () => {
  const read = [];
  const executables = load("lib/executables.js", {
    "node:fs": { readdirSync: (dir) => { read.push(dir); return dir === "/w" ? ["powershell.exe", "wsl.exe"] : ["codex"]; } },
  }, null, { PATH: "/a:/w:/a::/w" }).context.module.exports;
  assert.equal(executables.onPath("codex"), null, "unknown before a sweep");
  const found = executables.executablesOnPath();
  assert.deepEqual(read, ["/a", "/w"]);
  assert.deepEqual([...found].sort(), ["codex", "powershell", "wsl"]);
  assert.equal(executables.onPath("powershell.exe"), true);
  assert.equal(executables.onPath("xclip"), false);
});

test("Scratchpad is found from the catalog's PATH sweep, or by its one name before there is one", () => {
  const looked = [];
  const scratchpadWith = (onPath) => load("lib/scratchpad.js", {
    "./executables": { pathDirs: () => ["/a", "/b"], onPath: () => onPath },
    "node:fs": { existsSync: (file) => { looked.push(file); return file === path.join("/b", "scratch"); } },
  }).context.module.exports;
  assert.equal(scratchpadWith(false).available(), false);
  assert.equal(scratchpadWith(true).available(), true);
  assert.deepEqual(looked, [], "a sweep already knows");
  assert.equal(scratchpadWith(null).available(), true);
  assert.deepEqual(looked, [path.join("/a", "scratch"), path.join("/b", "scratch")]);
});

test("ctrl+v tries the reader that worked last, Windows' first under bare WSL, and none not on PATH", async () => {
  const cache = {};
  const tried = [];
  const clipboard = (PATH, env, working) => load("lib/clipboard.js", {
    "./executables": { onPath: (command) => (PATH ? PATH.includes(command) : null) },
    "./state": { readCache: (name) => cache[name] ?? null, writeCache: (name, value) => { cache[name] = value; } },
    "node:child_process": {
      execFile: (command, _, __, done) => {
        tried.push(command);
        if (command === working) done(null, "copied\r\n");
        else done(Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }));
        return { stdin: { end() {} } };
      },
    },
  }, null, env).context.module.exports;
  const order = (PATH, env, remembered) => [...clipboard(PATH, env).readers(env, remembered)].map((reader) => reader.command);

  const desktop = { WAYLAND_DISPLAY: "wayland-0" };
  const wsl = { WSL_DISTRO_NAME: "Ubuntu" };
  assert.deepEqual(order(null, desktop), ["wl-paste", "xclip", "xsel", "pbpaste", "powershell.exe"]);
  assert.deepEqual(order(null, wsl)[0], "powershell.exe");
  assert.deepEqual(order(null, { ...wsl, DISPLAY: ":0" })[0], "wl-paste", "WSLg has a clipboard of its own");
  assert.deepEqual(order(["xclip", "powershell.exe"], desktop), ["xclip", "powershell.exe"]);
  assert.deepEqual(order(null, desktop, "xsel")[0], "xsel");

  const reader = clipboard(null, desktop, "powershell.exe");
  assert.equal(await reader.readClipboard(), "copied");
  assert.deepEqual(tried, ["wl-paste", "xclip", "xsel", "pbpaste", "powershell.exe"]);
  assert.deepEqual({ ...cache.clipboard }, { command: "powershell.exe" });
  tried.length = 0;
  assert.equal(await clipboard(null, desktop, "powershell.exe").readClipboard(), "copied");
  assert.deepEqual(tried, ["powershell.exe"], "the next popup goes straight to it");
  tried.length = 0;
  assert.equal(await clipboard([], desktop, "xclip").readClipboard(), null);
  assert.deepEqual(tried, [], "nothing on PATH, nothing spawned");
});

test("looking up the running agent is bounded and gives up quietly", async () => {
  const calls = [];
  const lookup = (reply) => load("lib/agents.js", {
    "./herdr": { BIN: "herdr", runAsync: async (args, options) => { calls.push({ args, options }); return reply; } },
  }).context.module.exports.runningAgent;

  const found = await lookup({ ok: true, result: { agents: [{ agent: "pi", pane_id: "w1:p2", foreground_cwd: "/src" }] } })("w1:p2");
  assert.deepEqual({ ...found }, { kind: "pi", cwd: "/src" });
  assert.deepEqual([...calls[0].args], ["agent", "list"]);
  assert.ok(calls[0].options.timeout > 0, "a hung Herdr must not hold the popup open");

  assert.equal(await lookup({ ok: false, message: "herdr ETIMEDOUT" })("w1:p2"), null);
  assert.equal(await lookup({ ok: true, result: {} })("w1:p2"), null);
  calls.length = 0;
  assert.equal(await lookup({ ok: true, result: {} })(undefined), null);
  assert.equal(calls.length, 0, "no origin pane means nothing to ask");
});
