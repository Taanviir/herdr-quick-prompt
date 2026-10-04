"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { slugify, randomName, branchName, uniqueBranch } = require("../lib/worktree");

test("a prompt's first line becomes a lowercase, hyphenated branch name", () => {
  assert.equal(slugify("Fix the login bug"), "fix-the-login-bug");
  assert.equal(slugify("  Add OAuth2 (Google) support!  "), "add-oauth2-google-support");
  assert.equal(slugify("refactor auth\nand explain why in detail"), "refactor-auth");
  assert.equal(slugify("café ünïcode"), "caf-n-code");
  assert.equal(slugify("--leading and trailing--"), "leading-and-trailing");
});

test("a long prompt is capped without leaving a trailing hyphen", () => {
  const slug = slugify("migrate every invoice table to the new schema and backfill the totals");
  assert.ok(slug.length <= 40);
  assert.equal(slug, "migrate-every-invoice-table-to-the-new-s");
  assert.equal(slugify("a".repeat(39) + " b"), "a".repeat(39));
});

test("a prompt with nothing to slug gets a random adj-noun-verb name", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("修复登录"), "");
  assert.match(branchName(""), /^[a-z]+-[a-z]+-[a-z]+$/);
  assert.match(branchName("!!!"), /^[a-z]+-[a-z]+-[a-z]+$/);
  assert.equal(randomName(() => 0), "amber-badger-bakes");
  assert.equal(randomName(() => 0.999), "witty-zephyr-wanders");
  assert.equal(branchName("Ship it"), "ship-it");
});

test("the first line with words in it names the branch, without any paths on it", () => {
  assert.equal(slugify("\n  \nFix the login bug"), "fix-the-login-bug");
  assert.equal(slugify("/tmp/state/attachments/Screenshot-1.png what is wrong here"), "what-is-wrong-here");
  assert.equal(slugify("'/Users/me/Library/Application Support/x.png' explain"), "explain");
  assert.equal(slugify("compare ~/notes.md with C:\\notes"), "compare-with");
  assert.equal(slugify("/only/a/path.png"), "");
});

test("a branch name is taken when branches live under it as well as when it exists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-branch-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("branch", "feat/login");
  git("branch", "fix");

  assert.equal(uniqueBranch(dir, "feat"), "feat-2", "feat would clash with feat/login");
  assert.equal(uniqueBranch(dir, "fix"), "fix-2");
  assert.equal(uniqueBranch(dir, "fe"), "fe", "a shared prefix is not a clash");
  assert.equal(git("branch", uniqueBranch(dir, "feat")).status, 0, "git can create the name it picks");
});
