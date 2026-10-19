"use strict";

// What becomes of a prompt: launched, sent to a running agent, saved as a note,
// or kept as a draft on the way out. None of these repaint; the key that set
// them off does.

const path = require("node:path");

const { Editor } = require("../editor");
const { History } = require("../history");
const { spawnDetached, notify } = require("../herdr");
const { STATE_DIR, remember, readHistory, recordPrompt, writeRequest, saveDraft, clearDraft, logCrash } = require("../state");
const { truncate } = require("../ui");
const { KITTY_OFF } = require("../keys");
const { composePrompt } = require("../presets");
const { insideRepo } = require("../worktree");
const scratchpad = require("../scratchpad");
const { DESTINATIONS, workspace, originPane, state, agent, destination, choice } = require("./session");

const LAUNCHER = path.join(__dirname, "..", "..", "bin", "launch.js");

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
  state.modelPicked = false;
  if (state.followUp) return;
  if (preset.agent) {
    const index = state.agents.findIndex((item) => item.kind === preset.agent);
    if (index < 0) {
      state.notice = `preset ${preset.name}: herdr has no agent kind "${preset.agent}"`;
      return;
    }
    state.agent = index;
  }
  if (preset.destination === "worktree" && !insideRepo(state.cwd)) {
    state.notice = `preset ${preset.name}: no worktree outside a git repository`;
    return;
  }
  if (preset.destination) state.destination = DESTINATIONS.findIndex((d) => d.id === preset.destination);
  if (preset.task === "skip" && state.prompt.isEmpty) launch();
}

// With `stay`, the agent opens without taking focus and the popup stays up
// for the next one.
function launch(anyway = null, { stay = false } = {}) {
  if (state.followUp) return sendFollowUp({ stay });

  const chosen = agent();
  if (!chosen) return quit(0);

  // The popup only sees its own PATH, and a pane's shell can add to it, so a
  // second Enter launches anyway.
  if (!chosen.installed && anyway !== chosen.kind) {
    state.notice = `${chosen.kind} is not on PATH · ⏎ again to launch anyway · ctrl+k to pick another`;
    state.launchAnyway = chosen.kind;
    return;
  }

  // The directory can change after the worktree was chosen, or a recovered
  // draft can bring one along.
  if (destination().id === "worktree" && !insideRepo(state.cwd)) {
    state.notice = "no worktree outside a git repository · ctrl+t or ctrl+d to change";
    return;
  }

  // A preset's destination is the preset's, not a new default.
  remember(chosen.kind, state.preset?.destination === destination().id ? null : destination().id, state.cwd);
  recordPrompt({ text: state.prompt.text, kind: chosen.kind, preset: state.preset?.name ?? null, model: choice() });
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
    stay,
    ...(state.handoff && { handoff: true }),
  });
  // Only once the request holds the prompt.
  clearDraft(state.draftFile);

  spawnDetached(process.execPath, [LAUNCHER, request]);
  if (!stay) return quit(0);
  ready(`${chosen.kind} is opening in a ${destination().label} · type the next one`);
}

// Ready for another, with what it was sent to still chosen.
function ready(notice) {
  state.draftFile = null;
  // Whatever comes next is typed here, so it is a draft and can be a note.
  if (state.handoff) {
    state.handoff = null;
    state.canSaveNote = scratchpad.available();
  }
  state.prompt = new Editor("");
  state.history = new History(readHistory());
  state.notice = notice;
}

// A running agent is already at its prompt, so an empty one has nothing to do.
function sendFollowUp({ stay = false } = {}) {
  if (!composePrompt(state.preset, state.prompt.text)) {
    state.notice = "type a follow-up to send";
    return;
  }
  const { target, title, kind, cwd } = state.followUp;
  recordPrompt({ text: state.prompt.text, preset: state.preset?.name ?? null });
  const request = writeRequest({
    submittedAt: Date.now(),
    kind,
    prompt: state.prompt.text.trim(),
    preset: state.preset,
    destination: "follow-up",
    followUp: { target, title, kind, cwd },
    ...(state.handoff && { handoff: true }),
  });
  clearDraft(state.draftFile);
  spawnDetached(process.execPath, [LAUNCHER, request]);
  if (!stay) return quit(0);
  ready(`sending to ${truncate(title, 30)} · type the next one`);
}

// Not now: the prompt becomes a Scratchpad note for this directory, and the
// box closes the way it does after a launch.
function saveNote() {
  const text = state.prompt.text.trim();
  if (!state.canSaveNote) {
    state.notice = state.handoff ? "this came from Scratchpad, so it is already a note there"
      : "ctrl+s needs Scratchpad: herdr plugin install Taanviir/herdr-scratchpad";
  } else if (!text) {
    state.notice = "type something to save as a note";
  } else {
    const saved = scratchpad.save(text, { cwd: state.cwd, pane: originPane });
    if (!saved.ok) {
      state.notice = `not saved: ${saved.message}`;
    } else {
      recordPrompt({ text, kind: agent().kind, preset: state.preset?.name ?? null, model: choice() });
      clearDraft(state.draftFile);
      notify("Quick Prompt", `Saved to Scratchpad: ${saved.message}`, "done");
      quit(0);
    }
  }
}

// Closing keeps what you typed for next time, in place of the draft this
// opened with; closing an empty box forgets that draft. A handed-over prompt
// is never kept: it is still wherever it came from.
function keepDraft() {
  if (state.handoff) return;
  if (!state.prompt.text.trim()) return clearDraft(state.draftFile);
  saveDraft({ kind: agent().kind, ...choice(), prompt: state.prompt.text, preset: state.preset, followUp: state.followUp, destination: destination().id, cwd: state.cwd }, state.draftFile);
}

function close() {
  try {
    keepDraft();
  } catch { /* losing a draft is better than a modal that will not close */ }
  quit(0);
}

function quit(code) {
  process.stdout.write(`\x1b[?2004l${KITTY_OFF}\x1b[?25h\x1b[2J\x1b[H`);
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

module.exports = { applyPreset, launch, sendFollowUp, saveNote, close, quit, reportCrash };
