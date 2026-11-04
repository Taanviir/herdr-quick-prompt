#!/usr/bin/env node
"use strict";

// Copies lib/shared/ into the other plugins and records each file's hash in
// every repo, so test/shared.test.js fails on an edit that skipped this.
//
//   node tools/sync-shared.js [plugin checkout…]
//
// With no paths, it fills the sibling checkouts named in PLUGINS.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHARED = path.join("lib", "shared");
const SUMS = "checksums.json";
const TEST = path.join("test", "shared.test.js");
const PLUGINS = ["herdr-scratchpad", "herdr-projects"];

function checksums(dir) {
  const names = fs.readdirSync(dir).filter((name) => name !== SUMS).sort();
  return Object.fromEntries(names.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")]));
}

const given = process.argv.slice(2).map((dir) => path.resolve(dir));
const targets = given.length ? given : PLUGINS.map((name) => path.join(ROOT, "..", name)).filter((dir) => fs.existsSync(dir));
for (const target of targets) {
  if (!fs.existsSync(path.join(target, "herdr-plugin.toml"))) {
    process.stderr.write(`${target} is not a plugin checkout\n`);
    process.exit(1);
  }
}

const from = path.join(ROOT, SHARED);
const sums = `${JSON.stringify(checksums(from), null, 2)}\n`;
fs.writeFileSync(path.join(from, SUMS), sums);
for (const target of targets) {
  const to = path.join(target, SHARED);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  fs.copyFileSync(path.join(ROOT, TEST), path.join(target, TEST));
  process.stdout.write(`synced ${Object.keys(JSON.parse(sums)).length} files into ${to}\n`);
}
