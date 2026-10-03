"use strict";

// The agents already running in Herdr, for sending one a follow-up.

const { run } = require("./herdr");

// Agents waiting on you come first: those are the ones a follow-up is for.
// Herdr rejects a prompt to a blocked agent outright, so those go last.
const RANK = { idle: 0, done: 0, working: 1, unknown: 2, blocked: 3 };

const rank = (entry) => RANK[entry.status] ?? RANK.unknown;

// The pane is the target rather than the agent's name, since most agents are
// started by hand and never get one.
function parseAgents(result) {
  return (result?.agents ?? [])
    .filter((agent) => agent.pane_id)
    .map((agent) => ({
      target: agent.pane_id,
      title: agent.terminal_title_stripped || agent.name || agent.agent || agent.pane_id,
      kind: agent.agent ?? "agent",
      status: agent.agent_status ?? "unknown",
      cwd: agent.foreground_cwd ?? agent.cwd ?? "",
      changed: agent.state_change_seq ?? 0,
    }))
    .sort((a, b) => rank(a) - rank(b) || b.changed - a.changed);
}

function runningAgents() {
  const res = run(["agent", "list"], { check: false });
  return res.ok ? parseAgents(res.result) : [];
}

function matches(entry, filter) {
  const needle = filter.toLowerCase();
  return [entry.title, entry.kind, entry.cwd].some((field) => field.toLowerCase().includes(needle));
}

module.exports = { parseAgents, runningAgents, matches };
