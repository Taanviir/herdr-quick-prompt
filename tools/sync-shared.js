#!/usr/bin/env node
"use strict";

// Copies lib/shared/ into Scratchpad and records each file's hash in both
// repos, so test/shared.test.js fails on an edit that skipped this.
//
//   node tools/sync-shared.js [path to herdr-scratchpad]

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHARED = path.join("lib", "shared");
const SUMS = "checksums.json";
const TEST = path.join("test", "shared.test.js");

function checksums(dir) {
  const names = fs.readdirSync(dir).filter((name) => name !== SUMS).sort();
  return Object.fromEntries(names.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")]));
}

const target = path.resolve(process.argv[2] ?? path.join(ROOT, "..", "herdr-scratchpad"));
if (!fs.existsSync(path.join(target, "herdr-plugin.toml"))) {
  process.stderr.write(`${target} is not a plugin checkout\n`);
  process.exit(1);
}

const from = path.join(ROOT, SHARED);
const to = path.join(target, SHARED);
const sums = `${JSON.stringify(checksums(from), null, 2)}\n`;
fs.writeFileSync(path.join(from, SUMS), sums);
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
fs.copyFileSync(path.join(ROOT, TEST), path.join(target, TEST));
process.stdout.write(`synced ${Object.keys(JSON.parse(sums)).length} files into ${to}\n`);
