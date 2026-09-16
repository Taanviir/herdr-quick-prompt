"use strict";

// Popup entrypoint: one screen. The cursor starts in the prompt because that is
// what you came here to write; the agent and the destination are one keystroke
// away, and the agents you do not have installed stay behind ctrl+k.
//
// Herdr draws the popup's border and title, so this renders bare inside it.

const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

const { catalog } = require("../lib/agents");
const { Editor } = require("../lib/editor");
const { spawnDetached, notify } = require("../lib/herdr");
const { STATE_DIR, readPrefs, remember, writeRequest, readFailedRequest, discardRequest } = require("../lib/state");
const { style, pad, truncate, shortenPath, displayWidth } = require("../lib/ui");
const { sanitizePasted } = require("../lib/text");
const { readClipboard } = require("../lib/clipboard");
const { complete, expand, isDirectory, suggestions } = require("../lib/dirs");

const LAUNCHER = path.join(__dirname, "launch.js");

const DESTINATIONS = [
  { id: "tab", label: "new tab" },
  { id: "right", label: "split right" },
  { id: "down", label: "split down" },
  { id: "workspace", label: "new workspace" },
];

// Enough chips to be useful on a machine with nothing installed yet.
const MIN_CHIPS = 5;
const SHORTCUTS = 9;

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
const agents = catalog();
const recovered = readFailedRequest();
// Cleared once the draft has been taken up or thrown away, so neither happens twice.
let recoveredFile = recovered?.file ?? null;
const out = process.stdout;

// A paste is a burst of keypresses: inside it a newline is content, not "launch",
// and a tab is content, not "next agent". Bracketed paste gives explicit markers;
// the byte-count check covers terminals that do not send them.
const BURST_BYTES = 6;
const ESC = 0x1b;

const paste = { active: false, text: "" };
let burst = "";
let swallow = false;
// Escapes already acted on, waiting for readline to emit them late.
let pendingEscapes = 0;

const state = {
  // Recency decides which chip starts selected; it never moves the chips.
  agent: Math.max(0, agents.findIndex((a) => a.kind === (recovered?.request.kind ?? prefs.recents[0]))),
  destination: Math.max(0, DESTINATIONS.findIndex((d) => d.id === (recovered?.request.destination ?? prefs.destination))),
  prompt: new Editor(recovered?.request.prompt ?? ""),
  cwd: recovered?.request.cwd ?? cwd, // where the agent will be started; ctrl+d changes it
  overlay: null, // { type: "agents" | "dirs", ... } while a picker is open
  notice: recovered ? "Recovered failed launch · edit or Enter to retry · ctrl+u clear" : null,
};

// Every cell inside the popup has to be written: cells this never paints show
// whatever was on the screen behind it.
const GUTTER = 1;
const width = () => Math.max(40, out.columns ?? 73);
const height = () => Math.max(8, out.rows ?? 12);
const content = () => Math.max(28, width() - GUTTER * 2);
const agent = () => agents[state.agent];
const destination = () => DESTINATIONS[state.destination];

// The chip row is the agents you actually have, plus whatever is selected. The
// other twenty kinds Herdr knows about are noise until you go looking (ctrl+k).
const installedChips = agents.filter((item) => item.installed);
const chips = installedChips.length >= MIN_CHIPS ? installedChips : agents.slice(0, MIN_CHIPS);
function chipAgents() {
  if (!chips.includes(agent())) chips.push(agent());
  return chips;
}

/* ---------- rendering ---------- */

// Every keypress from one read arrives in the same tick, so a paste repaints
// once instead of once per character.
let queued = false;

function scheduleRender() {
  if (queued) return;
  queued = true;
  setImmediate(() => {
    queued = false;
    render();
  });
}

function render() {
  const inner = content();
  const rows = height();
  const body = state.overlay
    ? (state.overlay.type === "dirs" ? dirsBody(inner, rows) : agentsBody(inner, rows))
    : mainBody(inner, rows);

  const painted = [];
  for (let row = 0; row < rows; row += 1) {
    painted.push(" ".repeat(GUTTER) + pad(truncate(body.lines[row] ?? "", inner), inner));
  }

  out.write(`\x1b[2J\x1b[H${painted.join("\r\n")}`);

  if (body.caret) {
    out.write(`\x1b[${body.caret.row + 1};${GUTTER + body.caret.col + 1}H\x1b[?25h`);
  } else {
    out.write("\x1b[?25l");
  }
}

function mainBody(inner, rows) {
  const lines = new Array(rows).fill("");
  lines[1] = chipRow(inner);

  const caret = promptBlock(lines, 3, Math.max(1, rows - 6), inner);

  lines[rows - 3] = style.dim("─".repeat(inner));
  lines[rows - 2] = destinationRow(inner);
  lines[rows - 1] = state.notice ? style.warn(state.notice) : style.dim(hints());
  return { lines, caret };
}

function chipRow(inner) {
  const chips = chipAgents();
  const label = (item, index) => (index < SHORTCUTS ? `${index + 1} ${item.kind}` : item.kind);

  const hint = `ctrl+k`;
  const room = inner - hint.length - 6;

  const shown = [];
  let used = 0;
  for (let i = 0; i < chips.length; i += 1) {
    const next = label(chips[i], i).length + 2 + (shown.length ? 1 : 0);
    if (used + next > room && shown.length > 0) break;
    used += next;
    shown.push(i);
  }

  // Keep the selected agent visible even when its chip is beyond the row's room.
  const selected = chips.indexOf(agent());
  if (!shown.includes(selected)) {
    const selectedWidth = label(chips[selected], selected).length + 2;
    while (shown.length && used + 1 + selectedWidth > room) {
      const removed = shown.pop();
      used -= label(chips[removed], removed).length + 2 + (shown.length ? 1 : 0);
    }
    shown.push(selected);
  }

  const row = shown
    .map((i) => {
      const item = chips[i];
      const text = label(item, i);
      if (item === agent()) return style.selected(` ${text} `);
      const number = i < SHORTCUTS ? style.dim(`${i + 1} `) : "";
      return ` ${number}${item.kind} `;
    })
    .join(" ");

  const hidden = agents.length - shown.length;
  const tail = style.dim(hidden > 0 ? `+${hidden} ${hint}` : hint);
  const gap = Math.max(1, inner - displayWidth(row) - displayWidth(tail));
  return row + " ".repeat(gap) + tail;
}

function promptBlock(lines, top, rows, inner) {
  const { rows: wrapped, caret } = state.prompt.layout(inner - 2);
  const from = Math.max(0, caret.row - rows + 1);

  wrapped.slice(from, from + rows).forEach((line, index) => {
    const marker = from + index === 0 ? style.accent("› ") : "  ";
    lines[top + index] = marker + style.bright(line);
  });

  return { row: top + (caret.row - from), col: 2 + caret.col };
}

// The popup's title bar has no room for the working directory, so it rides along
// with the destination: what will happen and where, each next to the key that
// changes it.
function destinationRow(inner) {
  const what = `${destination().label} ${style.dim("(ctrl+t)")}`;
  const fixed = destination().label.length + 9 + 14; // label, hint, arrow and joins
  const where = shortenPath(state.cwd, Math.max(12, inner - fixed));
  return `${style.dim("→")} ${what} ${style.dim("·")} ${where} ${style.dim("(ctrl+d)")}`;
}

function hints() {
  const verb = state.prompt.isEmpty ? "⏎ open agent" : "⏎ launch";
  return `${verb} · tab agent · ctrl+v paste · ctrl+j newline · esc cancel`;
}

/* ---------- the full agent list ---------- */

function overlayMatches() {
  const needle = state.overlay.filter.toLowerCase();
  return agents.filter((item) => item.kind.includes(needle));
}

function agentsBody(inner, rows) {
  const lines = new Array(rows).fill("");
  const list = overlayMatches();

  lines[0] = state.overlay.filter
    ? `${style.dim("agent")}  ${style.accent(state.overlay.filter)}${style.dim("▏")}`
    : style.dim("agent");

  if (list.length === 0) {
    lines[1] = style.warn("no agent kind matches that filter");
    lines[rows - 1] = style.dim("esc back");
    return { lines, caret: null };
  }

  const room = rows - 2;
  const active = Math.min(state.overlay.index, list.length - 1);
  const start = Math.max(0, Math.min(active - Math.floor(room / 2), list.length - room));

  list.slice(start, start + room).forEach((item, index) => {
    const at = start + index;
    const mark = item.installed ? style.ok("●") : style.dim("○");
    const name = pad(item.kind, Math.max(10, inner - 6));
    lines[1 + index] = at === active ? `${style.selected(` ${name}`)} ${mark}` : ` ${name} ${mark}`;
  });

  lines[rows - 1] = style.dim("↑↓ select · type to filter · ⏎ choose · esc back");
  return { lines, caret: null };
}

/* ---------- the working directory ---------- */

function openDirectories() {
  state.overlay = { type: "dirs", input: new Editor(), index: 0 };
}

// Empty: where you are, where you have been, and the neighbours of where you
// are — usually the other project in the same folder. Typing filters that,
// unless it looks like a path, in which case it completes one.
function directoryEntries() {
  const text = state.overlay.input.text.trim();
  const known = () => suggestions(state.cwd, prefs.directories);

  if (!text) return known();
  if (text.startsWith("/") || text.startsWith("~")) return complete(text);

  const needle = text.toLowerCase();
  return known().filter((entry) => entry.toLowerCase().includes(needle));
}

function dirsBody(inner, rows) {
  const lines = new Array(rows).fill("");
  const { input } = state.overlay;
  const entries = directoryEntries();

  const here = shortenPath(state.cwd, Math.max(12, inner - 12));
  const gap = Math.max(1, inner - "directory".length - displayWidth(here));
  lines[0] = style.dim("directory") + " ".repeat(gap) + style.dim(here);

  const view = input.viewport(inner - 2);
  lines[1] = style.accent("› ") + style.bright(view.text);

  const room = Math.max(1, rows - 3);
  const active = Math.min(state.overlay.index, entries.length - 1);
  const start = Math.max(0, Math.min(active - Math.floor(room / 2), entries.length - room));

  entries.slice(start, start + room).forEach((entry, index) => {
    const at = start + index;
    const name = pad(truncate(shortenPath(entry, inner - 4), inner - 4), inner - 4);
    lines[2 + index] = at === active ? style.selected(` ${name} `) : ` ${name} `;
  });

  if (entries.length === 0) lines[2] = style.dim("no matching directory");

  lines[rows - 1] = state.overlay.error
    ? style.warn(state.overlay.error)
    : style.dim("↑↓ select · tab complete · ⏎ use · esc back");

  return { lines, caret: { row: 1, col: 2 + view.col } };
}

function chooseDirectory(value) {
  const target = expand(value);
  if (!isDirectory(target)) {
    state.overlay.error = `not a directory: ${shortenPath(target, 48)}`;
    return;
  }
  state.cwd = target;
  state.overlay = null;
}

function onDirsKey(chunk, key) {
  const overlay = state.overlay;
  const { input } = overlay;
  const entries = directoryEntries();
  const highlighted = entries[Math.min(overlay.index, entries.length - 1)];
  overlay.error = null;

  const edited = () => {
    overlay.index = 0;
    overlay.selectionMoved = false;
  };

  switch (true) {
    case key.name === "escape":
      state.overlay = null;
      break;
    case key.name === "up" || (key.ctrl && key.name === "p"):
      overlay.index = Math.max(0, Math.min(overlay.index, entries.length - 1) - 1);
      overlay.selectionMoved = true;
      break;
    case key.name === "down" || (key.ctrl && key.name === "n"):
      overlay.index = Math.min(entries.length - 1, overlay.index + 1);
      overlay.selectionMoved = true;
      break;
    case key.name === "tab":
      // Complete into the input so you can keep drilling down.
      if (highlighted) {
        overlay.input = new Editor(`${shortenPath(highlighted, 4096)}/`);
        overlay.index = 0;
        overlay.selectionMoved = false;
      }
      break;
    case chunk === "\r" || key.name === "return":
      // Navigation explicitly selects a suggestion; typing an exact path uses it.
      if (overlay.selectionMoved && highlighted) chooseDirectory(highlighted);
      else if (isDirectory(expand(input.text))) chooseDirectory(input.text);
      else if (highlighted) chooseDirectory(highlighted);
      else chooseDirectory(input.text);
      break;
    case key.ctrl && key.name === "u":
      input.clear();
      edited();
      break;
    case key.ctrl && key.name === "w":
      input.deleteWord();
      edited();
      break;
    case key.name === "backspace":
      input.backspace();
      edited();
      break;
    case key.name === "delete":
      input.deleteForward();
      edited();
      break;
    case key.name === "left":
      input.move(-1);
      break;
    case key.name === "right":
      input.move(1);
      break;
    case isPrintable(chunk, key):
      input.insert(chunk);
      edited();
      break;
    default:
      return;
  }
  scheduleRender();
}

/* ---------- input ---------- */

function onKey(chunk, key = {}) {
  if (key.name === "paste-start") {
    paste.active = true;
    paste.text = "";
    return;
  }
  if (key.name === "paste-end") {
    paste.active = false;
    insertPasted(paste.text);
    paste.text = "";
    return scheduleRender();
  }
  if (paste.active) {
    paste.text += typeof chunk === "string" ? chunk : "";
    return;
  }
  // Keypresses belonging to a burst this already handled as pasted text.
  if (swallow) return;
  // The late half of an escape already acted on above.
  if (key.name === "escape" && pendingEscapes > 0) {
    pendingEscapes -= 1;
    return;
  }

  if (key.ctrl && key.name === "c") return quit(0);
  if (key.ctrl && key.name === "v") {
    pasteFromClipboard();
    return scheduleRender();
  }
  if (state.overlay) {
    return state.overlay.type === "dirs" ? onDirsKey(chunk, key) : onAgentsKey(chunk, key);
  }
  return onMainKey(chunk, key);
}

// Runs before the keypress events for the same chunk, so it can claim a burst
// the terminal did not mark as a paste.
function onData(chunk) {
  if (paste.active || swallow) return;

  // A lone ESC byte in its own read is the Escape key. Terminals send real
  // escape sequences in a single write, so there is nothing more coming — but
  // readline cannot know that and waits 500ms before giving up on a sequence,
  // which is a very long time to watch a modal sit there after you cancelled it.
  if (chunk.length === 1 && chunk[0] === ESC) {
    pendingEscapes += 1;
    onEscape();
    return;
  }

  if (chunk[0] === ESC) return; // an escape sequence, however long, is not a paste
  if (chunk.length <= BURST_BYTES) return;

  burst = chunk.toString("utf8");
  swallow = true;
  setImmediate(() => {
    swallow = false;
    const text = burst;
    burst = "";
    if (!text) return;
    insertPasted(text);
    render();
  });
}

// Reading the clipboard can block for a second on WSL, so say what is happening
// before going to fetch it.
function pasteFromClipboard() {
  state.notice = "reading clipboard…";
  render();

  const text = readClipboard();
  state.notice = null;

  if (text === null) {
    state.notice = "no clipboard tool found — install xclip, xsel or wl-clipboard";
    return;
  }
  if (!text) {
    state.notice = "clipboard is empty";
    return;
  }
  insertPasted(text);
}

function onEscape() {
  if (state.overlay) {
    state.overlay = null;
    return scheduleRender();
  }
  quit(0);
}

function insertPasted(text) {
  const clean = sanitizePasted(text);
  if (!clean) return;
  if (state.overlay) {
    const flat = clean.replace(/\n/g, "");
    if (state.overlay.type === "dirs") {
      state.overlay.input.insert(flat);
      state.overlay.selectionMoved = false;
    } else {
      state.overlay.filter += flat.toLowerCase();
    }
    state.overlay.index = 0;
    return;
  }
  state.prompt.insert(clean);
}

function cycleAgent(step) {
  const chips = chipAgents();
  const at = chips.indexOf(agent());
  const next = chips[(Math.max(0, at) + step + chips.length) % chips.length];
  state.agent = agents.indexOf(next);
}

function onMainKey(chunk, key) {
  const prompt = state.prompt;
  state.notice = null;

  switch (true) {
    case key.name === "up":
      prompt.moveVertical(-1, content() - 2);
      break;
    case key.name === "down":
      prompt.moveVertical(1, content() - 2);
      break;
    case key.name === "escape":
      return quit(0);
    // \r launches; \n (ctrl+j) inserts a newline.
    case chunk === "\r" || key.name === "return":
      return launch();
    case chunk === "\n" || (key.ctrl && key.name === "j"):
      prompt.insert("\n");
      break;
    case key.name === "tab" && key.shift:
      cycleAgent(-1);
      break;
    case key.name === "tab":
      cycleAgent(1);
      break;
    case key.ctrl && key.name === "k":
      state.overlay = { type: "agents", filter: "", index: state.agent };
      break;
    case key.ctrl && key.name === "d":
      openDirectories();
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
      // The recovery notice offers this as the way to be rid of the draft, so
      // it has to actually throw it away rather than just empty the buffer.
      if (recoveredFile) {
        discardRequest(recoveredFile);
        recoveredFile = null;
        state.notice = "recovered draft discarded";
      }
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
  scheduleRender();
}

function onAgentsKey(chunk, key) {
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
  scheduleRender();
}

// alt+N always means the same agent as the chip numbered N.
function pickChip(index) {
  const chips = chipAgents();
  if (index < chips.length) state.agent = agents.indexOf(chips[index]);
}

function isPrintable(chunk, key) {
  return Boolean(chunk) && !key.ctrl && !key.meta && chunk >= " " && chunk !== "\x7f";
}

/* ---------- launch ---------- */

function launch() {
  const chosen = agent();
  if (!chosen) return quit(0);

  remember(chosen.kind, destination().id, state.cwd);
  const request = writeRequest({
    submittedAt: Date.now(),
    kind: chosen.kind,
    prompt: state.prompt.text.trim(),
    destination: destination().id,
    cwd: state.cwd,
    workspace,
    pane: originPane,
  });

  spawnDetached(process.execPath, [LAUNCHER, request]);
  if (recoveredFile) {
    discardRequest(recoveredFile);
    recoveredFile = null;
  }
  quit(0);
}

function quit(code) {
  out.write("\x1b[?2004l\x1b[?25h\x1b[2J\x1b[H");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

/* ---------- boot ---------- */

// A popup that dies takes its output with it: pane commands are not in
// `herdr plugin log list`, so a crash would otherwise be a window that blinks
// once and vanishes. Leave a trail.
function reportCrash(error) {
  const detail = error?.stack ?? String(error);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, "crash.log"), `${new Date().toISOString()}\n${detail}\n\n`);
  } catch {
    // Nothing more we can do from in here.
  }
  notify("Quick Prompt crashed", `${String(error).slice(0, 160)} — see crash.log in ${STATE_DIR}`);
  process.exit(1);
}

process.on("uncaughtException", reportCrash);

if (!process.stdin.isTTY) {
  process.stderr.write("quick-prompt: picker needs an interactive terminal\n");
  process.exit(1);
}

// Ask the terminal to wrap pastes in markers, and register the raw-data
// listener before readline's so it sees each chunk first.
out.write("\x1b[?2004h");
process.stdin.on("data", onData);

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("keypress", onKey);
out.on("resize", render);
render();
