"use strict";

// lib/shared/ is the same in Quick Prompt and Scratchpad. Quick Prompt holds
// the master copy and tools/sync-shared.js copies it across.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const SHARED = path.join(__dirname, "..", "lib", "shared");

test("lib/shared is exactly what was last synced from Quick Prompt", () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(SHARED, "checksums.json"), "utf8"));
  const names = fs.readdirSync(SHARED).filter((name) => name !== "checksums.json").sort();
  const actual = Object.fromEntries(names.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(SHARED, name))).digest("hex")]));
  assert.deepEqual(actual, recorded, "edit lib/shared in herdr-quick-prompt, then run node tools/sync-shared.js there");
});
