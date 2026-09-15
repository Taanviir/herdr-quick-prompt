"use strict";

// Detached worker: create the tab, start the agent in it, deliver the prompt.
// Runs after the popup has closed so the modal never blocks on agent startup.

const fs = require("node:fs");
const { run, notify, HerdrError } = require("../lib/herdr");

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

function tabLabel({ kind, prompt }) {
  const firstLine = prompt.split("\n")[0].trim();
  if (!firstLine) return kind;
  return firstLine.length > 24 ? `${firstLine.slice(0, 23)}…` : firstLine;
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

function createTab({ workspace, cwd, label }) {
  const args = ["tab", "create", "--label", label, "--focus"];
  if (workspace) args.push("--workspace", workspace);
  if (cwd) args.push("--cwd", cwd);

  const { result } = run(args);
  const pane = result.root_pane?.pane_id;
  if (!pane) throw new HerdrError("herdr did not return a pane for the new tab");
  return pane;
}

// A freshly created tab may not be at its interactive prompt yet, and
// `agent start` requires that, so retry briefly before giving up.
function startAgent(name, kind, pane) {
  let last = "agent did not start";

  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const res = run(["agent", "start", name, "--kind", kind, "--pane", pane], { check: false });
    if (res.ok) return { ready: true };

    last = res.message;
    // Startup reached the agent but it is waiting on a dialog: the name is live.
    if (/agent_not_ready/i.test(last)) return { ready: false, message: last };
    if (!/pane|shell|prompt|busy|not_available/i.test(last)) break;
    sleep(START_RETRY_MS);
  }

  throw new HerdrError(last);
}

function main() {
  const file = process.argv[2];
  if (!file) process.exit(2);

  const request = readRequest(file);
  const { kind, prompt, cwd, workspace } = request;

  const name = uniqueName(kind);
  const pane = createTab({ workspace, cwd, label: tabLabel(request) });
  const started = startAgent(name, kind, pane);

  if (!prompt) return;

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
    if (sent.ok === false && !/stalled|blocked|not_ready|busy/i.test(sent.message)) {
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
