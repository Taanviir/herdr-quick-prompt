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

// A worker deletes its request on success and turns it into the draft on
// failure, so a request file left behind belongs to one that was killed before
// it could do either. The longest a live launch can take is a couple of
// minutes, so an hour is well clear of anything still in flight.
const STALE_REQUEST_MS = 60 * 60 * 1000;

function sweepStaleRequests(maxAgeMs = STALE_REQUEST_MS) {
  const cutoff = Date.now() - maxAgeMs;
  try {
    for (const name of fs.readdirSync(STATE_DIR)) {
      if (!/^request-\d+-\d+\.json$/.test(name)) continue;
      const file = path.join(STATE_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) discard(file);
      } catch { /* vanished under us, which is the outcome we wanted */ }
    }
  } catch { /* no state directory yet */ }
}

function discard(file) {
  try { fs.unlinkSync(file); } catch { /* already removed or unavailable */ }
}

function finishRequest(file, success) {
  if (!file) return;
  if (success) return discard(file);
  try {
    saveDraft({ ...JSON.parse(fs.readFileSync(file, "utf8")), failed: true });
    discard(file);
  } catch { /* leave the request for the sweep rather than lose the prompt */ }
}

// One draft: what was left in the box when it closed, or a launch that failed.
// Whichever was written last wins, so a launch that fails after you have moved
// on still comes back first.
const DRAFT = path.join(STATE_DIR, "draft.json");
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readDraft(maxAgeMs = DRAFT_MAX_AGE_MS) {
  try {
    if (fs.statSync(DRAFT).mtimeMs < Date.now() - maxAgeMs) return clearDraft();
    const draft = JSON.parse(fs.readFileSync(DRAFT, "utf8"));
    if (typeof draft.prompt === "string" && typeof draft.kind === "string") return draft;
  } catch {
    // A malformed draft must not prevent opening the picker.
  }
  return clearDraft();
}

function saveDraft(draft) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(DRAFT, JSON.stringify(draft));
}

function clearDraft() {
  discard(DRAFT);
  return null;
}

module.exports = { STATE_DIR, readPrefs, remember, writeRequest, finishRequest, sweepStaleRequests, readDraft, saveDraft, clearDraft };
