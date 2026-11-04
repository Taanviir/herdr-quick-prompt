"use strict";

// The terminal plumbing for a full-screen popup: raw input, pastes, a prompt
// Escape, a full repaint, and a crash trail. The popup only supplies a body and
// a key handler.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { PassThrough } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { KITTY_ON, KITTY_OFF, legacyKeys } = require("./keys");
const { notify } = require("./herdr");
const { pad, truncate } = require("./ui");
const { sanitizePasted } = require("./text");

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(__dirname, "..", "..", ".state");
const GUTTER = 1;
// A paste is a burst of keypresses: inside it a newline is content, not
// "save". Bracketed paste gives explicit markers; the byte count covers
// terminals that do not send them.
const BURST_BYTES = 6;
const ESC = 0x1b;

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {
    return {};
  }
}

// `body(width, rows)` returns { lines, caret? }. `onKey(chunk, key)`,
// `onPaste(text)` and `onEscape()` change state; the screen repaints after each.
// `onInterrupt()` runs on ctrl+c and has to quit. `title` names the plugin
// in its crash notification.
function start({ title, name, body, onKey, onPaste = () => {}, onEscape, onInterrupt = () => quit(0) }) {
  const out = process.stdout;
  const width = () => Math.max(30, (out.columns ?? 76) - GUTTER * 2);
  const height = () => Math.max(6, out.rows ?? 12);

  function render() {
    const inner = width();
    const rows = height();
    const view = body(inner, rows);
    const painted = [];
    for (let row = 0; row < rows; row += 1) {
      painted.push(" ".repeat(GUTTER) + pad(truncate(view.lines[row] ?? "", inner), inner) + " ".repeat(GUTTER));
    }
    // Every row is painted to full width, so drawing over the last frame needs
    // no clear, and skipping it is what keeps the popup from flickering.
    out.write(`\x1b[H${painted.join("\r\n")}`);
    if (view.caret) out.write(`\x1b[${view.caret.row + 1};${GUTTER + view.caret.col + 1}H\x1b[?25h`);
    else out.write("\x1b[?25l");
  }

  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      render();
    });
  }

  function quit(code = 0) {
    out.write(`\x1b[?2004l${KITTY_OFF}\x1b[?25h\x1b[2J\x1b[H`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(code);
  }

  // Pane commands are not in `herdr plugin log list`, so a crash would
  // otherwise be a popup that blinks once and vanishes.
  process.on("uncaughtException", (error) => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(path.join(STATE_DIR, "crash.log"), `${new Date().toISOString()} ${name}\n${error?.stack ?? error}\n\n`);
    } catch { /* nothing more to do from in here */ }
    notify(`${title} crashed`, `${String(error).slice(0, 160)} — see crash.log in ${STATE_DIR}`);
    process.exit(1);
  });

  if (!process.stdin.isTTY) {
    process.stderr.write(`${title}: ${name} needs an interactive terminal\n`);
    process.exit(1);
  }

  const paste = { active: false, text: "" };
  let swallow = false;

  const pasted = (text) => {
    const clean = sanitizePasted(text);
    if (clean) onPaste(clean);
    scheduleRender();
  };

  // Runs before readline sees the chunk, so it can claim a burst the terminal
  // did not mark as a paste, and act on Escape without readline's 500ms wait.
  // Returns true when the chunk is handled and readline must not see it: a
  // lone ESC handed on would make readline read the next key as alt+key.
  function onData(chunk) {
    if (paste.active || swallow) return false;
    if (chunk.length === 1 && chunk[0] === ESC) {
      onEscape();
      scheduleRender();
      return true;
    }
    if (chunk[0] === ESC || chunk.length <= BURST_BYTES) return false;
    swallow = true;
    const text = chunk.toString("utf8");
    setImmediate(() => {
      swallow = false;
      pasted(text);
    });
    return false;
  }

  function keypress(chunk, key = {}) {
    if (key.name === "paste-start") {
      paste.active = true;
      paste.text = "";
      return;
    }
    if (key.name === "paste-end") {
      paste.active = false;
      pasted(paste.text);
      return;
    }
    if (paste.active) {
      paste.text += typeof chunk === "string" ? chunk : "";
      return;
    }
    if (swallow) return;
    if (key.ctrl && key.name === "c") return onInterrupt();
    onKey(chunk, key);
    scheduleRender();
  }

  out.write(`\x1b[?2004h${KITTY_ON}`);
  const decoder = new StringDecoder("utf8");
  const keys = new PassThrough();
  process.stdin.on("data", (raw) => {
    const chunk = Buffer.from(legacyKeys(decoder.write(raw)));
    if (!chunk.length) return;
    if (!onData(chunk)) keys.write(chunk);
  });
  readline.emitKeypressEvents(keys);
  keys.on("keypress", keypress);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.on("resize", render);
  render();

  return { render, scheduleRender, quit, width };
}

function isPrintable(chunk, key) {
  if (typeof chunk !== "string" || !chunk) return false;
  if (key.ctrl || key.meta) return false;
  if (chunk.startsWith("\x1b")) return false;
  return !/[\x00-\x1f\x7f]/.test(chunk);
}

// Plain \r saves. \n is ctrl+j, or shift+enter and ctrl+enter as lib/keys
// translates them; ESC \r is alt+enter.
function isNewline(chunk, key) {
  return chunk === "\n" || (key.ctrl && key.name === "j") || (key.meta && key.name === "return");
}

// The editing keys of a text field. Returns whether the key was one of them.
function editKey(editor, chunk, key) {
  switch (true) {
    case (key.name === "left" && key.ctrl) || (key.meta && key.name === "b"):
      editor.wordLeft();
      break;
    case (key.name === "right" && key.ctrl) || (key.meta && key.name === "f"):
      editor.wordRight();
      break;
    case key.name === "left":
      editor.move(-1);
      break;
    case key.name === "right":
      editor.move(1);
      break;
    case key.name === "home" || (key.ctrl && key.name === "a"):
      editor.toLineStart();
      break;
    case key.name === "end" || (key.ctrl && key.name === "e"):
      editor.toLineEnd();
      break;
    // ctrl+backspace arrives as a bare \b in most terminals.
    case (key.name === "backspace" && key.meta) || chunk === "\b" || (key.ctrl && key.name === "w"):
      editor.deleteWord();
      break;
    case (key.name === "delete" && (key.ctrl || key.meta)) || (key.meta && key.name === "d"):
      editor.deleteWordForward();
      break;
    case key.name === "backspace":
      editor.backspace();
      break;
    case key.name === "delete":
      editor.deleteForward();
      break;
    case key.ctrl && key.name === "u":
      editor.clear();
      break;
    case isPrintable(chunk, key):
      editor.insert(chunk);
      break;
    default:
      return false;
  }
  return true;
}

module.exports = { STATE_DIR, context, start, isPrintable, isNewline, editKey };
