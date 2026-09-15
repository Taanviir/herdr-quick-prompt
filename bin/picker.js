"use strict";

// Popup entrypoint: one screen. The cursor starts in the prompt because that is
// what you came here to write; the agent and the destination are one keystroke
// away, and the full agent list is behind ctrl+k rather than in your way.

const readline = require("node:readline");
const path = require("node:path");

const { catalog } = require("../lib/agents");
const { Editor } = require("../lib/editor");
const { spawnDetached } = require("../lib/herdr");
const { readPrefs, remember, writeRequest } = require("../lib/state");
const { style, pad, shortenPath, displayWidth, frame, frameContent } = require("../lib/ui");

const LAUNCHER = path.join(__dirname, "launch.js");

const DESTINATIONS = [
  { id: "tab", label: "new tab" },
  { id: "right", label: "split right" },
  { id: "down", label: "split down" },
];

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
const originPane = process.env.QUICK_PROMPT_PANE ?? ctx.focused_pane_id ?? process.env.HERDR_PANE_ID;

const prefs = readPrefs();
const agents = catalog(prefs.recents);
const out = process.stdout;

const state = {
  agent: Math.max(0, agents.findIndex((a) => a.kind === prefs.recents[0])),
  destination: Math.max(0, DESTINATIONS.findIndex((d) => d.id === prefs.destination)),
  prompt: new Editor(),
  chipStart: 0,
  overlay: null, // { filter, index } while the full agent list is open
};

const width = () => Math.max(32, out.columns ?? 64);
const height = () => Math.max(12, out.rows ?? 18);
const agent = () => agents[state.agent];
const destination = () => DESTINATIONS[state.destination];

/* ---------- rendering ---------- */

function render() {
  const bodyHeight = height() - 2;
  const content = frameContent(width());
  const body = state.overlay ? overlayBody(content, bodyHeight) : mainBody(content, bodyHeight);

  const painted = frame({
    width: width(),
    height: height(),
    title: "Quick Prompt",
    right: shortenPath(cwd, Math.max(10, content - 20)),
    body: body.lines,
  });

  out.write(`\x1b[2J\x1b[H${painted.lines.join("\r\n")}`);

  if (body.caret) {
    const row = painted.originRow + body.caret.row + 1;
    const col = painted.originCol + body.caret.col + 1;
    out.write(`\x1b[${row};${col}H\x1b[?25h`);
  } else {
    out.write("\x1b[?25l");
  }
}

function mainBody(content, bodyHeight) {
  const lines = new Array(bodyHeight).fill("");
  lines[1] = chipRow(content);

  const promptTop = 3;
  const promptRows = Math.max(1, bodyHeight - 7);
  const caret = promptBlock(lines, promptTop, promptRows, content);

  lines[bodyHeight - 3] = destinationRow(content);
  lines[bodyHeight - 1] = style.dim(hints());
  return { lines, caret };
}

// Agents as a row of chips, windowed so the selected one is always visible. The
// first nine carry their alt+N number so the shortcut is visible rather than
// something you have to remember.
const SHORTCUTS = 9;
const chipLabel = (index, kind) => (index < SHORTCUTS ? `${index + 1} ${kind}` : kind);

function chipRow(content) {
  const chip = (item, index, active) => {
    if (active) return style.selected(` ${chipLabel(index, item.kind)} `);
    const number = index < SHORTCUTS ? style.dim(`${index + 1} `) : "";
    return ` ${number}${item.installed ? item.kind : style.dim(item.kind)} `;
  };

  const room = content - "ctrl+k".length - 2;
  const fits = (start) => {
    const shown = [];
    let used = 0;
    for (let i = start; i < agents.length; i += 1) {
      const next = chipLabel(i, agents[i].kind).length + 2 + (shown.length ? 1 : 0);
      if (used + next > room) break;
      used += next;
      shown.push(i);
    }
    return shown;
  };

  if (state.agent < state.chipStart) state.chipStart = state.agent;
  let shown = fits(state.chipStart);
  while (!shown.includes(state.agent) && state.chipStart < agents.length - 1) {
    state.chipStart += 1;
    shown = fits(state.chipStart);
  }

  const row = shown.map((i) => chip(agents[i], i, i === state.agent)).join(" ");
  const hidden = agents.length - shown.length;
  const tail = style.dim(hidden > 0 ? `+${hidden} ctrl+k` : "ctrl+k");
  const gap = Math.max(1, content - displayWidth(row) - displayWidth(tail));
  return row + " ".repeat(gap) + tail;
}

function promptBlock(lines, top, rows, content) {
  const { rows: wrapped, caret } = state.prompt.layout(content - 2);
  const from = Math.max(0, caret.row - rows + 1);
  const visible = wrapped.slice(from, from + rows);

  visible.forEach((line, index) => {
    const marker = from + index === 0 ? style.accent("› ") : "  ";
    lines[top + index] = marker + line;
  });

  if (state.prompt.text === "") {
    lines[top] = `${style.accent("› ")}${style.dim("what should it work on?")}`;
  }

  return { row: top + (caret.row - from), col: 2 + caret.col };
}

function destinationRow(content) {
  const label = style.dim(`→ ${destination().label}`);
  const hint = style.dim("ctrl+t");
  const gap = Math.max(1, content - displayWidth(label) - displayWidth(hint));
  return label + " ".repeat(gap) + hint;
}

function hints() {
  if (state.prompt.isEmpty) return "⏎ open agent · tab agent · alt+1-9 · esc cancel";
  return "⏎ launch · tab agent · ctrl+j newline · esc cancel";
}

/* ---------- the full agent list ---------- */

function overlayMatches() {
  const needle = state.overlay.filter.toLowerCase();
  return agents.filter((item) => item.kind.includes(needle));
}

function overlayBody(content, bodyHeight) {
  const lines = new Array(bodyHeight).fill("");
  const list = overlayMatches();

  lines[0] = state.overlay.filter
    ? `${style.dim("agent")}  ${style.accent(state.overlay.filter)}${style.dim("▏")}`
    : style.dim("agent");

  if (list.length === 0) {
    lines[2] = style.warn("no agent kind matches that filter");
    lines[bodyHeight - 1] = style.dim("esc back");
    return { lines, caret: null };
  }

  const room = bodyHeight - 4;
  const active = Math.min(state.overlay.index, list.length - 1);
  const start = Math.max(0, Math.min(active - Math.floor(room / 2), list.length - room));

  list.slice(start, start + room).forEach((item, index) => {
    const at = start + index;
    const mark = item.installed ? style.ok("●") : style.dim("○");
    const name = pad(item.kind, Math.max(10, content - 6));
    lines[2 + index] = at === active ? `${style.selected(` ${name}`)} ${mark}` : ` ${name} ${mark}`;
  });

  lines[bodyHeight - 1] = style.dim("↑↓ select · type to filter · ⏎ choose · esc back");
  return { lines, caret: null };
}

/* ---------- input ---------- */

function onKey(chunk, key = {}) {
  if (key.ctrl && key.name === "c") return quit(0);
  if (state.overlay) return onOverlayKey(chunk, key);
  return onMainKey(chunk, key);
}

function onMainKey(chunk, key) {
  const prompt = state.prompt;

  switch (true) {
    case key.name === "escape":
      return quit(0);
    // \r launches; \n (ctrl+j) inserts a newline.
    case chunk === "\r" || key.name === "return":
      return launch();
    case chunk === "\n" || (key.ctrl && key.name === "j"):
      prompt.insert("\n");
      break;
    case key.name === "tab" && key.shift:
      state.agent = (state.agent - 1 + agents.length) % agents.length;
      break;
    case key.name === "tab":
      state.agent = (state.agent + 1) % agents.length;
      break;
    case key.ctrl && key.name === "k":
      state.overlay = { filter: "", index: state.agent };
      break;
    case key.ctrl && key.name === "t":
      state.destination = (state.destination + 1) % DESTINATIONS.length;
      break;
    case key.meta && /^[1-9]$/.test(key.name ?? ""):
      pickChip(Number(key.name) - 1);
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

function onOverlayKey(chunk, key) {
  const list = overlayMatches();

  switch (true) {
    case key.name === "escape" || (key.ctrl && key.name === "k"):
      state.overlay = null;
      break;
    case key.name === "up" || (key.ctrl && key.name === "p"):
      state.overlay.index = Math.max(0, Math.min(state.overlay.index, list.length - 1) - 1);
      break;
    case key.name === "down" || (key.ctrl && key.name === "n"):
      state.overlay.index = Math.min(list.length - 1, state.overlay.index + 1);
      break;
    case key.name === "return" || key.name === "enter": {
      const chosen = list[Math.min(state.overlay.index, list.length - 1)];
      if (chosen) state.agent = agents.indexOf(chosen);
      state.overlay = null;
      break;
    }
    case key.name === "backspace":
      state.overlay.filter = state.overlay.filter.slice(0, -1);
      state.overlay.index = 0;
      break;
    case isPrintable(chunk, key):
      state.overlay.filter += chunk.toLowerCase();
      state.overlay.index = 0;
      break;
    default:
      return;
  }
  render();
}

// alt+N always means the same agent, whether or not its chip is on screen; the
// row scrolls to it. Anything further away is what ctrl+k is for.
function pickChip(index) {
  if (index < agents.length) state.agent = index;
}

function isPrintable(chunk, key) {
  return Boolean(chunk) && !key.ctrl && !key.meta && chunk >= " " && chunk !== "\x7f";
}

/* ---------- launch ---------- */

function launch() {
  const chosen = agent();
  if (!chosen) return quit(0);

  remember(chosen.kind, destination().id);
  const request = writeRequest({
    kind: chosen.kind,
    prompt: state.prompt.text.trim(),
    destination: destination().id,
    cwd,
    workspace,
    pane: originPane,
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
