"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { slugify, randomName, branchName } = require("../lib/worktree");

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
