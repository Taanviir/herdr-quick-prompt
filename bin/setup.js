"use strict";

// Optional convenience action: add the keybindings to the user's config.toml so
// installing does not mean hand-editing a file. Herdr plugins cannot register
// their own keys, so this is the closest thing to a one-command install.

const fs = require("node:fs");
const path = require("node:path");
const { run, notify, BIN } = require("../lib/herdr");
const { spawnSync } = require("node:child_process");

const PLUGIN_ID = "taanviir.quick-prompt";

const BINDINGS = [
  { action: "open", variable: "QUICK_PROMPT_KEY", key: "prefix+shift+c", description: "Quick Prompt" },
  { action: "duplicate", variable: "QUICK_PROMPT_DUPLICATE_KEY", key: "prefix+shift+a", description: "Quick Prompt with the focused agent" },
];

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

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isBound(config, action) {
  return new RegExp(`^\\s*command\\s*=\\s*(["'])${literal(`${PLUGIN_ID}.${action}`)}\\1`, "m").test(config);
}

// Any binding counts, not only [[keys.command]] ones: `prefix+shift+c` in the
// [keys] table is just as taken.
function isKeyTaken(config, key) {
  return new RegExp(`=\\s*(["'])${literal(key)}\\1`, "m").test(config);
}

// What to add, and why anything is left out. Each action is checked on its
// own, so one bound by hand does not stop the other being added.
function plan(config, env = process.env) {
  const add = [];
  const skipped = [];
  for (const binding of BINDINGS) {
    if (isBound(config, binding.action)) continue;
    const key = env[binding.variable] || binding.key;
    if (isKeyTaken(config, key)) {
      skipped.push(`${key} is already bound; set ${binding.variable} to another key and retry`);
      continue;
    }
    add.push({ ...binding, key });
  }
  return { add, skipped };
}

function block({ key, action, description }) {
  return `
[[keys.command]]
key = "${key}"
type = "plugin_action"
command = "${PLUGIN_ID}.${action}"
description = "${description}"
`;
}

function report(message, { failed = false } = {}) {
  process.stdout.write(`${message}\n`);
  notify("Quick Prompt", message, failed ? "request" : "done");
  process.exit(failed ? 1 : 0);
}

function main() {
  const file = configPath();
  const config = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { add, skipped } = plan(config);
  const problems = skipped.join(". ");

  if (add.length === 0) {
    if (problems) report(`${problems}.`, { failed: true });
    report(`Already bound in ${file}. Nothing to do.`);
  }

  const text = `\n# Quick Prompt: pick an agent, type a prompt, launch it.${add.map(block).join("")}`;
  try {
    if (config) fs.copyFileSync(file, `${file}.bak-quick-prompt`);
    else fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, config.endsWith("\n") || !config ? config + text : `${config}\n${text}`);
  } catch (error) {
    report(`Could not write ${file}: ${error.message}`, { failed: true });
  }

  const keys = add.map((binding) => `${binding.key} (${binding.action})`).join(" and ");
  const reloaded = run(["server", "reload-config"], { check: false });
  if (reloaded.ok === false) {
    report(`Added ${keys} to ${file}, but the config reload failed: ${reloaded.message}`, { failed: true });
  }

  const diagnostics = reloaded.result?.diagnostics ?? [];
  if (diagnostics.length > 0) {
    report(`Added ${keys}, but herdr reported: ${diagnostics.map((d) => d.message ?? d).join("; ")}`, {
      failed: true,
    });
  }

  const saved = config ? ` Previous config saved as ${path.basename(file)}.bak-quick-prompt.` : "";
  if (problems) report(`Added ${keys}. ${problems}.${saved}`, { failed: true });
  report(`Added ${keys}.${saved}`);
}

if (require.main === module) main();

module.exports = { plan, isBound, isKeyTaken };
