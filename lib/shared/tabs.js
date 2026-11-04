"use strict";

// The strip across the top of every popup, so the three read as one: Prompt,
// Notes, Projects. Each tab is its own plugin's popup. Switching
// closes this one and opens the next where it stood, passing on the folder
// you were looking at.

const path = require("node:path");
const { style, truncate, displayWidth } = require("./ui");
const { spawnDetached } = require("./herdr");

const TABS = [
  { id: "prompt", title: "Prompt", plugin: "taanviir.quick-prompt", entrypoint: "picker", prefix: "QUICK_PROMPT" },
  { id: "notes", title: "Notes", plugin: "taanviir.scratchpad", entrypoint: "popup", prefix: "SCRATCHPAD" },
  { id: "projects", title: "Projects", plugin: "taanviir.projects", entrypoint: "picker", prefix: "PROJECTS" },
];

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

// The caller quits right after: Herdr opens the next popup once this one is
// gone. `where` is { cwd, workspace, pane }, as far as the popup knows them.
function switchTo(tab, where) {
  spawnDetached(process.execPath, [SWITCHER, JSON.stringify({ id: tab.id, ...where })]);
}

// Each plugin reads where it was opened from in its own variables.
function envFor(tab, { cwd, workspace, pane } = {}) {
  const env = { [`${tab.prefix}_CWD`]: cwd, [`${tab.prefix}_WORKSPACE`]: workspace, [`${tab.prefix}_PANE`]: pane };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

module.exports = { TABS, strip, switchFor, switchTo, envFor };
