"use strict";

// A terminal hands a dropped file over as a paste of its path, escaped for a
// shell. A macOS screenshot dragged from its floating thumbnail arrives as
//
//   /var/folders/…/TemporaryItems/NSIRD_screencaptureui_x/Screenshot\ 2026-09-21\ at\ 11.13.58 PM.png
//
// and that path is lost twice over by the time the agent reads it: macOS
// deletes the file soon after the drop, and the U+202F before "PM" comes back
// from the agent as a plain space. So a paste that is nothing but paths gets a
// copy, under a plain name, of every file that is about to vanish or is an
// image the agent cannot type back. Any other path stays as pasted, since the
// agent should work on the file itself.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// No terminal drops a wall of paths, and this keeps the check off everyday pastes.
const MAX_DROP = 16 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const PLAIN = /^[A-Za-z0-9/._\-+@,:=~%]*$/;

// Split the way a shell reads words: backslash escapes, single and double
// quotes. Only ASCII whitespace separates, because the U+202F is part of the
// name. Each word comes back as pasted and unescaped; null on a dangling quote
// or escape.
function splitWords(text) {
  const words = [];
  let start = -1;
  let word = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (!quote && /[ \t\n\r\f\v]/.test(c)) {
      if (start >= 0) words.push({ raw: text.slice(start, i), word });
      start = -1;
      word = "";
      continue;
    }
    if (start < 0) start = i;
    if (c === quote) {
      quote = null;
    } else if (c === "\\" && quote !== "'") {
      i += 1;
      if (i >= text.length) return null;
      word += text[i];
    } else if (!quote && (c === "'" || c === '"')) {
      quote = c;
    } else {
      word += c;
    }
  }
  if (quote) return null;
  if (start >= 0) words.push({ raw: text.slice(start), word });
  return words;
}

// The existing file one word names: an absolute path, ~/…, or a file:// URL.
function droppedFile(word) {
  let file = word;
  if (word.startsWith("file://")) {
    try {
      file = decodeURIComponent(word.slice("file://".length).replace(/^localhost/, ""));
    } catch {
      return null;
    }
  } else if (word.startsWith("~/")) {
    file = path.join(os.homedir(), word.slice(2));
  }
  if (!path.isAbsolute(file)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function needsCopy(file) {
  const vanishes = file.split(path.sep).includes("TemporaryItems");
  return vanishes || (IMAGE.test(file) && !PLAIN.test(file));
}

// Every run of anything but ASCII letters, digits, ".", "_" and "-" becomes one
// "-", so "Screenshot 2026-09-21 at 11.13.58 PM.png" keeps its shape.
function plainRun(text) {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function plainName(name) {
  const dot = name.lastIndexOf(".");
  const stem = plainRun(dot > 0 ? name.slice(0, dot) : name) || "dropped";
  const ext = dot > 0 ? plainRun(name.slice(dot + 1)) : "";
  return { stem, ext: ext ? `.${ext}` : "" };
}

// The state directory sits under "Application Support" on macOS.
function quoted(file) {
  return PLAIN.test(file) ? file : `'${file}'`;
}

function sameBytes(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// Dropping the same screenshot twice reuses its copy; a different file with
// the same name gets a numbered one beside it.
function copyIn(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { stem, ext } = plainName(path.basename(file));
  const size = fs.statSync(file).size;
  for (let n = 1; ; n += 1) {
    const dest = path.join(dir, n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`);
    let there;
    try {
      there = fs.statSync(dest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.copyFileSync(file, dest);
      there = null;
    }
    if (there && !(there.size === size && sameBytes(file, dest))) continue;
    // A reused copy is as new as its latest drop, and copyFile may keep the
    // source's mtime, which would get it pruned early.
    const now = new Date();
    fs.utimesSync(dest, now, now);
    return dest;
  }
}

function prune(dir, maxAgeMs = KEEP_MS) {
  const cutoff = Date.now() - maxAgeMs;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* left for the next drop */ }
  }
}

// The paste as it should land, with copies in dir, plus the names of files
// that could not be copied and so stay as pasted. Null when the paste is not
// a drop, or is one with nothing to copy.
function stage(text, dir) {
  const body = text.trim();
  if (!body || body.length > MAX_DROP || !/^[/~'"f]/.test(body)) return null;
  const words = splitWords(body);
  if (!words?.length) return null;
  const files = words.map(({ word }) => droppedFile(word));
  if (files.some((file) => !file) || !files.some(needsCopy)) return null;

  prune(dir);
  const failed = [];
  const staged = files.map((file, index) => {
    if (!needsCopy(file)) return words[index].raw;
    try {
      return quoted(copyIn(file, dir));
    } catch {
      failed.push(path.basename(file));
      return words[index].raw;
    }
  });

  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  return { text: `${lead}${staged.join(" ")}${trail}`, failed };
}

module.exports = { stage, splitWords, plainName, prune };
