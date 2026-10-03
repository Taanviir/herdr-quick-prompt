"use strict";

// Prompt presets: text wrapped around what you type, and optionally the agent
// to send it to. The file is written by hand, so it lives in the config
// directory rather than next to the state the plugin rewrites, and a mistake in
// one preset costs that preset, not the rest.

const fs = require("node:fs");
const path = require("node:path");
const { STATE_DIR } = require("./state");

const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR ?? STATE_DIR;
const PRESETS = path.join(CONFIG_DIR, "presets.json");
const TASKS = ["ask", "skip"];

function validate(entry, index, seen) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { problem: `preset ${index + 1} is not an object` };
  }
  const { name, agent, prefix = "", postfix = "", task = "ask" } = entry;
  if (typeof name !== "string" || !name.trim()) {
    return { problem: `preset ${index + 1} has no name` };
  }
  const label = name.trim();
  if (seen.has(label)) return { problem: `"${label}" is defined twice` };
  if (agent !== undefined && (typeof agent !== "string" || !agent.trim())) {
    return { problem: `"${label}": agent must be an agent kind` };
  }
  if (typeof prefix !== "string" || typeof postfix !== "string") {
    return { problem: `"${label}": prefix and postfix must be text` };
  }
  if (!TASKS.includes(task)) return { problem: `"${label}": task must be "ask" or "skip"` };

  seen.add(label);
  return { preset: { name: label, agent: agent?.trim() ?? null, prefix, postfix, task } };
}

// No file is not a problem: presets are optional.
function readPresets(file = PRESETS) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { presets: [], problems: [] };
    return { presets: [], problems: [`presets.json: ${error.message}`] };
  }
  if (!Array.isArray(parsed)) {
    return { presets: [], problems: ["presets.json must be a list of presets"] };
  }

  const presets = [];
  const problems = [];
  const seen = new Set();
  parsed.forEach((entry, index) => {
    const { preset, problem } = validate(entry, index, seen);
    if (preset) presets.push(preset);
    else problems.push(problem);
  });
  return { presets, problems };
}

function composePrompt(preset, text) {
  return [preset?.prefix, text, preset?.postfix]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

module.exports = { PRESETS, readPresets, composePrompt };
