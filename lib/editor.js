"use strict";

const { clusters, clusterWidth } = require("./text");

// Minimal text buffer with a cursor, wrapped rendering, and the editing keys a
// prompt box needs. It works in grapheme clusters rather than UTF-16 units, so
// one backspace deletes one visible character even when that character is an
// emoji or a letter with a combining accent.
class Editor {
  constructor(text = "") {
    this.cells = clusters(text);
    this.cursor = this.cells.length;
  }

  get text() {
    return this.cells.join("");
  }

  // Every change to the text goes through here, which is what lets layout()
  // keep its wrapping until the next one.
  edited() {
    this.goalColumn = null;
    this.wrapped = null;
  }

  insert(chunk) {
    this.edited();
    const added = clusters(chunk);
    // Spreading a paste into splice's arguments overflows the stack past ~125k.
    this.cells = this.cells.slice(0, this.cursor).concat(added, this.cells.slice(this.cursor));
    this.cursor += added.length;
  }

  backspace() {
    this.edited();
    if (this.cursor === 0) return;
    this.cells.splice(this.cursor - 1, 1);
    this.cursor -= 1;
  }

  deleteForward() {
    this.edited();
    if (this.cursor >= this.cells.length) return;
    this.cells.splice(this.cursor, 1);
  }

  // A word is a run of non-whitespace, and a word move skips the gap before it.
  wordStart() {
    let at = this.cursor;
    while (at > 0 && /\s/.test(this.cells[at - 1])) at -= 1;
    while (at > 0 && !/\s/.test(this.cells[at - 1])) at -= 1;
    return at;
  }

  wordEnd() {
    let at = this.cursor;
    while (at < this.cells.length && /\s/.test(this.cells[at])) at += 1;
    while (at < this.cells.length && !/\s/.test(this.cells[at])) at += 1;
    return at;
  }

  wordLeft() {
    this.goalColumn = null;
    this.cursor = this.wordStart();
  }

  wordRight() {
    this.goalColumn = null;
    this.cursor = this.wordEnd();
  }

  deleteWord() {
    this.edited();
    const start = this.wordStart();
    this.cells.splice(start, this.cursor - start);
    this.cursor = start;
  }

  deleteWordForward() {
    this.edited();
    this.cells.splice(this.cursor, this.wordEnd() - this.cursor);
  }

  clear() {
    this.edited();
    this.cells = [];
    this.cursor = 0;
  }

  move(delta) {
    this.goalColumn = null;
    this.cursor = Math.max(0, Math.min(this.cells.length, this.cursor + delta));
  }

  toLineStart() {
    this.goalColumn = null;
    while (this.cursor > 0 && this.cells[this.cursor - 1] !== "\n") this.cursor -= 1;
  }

  toLineEnd() {
    this.goalColumn = null;
    while (this.cursor < this.cells.length && this.cells[this.cursor] !== "\n") this.cursor += 1;
  }

  get isEmpty() {
    return this.text.trim().length === 0;
  }

  // Returns false when there is no row that way, so the caller can treat the
  // top and bottom edges as something else.
  moveVertical(delta, width) {
    const { caret, positions } = this.layout(width);
    const goal = this.goalColumn ?? caret.col;
    const row = caret.row + delta;
    let target = -1;
    for (let index = 0; index < positions.length; index += 1) {
      const at = positions[index];
      if (at.row === row && (target < 0 || at.col <= goal)) target = index;
    }
    if (target >= 0) this.cursor = target;
    this.goalColumn = goal;
    return target >= 0;
  }

  // A single-line field scrolls by graphemes and keeps a cell for the caret.
  viewport(width) {
    let start = Math.min(this.viewStart ?? 0, this.cursor);
    let col = this.cells.slice(start, this.cursor).reduce((n, cell) => n + clusterWidth(cell), 0);
    while (col >= width && start < this.cursor) col -= clusterWidth(this.cells[start++]);
    this.viewStart = start;
    let text = "";
    let used = 0;
    for (const cell of this.cells.slice(start)) {
      const size = clusterWidth(cell);
      if (used + size > width) break;
      text += cell;
      used += size;
    }
    return { text, col };
  }

  // Wrap to `width` terminal cells and report where the cursor lands, so the
  // caller can place the real terminal cursor on the right row and column.
  // The wrapping only changes with the text or the width, and ↑/↓ asks for it
  // just before the frame that draws it does.
  layout(width) {
    if (this.wrapped?.width !== width) this.wrapped = { width, ...this.wrap(width) };
    const { rows, positions } = this.wrapped;
    return { rows, caret: positions[this.cursor], positions };
  }

  wrap(width) {
    const rows = [];
    let row = "";
    let used = 0;
    const positions = [];

    const wrap = () => {
      rows.push(row);
      row = "";
      used = 0;
    };

    for (let index = 0; index < this.cells.length; index += 1) {
      const cell = this.cells[index];

      if (cell === "\n") {
        positions[index] = { row: rows.length, col: used };
        wrap();
        continue;
      }

      const cellWidth = clusterWidth(cell);
      // The cursor sits before this cell, so it belongs wherever the cell goes.
      if (used + cellWidth > width && used > 0) wrap();
      positions[index] = { row: rows.length, col: used };

      row += cell;
      used += cellWidth;
    }

    positions[this.cells.length] = { row: rows.length, col: used };
    rows.push(row);
    return { rows, positions };
  }
}

module.exports = { Editor };
