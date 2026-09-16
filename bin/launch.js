"use strict";

// Detached worker: create the tab, start the agent in it, deliver the prompt.
// Runs after the popup has closed so the modal never blocks on agent startup.

const fs = require("node:fs");
const { run, notify, HerdrError } = require("../lib/herdr");
const { supportsInlinePrompt } = require("../lib/agents");

const START_ATTEMPTS = 12;
const START_RETRY_MS = 400;
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 400;
const READY_POLLS = 40;
// Agent TUIs repaint for a moment after they report readiness, and keystrokes
// sent into that repaint are lost.
const SETTLE_MS = 900;
const DELIVERY_ATTEMPTS = 3;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readRequest(file) {
  const request = JSON.parse(fs.readFileSync(file, "utf8"));
  try {
    fs.unlinkSync(file);
  } catch {
    // A stale request file is harmless.
  }
  return request;
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

function createSplit({ pane, cwd, direction }) {
  if (!pane) throw new HerdrError("no pane to split; open Quick Prompt from a pane");

  const args = ["pane", "split", pane, "--direction", direction, "--focus"];
  if (cwd) args.push("--cwd", cwd);

  const { result } = run(args);
  const created = result.pane?.pane_id;
  if (!created) throw new HerdrError("herdr did not return a pane for the split");
  return created;
}

// Where the agent lands: its own tab, a split beside the caller, or a whole new
// workspace.
function createTarget(request) {
  if (request.destination === "right" || request.destination === "down") {
    return createSplit({ pane: request.pane, cwd: request.cwd, direction: request.destination });
  }
  if (request.destination === "workspace") {
    return createWorkspace({ cwd: request.cwd });
  }
  return createTab({ workspace: request.workspace, cwd: request.cwd });
}

// A freshly created tab may not be at its interactive prompt yet, and
// `agent start` requires that, so retry briefly before giving up.
//
// `inline` is passed through to the agent's own CLI after `--`, which hands the
// agent its prompt before its TUI even paints.
function startAgent(name, kind, pane, inline) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", pane];
  if (inline) args.push("--", inline);

  let last = "agent did not start";

  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(args, { check: false });
    if (res.ok) return { started: true, ready: true };

    last = res.message;
    // Startup reached the agent but it is not idle: either a trust dialog, or
    // an inline prompt it is already working on. Either way the name is live.
    const reason = `${res.code ?? ""} ${last}`;
    if (/agent_not_ready/i.test(reason)) return { started: true, ready: false, message: last };
    if (!/pane|shell|prompt|busy|not_available/i.test(reason)) break;
    sleep(START_RETRY_MS);
  }

  return { started: false, message: last };
}

function main() {
  const file = process.argv[2];
  if (!file) process.exit(2);

  const request = readRequest(file);
  const { kind, prompt } = request;

  const name = uniqueName(kind);
  const pane = createTarget(request);

  const inline = prompt && supportsInlinePrompt(kind) ? prompt : null;
  let delivered = Boolean(inline);
  let started = startAgent(name, kind, pane, inline);

  // The agent rejected our launch arguments rather than failing to start; try
  // again bare and fall back to typing the prompt in.
  if (!started.started && inline) {
    delivered = false;
    started = startAgent(name, kind, pane, null);
  }
  if (!started.started) throw new HerdrError(started.message);

  // Delivered at launch: nothing left to type.
  if (delivered || !prompt) return;

  if (!started.ready) {
    // Blocked on a trust or login dialog; wait for the user to clear it.
    const waited = run(["agent", "wait", name, "--until", "idle", "--timeout", String(READY_TIMEOUT_MS)], {
      check: false,
    });
    if (waited.ok === false) {
      notify("Quick Prompt", `${kind} needs attention before it can take the prompt.`);
      return;
    }
  }

  if (!waitInteractive(name)) {
    notify("Quick Prompt", `${kind} never became ready for input.`);
    return;
  }

  if (!deliverPrompt(name, prompt)) {
    notify("Quick Prompt", `${kind} started but did not accept the prompt.`);
  }
}

function agentState(name) {
  const res = run(["agent", "get", name], { check: false });
  return res.ok ? res.result?.agent ?? {} : {};
}

function waitInteractive(name) {
  for (let poll = 0; poll < READY_POLLS; poll += 1) {
    if (agentState(name).interactive_ready) return true;
    sleep(READY_POLL_MS);
  }
  return false;
}

// `agent prompt` can report success while the agent's startup repaint eats the
// keystrokes, so confirm the text actually landed before giving up on it.
function deliverPrompt(name, prompt) {
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt += 1) {
    sleep(SETTLE_MS);

    const sent = run(["agent", "prompt", name, prompt], { check: false });
    if (sent.ok === false && !/stalled|blocked|not_ready|busy/i.test(`${sent.code ?? ""} ${sent.message}`)) {
      notify("Quick Prompt", `Could not send the prompt: ${sent.message}`);
      return false;
    }

    sleep(SETTLE_MS);
    if (promptLanded(name, prompt)) return true;
  }
  return false;
}

function promptLanded(name, prompt) {
  const status = agentState(name).agent_status;
  if (status === "working" || status === "blocked") return true;

  const res = run(["agent", "read", name, "--source", "detection", "--lines", "60"], { check: false });
  if (!res.ok) return false;

  const screen = (res.result?.text ?? res.stdout ?? "").replace(/\s+/g, " ");
  const needle = prompt.split("\n")[0].trim().slice(0, 16).replace(/\s+/g, " ");
  return needle.length > 0 && screen.includes(needle);
}

try {
  main();
} catch (error) {
  notify("Quick Prompt failed", error.message ?? String(error));
  process.exit(1);
}
