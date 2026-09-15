"use strict";

// Popup entrypoint: pick an agent, type a prompt, hand the launch off to a
// detached worker so the modal closes immediately.

const readline = require("node:readline");
const path = require("node:path");

const { catalog } = require("../lib/agents");
const { Editor } = require("../lib/editor");
const { spawnDetached } = require("../lib/herdr");
const { readRecents, rememberAgent, writeRequest } = require("../lib/state");
const { style, pad, truncate, shortenPath } = require("../lib/ui");

const LAUNCHER = path.join(__dirname, "launch.js");

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {
    return {};
  }
}

const ctx = context();
const cwd = process.env.QUICK_PROMPT_CWD ?? ctx.focused_pane_cwd ?? ctx.workspace_cwd ?? process.env.HOME;
const workspace = process.env.QUICK_PROMPT_WORKSPACE ?? ctx.workspace_id ?? process.env.HERDR_WORKSPACE_ID;

const agents = catalog(readRecents());
const out = process.stdout;

const state = {
  step: "agent",
  filter: "",
  index: 0,
  prompt: new Editor(),
};

function matches() {
  const needle = state.filter.toLowerCase();
  return agents.filter((agent) => agent.kind.includes(needle));
}

function selected() {
  const list = matches();
  return list[Math.min(state.index, list.length - 1)];
}

/* ---------- rendering ---------- */

const width = () => Math.max(24, out.columns ?? 60);
const height = () => Math.max(10, out.rows ?? 18);

function render() {
  const cols = width();
  const inner = cols - 2;
  const lines = [];
  const rule = style.dim("─".repeat(inner));

  const agent = selected();
  const bare = state.step === "agent" || !agent;
  const heading = bare
    ? style.bold("Quick Prompt")
    : `${style.bold("Quick Prompt")} ${style.dim("\u203a")} ${style.accent(agent.kind)}`;
  const headingWidth = bare ? "Quick Prompt".length : "Quick Prompt \u203a ".length + agent.kind.length;
  const where = shortenPath(cwd, Math.max(12, inner - headingWidth - 2));

  lines.push(`${heading}${" ".repeat(Math.max(1, inner - headingWidth - where.length))}${style.dim(where)}`);
  lines.push(rule);

  let caret = null;
  if (state.step === "agent") {
    lines.push(...renderAgentList(inner, lines.length));
  } else {
    caret = renderPrompt(inner, lines);
  }

  const body = height() - 2;
  while (lines.length < body) lines.push("");
  lines.push(rule);
  lines.push(style.dim(truncate(footer(), inner)));

  out.write(`\x1b[2J\x1b[H${lines.map((line) => ` ${line}`).join("\r\n")}`);

  if (caret) {
    out.write(`\x1b[${caret.row + 1};${caret.col + 1}H\x1b[?25h`);
  } else {
    out.write("\x1b[?25l");
  }
}

function renderAgentList(inner, offset) {
  const list = matches();
  const rows = [];
  const label = state.filter
    ? `${style.dim("agent")}  ${style.accent(state.filter)}${style.dim("▏")}`
    : style.dim("agent");
  rows.push(label);

  if (list.length === 0) {
    rows.push(style.warn("  no agent kind matches that filter"));
    return rows;
  }

  const room = Math.max(3, height() - offset - 5);
  const active = Math.min(state.index, list.length - 1);
  const start = Math.max(0, Math.min(active - Math.floor(room / 2), list.length - room));

  for (const agent of list.slice(start, start + room)) {
    const isActive = list.indexOf(agent) === active;
    const mark = agent.installed ? style.ok("●") : style.dim("○");
    const name = pad(agent.kind, Math.max(10, inner - 6));
    rows.push(isActive ? style.selected(` ▸ ${name}`) + ` ${mark}` : `   ${name} ${mark}`);
  }

  if (list.length > room) rows.push(style.dim(`   ${list.length - room} more…`));
  return rows;
}

function renderPrompt(inner, lines) {
  lines.push(style.dim("prompt"));
  const { rows, caret } = state.prompt.layout(inner - 2);
  const room = Math.max(1, height() - lines.length - 3);
  const from = Math.max(0, caret.row - room + 1);

  for (const row of rows.slice(from, from + room)) lines.push(`  ${row}`);
  if (state.prompt.text === "") lines[lines.length - 1] = `  ${style.dim("what should it work on?")}`;

  // Terminal rows/cols are 1-based and every line is written with a leading space.
  return {
    row: lines.length - Math.min(rows.length - from, room) + (caret.row - from),
    col: caret.col + 3,
  };
}

function footer() {
  if (state.step === "agent") {
    return "↑↓ select · type to filter · enter continue · esc cancel";
  }
  return state.prompt.isEmpty
    ? "enter open agent with no prompt · esc back · ctrl+c cancel"
    : "enter launch · ctrl+j newline · esc back · ctrl+c cancel";
}

/* ---------- input ---------- */

function onKey(chunk, key = {}) {
  if (key.ctrl && key.name === "c") return quit(0);

  if (state.step === "agent") return onAgentKey(chunk, key);
  return onPromptKey(chunk, key);
}

function onAgentKey(chunk, key) {
  const list = matches();

  switch (true) {
    case key.name === "escape":
      return quit(0);
    case key.name === "up" || (key.ctrl && key.name === "p"):
      state.index = Math.max(0, Math.min(state.index, list.length - 1) - 1);
      break;
    case key.name === "down" || (key.ctrl && key.name === "n"):
      state.index = Math.min(list.length - 1, state.index + 1);
      break;
    case key.name === "return" || key.name === "enter":
      if (list.length === 0) return;
      state.step = "prompt";
      break;
    case key.name === "backspace":
      state.filter = state.filter.slice(0, -1);
      state.index = 0;
      break;
    case isPrintable(chunk, key):
      state.filter += chunk.toLowerCase();
      state.index = 0;
      break;
    default:
      return;
  }
  render();
}

function onPromptKey(chunk, key) {
  const prompt = state.prompt;

  switch (true) {
    case key.name === "escape":
      state.step = "agent";
      break;
    // \r submits; \n (ctrl+j) inserts a newline.
    case chunk === "\r" || key.name === "return":
      return launch();
    case chunk === "\n" || (key.ctrl && key.name === "j"):
      prompt.insert("\n");
      break;
    case key.name === "backspace":
      prompt.backspace();
      break;
    case key.name === "delete":
      prompt.deleteForward();
      break;
    case key.name === "left":
      prompt.move(-1);
      break;
    case key.name === "right":
      prompt.move(1);
      break;
    case key.ctrl && key.name === "a":
      prompt.toLineStart();
      break;
    case key.ctrl && key.name === "e":
      prompt.toLineEnd();
      break;
    case key.ctrl && key.name === "u":
      prompt.clear();
      break;
    case key.ctrl && key.name === "w":
      prompt.deleteWord();
      break;
    case isPrintable(chunk, key):
      prompt.insert(chunk);
      break;
    default:
      return;
  }
  render();
}

function isPrintable(chunk, key) {
  return Boolean(chunk) && !key.ctrl && !key.meta && chunk >= " " && chunk !== "\x7f";
}

/* ---------- launch ---------- */

function launch() {
  const agent = selected();
  if (!agent) return quit(0);

  rememberAgent(agent.kind);
  const request = writeRequest({
    kind: agent.kind,
    prompt: state.prompt.text.trim(),
    cwd,
    workspace,
  });

  spawnDetached(process.execPath, [LAUNCHER, request]);
  quit(0);
}

function quit(code) {
  out.write("\x1b[?25h\x1b[2J\x1b[H");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

/* ---------- boot ---------- */

if (!process.stdin.isTTY) {
  process.stderr.write("quick-prompt: picker needs an interactive terminal\n");
  process.exit(1);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("keypress", onKey);
out.on("resize", render);
render();
