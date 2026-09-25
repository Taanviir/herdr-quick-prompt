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

test("structured readiness errors preserve their code and do not restart an agent", () => {
  const wrapper = load("lib/herdr.js", {
    "node:child_process": {
      spawnSync: () => ({ status: 1, stderr: JSON.stringify({
        error: { code: "agent_not_ready", message: "Agent needs attention" },
      }) }),
    },
  });
  const result = wrapper.context.module.exports.run(["agent", "start"], { check: false });
  assert.equal(result.code, "agent_not_ready");
  assert.equal(result.message, "Agent needs attention");
  let calls = 0;
  const launcher = load("bin/launch.js", {
    "../lib/herdr": { run: () => { calls++; return result; } },
  }, "try {\n  const success = main();");
  const started = launcher.evaluate('startAgent("qp-test", "test", "pane", null)');
  assert.equal(started.started, true);
  assert.equal(started.ready, false);
  assert.equal(calls, 1);
});

test("an agent busy with its inline prompt counts as started after readiness times out", () => {
  const replies = [
    { ok: false, code: "timeout", message: "agent did not reach its prompt" },
    { ok: false, code: "agent_pane_busy", message: "pane already runs an agent" },
  ];
  let calls = 0;
  const launcher = load("bin/launch.js", {
    "../lib/herdr": { run: () => replies[calls++] },
  }, "try {\n  const success = main();");
  launcher.evaluate("sleep = () => {}");
  const started = launcher.evaluate('startAgent("qp-claude", "claude", "pane", "do the thing")');
  assert.equal(started.started, true);
  assert.equal(started.ready, false);
  assert.equal(calls, 2);
});

function picker(recovered = null, discarded = []) {
  return load("bin/picker.js", {
    "../lib/agents": { catalog: () => ["amp", "claude", "codex", "copilot", "cursor", "gemini"]
      .map((kind) => ({ kind, installed: false })) },
    "../lib/state": {
      readPrefs: () => ({ recents: [], directories: [] }),
      readFailedRequest: () => recovered,
      discardRequest: (file) => discarded.push(file),
      sweepStaleRequests: () => {},
    },
    "../lib/dirs": {
      expand: (value) => value,
      isDirectory: (value) => ["/tmp/", "/tmp/child"].includes(value),
      complete: () => ["/tmp/child"],
      suggestions: () => [],
    },
  }, "/* ---------- boot ---------- */");
}

test("an agent outside the first five remains selected and visible", () => {
  const ui = picker();
  ui.evaluate("state.agent = 5");
  assert.equal(ui.evaluate("chipAgents().includes(agent())"), true);
  assert.match(ui.evaluate("chipRow(40)"), /gemini/);
  assert.match(ui.evaluate("chipRow(71)"), /gemini/);
  ui.evaluate("cycleAgent(1); cycleAgent(-1)");
  assert.equal(ui.evaluate("agent().kind"), "gemini");
});

test("directory viewport follows the cursor through a long Unicode path", () => {
  const { Editor } = require("../lib/editor");
  const { displayWidth } = require("../lib/text");
  const editor = new Editor("/projects/" + "界".repeat(40) + "/tail");
  let view = editor.viewport(20);
  assert.ok(view.text.endsWith("/tail"));
  assert.ok(displayWidth(view.text) <= 20);
  assert.ok(view.col < 20);
  editor.move(-editor.cursor);
  view = editor.viewport(20);
  assert.ok(view.text.startsWith("/projects/"));
  assert.equal(view.col, 0);
  const ui = picker();
  ui.evaluate("openDirectories(); state.overlay.input = new Editor('/projects/' + 'x'.repeat(100) + '/tail')");
  assert.match(ui.evaluate("dirsBody(71, 16).lines[1]"), /\/tail/);
});

test("vertical navigation keeps a preferred column through short and wrapped lines", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("abcdef\nx\nabcdef");
  editor.moveVertical(-1, 20);
  assert.equal(editor.cursor, 8);
  editor.moveVertical(-1, 20);
  assert.equal(editor.cursor, 6);
  editor.moveVertical(1, 20);
  editor.moveVertical(1, 20);
  assert.equal(editor.cursor, editor.cells.length);
  const wrapped = new Editor("abcdefghij");
  wrapped.moveVertical(-1, 4);
  assert.equal(wrapped.cursor, 6);
  wrapped.moveVertical(-1, 4);
  assert.equal(wrapped.cursor, 2);
  wrapped.moveVertical(1, 4);
  assert.equal(wrapped.cursor, 6);
  const wide = new Editor("界界\na");
  wide.moveVertical(-1, 20);
  assert.equal(wide.cursor, 0);
  const ui = picker();
  ui.evaluate("state.prompt = new Editor('one\\ntwo'); onMainKey('', {name: 'up'})");
  assert.equal(ui.evaluate("state.prompt.cursor"), 3);
});

test("failed requests survive reopening and successful requests are removed", (t) => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-recovery-test-"));
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const state = load("lib/state.js", {}, "const STATE_DIR =");
  state.context.process.env.HERDR_PLUGIN_STATE_DIR = dir;
  state.context.process.pid = process.pid;
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/state.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const STATE_DIR =")), state.context);
  const api = state.context.module.exports;
  const request = { kind: "gemini", prompt: "recover this", cwd: "/tmp/", destination: "down" };
  const file = api.writeRequest(request);
  assert.equal(api.readFailedRequest(), null, "in-flight launches must not be restored");
  api.finishRequest(file, false);
  const saved = api.readFailedRequest();
  assert.equal(saved.request.prompt, request.prompt);
  const ui = picker(saved);
  assert.equal(ui.evaluate("state.prompt.text"), request.prompt);
  assert.equal(ui.evaluate("agent().kind"), request.kind);
  assert.equal(ui.evaluate("destination().id"), request.destination);
  assert.equal(ui.evaluate("state.cwd"), request.cwd);
  assert.match(ui.evaluate("state.notice"), /Recovered/);
  assert.ok(api.readFailedRequest(), "opening must not consume the draft");
  api.discardRequest(saved.file);
  const success = api.writeRequest(request);
  api.finishRequest(success, true);
  assert.equal(fs.existsSync(success), false);
  assert.equal(api.readFailedRequest(), null);
});

test("a multiline prompt is typed in, since Herdr refuses newlines in launch arguments", () => {
  const starts = [];
  const delivered = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "claude", prompt: "one\ntwo" }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => true },
    "../lib/herdr": {
      run: (args) => {
        if (args[0] === "tab") return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
        if (args[1] === "start") starts.push(args);
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  const success = main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.evaluate("waitInteractive = () => true");
  launcher.context.deliverPrompt = (_, prompt) => delivered.push(prompt) > 0;
  assert.equal(launcher.evaluate("main()"), true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].includes("--"), false);
  assert.deepEqual(delivered, ["one\ntwo"]);
});

test("a launch argument Herdr cannot encode is not retried", () => {
  let calls = 0;
  const launcher = load("bin/launch.js", {
    "../lib/herdr": {
      run: () => {
        calls++;
        return { ok: false, code: "invalid_agent_argument", message: "agent arguments cannot be encoded safely for the target shell" };
      },
    },
  }, "try {\n  const success = main();");
  launcher.evaluate("sleep = () => {}");
  const started = launcher.evaluate('startAgent("qp-claude", "claude", "pane", "do the thing")');
  assert.equal(started.started, false);
  assert.equal(calls, 1);
});

test("launcher finalizes recovery correctly on success, startup failure, and delivery failure", () => {
  for (const scenario of ["success", "target-failure", "start-failure", "wait-failure", "delivery-failure"]) {
    const finished = [];
    const notifications = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "test", prompt: "keep me" }) },
      "../lib/state": { finishRequest: (file, success) => finished.push({ file, success }) },
      "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), finish() {} }) },
      "../lib/agents": { supportsInlinePrompt: () => scenario === "success" },
      "../lib/herdr": {
        HerdrError: Error,
        notify: (...args) => notifications.push(args),
        run: (args) => {
          if (args[0] === "tab") {
            if (scenario === "target-failure") throw new Error("Could not create tab");
            return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
          }
          if (args[1] === "start" && scenario === "start-failure") return { ok: false, message: "permission denied" };
          if (args[1] === "start" && scenario === "wait-failure") return { ok: false, code: "agent_not_ready", message: "Needs attention" };
          if (args[1] === "wait") return { ok: false, message: "timeout" };
          return { ok: true, result: {} };
        },
      },
    }, "try {\n  const success = main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    launcher.evaluate("waitInteractive = () => true; deliverPrompt = () => false");
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  const success = main();")));
    assert.equal(finished.length, 1, scenario);
    assert.equal(finished[0].success, scenario === "success", scenario);
    if (scenario !== "success") assert.match(notifications.at(-1)[1], /recover your draft/, scenario);
  }
});

test("startup timings record stages without prompt text and tolerate logging failures", () => {
  const writes = [];
  const io = {
    mkdirSync() {}, existsSync: () => false,
    appendFileSync: (_, text) => writes.push(text),
  };
  const timing = load("lib/timing.js", {
    "node:fs": io, "./state": { STATE_DIR: "/tmp/mock-timing" },
  }).context.module.exports;
  const trace = timing.createTiming({ kind: "codex", prompt: "PRIVATE PROMPT", submittedAt: Date.now() - 20 });
  const result = { ok: false, code: "pane_not_ready", message: "PRIVATE ERROR" };
  assert.equal(trace.measure("agent start", () => result), result);
  assert.throws(() => trace.measure("tab create", () => { throw new Error("PRIVATE EXCEPTION"); }));
  trace.finish(false);
  const saved = JSON.parse(writes[0]);
  assert.equal(saved.steps[0].code, "pane_not_ready");
  assert.equal(saved.steps[1].ok, false);
  assert.ok(saved.dispatchMs >= 0);
  assert.ok(saved.workerMs >= 0);
  assert.equal(writes[0].includes("PRIVATE"), false);
  io.appendFileSync = () => { throw new Error("disk unavailable"); };
  assert.doesNotThrow(() => trace.finish(false));
});

test("directory arrows override typed parent, while direct Enter uses the typed path", () => {
  const ui = picker();
  const open = "state.overlay = {type: 'dirs', input: new Editor('/tmp/'), index: 0}";
  ui.evaluate(open);
  ui.evaluate("onDirsKey('', {name: 'down'}); onDirsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.cwd"), "/tmp/child");
  ui.evaluate(open);
  ui.evaluate("onDirsKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.cwd"), "/tmp/");
  ui.evaluate(open);
  ui.evaluate("onDirsKey('', {name: 'down'}); insertPasted('child')");
  assert.equal(ui.evaluate("state.overlay.selectionMoved"), false);
});

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

test("clearing a recovered draft throws it away instead of emptying the buffer", () => {
  const recovered = { file: "/tmp/failed-request-1-1.json", request: { kind: "codex", prompt: "lost work" } };
  const discarded = [];
  const ui = picker(recovered, discarded);

  assert.equal(ui.evaluate("state.prompt.text"), "lost work");
  ui.evaluate('onMainKey("", { ctrl: true, name: "u" })');

  assert.equal(ui.evaluate("state.prompt.text"), "");
  assert.deepEqual(discarded, [recovered.file], "the notice offers ctrl+u as the way to be rid of it");
  assert.match(ui.evaluate("state.notice"), /discarded/);

  ui.evaluate('onMainKey("", { ctrl: true, name: "u" })');
  assert.deepEqual(discarded, [recovered.file], "a second clear must not discard anything again");
});

test("reading a draft sweeps the older and unreadable ones it passes", (t) => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-sweep-test-"));
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });

  const state = load("lib/state.js", {}, "const STATE_DIR =");
  state.context.process.env.HERDR_PLUGIN_STATE_DIR = dir;
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/state.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const STATE_DIR =")), state.context);

  const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  write("failed-request-1000000000000-1.json", JSON.stringify({ kind: "codex", prompt: "oldest" }));
  write("failed-request-2000000000000-2.json", "{ not json");
  write("failed-request-3000000000000-3.json", JSON.stringify({ kind: "claude", prompt: "newest" }));

  const found = state.context.module.exports.readFailedRequest();
  assert.equal(found.request.prompt, "newest");
  assert.deepEqual(fs.readdirSync(dir), ["failed-request-3000000000000-3.json"],
    "only the draft that can still be offered is kept");
});

test("requests abandoned by a killed worker are swept, live ones are not", (t) => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "qp-stale-test-"));
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });

  const state = load("lib/state.js", {}, "const STATE_DIR =");
  state.context.process.env.HERDR_PLUGIN_STATE_DIR = dir;
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/state.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("const STATE_DIR =")), state.context);
  const api = state.context.module.exports;

  const body = JSON.stringify({ kind: "codex", prompt: "orphan" });
  const orphan = path.join(dir, "request-1000000000000-1.json");
  const live = path.join(dir, "request-2000000000000-2.json");
  const draft = path.join(dir, "failed-request-3000000000000-3.json");
  for (const file of [orphan, live, draft]) fs.writeFileSync(file, body);

  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(orphan, old / 1000, old / 1000);

  api.sweepStaleRequests();
  assert.equal(fs.existsSync(orphan), false, "a request older than any live launch is abandoned");
  assert.equal(fs.existsSync(live), true, "a request that could still be in flight is left alone");
  assert.equal(fs.existsSync(draft), true, "recoverable drafts are not requests and are not swept");
});

test("word motion and deletion stop at whitespace from either side", () => {
  const { Editor } = require("../lib/editor");
  const editor = new Editor("fix  the bug");
  editor.wordLeft();
  assert.equal(editor.cursor, 9);
  editor.wordLeft();
  assert.equal(editor.cursor, 5);
  editor.wordRight();
  assert.equal(editor.cursor, 8);
  editor.deleteWordForward();
  assert.equal(editor.text, "fix  the");
  editor.deleteWord();
  assert.equal(editor.text, "fix  ");
});

test("modifier keys from Linux, Windows and macOS terminals edit by word", () => {
  const ui = picker();
  const keys = (list) => ui.evaluate(`state.prompt = new Editor('one two three'); ${list}; state.prompt`);
  const cursorAfter = (list) => keys(list).cursor;
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'left', ctrl: true})"), 8);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'left', meta: true})"), 8);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'b', meta: true})"), 8);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'home'}); onMainKey(undefined, {name: 'f', meta: true})"), 3);
  assert.equal(cursorAfter("onMainKey(undefined, {name: 'home'}); onMainKey(undefined, {name: 'right', ctrl: true})"), 3);
  assert.equal(keys("onMainKey(undefined, {name: 'backspace', meta: true})").text, "one two ");
  assert.equal(keys("onMainKey('\\b', {name: 'backspace'})").text, "one two ");
  assert.equal(keys("onMainKey(undefined, {name: 'home'}); onMainKey(undefined, {name: 'd', meta: true})").text, " two three");
  ui.evaluate("openDirectories(); state.overlay.input = new Editor('/tmp/a b')");
  ui.evaluate("onDirsKey(undefined, {name: 'backspace', meta: true})");
  assert.equal(ui.evaluate("state.overlay.input.text"), "/tmp/a ");
});

test("backslash-Enter, alt+Enter and ctrl+j add a newline while plain Enter launches", () => {
  const ui = picker();
  ui.evaluate("launched = 0; launch = () => { launched += 1 }");
  ui.evaluate("state.prompt = new Editor('first\\\\'); onMainKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first\n");
  ui.evaluate("onMainKey(undefined, {name: 'return', meta: true})");
  ui.evaluate("onMainKey('\\n', {name: 'enter'})");
  assert.equal(ui.evaluate("state.prompt.text"), "first\n\n\n");
  assert.equal(ui.evaluate("launched"), 0);
  ui.evaluate("onMainKey('\\r', {name: 'return'})");
  assert.equal(ui.evaluate("launched"), 1);
});

test("kitty protocol keys come back as the legacy bytes readline knows", () => {
  const { legacyKeys } = require("../lib/keys");
  assert.equal(legacyKeys("\x1b[13;2u"), "\n");
  assert.equal(legacyKeys("\x1b[13;5u"), "\n");
  assert.equal(legacyKeys("\x1b[13u"), "\r");
  assert.equal(legacyKeys("\x1b[99;5u"), "\x03");
  assert.equal(legacyKeys("\x1b[27u"), "\x1b");
  assert.equal(legacyKeys("\x1b[49;3u"), "\x1b1");
  assert.equal(legacyKeys("\x1b[127;5u"), "\b");
  assert.equal(legacyKeys("\x1b[9;2u"), "\x1b[Z");
  assert.equal(legacyKeys("a\x1b[1;5Db"), "a\x1b[1;5Db");
});
