"use strict";

// The screens that open over the prompt: every key, the running agents, every
// agent kind, the model and effort, presets, and the working directory. Each
// has a body to paint and a key handler that returns whether it took the key.

const { Editor } = require("../shared/editor");
const { rememberModel } = require("../state");
const { style, pad, truncate, shortenPath, displayWidth } = require("../shared/ui");
const { complete, expand, isDirectory, suggestions } = require("../dirs");
const { modelsFor, effortsFor } = require("../models");
const { PRESETS } = require("../presets");
const { runningAgents, matches } = require("../running");
const { prefs, presets, presetProblems, state, agent, choice, missing } = require("./session");
const { editKey, isPrintable } = require("./editing");
const { applyPreset } = require("./actions");

/* ---------- every key ---------- */

const KEYS = [
  ["⏎", "launch"],
  ["ctrl+l", "launch, stay here"],
  ["\\⏎ shift+⏎", "new line"],
  ["↑ ↓", "lines, then history"],
  ["tab alt+1…9", "next or Nth agent"],
  ["ctrl+k", "every agent"],
  ["ctrl+t", "where it opens"],
  ["ctrl+n", "new worktree, or back"],
  ["ctrl+d", "directory"],
  ["ctrl+o", "model and effort"],
  ["ctrl+p ctrl+x", "preset, remove it"],
  ["ctrl+r", "follow up an agent"],
  ["ctrl+s", "save as a note"],
  ["ctrl+v", "paste clipboard"],
  ["ctrl+u ctrl+y", "clear, bring back"],
  ["ctrl+w", "delete a word"],
  ["ctrl+a ctrl+e", "line start, end"],
  ["esc", "close, keep draft"],
];

function helpBody(inner, rows) {
  const lines = new Array(rows).fill("");
  lines[0] = style.dim("keys");
  const keyWidth = Math.max(...KEYS.map(([key]) => displayWidth(key))) + 1;
  const cell = ([key, what], width) => truncate(`${style.accent(pad(key, keyWidth))}${what}`, width);

  // Two columns when they fit, otherwise one that scrolls.
  const columns = inner >= 66 ? 2 : 1;
  const perColumn = Math.ceil(KEYS.length / columns);
  const room = rows - 3;
  const top = columns === 1 ? Math.min(state.overlay.top, Math.max(0, KEYS.length - room)) : 0;
  state.overlay.top = top;
  const half = Math.floor(inner / columns);
  for (let row = 0; row < Math.min(perColumn, room); row += 1) {
    const left = KEYS[top + row];
    const right = columns === 2 ? KEYS[perColumn + row] : null;
    lines[2 + row] = pad(cell(left, half - 1), half) + (right ? cell(right, half - 1) : "");
  }
  lines[rows - 1] = style.dim(columns === 1 ? "↑↓ scroll · esc back" : "esc back");
  return { lines, caret: null };
}

function onHelpKey(chunk, key) {
  switch (true) {
    case key.name === "escape" || (key.ctrl && key.name === "g"):
      state.overlay = null;
      break;
    case key.name === "up":
      state.overlay.top = Math.max(0, state.overlay.top - 1);
      break;
    case key.name === "down":
      state.overlay.top += 1;
      break;
    default:
      return false;
  }
  return true;
}

/* ---------- follow-up to a running agent ---------- */

function openRunning() {
  const listed = runningAgents();
  state.overlay = { type: "running", filter: "", index: 0, agents: listed ?? [], unanswered: !listed };
}

function runningMatches() {
  return state.overlay.agents.filter((entry) => matches(entry, state.overlay.filter));
}

function runningBody(inner, rows) {
  const lines = new Array(rows).fill("");
  const list = runningMatches();

  lines[0] = state.overlay.filter
    ? `${style.dim("running agent")}  ${style.accent(state.overlay.filter)}${style.dim("▏")}`
    : style.dim("running agent");

  if (list.length === 0) {
    lines[1] = style.warn(state.overlay.unanswered ? "herdr did not answer · esc and try again"
      : state.overlay.agents.length ? "no running agent matches that filter" : "no agents are running");
    lines[rows - 1] = style.dim("esc back");
    return { lines, caret: null };
  }

  const room = rows - 2;
  const active = Math.min(state.overlay.index, list.length - 1);
  const start = Math.max(0, Math.min(active - Math.floor(room / 2), list.length - room));

  list.slice(start, start + room).forEach((entry, index) => {
    // The title is what tells agents apart, so the path gives way first.
    const status = `${entry.kind} · ${entry.status} `;
    const pathRoom = Math.min(20, inner - displayWidth(status) - Math.min(displayWidth(entry.title), 24) - 6);
    const detail = pathRoom >= 8 ? `${status}· ${shortenPath(entry.cwd, pathRoom)} ` : status;
    const name = pad(truncate(` ${entry.title}`, inner - displayWidth(detail) - 2), inner - displayWidth(detail));
    const plain = entry.status === "blocked" ? style.warn(detail) : style.dim(detail);
    lines[1 + index] = start + index === active ? style.selected(name + detail) : name + plain;
  });

  lines[rows - 1] = state.overlay.error
    ? style.warn(state.overlay.error)
    : style.dim("↑↓ select · type to filter · ⏎ follow up · esc back");
  return { lines, caret: null };
}

function onRunningKey(chunk, key) {
  const list = runningMatches();
  const highlighted = list[Math.min(state.overlay.index, list.length - 1)];
  state.overlay.error = null;

  switch (true) {
    case key.name === "escape":
      escapeOverlay();
      break;
    case key.ctrl && key.name === "r":
      state.overlay = null;
      break;
    case key.name === "up" || (key.ctrl && key.name === "p"):
      state.overlay.index = Math.max(0, Math.min(state.overlay.index, list.length - 1) - 1);
      break;
    case key.name === "down" || (key.ctrl && key.name === "n"):
      state.overlay.index = Math.min(list.length - 1, state.overlay.index + 1);
      break;
    // Herdr refuses a prompt to a blocked agent, so it would only come back as
    // a failed draft.
    case (key.name === "return" || key.name === "enter") && highlighted?.status === "blocked":
      state.overlay.error = `${truncate(highlighted.title, 30)} is blocked · answer it in its pane first`;
      break;
    case key.name === "return" || key.name === "enter":
      if (highlighted) state.followUp = highlighted;
      state.overlay = null;
      break;
    case key.name === "backspace":
      state.overlay.filter = state.overlay.filter.slice(0, -1);
      state.overlay.index = 0;
      break;
    case isPrintable(chunk, key):
      state.overlay.filter += chunk.toLowerCase();
      state.overlay.index = 0;
      break;
    default:
      return false;
  }
  return true;
}

/* ---------- the full agent list ---------- */

function overlayMatches() {
  const needle = state.overlay.filter.toLowerCase();
  return state.agents.filter((item) => item.kind.includes(needle));
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

function onAgentsKey(chunk, key) {
  const list = overlayMatches();

  switch (true) {
    case key.name === "escape":
      escapeOverlay();
      break;
    case key.ctrl && key.name === "k":
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
      if (chosen) state.agent = state.agents.indexOf(chosen);
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
      return false;
  }
  return true;
}

/* ---------- the model and effort ---------- */

function openModels() {
  const kind = agent().kind;
  if (!modelsFor(kind)) {
    state.notice = `no model choice for ${kind}`;
    return;
  }
  const { model, effort } = choice();
  state.overlay = { type: "model", kind, index: modelsFor(kind).indexOf(model), effort };
}

const optionName = (value) => value ?? "default";

function modelBody(inner, rows) {
  const lines = new Array(rows).fill("");
  const { kind, index, effort } = state.overlay;
  const models = modelsFor(kind);

  lines[0] = style.dim("model") + " ".repeat(Math.max(1, inner - 5 - displayWidth(kind))) + style.dim(kind);

  const room = Math.max(1, rows - 4);
  const start = Math.max(0, Math.min(index - Math.floor(room / 2), models.length - room));
  models.slice(start, start + room).forEach((model, offset) => {
    const name = pad(optionName(model), Math.max(10, inner - 2));
    lines[1 + offset] = start + offset === index ? style.selected(` ${name} `) : ` ${name} `;
  });

  const efforts = effortsFor(kind, models[index]).map((value) => (value === effort
    ? style.selected(` ${optionName(value)} `)
    : ` ${optionName(value)} `));
  lines[rows - 2] = `${style.dim("effort")} ${efforts.join("")}`;
  lines[rows - 1] = style.dim("↑↓ model · ←→ effort · ⏎ choose · esc back");
  return { lines, caret: null };
}

function onModelKey(chunk, key) {
  const overlay = state.overlay;
  const models = modelsFor(overlay.kind);
  const efforts = () => effortsFor(overlay.kind, models[overlay.index]);
  const step = (list, value, by) => list[Math.max(0, Math.min(list.length - 1, list.indexOf(value) + by))];
  const moveModel = (by) => {
    overlay.index = models.indexOf(step(models, models[overlay.index], by));
    // Not every model takes every effort.
    if (!efforts().includes(overlay.effort)) overlay.effort = null;
  };

  switch (true) {
    case key.name === "escape" || (key.ctrl && key.name === "o"):
      escapeOverlay();
      break;
    case key.name === "up" || (key.ctrl && key.name === "p"):
      moveModel(-1);
      break;
    case key.name === "down" || (key.ctrl && key.name === "n"):
      moveModel(1);
      break;
    case key.name === "left":
      overlay.effort = step(efforts(), overlay.effort, -1);
      break;
    case key.name === "right":
      overlay.effort = step(efforts(), overlay.effort, 1);
      break;
    case key.name === "return" || key.name === "enter":
      state.models[overlay.kind] = { model: models[overlay.index], effort: overlay.effort };
      rememberModel(overlay.kind, state.models[overlay.kind]);
      state.modelPicked = true;
      state.overlay = null;
      break;
    default:
      return false;
  }
  return true;
}

/* ---------- presets ---------- */

function presetMatches() {
  const needle = state.overlay.filter.toLowerCase();
  return presets.filter((item) => item.name.toLowerCase().includes(needle));
}

function presetsBody(inner, rows) {
  const lines = new Array(rows).fill("");
  const list = presetMatches();

  lines[0] = state.overlay.filter
    ? `${style.dim("preset")}  ${style.accent(state.overlay.filter)}${style.dim("▏")}`
    : style.dim("preset");

  // A broken entry is skipped, so say which one rather than let it vanish.
  let footer = rows - 2;
  if (presetProblems.length) {
    const more = presetProblems.length > 1 ? ` (+${presetProblems.length - 1} more)` : "";
    lines[rows - 3] = style.warn(`${presetProblems[0]}${more}`);
    footer = rows - 3;
  }

  if (presets.length === 0) {
    lines[1] = style.dim("no presets yet; add them to");
    lines[2] = shortenPath(PRESETS, inner);
    lines[rows - 1] = style.dim("esc back");
    return { lines, caret: null };
  }
  if (list.length === 0) {
    lines[1] = style.warn("no preset matches that filter");
    lines[rows - 1] = style.dim("esc back");
    return { lines, caret: null };
  }

  const room = footer - 1;
  const active = Math.min(state.overlay.index, list.length - 1);
  const start = Math.max(0, Math.min(active - Math.floor(room / 2), list.length - room));
  const detailWidth = Math.min(30, Math.max(10, inner - 30));
  const nameWidth = Math.max(10, inner - detailWidth - 5);

  list.slice(start, start + room).forEach((item, index) => {
    const at = start + index;
    const name = pad(truncate(item.name, nameWidth), nameWidth);
    const model = (item.model || item.effort) && [item.model, item.effort].filter(Boolean).join(" ");
    const parts = [item.agent && `${item.agent}${missing(item.agent)}`, model, item.destination, item.task === "skip" ? "skip" : null];
    const detail = style.dim(pad(truncate(parts.filter(Boolean).join(" · "), detailWidth), detailWidth));
    const mark = item.name === state.preset?.name ? style.ok("●") : " ";
    lines[1 + index] = at === active
      ? `${style.selected(` ${name}`)} ${detail} ${mark}`
      : ` ${name} ${detail} ${mark}`;
  });

  lines[rows - 2] = presetPreview(list[active], inner);
  lines[rows - 1] = style.dim("↑↓ select · type to filter · ⏎ apply, again to remove · esc back");
  return { lines, caret: null };
}

// What the highlighted preset sends, with your prompt in the middle.
function presetPreview(preset, inner) {
  const flat = (text) => text.replace(/\s+/g, " ").trim();
  const prefix = flat(preset.prefix);
  const postfix = flat(preset.postfix);
  const middle = "‹prompt›";
  const room = inner - displayWidth(middle) - 2;
  const postWidth = Math.min(displayWidth(postfix), Math.max(Math.floor(room / 2), room - displayWidth(prefix)));
  const before = prefix ? `${truncate(prefix, room - postWidth)} ` : "";
  const after = postfix ? ` ${truncate(postfix, postWidth)}` : "";
  return style.dim(before) + style.accent(middle) + style.dim(after);
}

function openPresets() {
  const index = presets.findIndex((item) => item.name === state.preset?.name);
  state.overlay = { type: "presets", filter: "", index: Math.max(0, index) };
}

function onPresetsKey(chunk, key) {
  const list = presetMatches();

  switch (true) {
    case key.name === "escape":
      escapeOverlay();
      break;
    case key.ctrl && key.name === "p":
      state.overlay = null;
      break;
    case key.name === "up":
      state.overlay.index = Math.max(0, Math.min(state.overlay.index, list.length - 1) - 1);
      break;
    case key.name === "down" || (key.ctrl && key.name === "n"):
      state.overlay.index = Math.min(list.length - 1, state.overlay.index + 1);
      break;
    case key.name === "return" || key.name === "enter": {
      const chosen = list[Math.min(state.overlay.index, list.length - 1)];
      state.overlay = null;
      if (chosen) applyPreset(chosen);
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
      return false;
  }
  return true;
}

/* ---------- the working directory ---------- */

function openDirectories() {
  state.overlay = { type: "dirs", input: new Editor(), index: 0 };
}

// Empty: where you are, where you have been, and the neighbours of where you
// are — usually the other project in the same folder. Typing filters that,
// unless it looks like a path, in which case it completes one. Both read the
// disk, so the list is kept until the text changes rather than redone per key.
function directoryEntries() {
  const overlay = state.overlay;
  const text = overlay.input.text.trim();
  const key = `${state.cwd}\0${text}`;
  if (overlay.listed?.key !== key) overlay.listed = { key, entries: listDirectories(overlay, text) };
  return overlay.listed.entries;
}

function listDirectories(overlay, text) {
  const known = () => (overlay.known ??= suggestions(state.cwd, prefs.directories));

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
      escapeOverlay();
      break;
    case key.ctrl && key.name === "d":
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
    default: {
      const before = input.text;
      if (!editKey(input, chunk, key)) return false;
      if (input.text !== before) edited();
    }
  }
  return true;
}

// A filter goes before the list does, so a mistyped one costs a single esc
// rather than the list and the place in it.
function escapeOverlay() {
  const overlay = state.overlay;
  if (overlay.filter) {
    overlay.filter = "";
    overlay.index = 0;
  } else if (overlay.input?.text) {
    overlay.input = new Editor();
    overlay.index = 0;
    overlay.selectionMoved = false;
  } else {
    state.overlay = null;
  }
}

const OVERLAYS = {
  agents: { body: agentsBody, key: onAgentsKey },
  help: { body: helpBody, key: onHelpKey },
  dirs: { body: dirsBody, key: onDirsKey },
  model: { body: modelBody, key: onModelKey },
  presets: { body: presetsBody, key: onPresetsKey },
  running: { body: runningBody, key: onRunningKey },
};

module.exports = {
  OVERLAYS,
  escapeOverlay,
  openRunning,
  openModels,
  openPresets,
  openDirectories,
  directoryEntries,
  helpBody,
  runningBody,
  presetsBody,
  dirsBody,
  onRunningKey,
  onModelKey,
  onPresetsKey,
  onDirsKey,
};
