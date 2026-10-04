"use strict";

const { performance } = require("node:perf_hooks");
const { appendLog } = require("./state");

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
    note(fields) {
      Object.assign(record, fields);
    },
    finish(success, error) {
      record.success = success;
      if (error) record.error = error;
      record.workerMs = Math.round(performance.now() - start);
      appendLog("startup.jsonl", `${JSON.stringify(record)}\n`);
    },
  };
}

module.exports = { createTiming };
