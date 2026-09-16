"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { STATE_DIR } = require("./state");

function createTiming({ kind, destination = "tab", submittedAt }) {
  const start = performance.now();
  const record = {
    at: new Date().toISOString(), kind, destination,
    dispatchMs: Number.isFinite(submittedAt) ? Math.max(0, Date.now() - submittedAt) : null,
    steps: [],
  };
  return {
    measure(command, fn) {
      const before = performance.now();
      const step = { command };
      try {
        const result = fn();
        step.ok = result?.ok !== false;
        if (result?.code) step.code = result.code;
        return result;
      } catch (error) {
        step.ok = false;
        throw error;
      } finally {
        step.ms = Math.round(performance.now() - before);
        record.steps.push(step);
      }
    },
    finish(success) {
      record.success = success;
      record.workerMs = Math.round(performance.now() - start);
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        const file = path.join(STATE_DIR, "startup.jsonl");
        // Keep one previous log; diagnostics must not grow indefinitely.
        if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) {
          fs.copyFileSync(file, `${file}.previous`);
          fs.truncateSync(file);
        }
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      } catch { /* timing must never prevent a launch */ }
    },
  };
}

module.exports = { createTiming };
