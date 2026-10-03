"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BIN, run } = require("./herdr");

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

function kinds() {
  const res = spawnSync(BIN, ["agent", "start", "--help"], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS });
  const match = /possible values:\s*([^\]]+)\]/.exec(res.stdout ?? "");
  if (!match) return FALLBACK_KINDS;
  const parsed = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[a-z][a-z0-9_-]*$/.test(value));
  return parsed.length > 0 ? parsed : FALLBACK_KINDS;
}

// One sweep of PATH beats spawning `which` per kind.
function executablesOnPath() {
  const found = new Set();
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) found.add(entry.replace(/\.(exe|cmd|bat|ps1)$/i, ""));
  }
  return found;
}

// Installed first, then alphabetical. Deliberately not ordered by recent use:
// the chips are numbered, and a number that points at a different agent
// depending on what you ran last is worse than no number at all. Recency picks
// which agent starts selected, nothing more.
function catalog() {
  const onPath = executablesOnPath();
  const items = kinds().map((kind) => ({
    kind,
    installed: onPath.has(EXECUTABLES[kind] ?? kind),
  }));

  return items.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.kind.localeCompare(b.kind);
  });
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

function runningAgent(paneId) {
  if (!paneId) return null;
  const res = run(["agent", "list"], { check: false, timeout: LOOKUP_TIMEOUT_MS });
  return res.ok ? agentInPane(res.result.agents, paneId) : null;
}

module.exports = { catalog, kinds, supportsInlinePrompt, agentInPane, runningAgent };
