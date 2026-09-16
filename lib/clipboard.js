"use strict";

// Ctrl+V is not a terminal paste: most terminals send the raw byte through to
// the application, so the picker has to read the system clipboard itself.

const { spawnSync } = require("node:child_process");

const READERS = [
  { command: "wl-paste", args: ["--no-newline"] },
  { command: "xclip", args: ["-selection", "clipboard", "-o"] },
  { command: "xsel", args: ["--clipboard", "--output"] },
  { command: "pbpaste", args: [] },
  // WSL and Windows. Slower than the native tools, and without the encoding
  // line it mangles anything outside ASCII.
  {
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard"],
  },
];

const TIMEOUT_MS = 3000;

let cached = null;

function read(reader) {
  const res = spawnSync(reader.command, reader.args, { encoding: "utf8", timeout: TIMEOUT_MS });
  if (res.error || res.status !== 0) return null;
  // Get-Clipboard and friends add a trailing newline that was never yours.
  return (res.stdout ?? "").replace(/\r?\n$/, "");
}

// Returns the clipboard text, or null when no reader on this machine works.
function readClipboard() {
  if (cached) {
    const text = read(cached);
    if (text !== null) return text;
    cached = null;
  }

  for (const reader of READERS) {
    const text = read(reader);
    if (text !== null) {
      cached = reader;
      return text;
    }
  }
  return null;
}

module.exports = { readClipboard };
