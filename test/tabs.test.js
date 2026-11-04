"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { scratch } = require("./support/helpers");
const { TABS, switchFor, program, pluginEnv, envFor } = require("../lib/shared/tabs");

const tab = (id) => TABS.find((candidate) => candidate.id === id);

test("alt+← and alt+→ step through the tabs and wrap; nothing else switches", () => {
  assert.equal(switchFor({ name: "right", meta: true }, "prompt").id, "notes");
  assert.equal(switchFor({ name: "left", meta: true }, "prompt").id, "projects");
  assert.equal(switchFor({ name: "right", meta: true }, "projects").id, "prompt");
  assert.equal(switchFor({ name: "right", ctrl: true }, "prompt"), null);
  assert.equal(switchFor({ name: "right" }, "prompt"), null);
});

test("a tab's program comes from Herdr's plugin list, and gets its own plugin's folders", () => {
  const plugins = [
    { plugin_id: "taanviir.scratchpad", plugin_root: "/plugins/sp", enabled: true, panes: [{ id: "popup", command: ["node", "bin/popup.js"] }] },
    { plugin_id: "taanviir.projects", plugin_root: "/plugins/pj", enabled: false, panes: [{ id: "picker", command: ["node", "bin/picker.js"] }] },
  ];
  assert.deepEqual(program(tab("notes"), plugins), { command: process.execPath, args: ["bin/popup.js"], cwd: "/plugins/sp" });
  assert.equal(program(tab("projects"), plugins), null, "a disabled plugin is not run");
  assert.equal(program(tab("prompt"), plugins), null, "nor one that is not installed");

  const env = pluginEnv(tab("notes"), "/plugins/sp", { HERDR_PLUGIN_STATE_DIR: "/state/taanviir.projects", HERDR_PLUGIN_CONFIG_DIR: "/config/taanviir.projects", KEEP: "1" });
  assert.equal(env.HERDR_PLUGIN_STATE_DIR, "/state/taanviir.scratchpad");
  assert.equal(env.HERDR_PLUGIN_CONFIG_DIR, "/config/taanviir.scratchpad");
  assert.equal(env.HERDR_PLUGIN_ROOT, "/plugins/sp");
  assert.equal(env.KEEP, "1");
  assert.deepEqual(envFor(tab("notes"), { cwd: "/repo", pane: "w1:p2" }), { SCRATCHPAD_CWD: "/repo", SCRATCHPAD_PANE: "w1:p2" });
});

test("switching runs the next tab in the same process tree, and the last one closing ends it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-tabs-"));
  scratch.push(dir);
  const log = path.join(dir, "log");
  const tabsModule = path.resolve(__dirname, "../lib/shared/tabs.js");
  // Notes switches on to Projects through the host; Projects just closes.
  fs.mkdirSync(path.join(dir, "sp"));
  fs.mkdirSync(path.join(dir, "pj"));
  fs.writeFileSync(path.join(dir, "sp", "popup.js"), `
    require("fs").appendFileSync(${JSON.stringify(log)}, "notes " + process.env.SCRATCHPAD_CWD + " " + process.env.HERDR_PLUGIN_STATE_DIR + "\\n");
    const tabs = require(${JSON.stringify(tabsModule)});
    tabs.switchTo(tabs.TABS[2], { cwd: "/repo/b" });
  `);
  fs.writeFileSync(path.join(dir, "pj", "picker.js"), `
    require("fs").appendFileSync(${JSON.stringify(log)}, "projects " + process.env.PROJECTS_CWD + "\\n");
    process.exit(7);
  `);
  const list = { result: { plugins: [
    { plugin_id: "taanviir.scratchpad", plugin_root: path.join(dir, "sp"), panes: [{ id: "popup", command: ["node", "popup.js"] }] },
    { plugin_id: "taanviir.projects", plugin_root: path.join(dir, "pj"), panes: [{ id: "picker", command: ["node", "picker.js"] }] },
  ] } };
  const herdr = path.join(dir, "herdr");
  fs.writeFileSync(herdr, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(list)}\nEOF\n`, { mode: 0o755 });

  const driver = `require(${JSON.stringify(tabsModule)}).switchTo(require(${JSON.stringify(tabsModule)}).TABS[1], { cwd: "/repo/a" }, () => require("fs").appendFileSync(${JSON.stringify(log)}, "kept\\n"));`;
  const env = { ...process.env, HERDR_BIN_PATH: herdr, HERDR_PLUGIN_STATE_DIR: path.join(dir, "state", "taanviir.quick-prompt") };
  delete env.HERDR_TABS_HOSTED;
  const res = spawnSync(process.execPath, ["-e", driver], { env, encoding: "utf8", timeout: 10000 });

  assert.equal(res.status, 7, "the host leaves with the last program's exit code");
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    "kept",
    `notes /repo/a ${path.join(dir, "state", "taanviir.scratchpad")}`,
    "projects /repo/b",
  ]);
});
