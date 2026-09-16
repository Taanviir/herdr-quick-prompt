"use strict";

// Optional convenience action: add the keybinding to the user's config.toml so
// installing does not mean hand-editing a file. Herdr plugins cannot register
// their own keys, so this is the closest thing to a one-command install.

const fs = require("node:fs");
const path = require("node:path");
const { run, notify, BIN } = require("../lib/herdr");
const { spawnSync } = require("node:child_process");

const PLUGIN_ID = "taanviir.quick-prompt";
const ACTION = `${PLUGIN_ID}.open`;
const DEFAULT_KEY = "prefix+shift+c";

const key = process.env.QUICK_PROMPT_KEY ?? DEFAULT_KEY;

// `herdr --help` prints the config path it actually uses, which beats guessing
// per-platform locations.
function configPath() {
  const res = spawnSync(BIN, ["--help"], { encoding: "utf8" });
  const match = /^Config:\s*(.+)$/m.exec(res.stdout ?? "");
  if (match) return match[1].trim();

  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const base = process.env.APPDATA ?? path.join(home, ".config");
  return path.join(base, "herdr", "config.toml");
}

function report(message, { failed = false } = {}) {
  process.stdout.write(`${message}\n`);
  notify("Quick Prompt", message, failed ? "request" : "done");
  process.exit(failed ? 1 : 0);
}

const file = configPath();
const config = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

if (config.includes(ACTION)) {
  report(`Already bound in ${file}. Nothing to do.`);
}

// Don't quietly shadow a key the user already uses for something else.
const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const existing = new RegExp(`^\\s*key\\s*=\\s*(["'])${escapedKey}\\1`, "m");
if (existing.test(config)) {
  report(`${key} is already bound in ${file}. Set QUICK_PROMPT_KEY to another key and retry.`, {
    failed: true,
  });
}

const block = `
# Quick Prompt: pick an agent, type a prompt, launch it.
[[keys.command]]
key = "${key}"
type = "plugin_action"
command = "${ACTION}"
description = "Quick Prompt"
`;

try {
  if (config) fs.copyFileSync(file, `${file}.bak-quick-prompt`);
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, config.endsWith("\n") || !config ? config + block : `${config}\n${block}`);
} catch (error) {
  report(`Could not write ${file}: ${error.message}`, { failed: true });
}

const reloaded = run(["server", "reload-config"], { check: false });
if (reloaded.ok === false) {
  report(`Added ${key} to ${file}, but the config reload failed: ${reloaded.message}`, { failed: true });
}

const diagnostics = reloaded.result?.diagnostics ?? [];
if (diagnostics.length > 0) {
  report(`Added ${key}, but herdr reported: ${diagnostics.map((d) => d.message ?? d).join("; ")}`, {
    failed: true,
  });
}

report(`${key} now opens Quick Prompt. Previous config saved as ${path.basename(file)}.bak-quick-prompt.`);
