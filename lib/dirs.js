"use strict";

// Directory completion for the working-directory picker. Deliberately small:
// it lists real directories, expands ~, and never touches anything else.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_ENTRIES = 200;

function expand(input) {
  const value = input.trim();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function subdirectories(parent, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const needle = prefix.toLowerCase();
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ENTRIES)
    .map((name) => path.join(parent, name));
}

// What to offer for a path the user is part-way through typing. A trailing
// slash means "inside this directory"; anything else completes the last segment.
function complete(input) {
  const target = expand(input);
  if (!target) return subdirectories(os.homedir(), "");
  if (input.endsWith("/") && isDirectory(target)) return subdirectories(target, "");

  const parent = path.dirname(target);
  const prefix = path.basename(target);
  return subdirectories(parent, prefix);
}

// The opening list: where you have launched before, then the neighbours of where
// you are now, which is usually the other project in the same folder.
function suggestions(cwd, recents = []) {
  const seen = new Set();
  const out = [];

  for (const candidate of [cwd, ...recents, ...subdirectories(path.dirname(cwd), "")]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isDirectory(candidate)) out.push(candidate);
  }
  return out.slice(0, MAX_ENTRIES);
}

module.exports = { complete, expand, isDirectory, suggestions };
