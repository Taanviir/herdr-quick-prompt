"use strict";

// Ctrl+V is not a terminal paste: most terminals send the raw byte through to
// the application, so the popup has to read the system clipboard itself.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { onPath } = require("./executables");

const NATIVE = [
  { command: "wl-paste", args: ["--no-newline"] },
  { command: "xclip", args: ["-selection", "clipboard", "-o"] },
  { command: "xsel", args: ["--clipboard", "--output"] },
  { command: "pbpaste", args: [] },
];

// WSL and Windows. Slower than the native tools, and without the encoding
// line it mangles anything outside ASCII.
const POWERSHELL = {
  command: "powershell.exe",
  args: ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard"],
};

const TIMEOUT_MS = 3000;
// Each popup is a new process, so the reader that worked is kept on disk.
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(__dirname, "..", "..", ".state");
const CACHE = path.join(STATE_DIR, "clipboard.json");

function remembered() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8")).command;
  } catch {
    return undefined;
  }
}

function remember(command) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ command }));
  } catch {
    // Losing it only makes the next paste slower.
  }
}

// The order to try them in: the one that worked last time, then, under WSL
// without a display of its own, Windows' clipboard before tools that have
// nothing to read. One known not to be on PATH is never tried.
function readers(env, remembered) {
  const wslOnly = env.WSL_DISTRO_NAME && !env.WAYLAND_DISPLAY && !env.DISPLAY;
  const all = wslOnly ? [POWERSHELL, ...NATIVE] : [...NATIVE, POWERSHELL];
  const first = all.filter((reader) => reader.command === remembered);
  return [...first, ...all.filter((reader) => reader.command !== remembered)]
    .filter((reader) => onPath(reader.command) !== false);
}

function read(reader) {
  return new Promise((resolve) => {
    const child = execFile(reader.command, reader.args, { encoding: "utf8", timeout: TIMEOUT_MS }, (error, stdout) => {
      // Get-Clipboard and friends add a trailing newline that was never yours.
      resolve(error ? null : (stdout ?? "").replace(/\r?\n$/, ""));
    });
    child.stdin?.end();
  });
}

// Resolves to the clipboard text, or null when no reader on this machine works.
async function readClipboard() {
  const last = remembered();
  for (const reader of readers(process.env, last)) {
    const text = await read(reader);
    if (text === null) continue;
    if (reader.command !== last) remember(reader.command);
    return text;
  }
  return null;
}

module.exports = { readClipboard, readers };
