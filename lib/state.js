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

module.exports = { STATE_DIR, readPrefs, remember, writeRequest };
