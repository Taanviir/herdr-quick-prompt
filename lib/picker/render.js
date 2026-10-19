"use strict";

// Painting the popup: the main screen row by row, or whichever overlay is open.

const { style, pad, truncate, shortenPath, displayWidth } = require("../ui");
const { modelLabel } = require("../models");
const { composePrompt } = require("../presets");
const { branchSlug } = require("../worktree");
const { state, agent, destination, choice, missing, chipAgents } = require("./session");
const { OVERLAYS } = require("./overlays");

const SHORTCUTS = 9;
const out = process.stdout;

// Every cell inside the popup has to be written: cells this never paints show
// whatever was on the screen behind it.
const GUTTER = 1;
const width = () => Math.max(40, out.columns ?? 73);
const height = () => Math.max(8, out.rows ?? 12);
const content = () => Math.max(28, width() - GUTTER * 2);

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
  const body = state.overlay ? OVERLAYS[state.overlay.type].body(inner, rows) : mainBody(inner, rows);

  // Every row covers the full width, so nothing from the last frame survives
  // and there is no need to clear the screen first.
  const gutter = " ".repeat(GUTTER);
  const painted = [];
  for (let row = 0; row < rows; row += 1) {
    painted.push(gutter + pad(truncate(body.lines[row] ?? "", inner), inner) + gutter);
  }

  const cursor = body.caret ? `\x1b[${body.caret.row + 1};${GUTTER + body.caret.col + 1}H\x1b[?25h` : "\x1b[?25l";
  out.write(`\x1b[H${painted.join("\r\n")}${cursor}`);
}

function mainBody(inner, rows) {
  const lines = new Array(rows).fill("");
  lines[1] = state.followUp ? followUpRow(inner) : chipRow(inner);

  const { caret, above, below } = promptBlock(lines, 3, Math.max(1, rows - 6), inner);
  lines[2] = statusRow(inner, above);

  lines[rows - 3] = rule(inner, below);
  lines[rows - 2] = state.followUp ? followUpWhere(inner) : destinationRow(inner);
  lines[rows - 1] = state.notice ? style.warn(state.notice) : style.dim(hints(inner));
  return { lines, caret };
}

// Above the prompt: the preset on the left, and on the right where you are in
// history and how much of a long prompt is scrolled out of view.
function statusRow(inner, above) {
  const notes = [];
  if (state.history.position) notes.push(`history ${state.history.position}/${state.history.entries.length}`);
  if (above) notes.push(`↑ ${above} more`);
  const right = style.dim(notes.join(" · "));
  if (!state.preset) return notes.length ? " ".repeat(Math.max(0, inner - displayWidth(right))) + right : "";

  let left = presetRow(true);
  if (displayWidth(left) + displayWidth(right) + 1 > inner) left = presetRow(false);
  return left + " ".repeat(Math.max(1, inner - displayWidth(left) - displayWidth(right))) + right;
}

function rule(inner, below) {
  if (!below) return style.dim("─".repeat(inner));
  const label = ` ↓ ${below} more `;
  return style.dim(`${"─".repeat(Math.max(0, inner - displayWidth(label) - 2))}${label}──`);
}

function chipRow(inner) {
  const chips = chipAgents();
  const label = (item, index) => `${index < SHORTCUTS ? `${index + 1} ` : ""}${item.kind}${missing(item.kind)}`;

  const noneInstalled = !state.agents.some((item) => item.installed);
  const hint = noneInstalled ? "no agent found on PATH · ctrl+k" : "ctrl+k";
  const room = inner - displayWidth(`+${state.agents.length} more · ${hint}`) - 1;

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
      const mark = missing(item.kind) && style.dim(missing(item.kind));
      return ` ${number}${item.kind}${mark} `;
    })
    .join(" ");

  const hidden = state.agents.length - shown.length;
  const tail = noneInstalled ? style.warn(hint) : style.dim(hidden > 0 ? `+${hidden} more · ${hint}` : hint);
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

  return {
    caret: { row: top + (caret.row - from), col: 2 + caret.col },
    above: from,
    below: Math.max(0, wrapped.length - from - rows),
  };
}

// The popup's title bar has no room for the working directory, so it rides along
// with the destination: what will happen, with which model, and where, each next
// to the key that changes it. The model only shows once it is not the default.
// Before the path is squeezed below legibility, the row gives up the model's
// key hint, then the destination's, and then a worktree branch's length.
const PATH_ROOM = 12;

function destinationRow(inner) {
  const join = ` ${style.dim("·")} `;
  const tail = ` ${style.dim("(ctrl+d)")}`;
  const picked = choice();
  const model = picked && (picked.model || picked.effort) ? modelLabel(picked) : null;
  const branch = destination().id === "worktree" ? branchSlug(state.prompt.text, state.preset) || null : null;

  const head = ({ modelKey = true, branchWidth = Infinity, destinationKey = true } = {}) => {
    const where = destination().id === "worktree"
      ? `${destination().label} ${style.dim("·")} ${branch ? truncate(branch, branchWidth) : style.dim("random branch")}`
      : destination().label;
    const parts = [
      destinationKey ? `${where} ${style.dim("(ctrl+t)")}` : where,
      model && (modelKey ? `${model} ${style.dim("(ctrl+o)")}` : model),
    ].filter(Boolean);
    return `${style.dim("→")} ${parts.join(join)}${join}`;
  };
  const room = (text) => inner - displayWidth(text) - displayWidth(tail);

  let chosen = head();
  if (room(chosen) < PATH_ROOM) chosen = head({ modelKey: false });
  if (room(chosen) < PATH_ROOM) chosen = head({ modelKey: false, destinationKey: false });
  if (room(chosen) < PATH_ROOM && branch) {
    const branchWidth = Math.max(8, displayWidth(branch) - (PATH_ROOM - room(chosen)));
    chosen = head({ modelKey: false, destinationKey: false, branchWidth });
  }

  return `${chosen}${shortenPath(state.cwd, Math.max(PATH_ROOM, room(chosen)))}${tail}`;
}

function presetRow(withKeys) {
  const name = `${style.dim("preset")} ${style.accent(state.preset.name)}`;
  return withKeys ? `${name}  ${style.dim("ctrl+p change · ctrl+x clear")}` : name;
}

// What the next key is likely to be: on an empty prompt, ways to fill it; once
// typing, ways to send it. Everything else is behind ctrl+g.
function hints(inner) {
  let parts;
  if (state.followUp) {
    parts = ["⏎ send", "ctrl+r other agent", "\\⏎ newline", "esc back", "ctrl+g keys"];
  } else if (state.prompt.isEmpty) {
    const verb = composePrompt(state.preset, "") ? "⏎ launch" : null;
    const history = state.history.entries.length ? "↑ history" : null;
    parts = [verb, history, "ctrl+p presets", "ctrl+r follow up", "ctrl+g keys"].filter(Boolean);
  } else {
    parts = ["⏎ launch", "ctrl+l launch & stay", state.canSaveNote && "ctrl+s note", "\\⏎ newline", "esc close"].filter(Boolean);
  }
  return fit(parts, inner);
}

// Keeps the first and last, dropping from just before the last until it fits.
function fit(parts, width) {
  const kept = [...parts];
  while (kept.length > 2 && displayWidth(kept.join(" · ")) > width) kept.splice(-2, 1);
  return kept.join(" · ");
}

function followUpRow(inner) {
  const { title, kind, status } = state.followUp;
  const tail = style.dim(status ? `${kind} · ${status}` : kind);
  const name = truncate(title, Math.max(8, inner - displayWidth(tail) - 3));
  const head = `${style.accent("→")} ${style.bright(name)}`;
  return head + " ".repeat(Math.max(1, inner - displayWidth(head) - displayWidth(tail))) + tail;
}

function followUpWhere(inner) {
  const where = shortenPath(state.followUp.cwd, Math.max(12, inner - 24));
  return `${style.dim("→")} follow-up ${style.dim("(ctrl+r)")} ${style.dim("·")} ${where}`;
}

module.exports = { content, scheduleRender, render, mainBody, chipRow, destinationRow, hints };
