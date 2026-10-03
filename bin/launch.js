"use strict";

// Detached worker: create the tab, start the agent in it, deliver the prompt.
// Runs after the popup has closed so the modal never blocks on agent startup.
// A follow-up skips all of that and prompts an agent that is already running.

const fs = require("node:fs");
const { finishRequest } = require("../lib/state");
const { run: herdrRun, notify, HerdrError } = require("../lib/herdr");
const { createTiming } = require("../lib/timing");
const { supportsInlinePrompt } = require("../lib/agents");
const { modelArgs } = require("../lib/models");
const { composePrompt } = require("../lib/presets");
const { branchName, uniqueBranch } = require("../lib/worktree");

const START_ATTEMPTS = 12;
const START_RETRY_MS = 400;
const START_TIMEOUT_MS = 15000;
// An agent handed its prompt inline goes straight to work on it and may never
// look ready to Herdr, while a launch argument Herdr refuses comes back within
// milliseconds. A short wait tells the two apart.
const INLINE_START_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 400;
const READY_POLLS = 40;
// Agent TUIs repaint for a moment after they report readiness, and keystrokes
// sent into that repaint are lost.
const SETTLE_MS = 900;
const DELIVERY_ATTEMPTS = 3;
const FOLLOW_UP_TIMEOUT_MS = 20000;
let timing;

function run(args, options) {
  return timing
    ? timing.measure(args.slice(0, 2).join(" "), () => herdrRun(args, options))
    : herdrRun(args, options);
}

function sleep(ms) {
  const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  if (timing) timing.measure("sleep", wait);
  else wait();
}

function readRequest(file) {
  const request = JSON.parse(fs.readFileSync(file, "utf8"));
  return request;
}

// `message` is for the notification. startup.jsonl gets `logged`, since it must
// never hold prompt text and an agent's title is often a summary of its prompt.
function failure(message, logged = message) {
  return Object.assign(new HerdrError(message), { logged });
}

// Names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents.
function uniqueName(kind) {
  const taken = new Set();
  const res = run(["agent", "list"], { check: false });
  for (const agent of res.result?.agents ?? []) {
    if (agent.name) taken.add(agent.name);
  }

  const base = `qp-${kind}`.slice(0, 30);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

// Deliberately unlabelled. A label taken from the prompt is a snapshot of the
// first second and wrong by the second minute; agents publish their own live
// titles, and Herdr shows those.
function createTab({ workspace, cwd }) {
  const args = ["tab", "create", "--focus"];
  if (workspace) args.push("--workspace", workspace);
  if (cwd) args.push("--cwd", cwd);

  const { result } = run(args);
  const pane = result.root_pane?.pane_id;
  if (!pane) throw new HerdrError("herdr did not return a pane for the new tab");
  return pane;
}

// Herdr labels a workspace from its directory, which is what you want here.
function createWorkspace({ cwd }) {
  const args = ["workspace", "create", "--focus"];
  if (cwd) args.push("--cwd", cwd);

  const { result } = run(args);
  const pane = result.root_pane?.pane_id;
  if (!pane) throw new HerdrError("herdr did not return a pane for the new workspace");
  return pane;
}

// A new branch of the directory's repository, checked out in a workspace of its
// own. The workspace is labelled with the branch, since every worktree of one
// repository would otherwise share its name.
function createWorktree({ cwd, prompt }) {
  const branch = uniqueBranch(cwd, branchName(prompt));
  const args = ["worktree", "create", "--cwd", cwd, "--branch", branch, "--label", branch, "--focus"];

  const { result } = run(args);
  const pane = result.root_pane?.pane_id;
  if (!pane) throw new HerdrError("herdr did not return a pane for the new worktree");
  return pane;
}

function createSplit({ pane, cwd, direction }) {
  if (!pane) throw new HerdrError("no pane to split; open Quick Prompt from a pane");

  const args = ["pane", "split", pane, "--direction", direction, "--focus"];
  if (cwd) args.push("--cwd", cwd);

  const { result } = run(args);
  const created = result.pane?.pane_id;
  if (!created) throw new HerdrError("herdr did not return a pane for the split");
  return created;
}

// Where the agent lands: its own tab, a split beside the caller, a whole new
// workspace, or a new worktree.
function createTarget(request) {
  if (request.destination === "right" || request.destination === "down") {
    return createSplit({ pane: request.pane, cwd: request.cwd, direction: request.destination });
  }
  if (request.destination === "workspace") {
    return createWorkspace({ cwd: request.cwd });
  }
  if (request.destination === "worktree") {
    return createWorktree({ cwd: request.cwd, prompt: request.prompt });
  }
  return createTab({ workspace: request.workspace, cwd: request.cwd });
}

// A freshly created tab may not be at its interactive prompt yet, and
// `agent start` requires that, so retry briefly before giving up.
//
// `agentArgs` are passed through to the agent's own CLI after `--`. An inline
// prompt goes last among them, which hands the agent its prompt before its TUI
// even paints.
function startAgent(name, kind, pane, agentArgs, timeoutMs) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", String(timeoutMs)];
  if (agentArgs.length > 0) args.push("--", ...agentArgs);

  let last = "agent did not start";

  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(args, { check: false });
    if (res.ok) return { started: true, ready: true };

    last = res.message;
    // The agent is running but not idle: a trust dialog, an inline prompt it is
    // already working on, or simply slower than the timeout. `agent_pane_busy`
    // on a pane this launch created is the same agent, seen by a retry.
    const reason = `${res.code ?? ""} ${last}`;
    if (res.code === "invalid_agent_argument") break;
    if (res.code === "timeout" || /agent_not_ready|agent_pane_busy/i.test(reason)) {
      return { started: true, ready: false, message: last };
    }
    if (!/pane|shell|prompt|busy|not_available/i.test(reason)) break;
    sleep(START_RETRY_MS);
  }

  return { started: false, message: last };
}

function main() {
  const file = process.argv[2];
  if (!file) process.exit(2);

  const request = readRequest(file);
  timing = createTiming(request);
  const prompt = composePrompt(request.preset, request.prompt);
  if (request.followUp) return followUp(request.followUp, prompt);
  const { kind } = request;

  const name = uniqueName(kind);
  // From here on the agent is addressed by its pane. Herdr accepts either, and
  // an `agent start` that times out may never have registered the name.
  const pane = createTarget(request);

  // Herdr refuses a launch argument with a newline in it, so multiline prompts
  // are typed in instead.
  const inline = prompt && !prompt.includes("\n") && supportsInlinePrompt(kind) ? prompt : null;
  timing?.note({ inline: Boolean(inline) });
  const options = modelArgs(kind, request);
  let delivered = Boolean(inline);
  let started = inline
    ? startAgent(name, kind, pane, [...options, inline], INLINE_START_TIMEOUT_MS)
    : startAgent(name, kind, pane, options, START_TIMEOUT_MS);

  // The agent rejected the inline prompt rather than failing to start; try
  // again without it and fall back to typing the prompt in.
  if (!started.started && inline) {
    delivered = false;
    timing?.note({ inline: false });
    started = startAgent(name, kind, pane, options, START_TIMEOUT_MS);
  }
  if (!started.started) throw new HerdrError(started.message);

  // Delivered at launch: nothing left to type.
  if (delivered || !prompt) return;

  if (!started.ready) {
    // Blocked on a trust or login dialog; wait for the user to clear it.
    const waited = run(["agent", "wait", pane, "--until", "idle", "--timeout", String(READY_TIMEOUT_MS)], {
      check: false,
    });
    if (waited.ok === false) throw failure(`${kind} needs attention: ${waited.message}`);
  }

  if (!waitInteractive(pane)) throw failure(`${kind} never became ready`);
  deliverPrompt(pane, kind, prompt);
}

// The agent is past its startup repaint, so the keystrokes are not at risk the
// way they are for a fresh one. Herdr confirms the prompt landed by seeing the
// agent start working on it.
function followUp({ target, title }, prompt) {
  const sent = run([
    "agent", "prompt", target, prompt,
    "--wait", "--until", "working", "--until", "blocked", "--timeout", String(FOLLOW_UP_TIMEOUT_MS),
  ], { check: false });
  if (!sent.ok) {
    throw failure(`${title} did not take the follow-up: ${sent.message}`, `follow-up not taken: ${sent.message}`);
  }
}

function agentState(pane) {
  const res = run(["agent", "get", pane], { check: false });
  return res.ok ? res.result?.agent ?? {} : {};
}

function waitInteractive(pane) {
  for (let poll = 0; poll < READY_POLLS; poll += 1) {
    if (agentState(pane).interactive_ready) return true;
    sleep(READY_POLL_MS);
  }
  return false;
}

// `agent prompt` can report success while the agent's startup repaint eats the
// keystrokes, so confirm the text actually landed before giving up on it.
function deliverPrompt(pane, kind, prompt) {
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt += 1) {
    sleep(SETTLE_MS);

    const sent = run(["agent", "prompt", pane, prompt], { check: false });
    if (sent.ok === false && !/stalled|blocked|not_ready|busy/i.test(`${sent.code ?? ""} ${sent.message}`)) {
      throw failure(`could not send the prompt to ${kind}: ${sent.message}`);
    }

    sleep(SETTLE_MS);
    if (promptLanded(pane, prompt)) return;
  }
  throw failure(`${kind} did not accept the prompt`);
}

function promptLanded(pane, prompt) {
  const status = agentState(pane).agent_status;
  if (status === "working" || status === "blocked") return true;

  const res = run(["agent", "read", pane, "--source", "detection", "--lines", "60"], { check: false });
  if (!res.ok) return false;

  const screen = (res.result?.text ?? res.stdout ?? "").replace(/\s+/g, " ");
  const needle = prompt.split("\n")[0].trim().slice(0, 16).replace(/\s+/g, " ");
  return needle.length > 0 && screen.includes(needle);
}

try {
  main();
  timing?.finish(true);
  finishRequest(process.argv[2], true);
} catch (error) {
  const message = error.message ?? String(error);
  timing?.finish(false, error.logged ?? message);
  finishRequest(process.argv[2], false);
  notify("Quick Prompt failed", `${message} — reopen Quick Prompt to recover your draft.`);
  process.exit(1);
}
