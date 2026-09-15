"use strict";

const { clusters, clusterWidth, displayWidth } = require("./text");

const USE_COLOR = !process.env.NO_COLOR;

const paint = (code) => (text) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

const style = {
  dim: paint("2"),
  bold: paint("1"),
  accent: paint("36"),
  selected: paint("30;46"),
  warn: paint("33"),
  ok: paint("32"),
};

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

// The modal frame. Body lines are placed inside the border already styled; the
// returned origin is where the first body line's first content cell lands, so
// the caller can put the real terminal cursor on it.
const BORDER = { topLeft: "\u250c", topRight: "\u2510", bottomLeft: "\u2514", bottomRight: "\u2518", horizontal: "\u2500", vertical: "\u2502" };
const GUTTER = 2;
const ORIGIN_ROW = 1;
const ORIGIN_COL = 1 + GUTTER;

// Content cells available inside the frame at a given terminal width.
const frameContent = (width) => Math.max(4, Math.max(8, width - 2) - GUTTER * 2);

function frame({ width, height, title, right, body }) {
  const inner = Math.max(8, width - 2);
  const content = frameContent(width);

  const lines = [style.dim(headerRule(inner, title, right))];
  for (let row = 0; row < height - 2; row += 1) {
    const line = body[row] ?? "";
    lines.push(style.dim(BORDER.vertical) + " ".repeat(GUTTER) + pad(truncate(line, content), content) + " ".repeat(GUTTER) + style.dim(BORDER.vertical));
  }
  lines.push(style.dim(BORDER.bottomLeft + BORDER.horizontal.repeat(inner) + BORDER.bottomRight));

  return { lines, originRow: ORIGIN_ROW, originCol: ORIGIN_COL, content };
}

// ┌─ Quick Prompt ──────────────── ~/projects/x ─┐
function headerRule(inner, title, right) {
  const left = ` ${title} `;
  const tail = right ? ` ${right} ` : "";
  const fill = Math.max(1, inner - 1 - displayWidth(left) - displayWidth(tail) - 1);
  return BORDER.topLeft + BORDER.horizontal + left + BORDER.horizontal.repeat(fill) + tail + BORDER.horizontal + BORDER.topRight;
}

module.exports = { style, pad, truncate, shortenPath, displayWidth, frame, frameContent };
