"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(__dirname, "..", ".state");
const RECENTS = path.join(STATE_DIR, "recent-agents.json");
const MAX_RECENTS = 5;

function readRecents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RECENTS, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function rememberAgent(kind) {
  const next = [kind, ...readRecents().filter((k) => k !== kind)].slice(0, MAX_RECENTS);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RECENTS, JSON.stringify(next));
  } catch {
    // Recents are a convenience; never fail a launch over them.
  }
}

function writeRequest(request) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `request-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(request));
  return file;
}

module.exports = { STATE_DIR, readRecents, rememberAgent, writeRequest };
