"use strict";

// Ctrl+V is not a terminal paste: most terminals send the raw byte through to
// the application, so the popup has to read the system clipboard itself.
// Copying goes the same way, through whichever tool this machine has.

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { onPath } = require("./executables");

const NATIVE = {
  read: [
    { command: "wl-paste", args: ["--no-newline"] },
    { command: "xclip", args: ["-selection", "clipboard", "-o"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
    { command: "pbpaste", args: [] },
  ],
  write: [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard", "-i"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
    { command: "pbcopy", args: [] },
  ],
};

// WSL and Windows. Slower than the native tools, and without the encoding
// line it mangles anything outside ASCII. clip.exe would too, so it is not used.
const POWERSHELL = {
  read: {
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard"],
  },
  write: {
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
  },
};

const TIMEOUT_MS = 3000;
// Each popup is a new process, so the tool that worked is kept on disk.
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(__dirname, "..", "..", ".state");
const CACHE = path.join(STATE_DIR, "clipboard.json");

function remembered() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function remember(direction, command) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ ...remembered(), [direction]: command }));
  } catch {
    // Losing it only makes the next copy or paste slower.
  }
}

// The order to try them in: the one that worked last time, then, under WSL
// without a display of its own, Windows' clipboard before tools that have
// nothing to reach. One known not to be on PATH is never tried.
function tools(direction, env, last) {
  const wslOnly = env.WSL_DISTRO_NAME && !env.WAYLAND_DISPLAY && !env.DISPLAY;
  const all = wslOnly ? [POWERSHELL[direction], ...NATIVE[direction]] : [...NATIVE[direction], POWERSHELL[direction]];
  const first = all.filter((tool) => tool.command === last);
  return [...first, ...all.filter((tool) => tool.command !== last)]
    .filter((tool) => onPath(tool.command) !== false);
}

const readers = (env, last) => tools("read", env, last);
const writers = (env, last) => tools("write", env, last);

function read(reader) {
  return new Promise((resolve) => {
    const child = execFile(reader.command, reader.args, { encoding: "utf8", timeout: TIMEOUT_MS }, (error, stdout) => {
      // Get-Clipboard and friends add a trailing newline that was never yours.
      resolve(error ? null : (stdout ?? "").replace(/\r?\n$/, ""));
    });
    child.stdin?.end();
  });
}

// xclip and xsel stay behind to serve the selection and keep any inherited
// pipe open, so this waits for the process to exit, not for its output.
function write(writer, text) {
  return new Promise((resolve) => {
    const child = spawn(writer.command, writer.args, { stdio: ["pipe", "ignore", "ignore"], timeout: TIMEOUT_MS });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

// Resolves to the clipboard text, or null when no reader on this machine works.
async function readClipboard() {
  const last = remembered().read;
  for (const reader of readers(process.env, last)) {
    const text = await read(reader);
    if (text === null) continue;
    if (reader.command !== last) remember("read", reader.command);
    return text;
  }
  return null;
}

// Resolves to whether any writer on this machine took the text.
async function writeClipboard(text) {
  const last = remembered().write;
  for (const writer of writers(process.env, last)) {
    if (!(await write(writer, text))) continue;
    if (writer.command !== last) remember("write", writer.command);
    return true;
  }
  return false;
}

module.exports = { readClipboard, writeClipboard, readers, writers };
