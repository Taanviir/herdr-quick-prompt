"use strict";

// Popup entrypoint: one screen. The cursor starts in the prompt because that is
// what you came here to write; the agent and the destination are one keystroke
// away, and the agents you do not have installed stay behind ctrl+k.
//
// Herdr draws the popup's border and title, so this renders bare inside it.

const readline = require("node:readline");
const { PassThrough } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");

const { refreshCatalog } = require("../lib/agents");
const { prune } = require("../lib/dropped");
const { KITTY_ON, legacyKeys } = require("../lib/keys");
const { ATTACHMENTS, cachedAgents, useCatalog, lookUpDuplicate } = require("../lib/picker/session");
const { render, scheduleRender } = require("../lib/picker/render");
const { onKey, onData } = require("../lib/picker/input");
const { reportCrash } = require("../lib/picker/actions");

/* ---------- boot ---------- */

process.on("uncaughtException", reportCrash);

if (!process.stdin.isTTY) {
  process.stderr.write("quick-prompt: picker needs an interactive terminal\n");
  process.exit(1);
}

// Ask the terminal to wrap pastes in markers and to tell a modified Enter
// apart. Each chunk reaches onData before readline sees it as keypresses.
process.stdout.write(`\x1b[?2004h${KITTY_ON}`);
const decoder = new StringDecoder("utf8");
const keys = new PassThrough();
process.stdin.on("data", (raw) => {
  const chunk = Buffer.from(legacyKeys(decoder.write(raw)));
  if (!chunk.length) return;
  if (!onData(chunk)) keys.write(chunk);
});

readline.emitKeypressEvents(keys);
keys.on("keypress", onKey);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.on("resize", render);
render();
// None of this is needed for the first paint. Copies are only pruned on a drop
// otherwise, and someone who stops dropping screenshots would keep the last
// week's for ever.
setImmediate(() => {
  prune(ATTACHMENTS);
  if (cachedAgents) refreshCatalog().then((items) => useCatalog(items) && scheduleRender());
  if (process.env.QUICK_PROMPT_DUPLICATE) lookUpDuplicate().then((changed) => changed && scheduleRender());
});
