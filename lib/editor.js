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

  insert(chunk) {
    const added = clusters(chunk);
    this.cells.splice(this.cursor, 0, ...added);
    this.cursor += added.length;
  }

  backspace() {
    if (this.cursor === 0) return;
    this.cells.splice(this.cursor - 1, 1);
    this.cursor -= 1;
  }

  deleteForward() {
    if (this.cursor >= this.cells.length) return;
    this.cells.splice(this.cursor, 1);
  }

  deleteWord() {
    let start = this.cursor;
    while (start > 0 && /\s/.test(this.cells[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(this.cells[start - 1])) start -= 1;
    this.cells.splice(start, this.cursor - start);
    this.cursor = start;
  }

  clear() {
    this.cells = [];
    this.cursor = 0;
  }

  move(delta) {
    this.cursor = Math.max(0, Math.min(this.cells.length, this.cursor + delta));
  }

  toLineStart() {
    while (this.cursor > 0 && this.cells[this.cursor - 1] !== "\n") this.cursor -= 1;
  }

  toLineEnd() {
    while (this.cursor < this.cells.length && this.cells[this.cursor] !== "\n") this.cursor += 1;
  }

  get isEmpty() {
    return this.text.trim().length === 0;
  }

  // Wrap to `width` terminal cells and report where the cursor lands, so the
  // caller can place the real terminal cursor on the right row and column.
  layout(width) {
    const rows = [];
    let row = "";
    let used = 0;
    let caret = { row: 0, col: 0 };

    const wrap = () => {
      rows.push(row);
      row = "";
      used = 0;
    };

    for (let index = 0; index < this.cells.length; index += 1) {
      const cell = this.cells[index];

      if (cell === "\n") {
        if (index === this.cursor) caret = { row: rows.length, col: used };
        wrap();
        continue;
      }

      const cellWidth = clusterWidth(cell);
      // The cursor sits before this cell, so it belongs wherever the cell goes.
      if (used + cellWidth > width && used > 0) wrap();
      if (index === this.cursor) caret = { row: rows.length, col: used };

      row += cell;
      used += cellWidth;
    }

    if (this.cursor >= this.cells.length) caret = { row: rows.length, col: used };
    rows.push(row);
    return { rows, caret };
  }
}

module.exports = { Editor };
