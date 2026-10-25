"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { load, timedOutLaunch, failedLaunch, worktreeLaunch, launchOf } = require("./support/helpers");

test("structured readiness errors preserve their code and do not restart an agent", () => {
  const wrapper = load("lib/shared/herdr.js", {
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
    "../lib/shared/herdr": { run: () => { calls++; return result; } },
  }, "try {\n  main();");
  const started = launcher.evaluate('startAgent("qp-test", "test", "pane", [])');
  assert.equal(started.started, true);
  assert.equal(started.ready, false);
  assert.equal(calls, 1);
});

test("a busy new pane is retried, and a pane that stays busy keeps the prompt as a draft", () => {
  for (const inline of [true, false]) {
    const recovered = timedOutLaunch("analyze application performance", { inline, busyStarts: 2 });
    const starts = recovered.calls.filter((args) => args[1] === "start");
    assert.equal(starts.length, 3);
    assert.ok(starts.every((args) => JSON.stringify(args) === JSON.stringify(starts[0])));
    assert.deepEqual(recovered.finished, [true]);
    assert.deepEqual(recovered.notifications, []);

    const failed = timedOutLaunch("analyze application performance", { inline, busyStarts: Infinity });
    assert.equal(failed.calls.filter((args) => args[1] === "start").length, inline ? 24 : 12);
    assert.deepEqual(failed.finished, [false]);
    assert.equal(failed.records.at(-1)[0], false);
    assert.ok(failed.calls.some((args) => args[0] === "tab" && args[1] === "close"));
    assert.equal(failed.calls.some((args) => args[0] === "agent" && ["wait", "prompt"].includes(args[1])), false);
    assert.match(failed.notifications.at(-1)[1], /recover your draft/);
  }
});

test("an agent start that times out is a slow agent, and it is followed by its pane", () => {
  const { calls, records, notifications } = timedOutLaunch("one\ntwo");
  const starts = calls.filter((args) => args[1] === "start");
  assert.equal(starts.length, 1, "a timeout is not retried into agent_pane_busy");
  assert.equal(starts[0][starts[0].indexOf("--timeout") + 1], "15000");
  const followed = calls.filter((args) => args[0] === "agent" && ["wait", "get", "prompt"].includes(args[1]));
  assert.ok(followed.length >= 3);
  assert.ok(followed.every((args) => args[2] === "w9:p1"), "never by a name Herdr may not have registered");
  assert.deepEqual(notifications, []);
  assert.deepEqual([...records.at(-1)], [true]);
  assert.deepEqual({ ...records[0] }, { inline: false });
});

test("an inline prompt gets a short start timeout, and a timeout there means it is at work", () => {
  const { calls, records, notifications } = timedOutLaunch("fix the login bug");
  const starts = calls.filter((args) => args[1] === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0][starts[0].indexOf("--timeout") + 1], "3500");
  assert.equal(starts[0].at(-1), "fix the login bug");
  assert.equal(calls.some((args) => args[1] === "prompt"), false, "nothing is typed on top of it");
  assert.deepEqual(notifications, []);
  assert.deepEqual({ ...records[0] }, { inline: true });
});

test("a prompt starting with a dash is typed in rather than handed to the CLI as an option", () => {
  const { calls } = timedOutLaunch("--help me with the build");
  const starts = calls.filter((args) => args[1] === "start");
  assert.equal(starts[0].includes("--help me with the build"), false);
  assert.ok(calls.some((args) => args[1] === "prompt" && args[3] === "--help me with the build"));
});

test("a prompt Herdr cannot pass as an argument is saved to a file the agent is pointed at", () => {
  for (const prompt of ["one\ntwo", "--help me with the build"]) {
    const { calls, records, saved } = timedOutLaunch(prompt, { promptFile: true });
    const starts = calls.filter((args) => args[1] === "start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0][starts[0].indexOf("--timeout") + 1], "3500");
    assert.deepEqual([...starts[0].slice(starts[0].indexOf("--") + 1)], ["--add-dir=/state/prompts", "read /state/prompts/prompt-1.md"]);
    assert.deepEqual(saved, [prompt]);
    assert.equal(calls.some((args) => args[1] === "prompt"), false, "nothing is typed on top of it");
    assert.deepEqual({ ...records[0] }, { inline: true });
  }
});

test("claude is let into the prompt's directory, without the prompt line read as another one", () => {
  const { promptFileArgs } = require("../lib/agents");
  assert.deepEqual(promptFileArgs("claude", "/state/prompts/p.md"),
    ["--add-dir=/state/prompts", 'My prompt is in the file "/state/prompts/p.md". Read it and do what it says.']);
  assert.deepEqual(promptFileArgs("codex", "/state/prompts/p.md"),
    ['My prompt is in the file "/state/prompts/p.md". Read it and do what it says.']);
});

test("a launch whose agent never starts closes the tab, split or workspace it made", () => {
  const refused = { ok: false, code: "agent_exited", message: "gemini exited" };
  assert.deepEqual(failedLaunch("tab", refused).closed, ["tab close w1:t7"]);
  assert.deepEqual(failedLaunch("right", refused).closed, ["pane close w1:p9"]);
  assert.deepEqual(failedLaunch("workspace", refused).closed, ["workspace close w5"]);
});

test("a failed worktree launch keeps the worktree and names its branch", () => {
  const { closed, notifications } = failedLaunch("worktree", { ok: false, code: "agent_exited", message: "gemini exited" });
  assert.deepEqual(closed, []);
  assert.match(notifications[0][1], /gemini exited \(branch fix-the-login-bug is kept\)/);
});

test("an agent that started is left running when its prompt does not land", () => {
  const { closed, notifications } = failedLaunch("tab", { ok: true, result: {} }, {
    deliver: () => { throw new Error("gemini did not accept the prompt"); },
  });
  assert.deepEqual(closed, [], "the user may be looking at it");
  assert.match(notifications[0][1], /did not accept the prompt/);
});

test("a failed launch records why in startup.jsonl, without the prompt or the agent's title", () => {
  const records = [];
  const followUp = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "codex", prompt: "PRIVATE PROMPT", followUp: { target: "w1:p2", title: "PRIVATE TITLE" } }) },
    "../lib/state": { finishRequest: () => {} },
    "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), note() {}, finish: (...args) => records.push(args) }) },
    "../lib/shared/herdr": { HerdrError: Error, notify: () => {}, run: () => ({ ok: false, code: "agent_blocked", message: "agent is blocked" }) },
  }, "try {\n  main();");
  followUp.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  followUp.context.process.exit = () => {};
  const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
  followUp.evaluate(source.slice(source.indexOf("try {\n  main();")));
  assert.equal(records[0][0], false);
  assert.match(records[0][1], /agent is blocked/);
  assert.doesNotMatch(records[0][1], /PRIVATE/);
});

test("the worktree destination branches from the prompt and starts the agent in its pane", () => {
  const calls = worktreeLaunch({ prompt: "Fix the login bug" });
  const created = calls.find((args) => args[0] === "worktree");
  assert.equal(created.join(" "), "worktree create --cwd /repo --branch fix-the-login-bug-2 --label fix-the-login-bug-2 --focus");
  const started = calls.find((args) => args[1] === "start");
  assert.equal(started[started.indexOf("--pane") + 1], "w2:p1");
});

test("a worktree branches from origin/HEAD, or QUICK_PROMPT_WORKTREE_BASE when set", () => {
  const base = (calls) => {
    const created = calls.find((args) => args[0] === "worktree");
    return created.includes("--base") ? created[created.indexOf("--base") + 1] : null;
  };
  assert.equal(base(worktreeLaunch({ prompt: "x" }, { originHead: "origin/main" })), "origin/main@commit", "a commit, so the branch does not track origin");
  assert.equal(base(worktreeLaunch({ prompt: "x" })), null, "no remote default leaves Herdr branching from HEAD");
  assert.equal(base(worktreeLaunch({ prompt: "x" }, { originHead: "origin/main", env: { QUICK_PROMPT_WORKTREE_BASE: "release" } })), "release@commit");
});

test("an empty prompt with a preset names the worktree branch after the preset", () => {
  const calls = worktreeLaunch({ prompt: "", preset: { name: "Fix tests", prefix: "Run the tests.", postfix: "", task: "skip" } });
  const created = calls.find((args) => args[0] === "worktree");
  assert.equal(created[created.indexOf("--branch") + 1], "fix-tests");
});

test("a multiline prompt is typed in when the agent cannot be pointed at a file", () => {
  const starts = [];
  const delivered = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({ kind: "cursor", prompt: "one\ntwo" }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => true, readsPromptFile: () => false },
    "../lib/shared/herdr": {
      run: (args) => {
        if (args[0] === "tab") return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
        if (args[1] === "start") starts.push(args);
        return { ok: true, result: {} };
      },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.evaluate("waitInteractive = () => true");
  launcher.context.deliverPrompt = (_, __, prompt) => delivered.push(prompt);
  assert.doesNotThrow(() => launcher.evaluate("main()"));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].includes("--"), false);
  assert.deepEqual(delivered, ["one\ntwo"]);
});

test("a typed-in prompt waits for the agent to start on it, and only a stall is sent again", () => {
  const deliver = (replies) => {
    const calls = [];
    const slept = [];
    const launcher = load("bin/launch.js", {
      "../lib/shared/herdr": {
        HerdrError: Error,
        run: (args) => {
          calls.push(args);
          return replies.shift() ?? { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.sleep = (ms) => slept.push(ms);
    let error = null;
    try {
      launcher.evaluate('deliverPrompt("w1:p1", "gemini", "fix it")');
    } catch (caught) {
      error = caught;
    }
    return { calls, slept, error };
  };

  const landed = deliver([]);
  assert.equal(landed.error, null);
  assert.deepEqual(landed.calls.map((args) => args.join(" ")),
    ["agent prompt w1:p1 fix it --wait --until working --until blocked --timeout 6000"]);
  assert.ok(landed.slept.reduce((a, b) => a + b, 0) <= 300, "one short settle, not fixed waits around the prompt");

  const stalled = { ok: false, code: "agent_prompt_stalled", message: "agent never started working" };
  const retried = deliver([stalled]);
  assert.equal(retried.error, null);
  assert.equal(retried.calls.length, 2);

  assert.match(deliver([stalled, stalled, stalled]).error.message, /gemini did not accept the prompt/);
  const refused = deliver([{ ok: false, code: "agent_blocked", message: "agent is blocked" }]);
  assert.match(refused.error.message, /could not send the prompt to gemini: agent is blocked/);
  assert.equal(refused.calls.length, 1);
});

test("a launch argument Herdr cannot encode is not retried", () => {
  let calls = 0;
  const launcher = load("bin/launch.js", {
    "../lib/shared/herdr": {
      run: () => {
        calls++;
        return { ok: false, code: "invalid_agent_argument", message: "agent arguments cannot be encoded safely for the target shell" };
      },
    },
  }, "try {\n  main();");
  launcher.evaluate("sleep = () => {}");
  const started = launcher.evaluate('startAgent("qp-claude", "claude", "pane", ["do the thing"])');
  assert.equal(started.started, false);
  assert.equal(calls, 1);
});

test("launcher finalizes recovery correctly on success, startup failure, and delivery failure", () => {
  for (const scenario of ["success", "target-failure", "start-failure", "wait-failure", "delivery-failure"]) {
    const finished = [];
    const notifications = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "test", prompt: "keep me" }) },
      "../lib/state": { finishRequest: (file, success) => finished.push({ file, success }), logCrash: () => {} },
      "../lib/timing": { createTiming: () => ({ measure: (_, fn) => fn(), note() {}, finish() {} }) },
      "../lib/agents": { supportsInlinePrompt: () => scenario === "success" },
      "../lib/shared/herdr": {
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
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    launcher.evaluate("waitInteractive = () => true; deliverPrompt = () => { throw new Error(\"test did not accept the prompt\") }");
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
    assert.equal(finished.length, 1, scenario);
    assert.equal(finished[0].success, scenario === "success", scenario);
    if (scenario !== "success") assert.match(notifications.at(-1)[1], /recover your draft/, scenario);
  }
});

test("startup timings record stages without prompt text", () => {
  const writes = [];
  const timing = load("lib/timing.js", {
    "./state": { appendLog: (name, text) => writes.push(text) },
  }).context.module.exports;
  const trace = timing.createTiming({ kind: "codex", prompt: "PRIVATE PROMPT", submittedAt: Date.now() - 20 });
  const result = { ok: false, code: "pane_not_ready", message: "PRIVATE ERROR" };
  assert.equal(trace.measure("agent start", () => result), result);
  assert.throws(() => trace.measure("tab create", () => { throw new Error("PRIVATE EXCEPTION"); }));
  trace.note({ inline: true });
  trace.finish(false, "agent did not start");
  const saved = JSON.parse(writes[0]);
  assert.equal(saved.inline, true);
  assert.equal(saved.error, "agent did not start");
  assert.equal(saved.steps[0].code, "pane_not_ready");
  assert.equal(saved.steps[1].ok, false);
  assert.ok(saved.dispatchMs >= 0);
  assert.ok(saved.workerMs >= 0);
  assert.equal(writes[0].includes("PRIVATE"), false);
});

test("the worker logs a bug to crash.log, and leaves Herdr refusing to startup.jsonl", () => {
  for (const [label, fail, logged] of [
    ["bug", () => { throw new TypeError("cannot read properties of undefined"); }, true],
    ["refusal", () => ({ ok: false, code: "agent_exited", message: "gemini exited" }), false],
  ]) {
    const crashes = [];
    class HerdrError extends Error {}
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "gemini", prompt: "x" }) },
      "../lib/state": { finishRequest: () => {}, logCrash: (error) => crashes.push(error) },
      "../lib/timing": { createTiming: () => null },
      "../lib/agents": { supportsInlinePrompt: () => false },
      "../lib/shared/herdr": {
        HerdrError,
        notify: () => {},
        run: (args) => {
          if (args[0] === "tab") return { ok: true, result: { tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } } };
          if (args[1] === "start") return fail();
          return { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));
    assert.equal(crashes.length, logged ? 1 : 0, label);
  }
});

test("model and effort become the CLI's own flags, and unknown choices none", () => {
  const { modelArgs } = require("../lib/models");
  assert.deepEqual(modelArgs("claude", { model: "opus", effort: "high" }), ["--model", "opus", "--effort", "high"]);
  assert.deepEqual(modelArgs("claude", { model: null, effort: "max" }), ["--effort", "max"]);
  assert.deepEqual(modelArgs("codex", { model: "gpt-6-sol", effort: "ultra" }),
    ["-m", "gpt-6-sol", "-c", "model_reasoning_effort=ultra"]);
  assert.deepEqual(modelArgs("codex", { model: "gpt-5.5", effort: "ultra" }), ["-m", "gpt-5.5"],
    "an effort the model does not take is dropped");
  assert.deepEqual(modelArgs("claude", { model: "retired-model", effort: "high" }), ["--effort", "high"]);
  assert.deepEqual(modelArgs("claude", null), []);
  assert.deepEqual(modelArgs("gemini", { model: "opus", effort: "high" }), []);
});

test("model flags go ahead of the inline prompt and survive falling back to typing it", () => {
  for (const prompt of ["one line", "one\ntwo"]) {
    const starts = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({ kind: "codex", prompt, model: "gpt-5.5", effort: "low" }) },
      "../lib/state": { writePromptFile: () => "/state/p.md" },
      "../lib/timing": { createTiming: () => null },
      "../lib/agents": { supportsInlinePrompt: () => true, readsPromptFile: () => true, promptFileArgs: (_, file) => [`read ${file}`] },
      "../lib/shared/herdr": {
        run: (args) => {
          if (args[0] === "tab") return { ok: true, result: { root_pane: { pane_id: "test-pane" } } };
          if (args[1] === "start") {
            starts.push([...args.slice(args.indexOf("--") + 1)]);
            if (starts.length === 1 && prompt === "one line") return { ok: false, message: "unexpected argument" };
          }
          return { ok: true, result: {} };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.evaluate("waitInteractive = () => true; deliverPrompt = () => {}");
    assert.doesNotThrow(() => launcher.evaluate("main()"));
    const flags = ["-m", "gpt-5.5", "-c", "model_reasoning_effort=low"];
    if (prompt === "one line") assert.deepEqual(starts, [[...flags, prompt], flags]);
    else assert.deepEqual(starts, [[...flags, "read /state/p.md"]]);
  }
});

test("the launcher sends the preset's prefix and postfix around the typed prompt", () => {
  const delivered = [];
  const launcher = load("bin/launch.js", {
    "node:fs": { readFileSync: () => JSON.stringify({
      kind: "gemini", prompt: "the auth module", preset: { name: "review", prefix: "Review:", postfix: "Be brief." },
    }) },
    "../lib/timing": { createTiming: () => null },
    "../lib/agents": { supportsInlinePrompt: () => false },
    "../lib/shared/herdr": {
      run: (args) => args[0] === "tab"
        ? { ok: true, result: { root_pane: { pane_id: "test-pane" } } }
        : { ok: true, result: {} },
    },
  }, "try {\n  main();");
  launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
  launcher.evaluate("waitInteractive = () => true");
  launcher.context.deliverPrompt = (_, __, prompt) => delivered.push(prompt);
  assert.doesNotThrow(() => launcher.evaluate("main()"));
  assert.deepEqual(delivered, ["Review:\n\nthe auth module\n\nBe brief."]);
});

test("the worker sends a follow-up to the running agent without starting anything", () => {
  for (const ok of [true, false]) {
    const calls = [];
    const finished = [];
    const notifications = [];
    const launcher = load("bin/launch.js", {
      "node:fs": { readFileSync: () => JSON.stringify({
        kind: "codex", prompt: "one\ntwo", destination: "follow-up",
        followUp: { target: "w1:p2", title: "Fix the build", kind: "codex", cwd: "/work/web" },
      }) },
      "../lib/state": { finishRequest: (file, success) => finished.push(success) },
      "../lib/timing": { createTiming: () => null },
      "../lib/shared/herdr": {
        HerdrError: Error,
        notify: (...args) => notifications.push(args),
        run: (args) => {
          calls.push(args);
          return ok ? { ok: true, result: {} } : { ok: false, code: "agent_blocked", message: "agent is blocked" };
        },
      },
    }, "try {\n  main();");
    launcher.context.process.argv = ["node", "launch.js", "/tmp/mock-request.json"];
    launcher.context.process.exit = () => {};
    const source = fs.readFileSync(path.resolve(__dirname, "../bin/launch.js"), "utf8");
    launcher.evaluate(source.slice(source.indexOf("try {\n  main();")));

    assert.equal(calls.length, 1, "no tab, no agent start, no list");
    assert.deepEqual([...calls[0].slice(0, 4)], ["agent", "prompt", "w1:p2", "one\ntwo"]);
    assert.ok(calls[0].includes("--wait"));
    assert.deepEqual(finished, [ok]);
    if (!ok) assert.match(notifications[0][1], /Fix the build.*agent is blocked.*recover your draft/);
  }
});

test("a launch that stays opens without focus and says where it went", () => {
  const created = ({ calls }) => calls.find((args) => args[1] === "create" || args[1] === "split");
  const quiet = launchOf({ kind: "claude", prompt: "fix it", destination: "tab", cwd: "/work/alpha" });
  assert.ok(created(quiet).includes("--focus"));
  assert.deepEqual(quiet.notifications, [], "you are looking at it already");

  const stayed = launchOf({ kind: "claude", prompt: "fix it", destination: "tab", cwd: "/work/alpha", stay: true });
  assert.ok(created(stayed).includes("--no-focus"));
  assert.ok(!created(stayed).includes("--focus"));
  assert.deepEqual(stayed.notifications.map((args) => [...args]), [["Quick Prompt", "claude started in a new tab (alpha)", "none"]]);

  for (const destination of ["right", "workspace", "worktree"]) {
    const other = launchOf({ kind: "codex", prompt: "fix it", destination, cwd: "/repo", pane: "w1:p1", stay: true });
    assert.ok(created(other).includes("--no-focus"), destination);
  }
  const branch = launchOf({ kind: "codex", prompt: "fix it", destination: "worktree", cwd: "/repo", stay: true });
  assert.equal(branch.notifications[0][1], "codex started on branch fix-it");
});

test("a follow-up that lands says so quietly", () => {
  const { notifications } = launchOf({ kind: "codex", prompt: "and the docs", followUp: { target: "w1:p2", title: "Fix the build", kind: "codex" } });
  assert.deepEqual(notifications.map((args) => [...args]), [["Quick Prompt", "sent to Fix the build", "none"]]);
});

test("an agent is named after its pane, without asking Herdr which names are taken", () => {
  const { calls } = timedOutLaunch("fix the login bug");
  const start = calls.find((args) => args[1] === "start");
  assert.equal(start[2], "qp-claude-w9-p1");
  assert.equal(calls.some((args) => args[0] === "agent" && args[1] === "list"), false);
});

test("a busy new pane is retried quickly at first, then every 400ms", () => {
  const slept = [];
  let busy = 5;
  const launcher = load("bin/launch.js", {
    "../lib/shared/herdr": { run: () => (busy-- > 0 ? { ok: false, code: "agent_pane_busy", message: "pane is busy" } : { ok: true, result: {} }) },
  }, "try {\n  main();");
  launcher.context.sleep = (ms) => slept.push(ms);
  assert.equal(launcher.evaluate('startAgent("qp-claude-w1-p1", "claude", "w1:p1", [], 15000)').started, true);
  assert.deepEqual(slept, [50, 100, 200, 400, 400]);
});

test("every herdr call has a deadline: its own --timeout plus slack, or 30s", () => {
  const seen = [];
  const herdr = load("lib/shared/herdr.js", {
    "node:child_process": { spawnSync: (_, args, options) => { seen.push(options.timeout); return { status: 0, stdout: "{}" }; } },
  }).context.module.exports;
  herdr.run(["tab", "create"]);
  herdr.run(["agent", "start", "x", "--timeout", "15000"]);
  herdr.run(["agent", "list"], { timeout: 500 });
  assert.deepEqual(seen, [30000, 20000, 500]);
});

test("a herdr call that hangs says so", () => {
  const herdr = load("lib/shared/herdr.js", {
    "node:child_process": { spawnSync: () => ({ error: Object.assign(new Error("spawnSync herdr ETIMEDOUT"), { code: "ETIMEDOUT" }) }) },
  }).context.module.exports;
  assert.equal(herdr.run(["agent", "list"], { check: false }).message, "herdr agent list did not answer in time");
});
