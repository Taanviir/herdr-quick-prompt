"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(__dirname, "..", ".state");
const PREFS = path.join(STATE_DIR, "prefs.json");
const MAX_RECENTS = 8;

const MAX_DIRECTORIES = 8;
const DEFAULTS = { recents: [], destination: "tab", directories: [] };

function readPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS, "utf8"));
    return {
      recents: Array.isArray(parsed.recents) ? parsed.recents.filter((k) => typeof k === "string") : [],
      destination: typeof parsed.destination === "string" ? parsed.destination : DEFAULTS.destination,
      directories: Array.isArray(parsed.directories) ? parsed.directories.filter((d) => typeof d === "string") : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Preferences are a convenience; never fail a launch over them.
function writePrefs(prefs) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PREFS, JSON.stringify(prefs));
  } catch {
    // ignored
  }
}

function remember(kind, destination, directory) {
  const prefs = readPrefs();
  writePrefs({
    recents: [kind, ...prefs.recents.filter((k) => k !== kind)].slice(0, MAX_RECENTS),
    destination,
    directories: directory
      ? [directory, ...prefs.directories.filter((d) => d !== directory)].slice(0, MAX_DIRECTORIES)
      : prefs.directories,
  });
}

function writeRequest(request) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `request-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(request));
  return file;
}

function discardRequest(file) {
  try { fs.unlinkSync(file); } catch { /* already removed or unavailable */ }
}

function finishRequest(file, success) {
  if (!file) return;
  if (success) return discardRequest(file);
  try {
    fs.renameSync(file, path.join(path.dirname(file), `failed-${path.basename(file)}`));
  } catch { /* preserve the original request if renaming fails */ }
}

function readFailedRequest() {
  try {
    const files = fs.readdirSync(STATE_DIR).filter((name) => /^failed-request-\d+-\d+\.json$/.test(name)).sort().reverse();
    for (const name of files) {
      try {
        const file = path.join(STATE_DIR, name);
        const request = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof request.prompt === "string" && typeof request.kind === "string") return { file, request };
      } catch { /* a malformed draft must not prevent opening the picker */ }
    }
  } catch { /* no saved failures */ }
  return null;
}

module.exports = { STATE_DIR, readPrefs, remember, writeRequest, readFailedRequest, discardRequest, finishRequest };
