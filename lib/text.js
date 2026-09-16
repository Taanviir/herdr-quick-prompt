"use strict";

// Terminal cells, not UTF-16 units. Emoji, CJK and combining marks all break
// naive .length arithmetic, which shows up as wrapped lines and a cursor in the
// wrong column.

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ANSI = /\x1b\[[0-9;]*m/g;
const VARIATION_SELECTOR_16 = "️";
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

// East Asian Wide and Fullwidth blocks. Symbol-range emoji are covered by the
// Emoji_Presentation check instead of being listed here.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function isWide(code) {
  return WIDE_RANGES.some(([from, to]) => code >= from && code <= to);
}

// Grapheme clusters, so a family emoji or an accented letter stays one unit.
function clusters(text) {
  const out = [];
  for (const { segment } of SEGMENTER.segment(text)) out.push(segment);
  return out;
}

// Combining marks inside the cluster contribute nothing, which falls out of
// measuring the cluster by its base character.
function clusterWidth(cluster) {
  if (cluster === "") return 0;
  if (cluster.includes(VARIATION_SELECTOR_16)) return 2;

  const base = cluster.codePointAt(0);
  if (base < 0x20 || base === 0x7f) return 0;
  if (isWide(base)) return 2;
  if (EMOJI_PRESENTATION.test(String.fromCodePoint(base))) return 2;
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const cluster of clusters(String(text).replace(ANSI, ""))) width += clusterWidth(cluster);
  return width;
}

// Pasted text arrives with terminal line endings, tabs that no width function
// can predict, and control bytes that would corrupt the display. The editor
// only deals in newlines and printable text.
const TAB_WIDTH = 4;

function sanitizePasted(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ".repeat(TAB_WIDTH))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

module.exports = { clusters, clusterWidth, displayWidth, sanitizePasted };
