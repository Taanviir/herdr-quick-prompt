"use strict";

// The strip across the top of every popup, so the three read as one: Prompt,
// Notes, Projects. Each tab is its own plugin's popup program.
//
// Switching never closes the popup. The first switch turns the process
// running in it into a host: it stops reading keys and painting, and runs the
// next tab's program in the same terminal, so that program's first frame
// lands on top of this one's last. A hosted program that switches again hands
// the request back to the host on file descriptor 3 and exits, and the host
// runs the next one. Closing a hosted program closes the popup.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { style, truncate, displayWidth } = require("./ui");
const { run, spawnDetached } = require("./herdr");

const TABS = [
  { id: "prompt", title: "Prompt", plugin: "taanviir.quick-prompt", entrypoint: "picker", prefix: "QUICK_PROMPT" },
  { id: "notes", title: "Notes", plugin: "taanviir.scratchpad", entrypoint: "popup", prefix: "SCRATCHPAD" },
  { id: "projects", title: "Projects", plugin: "taanviir.projects", entrypoint: "picker", prefix: "PROJECTS" },
];

const HOST_FD = 3;
const SWITCHER = path.join(__dirname, "switch.js");

// `right` is the popup's own summary, kept at the far end.
function strip(current, width, right = "") {
  const tabs = TABS.map((tab) => (tab.id === current ? style.accent(style.bold(tab.title)) : style.dim(tab.title))).join("   ");
  const hint = style.dim("alt+←→");
  const end = right ? `${right}  ${hint}` : hint;
  const gap = width - displayWidth(tabs) - displayWidth(end);
  return gap >= 2 ? `${tabs}${" ".repeat(gap)}${end}` : truncate(tabs, width);
}

// alt+← and alt+→ step through the tabs, wrapping round. Returns the tab to
// go to, or null when the key is not a switch.
function switchFor(key, current) {
  if (!key?.meta || (key.name !== "left" && key.name !== "right")) return null;
  const at = TABS.findIndex((tab) => tab.id === current);
  return TABS[(at + (key.name === "left" ? -1 : 1) + TABS.length) % TABS.length];
}

// Each plugin reads where it was opened from in its own variables.
function envFor(tab, { cwd, workspace, pane } = {}) {
  const env = { [`${tab.prefix}_CWD`]: cwd, [`${tab.prefix}_WORKSPACE`]: workspace, [`${tab.prefix}_PANE`]: pane };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

// How a tab's popup starts, from `herdr plugin list --json`: its command, run
// from its plugin's folder. Null when that plugin is not installed.
function program(tab, plugins) {
  const plugin = plugins.find((candidate) => candidate.plugin_id === tab.plugin && candidate.enabled !== false);
  const pane = plugin?.panes?.find((candidate) => candidate.id === tab.entrypoint);
  if (!plugin?.plugin_root || !pane?.command?.length) return null;
  const [command, ...args] = pane.command;
  return { command: command === "node" ? process.execPath : command, args, cwd: plugin.plugin_root };
}

// What Herdr would have given that popup: this one's variables, pointed at
// the other plugin's own folders.
function pluginEnv(tab, root, env = process.env) {
  const out = { ...env, HERDR_PLUGIN_ID: tab.plugin, HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_ENTRYPOINT_ID: tab.entrypoint };
  for (const name of ["HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR"]) {
    if (env[name]) out[name] = path.join(path.dirname(env[name]), tab.plugin);
  }
  return out;
}

function installed() {
  const res = run(["plugin", "list", "--json"], { check: false, timeout: 2000 });
  return res.ok ? res.result.plugins ?? [] : [];
}

// This process keeps the popup open from here on, and nothing else: its
// keys go to the program it runs, and anything still scheduled to paint
// would scribble over that program's screen.
function host(first) {
  process.stdin.removeAllListeners();
  process.stdin.pause();
  // pause() alone leaves Node reading the terminal into a buffer of its own,
  // and every key it wins is a key the program never sees.
  process.stdin._handle?.readStop?.();
  process.stdout.removeAllListeners("resize");
  process.stdout.write = () => true;
  const plugins = installed();

  const runTab = (request) => {
    const tab = TABS.find((candidate) => candidate.id === request.id);
    const started = tab && program(tab, plugins);
    if (!started) {
      // Not installed where Herdr can say: close and open it the old way.
      spawnDetached(process.execPath, [SWITCHER, JSON.stringify(request)]);
      process.exit(0);
    }
    const env = { ...pluginEnv(tab, started.cwd), ...envFor(tab, request), HERDR_TABS_HOSTED: "1" };
    const child = spawn(started.command, started.args, { cwd: started.cwd, env, stdio: ["inherit", "inherit", "inherit", "pipe"] });
    let said = "";
    child.stdio[HOST_FD].on("data", (chunk) => {
      said += chunk;
    });
    child.on("error", () => process.exit(1));
    child.on("exit", (code) => {
      const line = said.trim().split("\n").pop();
      if (line) {
        try {
          return runTab(JSON.parse(line));
        } catch { /* not a request: the program closed */ }
      }
      process.exit(code ?? 0);
    });
  };
  runTab(first);
}

// `where` is { cwd, workspace, pane }, as far as the popup knows them.
// `leave` keeps what the popup must not lose, such as a draft, and runs first.
function switchTo(tab, where, leave = () => {}) {
  leave();
  const request = { id: tab.id, ...where };
  if (process.env.HERDR_TABS_HOSTED) {
    fs.writeSync(HOST_FD, `${JSON.stringify(request)}\n`);
    process.exit(0);
  }
  host(request);
}

module.exports = { TABS, strip, switchFor, switchTo, envFor, program, pluginEnv };
