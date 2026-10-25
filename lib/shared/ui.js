"use strict";

const { clusters, clusterWidth, displayWidth } = require("./text");

const USE_COLOR = !process.env.NO_COLOR;

const paint = (code) => (text) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

const style = {
  dim: paint("2"),
  bright: paint("97"),
  bold: paint("1"),
  accent: paint("36"),
  selected: paint("30;46"),
  warn: paint("33"),
  ok: paint("32"),
  danger: paint("31"),
};

// Each label keeps one colour wherever it appears, picked from its name.
const TINTS = ["36", "35", "33", "32", "34", "91"];

function tint(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return paint(TINTS[hash % TINTS.length])(name);
}

function pad(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

// Cuts to terminal cells, so a truncated line never overflows because of a wide
// character straddling the limit. Colour escapes are carried through as
// zero-width, and a cut inside one is closed with a reset.
const SGR = /(\x1b\[[0-9;]*m)/;

function truncate(text, width) {
  if (width <= 0) return "";
  const value = String(text);
  if (displayWidth(value) <= width) return value;

  let out = "";
  let used = 0;
  let styled = false;

  for (const part of value.split(SGR)) {
    if (SGR.test(part)) {
      out += part;
      styled = true;
      continue;
    }
    for (const cluster of clusters(part)) {
      const next = clusterWidth(cluster);
      if (used + next > width - 1) return `${out}\u2026${styled ? "\x1b[0m" : ""}`;
      out += cluster;
      used += next;
    }
  }
  return `${out}\u2026${styled ? "\x1b[0m" : ""}`;
}

// Collapse $HOME so the footer path stays readable in a narrow popup.
function shortenPath(value, width) {
  if (!value) return "";
  const home = process.env.HOME ?? "";
  const short = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (displayWidth(short) <= width) return short;

  const parts = short.split("/");
  for (let drop = 1; drop < parts.length - 1; drop += 1) {
    const candidate = [parts[0], "…", ...parts.slice(drop + 1)].join("/");
    if (displayWidth(candidate) <= width) return candidate;
  }

  // Keep the tail; it is the part that identifies the directory.
  const cells = clusters(short);
  let out = "";
  let used = 0;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    const next = clusterWidth(cells[i]);
    if (used + next > width - 1) break;
    out = cells[i] + out;
    used += next;
  }
  return `…${out}`;
}

module.exports = { style, tint, pad, truncate, shortenPath, displayWidth };
