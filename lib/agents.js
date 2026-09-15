"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BIN } = require("./herdr");

// Fallback for the unlikely case that --help cannot be parsed. The live list
// comes from the installed binary, so new agent kinds appear without a release.
const FALLBACK_KINDS = [
  "claude", "codex", "gemini", "cursor", "copilot", "opencode", "droid",
  "amp", "grok", "qwen", "kimi", "cline", "devin", "pi",
];

// Kinds whose executable on PATH is not simply the kind name.
const EXECUTABLES = {
  cursor: "cursor-agent",
  qodercli: "qoder",
  mastracode: "mastra",
};

function kinds() {
  const res = spawnSync(BIN, ["agent", "start", "--help"], { encoding: "utf8" });
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

// Recently used first, then whatever is actually installed, then the rest.
function catalog(recents = []) {
  const onPath = executablesOnPath();
  const items = kinds().map((kind) => ({
    kind,
    installed: onPath.has(EXECUTABLES[kind] ?? kind),
    rank: recents.indexOf(kind),
  }));

  return items.sort((a, b) => {
    if (a.rank !== b.rank) {
      if (a.rank === -1) return 1;
      if (b.rank === -1) return -1;
      return a.rank - b.rank;
    }
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.kind.localeCompare(b.kind);
  });
}

module.exports = { catalog, kinds };
