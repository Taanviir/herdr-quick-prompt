"use strict";

// Branch names for the worktree destination, and whether a directory has a
// repository to branch from.

const { spawnSync } = require("node:child_process");

const MAX_SLUG = 40;

const ADJECTIVES = [
  "amber", "brave", "calm", "eager", "fuzzy", "gentle", "humble", "jolly",
  "lucky", "mellow", "nimble", "quiet", "rapid", "shy", "tidy", "witty",
];
const NOUNS = [
  "badger", "comet", "falcon", "garden", "harbor", "lantern", "maple", "otter",
  "pebble", "quill", "river", "spruce", "thistle", "walrus", "willow", "zephyr",
];
const VERBS = [
  "bakes", "climbs", "dances", "drifts", "glows", "hums", "jumps", "naps",
  "paints", "roams", "sings", "skips", "spins", "swims", "waits", "wanders",
];

// Only [a-z0-9-] survives, which is always a valid branch name once the ends
// are trimmed. Paths are left out: a prompt that opens with a dropped
// screenshot would otherwise be named after the state directory.
function slugify(text) {
  const line = String(text).split("\n").find((l) => l.trim()) ?? "";
  const words = line.split(/\s+/).filter((word) => !/[/\\]|^~/.test(word));
  const slug = words.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "");
  return slug.slice(0, MAX_SLUG).replace(/-+$/, "");
}

function randomName(random = Math.random) {
  const pick = (words) => words[Math.floor(random() * words.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(VERBS)}`;
}

function branchName(prompt, random) {
  return slugify(prompt) || randomName(random);
}

function git(dir, args) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function insideRepo(dir) {
  const res = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.status === 0 && res.stdout.trim() === "true";
}

// Herdr checks out a branch that already exists instead of refusing, which
// would start the agent on top of older work. A name with branches under it,
// "feat" beside "feat/login", is taken too: git cannot have both.
function uniqueBranch(dir, name) {
  const taken = (branch) => git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0
    || (git(dir, ["for-each-ref", "--count=1", "--format=x", `refs/heads/${branch}/`]).stdout ?? "").trim() !== "";
  if (!taken(name)) return name;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${name}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${name}-${Date.now().toString(36).slice(-4)}`;
}

module.exports = { slugify, randomName, branchName, insideRepo, uniqueBranch };
