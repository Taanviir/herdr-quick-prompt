"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { scratch } = require("./support/helpers");

test("setup matches keys and actions in either quote style, and punctuation literally", () => {
  const { isBound, isKeyTaken } = require("../bin/setup");
  for (const key of ["prefix+shift+c", "prefix+.", "prefix+["]) {
    for (const quote of ['"', "'"]) {
      assert.equal(isKeyTaken(`key = ${quote}${key}${quote}`, key), true);
      assert.equal(isKeyTaken(`  split_right = ${quote}${key}${quote}`, key), true, "any binding, not only a command's");
    }
  }
  assert.equal(isKeyTaken('key = "prefix+x"', "prefix+."), false);
  assert.equal(isBound("command = 'taanviir.quick-prompt.open'", "open"), true);
  assert.equal(isBound('command = "taanviir.quick-prompt.open"', "duplicate"), false);
});

test("setup binds open and duplicate each unless already bound, and says which key clashes", () => {
  const { plan } = require("../bin/setup");
  const keys = (config, env = {}) => plan(config, env).add.map((binding) => `${binding.action} ${binding.key}`);
  assert.deepEqual(keys(""), ["open prefix+shift+c", "duplicate prefix+shift+a"]);
  assert.deepEqual(keys('command = "taanviir.quick-prompt.open"'), ["duplicate prefix+shift+a"],
    "open bound by hand does not stop duplicate being added later");
  assert.deepEqual(keys("", { QUICK_PROMPT_KEY: "alt+q", QUICK_PROMPT_DUPLICATE_KEY: "alt+w" }), ["open alt+q", "duplicate alt+w"]);
  const clash = plan('[keys]\nzoom = "prefix+shift+a"\n', {});
  assert.deepEqual(clash.add.map((binding) => binding.action), ["open"]);
  assert.match(clash.skipped[0], /prefix\+shift\+a is already bound; set QUICK_PROMPT_DUPLICATE_KEY/);
});

test("setup writes both bindings into the config file Herdr names, once", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-setup-"));
  scratch.push(dir);
  const config = path.join(dir, "config.toml");
  const log = path.join(dir, "calls.log");
  const herdr = path.join(dir, "herdr");
  fs.writeFileSync(herdr, `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = --help ] && echo "Config: ${config}" || echo '{"result":{}}'\n`, { mode: 0o755 });
  const setup = (env = {}) => require("node:child_process").spawnSync(process.execPath, [path.resolve(__dirname, "../bin/setup.js")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, HERDR_BIN_PATH: herdr, ...env },
  });

  fs.writeFileSync(config, '[keys]\nprefix = "ctrl+b"\n');
  const first = setup();
  assert.equal(first.status, 0, first.stdout);
  const written = fs.readFileSync(config, "utf8");
  assert.match(written, /^prefix = "ctrl\+b"$/m);
  assert.match(written, /key = "prefix\+shift\+c"\ntype = "plugin_action"\ncommand = "taanviir\.quick-prompt\.open"/);
  assert.match(written, /key = "prefix\+shift\+a"\ntype = "plugin_action"\ncommand = "taanviir\.quick-prompt\.duplicate"/);
  assert.equal(fs.readFileSync(`${config}.bak-quick-prompt`, "utf8"), '[keys]\nprefix = "ctrl+b"\n');
  assert.match(fs.readFileSync(log, "utf8"), /^server reload-config$/m);

  const again = setup();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /Already bound/);
  assert.equal(fs.readFileSync(config, "utf8"), written);
});
