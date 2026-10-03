"use strict";

// Scratchpad (github.com/Taanviir/herdr-scratchpad) keeps notes for later.
// When its `scratch` command is on PATH, ctrl+s saves the prompt there instead
// of launching it: for the prompt that turns out not to be for right now.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SAVE_TIMEOUT_MS = 5000;

function available() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, "scratch")));
}

// Run from the prompt's directory and as the pane you came from, so the note
// is filed under that folder and remembers the agent and branch in front of you.
function save(text, { cwd, pane }) {
  // spawn reports a missing cwd as a missing command, which would mislead.
  if (!fs.existsSync(cwd)) return { ok: false, message: `${cwd} does not exist` };
  const res = spawnSync("scratch", ["add", "-"], {
    cwd,
    input: text,
    encoding: "utf8",
    timeout: SAVE_TIMEOUT_MS,
    env: pane ? { ...process.env, HERDR_PANE_ID: pane } : process.env,
  });
  if (res.error) return { ok: false, message: res.error.message };
  if (res.status !== 0) return { ok: false, message: (res.stderr || "scratch add failed").trim().replace(/^scratch: /, "") };
  return { ok: true, message: res.stdout.trim() };
}

module.exports = { available, save };
