"use strict";

// Detached: opens the popup a tab switch asked for. Herdr opens one popup at a
// time and says ui_busy until the one switched away from has gone.

const { run, notify } = require("./herdr");
const { TABS, envFor } = require("./tabs");

const ATTEMPTS = 40;
const RETRY_MS = 25;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function open(request) {
  const tab = TABS.find((candidate) => candidate.id === request.id);
  if (!tab) return;
  const args = ["plugin", "pane", "open", "--plugin", tab.plugin, "--entrypoint", tab.entrypoint];
  for (const [key, value] of Object.entries(envFor(tab, request))) args.push("--env", `${key}=${value}`);
  for (let attempt = 1; ; attempt += 1) {
    const res = run(args, { check: false });
    if (res.ok) return;
    if (res.code !== "ui_busy" || attempt === ATTEMPTS) {
      notify(`${tab.title} did not open`, res.message);
      return;
    }
    sleep(RETRY_MS);
  }
}

if (require.main === module) open(JSON.parse(process.argv[2]));

module.exports = { open };
