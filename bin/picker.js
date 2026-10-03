"use strict";

// Popup entrypoint: one screen. The cursor starts in the prompt because that is
// what you came here to write; the agent and the destination are one keystroke
// away, and the agents you do not have installed stay behind ctrl+k.
//
// Herdr draws the popup's border and title, so this renders bare inside it.

const readline = require("node:readline");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");

const { catalog, runningAgent } = require("../lib/agents");
const { Editor } = require("../lib/editor");
const { History } = require("../lib/history");
const { spawnDetached, notify } = require("../lib/herdr");
const { STATE_DIR, readPrefs, remember, readHistory, recordPrompt, writeRequest, sweepStaleRequests, readDraft, saveDraft, clearDraft, logCrash } = require("../lib/state");
const { style, pad, truncate, shortenPath, displayWidth } = require("../lib/ui");
const { sanitizePasted } = require("../lib/text");
const { readClipboard } = require("../lib/clipboard");
const { stage, prune } = require("../lib/dropped");
const { KITTY_ON, KITTY_OFF, legacyKeys } = require("../lib/keys");
const { complete, expand, isDirectory, suggestions } = require("../lib/dirs");
const { modelsFor, effortsFor, normalize, modelLabel } = require("../lib/models");
const { PRESETS, readPresets, composePrompt } = require("../lib/presets");
const { insideRepo } = require("../lib/worktree");
const { runningAgents, matches } = require("../lib/running");
const scratchpad = require("../lib/scratchpad");

const LAUNCHER = path.join(__dirname, "launch.js");
const ATTACHMENTS = path.join(STATE_DIR, "attachments");

const DESTINATIONS = [
  { id: "tab", label: "new tab" },
  { id: "right", label: "split right" },
  { id: "down", label: "split down" },
  { id: "workspace", label: "new workspace" },
  { id: "worktree", label: "new worktree" },
];

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
const { presets, problems: presetProblems } = readPresets();
sweepStaleRequests();
// Another plugin can open the picker with the prompt already written, as
// Scratchpad does with notes. A handed-over prompt never touches the drafts:
// it did not come from this box, and the one you left here stays for later.
const handoff = process.env.QUICK_PROMPT_TEXT || null;
const { draft = null, file: openedDraft = null } = (handoff ? null : readDraft()) ?? {};
// A handed-over prompt from Scratchpad is already a note there.
const canSaveNote = !handoff && scratchpad.available();
// The draft file this popup opened, and the only one it may replace or clear:
// a launch that fails while it is open leaves a draft of its own. Null once
// thrown away, so the notice says so only once, and always null for a handoff.
let draftFile = openedDraft;
// The duplicate action starts from the agent in the pane you came from, which
// is a deliberate ask, so it outranks both a restored draft and recency.
const duplicate = process.env.QUICK_PROMPT_DUPLICATE ? runningAgent(originPane) : null;
const out = process.stdout;

// A paste is a burst of keypresses: inside it a newline is content, not "launch",
// and a tab is content, not "next agent". Bracketed paste gives explicit markers;
// the byte-count check covers terminals that do not send them.
const BURST_BYTES = 6;
const ESC = 0x1b;

const paste = { active: false, text: "" };
let burst = "";
let swallow = false;

// The first of these that is a kind Herdr knows starts selected.
function initialAgent(...wanted) {
  for (const kind of wanted) {
    const at = agents.findIndex((a) => a.kind === kind);
    if (at >= 0) return at;
  }
  return Math.max(0, agents.findIndex((a) => a.installed));
}

// The kind Enter was refused for, so that Enter again launches it anyway.
let launchAnyway = null;

// A failed follow-up's draft has no model and no destination of its own, so
// those come from preferences rather than resetting them.
const draftDestination = DESTINATIONS.some((d) => d.id === draft?.destination) ? draft.destination : null;
const draftModel = draft && (draft.model !== undefined || draft.effort !== undefined);

const state = {
  // Recency decides which chip starts selected; it never moves the chips.
  agent: initialAgent(duplicate?.kind, draft?.kind, prefs.recents[0]),
  destination: Math.max(0, DESTINATIONS.findIndex((d) => d.id === (draftDestination ?? prefs.destination))),
  prompt: new Editor(handoff ?? draft?.prompt ?? ""),
  history: new History(readHistory()),
  cwd: duplicate?.cwd ?? draft?.cwd ?? cwd, // where the agent will be started; ctrl+d changes it
  preset: draft?.preset ?? null,
  followUp: draft?.followUp ?? null, // the running agent Enter sends to, instead of launching
  models: draftModel ? { ...prefs.models, [draft.kind]: draft } : { ...prefs.models },
  overlay: null, // { type: "agents" | "dirs" | "presets" | "model" | "running", ... } while a picker is open
  notice: handoff ? `From ${process.env.QUICK_PROMPT_SOURCE || "another plugin"} · ⏎ launch · ctrl+r follow up instead`
    : draft?.failed ? `Recovered failed ${draft.followUp ? "follow-up" : "launch"} · edit or Enter to retry · ctrl+u clear`
    : draft ? "Restored draft · ctrl+u clear" : null,
};

// A restored follow-up names a pane that may have closed since, or now runs
// another agent. When Herdr cannot say, keep it: the worker will find out.
if (state.followUp) {
  const live = runningAgents();
  const { target, kind, title } = state.followUp;
  if (live && !live.some((entry) => entry.target === target && entry.kind === kind)) {
    state.followUp = null;
    state.notice = `${truncate(title, 24)} is no longer running · ⏎ launches a new ${kind}`;
  }
}

// Every cell inside the popup has to be written: cells this never paints show
// whatever was on the screen behind it.
const GUTTER = 1;
const width = () => Math.max(40, out.columns ?? 73);
const height = () => Math.max(8, out.rows ?? 12);
const content = () => Math.max(28, width() - GUTTER * 2);
const agent = () => agents[state.agent];
const destination = () => DESTINATIONS[state.destination];
// null for a kind with no model picker.
const choice = () => (modelsFor(agent().kind) ? normalize(agent().kind, state.models[agent().kind]) : null);

// The chip row is the agents you actually have, plus whatever is selected. The
// other twenty kinds Herdr knows about are noise until you go looking (ctrl+k).
const chips = agents.filter((item) => item.installed);
const noneInstalled = chips.length === 0;
// Marks a kind that is not on PATH wherever one can be picked.
const missing = (kind) => (agents.find((item) => item.kind === kind)?.installed === false ? " ○" : "");
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
  const body = state.overlay ? OVERLAYS[state.overlay.type].body(inner, rows) : mainBody(inner, rows);

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
  lines[1] = state.followUp ? followUpRow(inner) : chipRow(inner);
  if (state.preset) lines[2] = presetRow();

  const caret = promptBlock(lines, 3, Math.max(1, rows - 6), inner);

  lines[rows - 3] = style.dim("─".repeat(inner));
  lines[rows - 2] = state.followUp ? followUpWhere(inner) : destinationRow(inner);
  lines[rows - 1] = state.notice ? style.warn(state.notice) : style.dim(hints());
  return { lines, caret };
}

function chipRow(inner) {
  const chips = chipAgents();
  const label = (item, index) => `${index < SHORTCUTS ? `${index + 1} ` : ""}${item.kind}${missing(item.kind)}`;

  const hint = noneInstalled ? "no agent found on PATH · ctrl+k" : "ctrl+k";
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
      const mark = missing(item.kind) && style.dim(missing(item.kind));
      return ` ${number}${item.kind}${mark} `;
    })
    .join(" ");

  const hidden = agents.length - shown.length;
  const tail = noneInstalled ? style.warn(hint) : style.dim(hidden > 0 ? `+${hidden} ${hint}` : hint);
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
// with the destination: what will happen, with which model, and where, each next
// to the key that changes it. A long model name gives up its key hint before the
// path is squeezed below legibility.
function destinationRow(inner) {
  const join = ` ${style.dim("·")} `;
  const row = (model) => {
    const parts = [`${destination().label} ${style.dim("(ctrl+t)")}`, model].filter(Boolean);
    return `${style.dim("→")} ${parts.join(join)}${join}`;
  };
  const tail = ` ${style.dim("(ctrl+d)")}`;
  const room = (head) => inner - displayWidth(head) - displayWidth(tail);

  const label = choice() && modelLabel(choice());
  let head = row(label && `${label} ${style.dim("(ctrl+o)")}`);
  if (room(head) < 12) head = row(label);

  return `${head}${shortenPath(state.cwd, Math.max(12, room(head)))}${tail}`;
}

function presetRow() {
  return `${style.dim("preset")} ${style.accent(state.preset.name)}  ${style.dim("ctrl+p change · ctrl+x clear")}`;
}

function hints() {
  if (state.followUp) return "⏎ send · ctrl+r other agent · ctrl+v paste · \\⏎ newline · esc back";
  const verb = composePrompt(state.preset, state.prompt.text) ? "⏎ launch" : "⏎ open agent";
  if (canSaveNote) return `${verb} · tab agent · ctrl+r follow up · ctrl+s note · esc cancel`;
  return `${verb} · tab agent · ctrl+r follow up · \\⏎ newline · esc cancel`;
}

/* ---------- follow-up to a running agent ---------- */

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
    const detail = `${entry.kind} · ${entry.status} · ${shortenPath(entry.cwd, 20)} `;
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
    case key.name === "escape" || (key.ctrl && key.name === "r"):
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
      return;
  }
  scheduleRender();
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
      state.overlay = null;
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
      state.overlay = null;
      break;
    default:
      return;
  }
  scheduleRender();
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
  let footer = rows - 1;
  if (presetProblems.length) {
    const more = presetProblems.length > 1 ? ` (+${presetProblems.length - 1} more)` : "";
    lines[rows - 2] = style.warn(`${presetProblems[0]}${more}`);
    footer = rows - 2;
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
  const detailWidth = 18;
  const nameWidth = Math.max(10, inner - detailWidth - 5);

  list.slice(start, start + room).forEach((item, index) => {
    const at = start + index;
    const name = pad(truncate(item.name, nameWidth), nameWidth);
    const detail = style.dim(pad(truncate([item.agent && `${item.agent}${missing(item.agent)}`, item.task === "skip" ? "skip" : null]
      .filter(Boolean).join(" · "), detailWidth), detailWidth));
    const mark = item.name === state.preset?.name ? style.ok("●") : " ";
    lines[1 + index] = at === active
      ? `${style.selected(` ${name}`)} ${detail} ${mark}`
      : ` ${name} ${detail} ${mark}`;
  });

  lines[rows - 1] = style.dim("↑↓ select · type to filter · ⏎ apply, again to remove · esc back");
  return { lines, caret: null };
}

function openPresets() {
  const index = presets.findIndex((item) => item.name === state.preset?.name);
  state.overlay = { type: "presets", filter: "", index: Math.max(0, index) };
}

// Choosing the preset already applied takes it off again. A skip preset over an
// empty prompt has nothing left to ask for, so it launches straight away. In a
// follow-up only the text applies: the agent is already chosen, and sending
// stays a deliberate Enter.
function applyPreset(preset) {
  if (state.preset?.name === preset.name) {
    state.preset = null;
    return;
  }
  state.preset = preset;
  if (state.followUp) return;
  if (preset.agent) {
    const index = agents.findIndex((item) => item.kind === preset.agent);
    if (index < 0) {
      state.notice = `preset ${preset.name}: herdr has no agent kind "${preset.agent}"`;
      return;
    }
    state.agent = index;
  }
  if (preset.task === "skip" && state.prompt.isEmpty) launch();
}

function onPresetsKey(chunk, key) {
  const list = presetMatches();

  switch (true) {
    case key.name === "escape":
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
      return;
  }
  scheduleRender();
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
      if (!editKey(input, chunk, key)) return;
      if (input.text !== before) edited();
    }
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

  if (key.ctrl && key.name === "c") return quit(0);
  if (key.ctrl && key.name === "v") {
    pasteFromClipboard();
    return scheduleRender();
  }
  if (state.overlay) return OVERLAYS[state.overlay.type].key(chunk, key);
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
  state.agent = agents.indexOf(next);
}

function onMainKey(chunk, key) {
  const prompt = state.prompt;
  state.notice = null;
  const anyway = launchAnyway;
  launchAnyway = null;

  switch (true) {
    // Up and down walk the prompt's own lines first and history only past its
    // top and bottom, so a multi-line prompt stays editable.
    case key.name === "up":
      if (!prompt.moveVertical(-1, content() - 2)) recall(state.history.older(prompt.text));
      break;
    case key.name === "down":
      if (!prompt.moveVertical(1, content() - 2)) recall(state.history.newer());
      break;
    case key.name === "escape":
      return back();
    // A running agent already has its kind, its place and its directory.
    case Boolean(state.followUp) && launchControl(key):
      return;
    case isNewline(chunk, key):
      prompt.insert("\n");
      break;
    // A backslash before Enter asks for a newline instead, as in Claude Code.
    case chunk === "\r" || key.name === "return":
      if (prompt.cells[prompt.cursor - 1] !== "\\") return launch(anyway);
      prompt.backspace();
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
    case key.ctrl && key.name === "r":
      openRunning();
      break;
    case key.ctrl && key.name === "o":
      openModels();
      break;
    case key.ctrl && key.name === "p":
      openPresets();
      break;
    case key.ctrl && key.name === "x":
      state.preset = null;
      break;
    case key.ctrl && key.name === "t":
      cycleDestination();
      break;
    case key.ctrl && key.name === "s":
      return saveNote();
    case key.meta && /^[1-9]$/.test(key.name ?? ""):
      pickChip(Number(key.name) - 1);
      break;
    case key.ctrl && key.name === "u":
      prompt.clear();
      // The draft notice offers this as the way to be rid of the draft, so it
      // has to actually throw it away rather than just empty the buffer.
      if (draftFile) {
        clearDraft(draftFile);
        draftFile = null;
        // What the draft brought along goes with it; a choice made since stays.
        if (state.followUp === draft.followUp) state.followUp = null;
        if (state.preset === draft.preset) state.preset = null;
        state.notice = "draft discarded";
      }
      break;
    default:
      if (!editKey(prompt, chunk, key)) return;
  }
  scheduleRender();
}

function launchControl(key) {
  return key.name === "tab"
    || (key.ctrl && ["k", "t", "d", "o"].includes(key.name))
    || (key.meta && /^[1-9]$/.test(key.name ?? ""));
}

function recall(text) {
  if (text !== null) state.prompt = new Editor(text);
}

// Plain \r launches. \n is ctrl+j, or shift+enter and ctrl+enter as
// lib/keys translates them. ESC \r is alt+enter, and shift+enter in terminals
// set up the way Claude Code's /terminal-setup does it.
function isNewline(chunk, key) {
  return chunk === "\n" || (key.ctrl && key.name === "j") || (key.meta && key.name === "return");
}

// The editing keys shared by the prompt and the directory field, covering what
// Linux, Windows and macOS terminals send for them. macOS terminals with Option
// as Meta send alt+b / alt+f for option+arrow, and cmd+arrow arrives as
// ctrl+a / ctrl+e or Home / End. Returns whether the key was one of these.
function editKey(editor, chunk, key) {
  switch (true) {
    case (key.name === "left" && (key.ctrl || key.meta)) || (key.meta && key.name === "b"):
      editor.wordLeft();
      break;
    case (key.name === "right" && (key.ctrl || key.meta)) || (key.meta && key.name === "f"):
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

// A worktree needs a repository to branch from, so outside one it is skipped.
function cycleDestination() {
  do {
    state.destination = (state.destination + 1) % DESTINATIONS.length;
  } while (destination().id === "worktree" && !insideRepo(state.cwd));
}

// alt+N always means the same agent as the chip numbered N.
function pickChip(index) {
  const chips = chipAgents();
  if (index < chips.length) state.agent = agents.indexOf(chips[index]);
}

function isPrintable(chunk, key) {
  return Boolean(chunk) && !key.ctrl && !key.meta && chunk >= " " && chunk !== "\x7f";
}

const OVERLAYS = {
  agents: { body: agentsBody, key: onAgentsKey },
  dirs: { body: dirsBody, key: onDirsKey },
  model: { body: modelBody, key: onModelKey },
  presets: { body: presetsBody, key: onPresetsKey },
  running: { body: runningBody, key: onRunningKey },
};

/* ---------- launch ---------- */

function launch(anyway = null) {
  if (state.followUp) return sendFollowUp();

  const chosen = agent();
  if (!chosen) return quit(0);

  // The popup only sees its own PATH, and a pane's shell can add to it, so a
  // second Enter launches anyway.
  if (!chosen.installed && anyway !== chosen.kind) {
    state.notice = `${chosen.kind} is not on PATH · ⏎ again to launch anyway · ctrl+k to pick another`;
    launchAnyway = chosen.kind;
    return scheduleRender();
  }

  // The directory can change after the worktree was chosen, or a recovered
  // draft can bring one along.
  if (destination().id === "worktree" && !insideRepo(state.cwd)) {
    state.notice = "no worktree outside a git repository · ctrl+t or ctrl+d to change";
    return scheduleRender();
  }

  remember(chosen.kind, destination().id, state.cwd, choice());
  recordPrompt(state.prompt.text);
  const request = writeRequest({
    submittedAt: Date.now(),
    kind: chosen.kind,
    ...choice(),
    prompt: state.prompt.text.trim(),
    preset: state.preset,
    destination: destination().id,
    cwd: state.cwd,
    workspace,
    pane: originPane,
    ...(handoff && { handoff: true }),
  });
  // Only once the request holds the prompt.
  clearDraft(draftFile);

  spawnDetached(process.execPath, [LAUNCHER, request]);
  quit(0);
}

// A running agent is already at its prompt, so an empty one has nothing to do.
function sendFollowUp() {
  if (!composePrompt(state.preset, state.prompt.text)) {
    state.notice = "type a follow-up to send";
    return scheduleRender();
  }
  const { target, title, kind, cwd } = state.followUp;
  recordPrompt(state.prompt.text);
  const request = writeRequest({
    submittedAt: Date.now(),
    kind,
    prompt: state.prompt.text.trim(),
    preset: state.preset,
    destination: "follow-up",
    followUp: { target, title, kind, cwd },
    ...(handoff && { handoff: true }),
  });
  clearDraft(draftFile);
  spawnDetached(process.execPath, [LAUNCHER, request]);
  quit(0);
}

// Not now: the prompt becomes a Scratchpad note for this directory, and the
// box closes the way it does after a launch.
function saveNote() {
  const text = state.prompt.text.trim();
  if (!canSaveNote) {
    state.notice = handoff ? "this came from Scratchpad, so it is already a note there"
      : "ctrl+s needs Scratchpad: herdr plugin install Taanviir/herdr-scratchpad";
  } else if (!text) {
    state.notice = "type something to save as a note";
  } else {
    const saved = scratchpad.save(text, { cwd: state.cwd, pane: originPane });
    if (!saved.ok) {
      state.notice = `not saved: ${saved.message}`;
    } else {
      recordPrompt(text);
      clearDraft(draftFile);
      notify("Quick Prompt", `Saved to Scratchpad: ${saved.message}`, "done");
      return quit(0);
    }
  }
  scheduleRender();
}

// Closing keeps what you typed for next time, in place of the draft this
// opened with; closing an empty box forgets that draft. A handed-over prompt
// is never kept: it is still wherever it came from.
function keepDraft() {
  if (handoff) return;
  if (!state.prompt.text.trim()) return clearDraft(draftFile);
  saveDraft({ kind: agent().kind, ...choice(), prompt: state.prompt.text, preset: state.preset, followUp: state.followUp, destination: destination().id, cwd: state.cwd }, draftFile);
}

function close() {
  try {
    keepDraft();
  } catch { /* losing a draft is better than a modal that will not close */ }
  quit(0);
}

function quit(code) {
  out.write(`\x1b[?2004l${KITTY_OFF}\x1b[?25h\x1b[2J\x1b[H`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

// A popup that dies takes its output with it: pane commands are not in
// `herdr plugin log list`, so a crash would otherwise be a window that blinks
// once and vanishes. Leave a trail, and keep what was typed.
function reportCrash(error) {
  logCrash(error);
  try {
    if (state.prompt.text.trim()) keepDraft();
  } catch { /* the state that crashed may be what is broken */ }
  notify("Quick Prompt crashed", `${String(error).slice(0, 160)} — see crash.log in ${STATE_DIR}`);
  process.exit(1);
}

/* ---------- boot ---------- */

process.on("uncaughtException", reportCrash);

if (!process.stdin.isTTY) {
  process.stderr.write("quick-prompt: picker needs an interactive terminal\n");
  process.exit(1);
}

// Ask the terminal to wrap pastes in markers and to tell a modified Enter
// apart. Each chunk reaches onData before readline sees it as keypresses.
out.write(`\x1b[?2004h${KITTY_ON}`);
const decoder = new StringDecoder("utf8");
const keys = new PassThrough();
process.stdin.on("data", (raw) => {
  const chunk = Buffer.from(legacyKeys(decoder.write(raw)));
  if (!chunk.length) return;
  if (!onData(chunk)) keys.write(chunk);
});

readline.emitKeypressEvents(keys);
keys.on("keypress", onKey);
process.stdin.setRawMode(true);
process.stdin.resume();
out.on("resize", render);
render();
// Copies are only pruned on a drop otherwise, and someone who stops dropping
// screenshots would keep the last week's for ever. Not before the first paint.
setImmediate(() => prune(ATTACHMENTS));
