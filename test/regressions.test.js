"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

// Exercise entrypoint handlers without starting a terminal, agent, or server.
function load(relative, mocks = {}, stop) {
  const file = path.resolve(__dirname, "..", relative);
  const realRequire = createRequire(file);
  const context = vm.createContext({
    require: (name) => mocks[name] ?? realRequire(name),
    module: { exports: {} },
    __dirname: path.dirname(file),
    process: { env: { QUICK_PROMPT_CWD: "/tmp" }, stdout: { write() {} } },
    setImmediate() {},
  });
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(stop ? source.slice(0, source.indexOf(stop)) : source, context);
  return { context, evaluate: (code) => vm.runInContext(code, context) };
}

test("setup detects both TOML quote styles and treats punctuation literally", () => {
  for (const key of ["prefix+shift+c", "prefix+.", "prefix+["]) {
    for (const quote of ['"', "'"]) {
      const setup = load("bin/setup.js", {
        "node:fs": { existsSync: () => true, readFileSync: () => "" },
        "node:child_process": { spawnSync: () => ({ stdout: "Config: /tmp/mock.toml" }) },
      }, "const key =");
      setup.context.process.env.QUICK_PROMPT_KEY = key;
      const source = fs.readFileSync(path.resolve(__dirname, "../bin/setup.js"), "utf8");
      vm.runInContext(source.slice(source.indexOf("const key ="), source.indexOf("if (existing.test(config))")), setup.context);
      const binding = `key = ${quote}${key}${quote}`;
      assert.equal(setup.evaluate(`existing.test(${JSON.stringify(binding)})`), true);
      if (key.endsWith(".")) {
        assert.equal(setup.evaluate('existing.test("key = \\\"prefix+x\\\"")'), false);
      }
    }
  }
});
