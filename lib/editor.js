"use strict";

// Minimal text buffer with a cursor, wrapped rendering, and the editing keys a
// prompt box needs. Kept separate so the picker only deals with layout.
class Editor {
  constructor(text = "") {
    this.text = text;
    this.cursor = text.length;
  }

  insert(chunk) {
    this.text = this.text.slice(0, this.cursor) + chunk + this.text.slice(this.cursor);
    this.cursor += chunk.length;
  }

  backspace() {
    if (this.cursor === 0) return;
    this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
    this.cursor -= 1;
  }

  deleteForward() {
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
  }

  deleteWord() {
    let start = this.cursor;
    while (start > 0 && /\s/.test(this.text[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(this.text[start - 1])) start -= 1;
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  clear() {
    this.text = "";
    this.cursor = 0;
  }

  move(delta) {
    this.cursor = Math.max(0, Math.min(this.text.length, this.cursor + delta));
  }

  toLineStart() {
    const before = this.text.lastIndexOf("\n", this.cursor - 1);
    this.cursor = before === -1 ? 0 : before + 1;
  }

  toLineEnd() {
    const after = this.text.indexOf("\n", this.cursor);
    this.cursor = after === -1 ? this.text.length : after;
  }

  get isEmpty() {
    return this.text.trim().length === 0;
  }

  // Wrap to `width` columns and report where the cursor lands, so the caller can
  // place the real terminal cursor on the right row and column.
  layout(width) {
    const rows = [];
    let caret = { row: 0, col: 0 };
    let index = 0;

    for (const line of this.text.split("\n")) {
      const chunks = [];
      for (let at = 0; at < line.length; at += width) chunks.push(line.slice(at, at + width));
      if (chunks.length === 0) chunks.push("");

      for (const chunk of chunks) {
        if (this.cursor >= index && this.cursor <= index + chunk.length) {
          caret = { row: rows.length, col: this.cursor - index };
        }
        rows.push(chunk);
        index += chunk.length;
      }
      index += 1; // the newline itself
    }

    // A cursor sitting exactly at a wrap boundary belongs on the next row.
    if (caret.col === width && caret.row + 1 < rows.length) caret = { row: caret.row + 1, col: 0 };
    return { rows, caret };
  }
}

module.exports = { Editor };
