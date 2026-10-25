"use strict";

// What is on PATH. One sweep of each directory beats spawning `which`, or
// letting a spawn find out the hard way, once per name.

const fs = require("node:fs");
const path = require("node:path");

// WSL appends Windows' PATH, repeats and all, and every one of those
// directories is a slow 9p mount.
function pathDirs(value = process.env.PATH ?? "") {
  return [...new Set(value.split(path.delimiter).filter(Boolean))];
}

// Windows executables answer to their name without the extension.
const bare = (name) => name.replace(/\.(exe|cmd|bat|ps1)$/i, "");

let swept = null;

function executablesOnPath() {
  const found = new Set();
  for (const dir of pathDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) found.add(bare(entry));
  }
  swept = found;
  return found;
}

async function executablesOnPathAsync() {
  const listed = await Promise.all(pathDirs().map((dir) => fs.promises.readdir(dir).catch(() => [])));
  swept = new Set(listed.flat().map(bare));
  return swept;
}

// Whether `command` is on PATH as of the last sweep, or null before one.
function onPath(command) {
  return swept ? swept.has(bare(command)) : null;
}

module.exports = { pathDirs, executablesOnPath, executablesOnPathAsync, onPath };
