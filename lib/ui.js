"use strict";

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

const visibleLength = (text) => text.replace(/\x1b\[[0-9;]*m/g, "").length;

function pad(text, width) {
  const gap = width - visibleLength(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

function truncate(text, width) {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

// Collapse $HOME so the footer path stays readable in a narrow popup.
function shortenPath(value, width) {
  if (!value) return "";
  const home = process.env.HOME ?? "";
  const short = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (short.length <= width) return short;
  const parts = short.split("/");
  for (let drop = 1; drop < parts.length - 1; drop += 1) {
    const candidate = [parts[0], "…", ...parts.slice(drop + 1)].join("/");
    if (candidate.length <= width) return candidate;
  }
  return `…${short.slice(-(width - 1))}`;
}

module.exports = { style, pad, truncate, shortenPath, visibleLength };
