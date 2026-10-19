"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { picker } = require("./support/helpers");

test("directory viewport follows the cursor through a long Unicode path", () => {
  const { Editor } = require("../lib/editor");
  const { displayWidth } = require("../lib/text");
  const editor = new Editor("/projects/" + "界".repeat(40) + "/tail");
  let view = editor.viewport(20);
  assert.ok(view.text.endsWith("/tail"));
  assert.ok(displayWidth(view.text) <= 20);
  assert.ok(view.col < 20);
  editor.move(-editor.cursor);
  view = editor.viewport(20);
  assert.ok(view.text.startsWith("/projects/"));
  assert.equal(view.col, 0);
  const ui = picker();
  ui.evaluate("openDirectories(); state.overlay.input = new Editor('/projects/' + 'x'.repeat(100) + '/tail')");
  assert.match(ui.evaluate("dirsBody(71, 16).lines[1]"), /\/tail/);
});

test("vertical navigation keeps a preferred column through short and wrapped lines", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("abcdef\nx\nabcdef");
  editor.moveVertical(-1, 20);
  assert.equal(editor.cursor, 8);
  editor.moveVertical(-1, 20);
  assert.equal(editor.cursor, 6);
  editor.moveVertical(1, 20);
  editor.moveVertical(1, 20);
  assert.equal(editor.cursor, editor.cells.length);
  const wrapped = new Editor("abcdefghij");
  wrapped.moveVertical(-1, 4);
  assert.equal(wrapped.cursor, 6);
  wrapped.moveVertical(-1, 4);
  assert.equal(wrapped.cursor, 2);
  wrapped.moveVertical(1, 4);
  assert.equal(wrapped.cursor, 6);
  const wide = new Editor("界界\na");
  wide.moveVertical(-1, 20);
  assert.equal(wide.cursor, 0);
  const ui = picker();
  ui.evaluate("state.prompt = new Editor('one\\ntwo'); onMainKey('', {name: 'up'})");
  assert.equal(ui.evaluate("state.prompt.cursor"), 3);
});

test("the prompt is wrapped once per edit and width, and the caret still follows the cursor", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("abcdefghij");
  let wraps = 0;
  const wrap = editor.wrap.bind(editor);
  editor.wrap = (width) => { wraps += 1; return wrap(width); };

  editor.moveVertical(-1, 4);
  assert.deepEqual(editor.layout(4).caret, { row: 1, col: 2 });
  editor.move(-1);
  assert.deepEqual(editor.layout(4).caret, { row: 1, col: 1 });
  assert.equal(wraps, 1, "moving the cursor reuses the wrapping");

  editor.layout(5);
  assert.equal(wraps, 2, "a new width wraps again");
  for (const edit of ["insert('x')", "backspace()", "deleteForward()", "deleteWord()", "deleteWordForward()", "clear()"]) {
    editor.insert("one two");
    editor.layout(5);
    const before = wraps;
    new Function("editor", `editor.${edit}`)(editor);
    assert.deepEqual(editor.layout(5).rows, new Editor(editor.text).layout(5).rows, edit);
    assert.equal(wraps, before + 1, edit);
  }
});

test("history walks back to the oldest entry and forward to the draft it set aside", () => {
  const { History } = require("../lib/history");
  const history = new History(["newest", "older"]);
  assert.equal(history.newer(), null, "nothing is newer than the draft");
  assert.equal(history.older("draft"), "newest");
  assert.equal(history.older("newest"), "older");
  assert.equal(history.older("older"), null, "the oldest entry is the end");
  assert.equal(history.newer(), "newest");
  assert.equal(history.newer(), "draft");
  assert.equal(history.newer(), null);
  assert.equal(new History([]).older("draft"), null);
});

test("a paste far larger than the call stack lands whole, at the cursor", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("ab");
  editor.move(-1);
  editor.insert("x".repeat(500000));
  assert.equal(editor.text.length, 500002);
  assert.equal(editor.text.at(-1), "b");
  assert.equal(editor.cursor, 500001);
});

test("word motion and deletion stop at whitespace from either side", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("fix  the bug");
  editor.wordLeft();
  assert.equal(editor.cursor, 9);
  editor.wordLeft();
  assert.equal(editor.cursor, 5);
  editor.wordRight();
  assert.equal(editor.cursor, 8);
  editor.deleteWordForward();
  assert.equal(editor.text, "fix  the");
  editor.deleteWord();
  assert.equal(editor.text, "fix  ");
});

test("a word that runs past the edge moves down whole, and only a word wider than the row is cut", () => {
  const { Editor } = require("../lib/editor");
  const typing = new Editor("fix the login bug");
  assert.deepEqual([...typing.layout(10).rows], ["fix the ", "login bug"]);
  assert.deepEqual({ ...typing.layout(10).caret }, { row: 1, col: 9 });

  const mid = new Editor("fix the login");
  mid.cursor = 9; // inside "login"
  assert.deepEqual({ ...mid.layout(10).caret }, { row: 1, col: 1 });

  assert.deepEqual([...new Editor("supercalifragilistic").layout(8).rows], ["supercal", "ifragili", "stic"]);
  assert.deepEqual([...new Editor("one\ntwo three").layout(6).rows], ["one", "two ", "three"]);
});
