"use strict";

// Every key and paste: the main screen's keys, the open overlay's, and telling
// a paste apart from typing.

const { Editor } = require("../editor");
const { clearDraft } = require("../state");
const { sanitizePasted } = require("../text");
const { readClipboard } = require("../clipboard");
const { stage } = require("../dropped");
const { modelsFor } = require("../models");
const { insideRepo } = require("../worktree");
const { ATTACHMENTS, DESTINATIONS, presets, draft, state, agent, destination, choice, chipAgents } = require("./session");
const { content, scheduleRender, render } = require("./render");
const { OVERLAYS, escapeOverlay, openRunning, openModels, openPresets, openDirectories } = require("./overlays");
const { launch, saveNote, close, quit } = require("./actions");
const { isNewline, editKey } = require("./editing");

// A paste is a burst of keypresses: inside it a newline is content, not "launch",
// and a tab is content, not "next agent". Bracketed paste gives explicit markers;
// the byte-count check covers terminals that do not send them.
const BURST_BYTES = 6;
const ESC = 0x1b;

const paste = { active: false, text: "" };
let burst = "";
let swallow = false;

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

  if (key.ctrl && key.name === "c") return quit(0);
  if (key.ctrl && key.name === "v") return pasteFromClipboard();
  if (state.overlay) {
    if (OVERLAYS[state.overlay.type].key(chunk, key)) scheduleRender();
    return;
  }
  return onMainKey(chunk, key);
}

// Runs before the keypress events for the same chunk, so it can claim a burst
// the terminal did not mark as a paste. Returns true when it has dealt with the
// chunk and readline must not see it.
function onData(chunk) {
  if (paste.active || swallow) return false;

  // A lone ESC byte in its own read is the Escape key. Terminals send real
  // escape sequences in a single write, so there is nothing more coming — but
  // readline cannot know that and waits 500ms before giving up on a sequence,
  // which is a very long time to watch a modal sit there after you cancelled it.
  // Handed to readline anyway, it would swallow the next key as alt+key.
  if (chunk.length === 1 && chunk[0] === ESC) {
    onEscape();
    return true;
  }

  if (chunk[0] === ESC) return false; // an escape sequence, however long, is not a paste
  if (chunk.length <= BURST_BYTES) return false;

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
  return false;
}

// Reading the clipboard takes a quarter of a second or more on WSL. The popup
// keeps taking keys meanwhile, and the text lands wherever the cursor is then.
const PASTING = "pasting…";
let pasting = false;

async function pasteFromClipboard() {
  if (pasting) return;
  pasting = true;
  state.notice = PASTING;
  scheduleRender();

  const text = await readClipboard();
  pasting = false;
  if (state.notice === PASTING) state.notice = null;

  if (text === null) state.notice = "no clipboard tool found — install xclip, xsel or wl-clipboard";
  else if (!text) state.notice = "clipboard is empty";
  else insertPasted(text);
  scheduleRender();
}

function onEscape() {
  if (state.overlay) {
    escapeOverlay();
    return scheduleRender();
  }
  back();
}

// Out of a follow-up and back to launching, or out of the picker altogether.
function back() {
  if (!state.followUp) return close();
  state.followUp = null;
  state.notice = null;
  scheduleRender();
}

function insertPasted(text) {
  const clean = sanitizePasted(text);
  if (!clean) return;
  if (state.overlay?.type === "model") return;
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
  const dropped = stage(clean, ATTACHMENTS);
  if (dropped?.failed.length) state.notice = `could not copy ${dropped.failed.join(", ")} · pasted its path`;
  state.prompt.insert(dropped?.text ?? clean);
}

function cycleAgent(step) {
  const chips = chipAgents();
  const at = chips.indexOf(agent());
  const next = chips[(Math.max(0, at) + step + chips.length) % chips.length];
  state.agent = state.agents.indexOf(next);
}

function onMainKey(chunk, key) {
  const prompt = state.prompt;
  state.notice = null;
  const anyway = state.launchAnyway;
  state.launchAnyway = null;

  switch (true) {
    // Up and down walk the prompt's own lines first and history only past its
    // top and bottom, so a multi-line prompt stays editable.
    case key.name === "up":
      if (!prompt.moveVertical(-1, content() - 2)) recall(state.history.older(snapshot()));
      break;
    case key.name === "down":
      if (!prompt.moveVertical(1, content() - 2)) recall(state.history.newer());
      break;
    case key.name === "escape":
      return back();
    case key.ctrl && key.name === "l":
      launch(anyway, { stay: true });
      break;
    // A running agent already has its kind, its place and its directory.
    case Boolean(state.followUp) && launchControl(key):
      state.notice = "following up · esc to launch a new agent instead";
      break;
    case isNewline(chunk, key):
      prompt.insert("\n");
      break;
    // A backslash before Enter asks for a newline instead, as in Claude Code.
    case chunk === "\r" || key.name === "return":
      if (prompt.cells[prompt.cursor - 1] === "\\") {
        prompt.backspace();
        prompt.insert("\n");
      } else {
        launch(anyway);
      }
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
    case key.ctrl && key.name === "r":
      openRunning();
      break;
    case key.ctrl && key.name === "o":
      openModels();
      break;
    case key.ctrl && key.name === "p":
      openPresets();
      break;
    case key.ctrl && key.name === "g":
      state.overlay = { type: "help", top: 0 };
      break;
    case key.ctrl && key.name === "x":
      state.preset = null;
      break;
    case key.ctrl && key.name === "t":
      cycleDestination();
      break;
    case key.ctrl && key.name === "n":
      toggleWorktree();
      break;
    case key.ctrl && key.name === "s":
      saveNote();
      break;
    case key.meta && /^[1-9]$/.test(key.name ?? ""):
      pickChip(Number(key.name) - 1);
      break;
    case key.ctrl && key.name === "u":
      if (prompt.text) state.killed = prompt.text;
      prompt.clear();
      // The draft notice offers this as the way to be rid of the draft, so it
      // has to actually throw it away rather than just empty the buffer.
      if (state.draftFile) {
        clearDraft(state.draftFile);
        state.draftFile = null;
        // What the draft brought along goes with it; a choice made since stays.
        if (state.followUp === draft.followUp) state.followUp = null;
        if (state.preset === draft.preset) state.preset = null;
        state.notice = "draft discarded · ctrl+y brings it back";
      }
      break;
    case key.ctrl && key.name === "y":
      prompt.insert(state.killed);
      break;
    default:
      if (!editKey(prompt, chunk, key)) return;
  }
  scheduleRender();
}

function launchControl(key) {
  return key.name === "tab"
    || (key.ctrl && ["k", "t", "n", "d", "o"].includes(key.name))
    || (key.meta && /^[1-9]$/.test(key.name ?? ""));
}

// What is on screen, in the shape of a history entry.
function snapshot() {
  return { text: state.prompt.text, kind: agent().kind, preset: state.preset?.name ?? null, model: choice() };
}

// A running agent keeps its own kind and model, so a follow-up takes the text
// and the preset only.
function recall(entry) {
  if (!entry) return;
  state.prompt = new Editor(entry.text);
  state.preset = presets.find((item) => item.name === entry.preset) ?? null;
  if (state.followUp) return;
  const at = state.agents.findIndex((item) => item.kind === entry.kind);
  if (at >= 0) state.agent = at;
  if (entry.model && modelsFor(entry.kind)) state.models[entry.kind] = entry.model;
}

// The worktree is not one of the places ctrl+t cycles through: ctrl+n turns it
// on, and either key goes back to where the agent was going to open.
function cycleDestination() {
  if (destination().id === "worktree") return toggleWorktree();
  do {
    state.destination = (state.destination + 1) % DESTINATIONS.length;
  } while (destination().id === "worktree");
}

// A worktree needs a repository to branch from.
function toggleWorktree() {
  if (destination().id === "worktree") {
    state.destination = state.beforeWorktree ?? 0;
    return;
  }
  if (!insideRepo(state.cwd)) {
    state.notice = "no worktree outside a git repository";
    return;
  }
  state.beforeWorktree = state.destination;
  state.destination = DESTINATIONS.findIndex((d) => d.id === "worktree");
}

// alt+N always means the same agent as the chip numbered N.
function pickChip(index) {
  const chips = chipAgents();
  if (index < chips.length) state.agent = state.agents.indexOf(chips[index]);
}

module.exports = { onKey, onData, onEscape, insertPasted, onMainKey, cycleAgent, cycleDestination, toggleWorktree };
