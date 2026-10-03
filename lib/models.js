"use strict";

// Models and reasoning efforts per agent kind, checked against each CLI's own
// --help (and, for codex, `codex debug models`). Kinds not listed here get no
// model picker: a guessed flag would make the agent refuse to start.

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_ULTRA = [...CODEX_EFFORTS, "ultra"];

const flag = (name, value) => (value ? [name, value] : []);

const MODELS = {
  claude: {
    efforts: CLAUDE_EFFORTS,
    models: { fable: CLAUDE_EFFORTS, opus: CLAUDE_EFFORTS, sonnet: CLAUDE_EFFORTS },
    args: (model, effort) => [...flag("--model", model), ...flag("--effort", effort)],
  },
  codex: {
    efforts: CODEX_EFFORTS,
    models: {
      "gpt-6.1-sol": CODEX_ULTRA,
      "gpt-6-astra": CODEX_ULTRA,
      "gpt-6-sol": CODEX_ULTRA,
      "gpt-6-luna": CODEX_EFFORTS,
      "gpt-5.6-sol": CODEX_ULTRA,
      "gpt-5.6-terra": CODEX_ULTRA,
      "gpt-5.6-luna": CODEX_EFFORTS,
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
    },
    // A bare value is not valid TOML, so codex takes it as a literal string,
    // which spares the argument a pair of quotes Herdr would have to escape.
    args: (model, effort) => [...flag("-m", model), ...flag("-c", effort && `model_reasoning_effort=${effort}`)],
  },
};

// null is the CLI's own default, for the model and the effort alike.
function modelsFor(kind) {
  const entry = MODELS[kind];
  return entry ? [null, ...Object.keys(entry.models)] : null;
}

function effortsFor(kind, model) {
  const entry = MODELS[kind];
  if (!entry) return [null];
  return [null, ...(model ? entry.models[model] ?? [] : entry.efforts)];
}

// Prefs and recovered drafts can name a model this table has since dropped, so
// anything unknown falls back to the default rather than reaching the CLI.
function normalize(kind, choice) {
  const models = modelsFor(kind) ?? [null];
  const model = models.includes(choice?.model) ? choice.model : null;
  const effort = effortsFor(kind, model).includes(choice?.effort) ? choice.effort : null;
  return { model, effort };
}

function modelArgs(kind, choice) {
  const entry = MODELS[kind];
  if (!entry) return [];
  const { model, effort } = normalize(kind, choice);
  return entry.args(model, effort);
}

function modelLabel(choice) {
  if (!choice?.model && !choice?.effort) return "default model";
  return [choice.model ?? "default", choice.effort].filter(Boolean).join(" · ");
}

module.exports = { modelsFor, effortsFor, normalize, modelArgs, modelLabel };
