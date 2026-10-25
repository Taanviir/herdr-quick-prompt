"use strict";

const { spawnSync, spawn, execFile } = require("node:child_process");

const BIN = process.env.HERDR_BIN_PATH ?? "herdr";

class HerdrError extends Error {
  constructor(message, { args, stderr, status } = {}) {
    super(message);
    this.name = "HerdrError";
    this.args = args;
    this.stderr = stderr;
    this.status = status;
  }
}

// A command that waits on Herdr's side carries its own --timeout; the process
// gets that plus some slack. Anything else that takes this long has hung.
const DEFAULT_TIMEOUT_MS = 30000;
const SLACK_MS = 5000;

function deadline(args) {
  const at = args.indexOf("--timeout");
  const waits = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isFinite(waits) ? waits + SLACK_MS : DEFAULT_TIMEOUT_MS;
}

// Run a herdr CLI command. Server errors arrive as JSON on stderr with status 1,
// syntax errors as status 2.
function run(args, { check = true, timeout = deadline(args) } = {}) {
  const res = spawnSync(BIN, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return outcome(args, res, check);
}

// The same, without holding up the popup while Herdr answers. Never throws.
function runAsync(args, { timeout } = {}) {
  return new Promise((resolve) => {
    const child = execFile(BIN, args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
      // A non-zero exit is Herdr answering; anything else is no answer at all.
      const failed = error && typeof error.code !== "number" ? error : null;
      resolve(outcome(args, { error: failed, status: error ? error.code : 0, stdout, stderr }, false));
    });
    child.stdin?.end();
  });
}

function outcome(args, res, check) {
  if (res.error) {
    const message = res.error.code === "ETIMEDOUT" ? `herdr ${args.slice(0, 2).join(" ")} did not answer in time` : res.error.message;
    if (!check) return { ok: false, message };
    throw new HerdrError(message, { args });
  }

  if (res.status !== 0) {
    const { message = `herdr ${args[0] ?? ""} failed`, code } = errorDetails(res.stderr);
    if (!check) return { ok: false, message, code, status: res.status };
    throw new HerdrError(message, { args, stderr: res.stderr, status: res.status });
  }

  return { ok: true, result: parse(res.stdout), stdout: res.stdout };
}

function parse(stdout) {
  try {
    return JSON.parse(stdout).result ?? {};
  } catch {
    return {};
  }
}

function errorDetails(stderr) {
  const text = (stderr ?? "").trim();
  if (!text) return {};
  const line = text.split("\n").find((l) => l.trim().startsWith("{")) ?? text;
  try {
    const parsed = JSON.parse(line);
    const err = parsed.error ?? parsed;
    return { message: err.message ?? err.code ?? text, code: err.code };
  } catch {
    return { message: text };
  }
}

// Fire-and-forget: survives the caller exiting (the popup closes on exit).
function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function notify(title, body, sound = "request") {
  run(["notification", "show", title, "--body", body, "--sound", sound], { check: false });
}

module.exports = { BIN, HerdrError, run, runAsync, spawnDetached, notify };
