"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(__dirname, "..", ".state");
const PREFS = path.join(STATE_DIR, "prefs.json");
const HISTORY = path.join(STATE_DIR, "history.json");
const MAX_RECENTS = 8;
const MAX_HISTORY = 50;

const MAX_DIRECTORIES = 8;
const DEFAULTS = { recents: [], destination: "tab", directories: [], models: {} };

function readPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS, "utf8"));
    return {
      recents: Array.isArray(parsed.recents) ? parsed.recents.filter((k) => typeof k === "string") : [],
      destination: typeof parsed.destination === "string" ? parsed.destination : DEFAULTS.destination,
      directories: Array.isArray(parsed.directories) ? parsed.directories.filter((d) => typeof d === "string") : [],
      models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// A reader never sees half a file: the popup and a worker can both be writing.
function writeJson(file, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

// Preferences and history are a convenience; never fail a launch over them.
function writeState(file, value) {
  try {
    writeJson(file, value);
  } catch {
    // ignored
  }
}

// Answers that are slow to work out and rarely change, each in a file of its
// own. Losing one only makes the next popup slower.
function readCache(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${name}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(name, value) {
  writeState(path.join(STATE_DIR, `${name}.json`), value);
}

function remember(kind, destination, directory, model) {
  const prefs = readPrefs();
  writeState(PREFS, {
    recents: [kind, ...prefs.recents.filter((k) => k !== kind)].slice(0, MAX_RECENTS),
    destination,
    directories: directory
      ? [directory, ...prefs.directories.filter((d) => d !== directory)].slice(0, MAX_DIRECTORIES)
      : prefs.directories,
    models: { ...prefs.models, [kind]: model },
  });
}

// Newest first, as in a shell.
function readHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string" && p) : [];
  } catch {
    return [];
  }
}

function recordPrompt(prompt) {
  const text = prompt.trim();
  if (!text) return;
  writeState(HISTORY, [text, ...readHistory().filter((p) => p !== text)].slice(0, MAX_HISTORY));
}

// Unique across processes by pid, and within one by the count.
let written = 0;
function uniqueFile(prefix) {
  written += 1;
  return path.join(STATE_DIR, `${prefix}-${Date.now()}-${process.pid}-${written}.json`);
}

function writeRequest(request) {
  const file = uniqueFile("request");
  writeJson(file, request);
  return file;
}

// A worker deletes its request on success and turns it into a draft on
// failure, so a request file left behind belongs to one that was killed before
// it could do either. The longest a live launch can take is a couple of
// minutes, so an hour is well clear of anything still in flight.
const STALE_REQUEST_MS = 60 * 60 * 1000;

function sweepStaleRequests(maxAgeMs = STALE_REQUEST_MS) {
  const cutoff = Date.now() - maxAgeMs;
  try {
    for (const name of fs.readdirSync(STATE_DIR)) {
      if (!/^request-[\d-]+\.json$/.test(name)) continue;
      const file = path.join(STATE_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) finishRequest(file, false);
      } catch { /* vanished under us, which is the outcome we wanted */ }
    }
  } catch { /* no state directory yet */ }
}

function discard(file) {
  try { fs.unlinkSync(file); } catch { /* already removed or unavailable */ }
}

// The draft keeps the request's age, so one swept long after its launch
// expires on time instead of coming back as new. True when a draft was kept.
function finishRequest(file, success) {
  if (!file) return false;
  if (success) {
    discard(file);
    return false;
  }
  try {
    const request = JSON.parse(fs.readFileSync(file, "utf8"));
    // A prompt handed over by another plugin is still there, and is never a draft.
    if (request.handoff) {
      discard(file);
      return false;
    }
    const draft = path.join(STATE_DIR, path.basename(file).replace(/^request-/, "draft-"));
    const { mtime } = fs.statSync(file);
    writeJson(draft, { ...request, failed: true });
    fs.utimesSync(draft, mtime, mtime);
    discard(file);
    return true;
  } catch {
    return false; // leave the request for the sweep rather than lose the prompt
  }
}

// Every draft is a file of its own: what was left in the box when it closed, or
// a launch that failed. The picker opens on the newest and only ever replaces
// or clears the one it opened, so a launch that fails while it is open, or two
// that fail together, are still there the next time.
const DRAFT_NAME = /^draft-[\d-]+\.json$/;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function draftFiles() {
  let names;
  try {
    names = fs.readdirSync(STATE_DIR).filter((name) => DRAFT_NAME.test(name));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const file = path.join(STATE_DIR, name);
    try {
      files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch { /* cleared by another picker */ }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
}

// The newest draft and the file it came from, or null. Old and malformed ones
// are removed on the way, since neither may stop the picker opening.
function readDraft(maxAgeMs = DRAFT_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  let found = null;
  for (const { file, mtimeMs } of draftFiles()) {
    if (mtimeMs < cutoff) {
      discard(file);
      continue;
    }
    if (found) continue;
    try {
      const draft = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof draft.prompt === "string" && typeof draft.kind === "string") {
        found = { draft, file };
        continue;
      }
    } catch { /* malformed */ }
    discard(file);
  }
  return found;
}

// Written under a new name before the draft it replaces is removed, so there is
// no moment with neither.
function saveDraft(draft, replacing = null) {
  const file = uniqueFile("draft");
  writeJson(file, draft);
  if (replacing && replacing !== file) discard(replacing);
  return file;
}

function clearDraft(file) {
  if (file) discard(file);
}

// Diagnostics keep one previous file each, so they cannot grow without bound,
// and never get in the way of what they are recording.
const LOG_LIMIT = 256 * 1024;

function appendLog(name, text) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, name);
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, text, { mode: 0o600 });
  } catch { /* nowhere left to report it */ }
}

function logCrash(error) {
  appendLog("crash.log", `${new Date().toISOString()}\n${error?.stack ?? String(error)}\n\n`);
}

module.exports = { STATE_DIR, readPrefs, remember, readCache, writeCache, readHistory, recordPrompt, writeRequest, finishRequest, sweepStaleRequests, readDraft, saveDraft, clearDraft, appendLog, logCrash };
