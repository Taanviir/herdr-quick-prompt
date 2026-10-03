"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { stage, splitWords, plainName, prune } = require("../lib/dropped");

const SHOT = "Screenshot 2026-09-21 at 11.13.58\u202fPM.png";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-dropped-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The way Ghostty pastes a drop.
function escaped(file) {
  return file.replace(/[ ()'"\\]/g, "\\$&");
}

function thumbnail(root) {
  const dir = path.join(root, "T", "TemporaryItems", "NSIRD_screencaptureui_x");
  fs.mkdirSync(dir, { recursive: true });
  const shot = path.join(dir, SHOT);
  fs.writeFileSync(shot, "\x89PNG pixels");
  return shot;
}

test("shell escapes and quotes are undone, and only ASCII whitespace separates", () => {
  const words = splitWords(`/a/b\\ c.png '/d e/f' "/g\\"h" /i\u202fj`);
  assert.deepEqual(words.map((w) => w.word), ["/a/b c.png", "/d e/f", '/g"h', "/i\u202fj"]);
  assert.deepEqual(words.map((w) => w.raw), ["/a/b\\ c.png", "'/d e/f'", '"/g\\"h"', "/i\u202fj"]);
  assert.equal(splitWords("'/unterminated"), null);
  assert.equal(splitWords("/dangling\\"), null);
});

test("dropped names are made plain ASCII and keep their extension", () => {
  assert.deepEqual(plainName(SHOT), { stem: "Screenshot-2026-09-21-at-11.13.58-PM", ext: ".png" });
  assert.deepEqual(plainName("日本 語.PNG"), { stem: "dropped", ext: ".PNG" });
  assert.deepEqual(plainName("(draft) notes"), { stem: "draft-notes", ext: "" });
});

test("a screenshot dropped from its thumbnail is copied and its copy pasted instead", (t) => {
  const root = tempDir(t);
  const attachments = path.join(root, "attachments");
  const shot = thumbnail(root);

  const dropped = stage(`${escaped(shot)} `, attachments);
  const copy = path.join(attachments, "Screenshot-2026-09-21-at-11.13.58-PM.png");
  assert.equal(dropped.text, `${copy} `);
  assert.deepEqual(dropped.failed, []);
  assert.equal(fs.readFileSync(copy, "utf8"), "\x89PNG pixels");

  fs.unlinkSync(shot);
  assert.ok(fs.existsSync(copy), "the copy outlives the file macOS deletes");
});

test("the same drop twice reuses its copy, and a different file of that name gets its own", (t) => {
  const root = tempDir(t);
  const attachments = path.join(root, "attachments");
  const shot = thumbnail(root);

  const first = stage(escaped(shot), attachments).text;
  assert.equal(stage(escaped(shot), attachments).text, first);
  fs.writeFileSync(shot, "other pixels");
  assert.equal(stage(escaped(shot), attachments).text,
    path.join(attachments, "Screenshot-2026-09-21-at-11.13.58-PM-2.png"));
});

test("an awkward image path is copied, while plain paths beside it stay as pasted", (t) => {
  const root = tempDir(t);
  const attachments = path.join(root, "attachments");
  const image = path.join(root, "my photo.jpg");
  const source = path.join(root, "notes file.txt");
  const tidy = path.join(root, "tidy.png");
  for (const file of [image, source, tidy]) fs.writeFileSync(file, file);

  const dropped = stage(`'${source}' ${tidy} ${escaped(image)}`, attachments);
  assert.equal(dropped.text, `'${source}' ${tidy} ${path.join(attachments, "my-photo.jpg")}`);
});

test("anything but a paste of existing files is left alone", (t) => {
  const root = tempDir(t);
  const attachments = path.join(root, "attachments");
  const image = path.join(root, "my photo.png");
  fs.writeFileSync(image, "pixels");

  assert.equal(stage(`look at ${escaped(image)}`, attachments), null, "prose around a path");
  assert.equal(stage(`${escaped(image)} ${root}/missing.png`, attachments), null, "a missing file");
  assert.equal(stage(escaped(root), attachments), null, "a directory");
  assert.equal(stage(path.join(root, "tidy.txt"), attachments), null, "nothing to copy");
  assert.equal(stage("fix the bug", attachments), null);
  assert.equal(fs.existsSync(attachments), false);
});

test("copies older than a week are pruned when a new one is made", (t) => {
  const root = tempDir(t);
  const attachments = path.join(root, "attachments");
  fs.mkdirSync(attachments);
  const stale = path.join(attachments, "stale.png");
  const recent = path.join(attachments, "recent.png");
  for (const file of [stale, recent]) fs.writeFileSync(file, "pixels");
  const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);
  const day = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(recent, day, day);

  stage(escaped(thumbnail(root)), attachments);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(recent), true);

  prune(attachments, 60 * 60 * 1000);
  assert.deepEqual(fs.readdirSync(attachments), ["Screenshot-2026-09-21-at-11.13.58-PM.png"]);
});
