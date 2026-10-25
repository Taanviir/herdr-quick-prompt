"use strict";

// What the popup opens with: where it was invoked from, the agents and presets
// it offers, and the draft it brings back. `state` is the one object every part
// of the picker reads and changes.

const path = require("node:path");

const { catalog, cachedCatalog, runningAgent } = require("../agents");
const { Editor } = require("../shared/editor");
const { History } = require("../history");
const { STATE_DIR, readPrefs, readHistory, sweepStaleRequests, readDraft } = require("../state");
const { truncate } = require("../shared/ui");
const { modelsFor, normalize } = require("../models");
const { readPresets } = require("../presets");
const { insideRepo } = require("../worktree");
const { runningAgents } = require("../running");
const scratchpad = require("../scratchpad");

const ATTACHMENTS = path.join(STATE_DIR, "attachments");

const DESTINATIONS = [
  { id: "tab", label: "new tab" },
  { id: "right", label: "split right" },
  { id: "down", label: "split down" },
  { id: "workspace", label: "new workspace" },
  { id: "worktree", label: "new worktree" },
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
// What the last popup found, while nothing it depends on has changed. It is
// checked again once this one is up, in case an agent was installed since.
const cachedAgents = cachedCatalog();
const agents = cachedAgents ?? catalog();
const { presets, problems: presetProblems } = readPresets();
sweepStaleRequests();
// Another plugin can open the picker with the prompt already written, as
// Scratchpad does with notes. A handed-over prompt never touches the drafts:
// it did not come from this box, and the one you left here stays for later.
const handoff = process.env.QUICK_PROMPT_TEXT || null;
const { draft = null, file: openedDraft = null } = (handoff ? null : readDraft()) ?? {};

// The first of these that is a kind Herdr knows starts selected.
function initialAgent(list, ...wanted) {
  for (const kind of wanted) {
    const at = list.findIndex((a) => a.kind === kind);
    if (at >= 0) return at;
  }
  return Math.max(0, list.findIndex((a) => a.installed));
}

// A failed follow-up's draft has no model and no destination of its own, so
// those come from preferences rather than resetting them.
const draftDestination = DESTINATIONS.some((d) => d.id === draft?.destination) ? draft.destination : null;
const draftModel = draft && (draft.model !== undefined || draft.effort !== undefined);

// A worktree needs a repository, and the directory may not be one this time.
function initialDestination(id) {
  if (id === "worktree" && !insideRepo(draft?.cwd ?? cwd)) return 0;
  return Math.max(0, DESTINATIONS.findIndex((d) => d.id === id));
}

const state = {
  agents,
  // The chip row is the agents you actually have, plus whatever is selected. The
  // other twenty kinds Herdr knows about are noise until you go looking (ctrl+k).
  chips: agents.filter((item) => item.installed),
  // Recency decides which chip starts selected; it never moves the chips.
  agent: initialAgent(agents, draft?.kind, prefs.recents[0]),
  destination: initialDestination(draftDestination ?? prefs.destination),
  prompt: new Editor(handoff ?? draft?.prompt ?? ""),
  history: new History(readHistory()),
  cwd: draft?.cwd ?? cwd, // where the agent will be started; ctrl+d changes it
  preset: draft?.preset ?? null,
  followUp: draft?.followUp ?? null, // the running agent Enter sends to, instead of launching
  models: draftModel ? { ...prefs.models, [draft.kind]: draft } : { ...prefs.models },
  killed: "", // what ctrl+u last cleared, for ctrl+y
  overlay: null, // { type: "agents" | "dirs" | "presets" | "model" | "running" | "help", ... } while one is open
  notice: handoff ? `From ${process.env.QUICK_PROMPT_SOURCE || "another plugin"} · ⏎ launch · ctrl+r follow up instead`
    : draft?.failed ? `Recovered failed ${draft.followUp ? "follow-up" : "launch"} · edit or Enter to retry · ctrl+u clear`
    : draft ? "Restored draft · ctrl+u clear" : null,
  handoff,
  // A handed-over prompt from Scratchpad is already a note there.
  canSaveNote: !handoff && scratchpad.available(),
  // The draft file this popup opened, and the only one it may replace or clear:
  // a launch that fails while it is open leaves a draft of its own. Null once
  // thrown away, so the notice says so only once, and always null for a handoff.
  draftFile: openedDraft,
  // The kind Enter was refused for, so that Enter again launches it anyway.
  launchAnyway: null,
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

const agent = () => state.agents[state.agent];
const destination = () => DESTINATIONS[state.destination];
// null for a kind with no model picker. A preset's model holds for its own
// agent, or for any when it names none, until one is picked with ctrl+o.
function choice() {
  const kind = agent().kind;
  if (!modelsFor(kind)) return null;
  const preset = state.preset;
  const fromPreset = preset && !state.modelPicked && (preset.model || preset.effort) && (!preset.agent || preset.agent === kind);
  return normalize(kind, fromPreset ? preset : state.models[kind]);
}

// Marks a kind that is not on PATH wherever one can be picked.
const missing = (kind) => (state.agents.find((item) => item.kind === kind)?.installed === false ? " ○" : "");
function chipAgents() {
  if (!state.chips.includes(agent())) state.chips.push(agent());
  return state.chips;
}

// A catalog that differs from the one painted replaces it, keeping the selected
// agent selected. Returns whether anything changed.
function useCatalog(items) {
  const same = items.length === state.agents.length
    && items.every((item, at) => item.kind === state.agents[at].kind && item.installed === state.agents[at].installed);
  if (same) return false;
  const selected = agent().kind;
  state.agents = items;
  state.agent = initialAgent(items, selected);
  state.chips = items.filter((item) => item.installed);
  return true;
}

// The duplicate action starts from the agent in the pane you came from, which
// is a deliberate ask, so it outranks both a restored draft and recency. Herdr
// is asked after the first paint, and its answer is dropped if the agent or
// directory was changed by hand while it came. Returns whether to repaint.
async function lookUpDuplicate() {
  const before = { kind: agent().kind, cwd: state.cwd };
  const found = await runningAgent(originPane);
  if (agent().kind !== before.kind || state.cwd !== before.cwd) return false;
  if (!found) {
    state.notice ??= "no agent here · starting from your last agent";
    return true;
  }
  state.agent = initialAgent(state.agents, found.kind, before.kind);
  if (found.cwd) state.cwd = found.cwd;
  return true;
}

module.exports = {
  ATTACHMENTS,
  DESTINATIONS,
  workspace,
  originPane,
  prefs,
  cachedAgents,
  presets,
  presetProblems,
  draft,
  state,
  agent,
  destination,
  choice,
  missing,
  chipAgents,
  useCatalog,
  lookUpDuplicate,
};
