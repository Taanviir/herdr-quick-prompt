"use strict";

const { spawnSync, spawn } = require("node:child_process");

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

// Run a herdr CLI command. Server errors arrive as JSON on stderr with status 1,
// syntax errors as status 2.
function run(args, { check = true } = {}) {
  const res = spawnSync(BIN, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.error) {
    if (!check) return { ok: false, message: res.error.message };
    throw new HerdrError(res.error.message, { args });
  }

  if (res.status !== 0) {
    const message = errorMessage(res.stderr) ?? `herdr ${args[0] ?? ""} failed`;
    if (!check) return { ok: false, message, status: res.status };
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

function errorMessage(stderr) {
  const text = (stderr ?? "").trim();
  if (!text) return null;
  const line = text.split("\n").find((l) => l.trim().startsWith("{")) ?? text;
  try {
    const parsed = JSON.parse(line);
    const err = parsed.error ?? parsed;
    return err.message ?? err.code ?? text;
  } catch {
    return text;
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

module.exports = { BIN, HerdrError, run, spawnDetached, notify };
