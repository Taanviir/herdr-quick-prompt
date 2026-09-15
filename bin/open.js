"use strict";

// Action entrypoint: resolve where the user is, then open the popup picker
// there. Bound to a key through [[keys.command]] in config.toml.

const { run } = require("../lib/herdr");

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {
    return {};
  }
}

const ctx = context();
const cwd = ctx.focused_pane_cwd ?? ctx.workspace_cwd ?? process.env.HOME;
const workspace = ctx.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
const pane = ctx.focused_pane_id ?? process.env.HERDR_PANE_ID;

// A popup always targets the active pane, so it rejects --workspace; the picker
// gets the caller's location through the environment instead.
const args = ["plugin", "pane", "open", "--plugin", "taanviir.quick-prompt", "--entrypoint", "picker"];
if (cwd) args.push("--cwd", cwd, "--env", `QUICK_PROMPT_CWD=${cwd}`);
if (workspace) args.push("--env", `QUICK_PROMPT_WORKSPACE=${workspace}`);
// A popup has no pane of its own, so the split destinations need to be told
// which pane the user was sitting in.
if (pane) args.push("--env", `QUICK_PROMPT_PANE=${pane}`);

const res = run(args, { check: false });
if (res.ok === false) {
  process.stderr.write(`${res.message}\n`);
  process.exit(1);
}
