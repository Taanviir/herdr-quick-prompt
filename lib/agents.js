"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFile } = require("node:child_process");
const { BIN, runAsync } = require("./herdr");
const { pathDirs, executablesOnPath, executablesOnPathAsync } = require("./executables");
const { readCache, writeCache } = require("./state");

// Fallback for the unlikely case that --help cannot be parsed. The live list
// comes from the installed binary, so new agent kinds appear without a release.
const FALLBACK_KINDS = [
  "claude", "codex", "gemini", "cursor", "copilot", "opencode", "droid",
  "amp", "grok", "qwen", "kimi", "cline", "devin", "pi",
];

// Kinds whose CLI takes the first prompt as a positional argument, verified
// against each agent's own --help. Passing the prompt at launch is both faster
// and more reliable than typing into a TUI that is still painting, so anything
// not listed here falls back to keystroke delivery.
const INLINE_PROMPT_KINDS = new Set(["claude", "codex", "cursor", "pi"]);

// QUICK_PROMPT_NO_INLINE forces keystroke delivery, for comparing the two paths
// when an agent misbehaves with a launch argument.
const supportsInlinePrompt = (kind) =>
  !process.env.QUICK_PROMPT_NO_INLINE && INLINE_PROMPT_KINDS.has(kind);

// Kinds whose executable on PATH is not simply the kind name.
const EXECUTABLES = {
  cursor: "cursor-agent",
  qodercli: "qoder",
  mastracode: "mastra",
};

// Asked while the popup is opening, so a slow or failing Herdr costs at most
// the timeout and leaves the ordinary defaults in place.
const LOOKUP_TIMEOUT_MS = 500;
const HELP = ["agent", "start", "--help"];
const CACHE = "catalog";

// The kinds listed in `agent start --help`, or null when there are none.
function parseKinds(help) {
  const match = /possible values:\s*([^\]]+)\]/.exec(help ?? "");
  if (!match) return null;
  const parsed = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[a-z][a-z0-9_-]*$/.test(value));
  return parsed.length > 0 ? parsed : null;
}


// Installed first, then alphabetical. Deliberately not ordered by recent use:
// the chips are numbered, and a number that points at a different agent
// depending on what you ran last is worse than no number at all. Recency picks
// which agent starts selected, nothing more.
function order(list, onPath) {
  return list
    .map((kind) => ({ kind, installed: onPath.has(EXECUTABLES[kind] ?? kind) }))
    .sort((a, b) => {
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return a.kind.localeCompare(b.kind);
    });
}

// The catalog only changes when Herdr is replaced or PATH does, short of an
// agent being installed; refreshCatalog catches that one after the popup is up.
function cacheKey() {
  const bin = BIN.includes("/")
    ? path.resolve(BIN)
    : pathDirs().map((dir) => path.join(dir, BIN)).find((file) => fs.existsSync(file)) ?? BIN;
  let stat = null;
  try {
    stat = fs.statSync(bin);
  } catch { /* not there; the key still says so */ }
  return JSON.stringify({ bin, mtimeMs: stat?.mtimeMs ?? null, size: stat?.size ?? null, path: process.env.PATH ?? "" });
}

// A list from Herdr's fallback is not kept, so the next popup asks again.
function settle(found, onPath) {
  const items = order(found ?? FALLBACK_KINDS, onPath);
  if (found) writeCache(CACHE, { key: cacheKey(), items });
  return items;
}

// What the last popup worked out, if nothing it depends on has changed.
function cachedCatalog() {
  const cached = readCache(CACHE);
  if (cached?.key !== cacheKey() || !Array.isArray(cached.items) || cached.items.length === 0) return null;
  const valid = cached.items.every((item) => typeof item?.kind === "string" && typeof item.installed === "boolean");
  return valid ? cached.items : null;
}

// Worked out on the spot, for a popup with no usable cache to paint from.
function catalog() {
  const help = spawnSync(BIN, HELP, { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS });
  return settle(parseKinds(help.stdout), executablesOnPath());
}

function refreshCatalog() {
  const help = new Promise((resolve) => {
    execFile(BIN, HELP, { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS }, (_, stdout) => resolve(parseKinds(stdout)));
  });
  return Promise.all([help, executablesOnPathAsync()]).then(([found, onPath]) => settle(found, onPath));
}

// The agent Herdr reports in a pane, and the directory it is working in now
// rather than the one its pane was opened in.
function agentInPane(list, paneId) {
  if (!paneId || !Array.isArray(list)) return null;
  const found = list.find((item) => item?.pane_id === paneId);
  if (typeof found?.agent !== "string") return null;
  const cwd = found.foreground_cwd ?? found.cwd;
  return { kind: found.agent, cwd: typeof cwd === "string" ? cwd : null };
}

async function runningAgent(paneId) {
  if (!paneId) return null;
  const res = await runAsync(["agent", "list"], { timeout: LOOKUP_TIMEOUT_MS });
  return res.ok ? agentInPane(res.result.agents, paneId) : null;
}

module.exports = { catalog, cachedCatalog, refreshCatalog, supportsInlinePrompt, agentInPane, runningAgent };
