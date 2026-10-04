# Quick Prompt

A [Herdr](https://herdr.dev) plugin. Press a key, pick a coding agent, type a
prompt. Quick Prompt opens a new tab, starts the agent there, and hands it the
prompt.

![The Quick Prompt popup: numbered agent chips, a prompt, and the destination it will open in](docs/quick-prompt.png)

- One screen, with the cursor already in the prompt.
- Launch into a new tab, a split, a new workspace, or a new git worktree.
- Send a follow-up to an agent that is already running.
- Presets, prompt history, and a draft that survives closing the popup.
- No dependencies and no build step. Just Node 18 or newer.

## Install

```bash
herdr plugin install Taanviir/herdr-quick-prompt
herdr plugin action invoke taanviir.quick-prompt.setup
```

The second command adds two keys to your `config.toml` and reloads Herdr:
**ctrl+b** then **shift+c** opens Quick Prompt, and **ctrl+b** then **shift+a**
opens it on the agent in the current pane. Set `QUICK_PROMPT_KEY` or
`QUICK_PROMPT_DUPLICATE_KEY` first to use other keys. A key that is already
bound is left alone, and setup says which.

To bind them by hand, put this in `~/.config/herdr/config.toml` and run
`herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "taanviir.quick-prompt.open"
description = "Quick Prompt"

# Opens on the agent in the current pane, in the directory it is working in.
[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "taanviir.quick-prompt.duplicate"
description = "Quick Prompt with the focused agent"
```

## Keys

| Key | |
| --- | --- |
| `⏎` | launch (an empty prompt just opens the agent) |
| `ctrl+l` | launch without leaving where you are, and keep the popup open |
| `shift+⏎`, `alt+⏎`, `ctrl+j`, `\` `⏎` | new line |
| `↑` / `↓` | move between lines; past the first or last, earlier prompts |
| `tab`, `alt+1`…`alt+9` | next agent, or jump to a numbered one |
| `ctrl+k` | every agent Herdr supports, filterable |
| `ctrl+t` | where it opens: tab → split right → split down → workspace → worktree |
| `ctrl+d` | which directory it starts in |
| `ctrl+o` | model and effort (Claude Code and Codex) |
| `ctrl+p` / `ctrl+x` | pick a preset / remove it |
| `ctrl+r` | follow up on an agent that is already running |
| `ctrl+s` | not now: save the prompt to [Scratchpad](https://github.com/Taanviir/herdr-scratchpad) as a note |
| `ctrl+v` | paste from the system clipboard |
| `ctrl+u` / `ctrl+y` | clear the prompt / bring it back |
| `ctrl+g` | list every key |
| `esc` | close, keeping what you typed |

In a list, the key that opened it closes it again, and `esc` clears what you
typed to filter it before it closes the list.

The usual word keys work too: `ctrl+←`/`→` or `alt+b`/`alt+f` to move by word,
`ctrl+w` or `alt+backspace` to delete one, and `ctrl+a`/`ctrl+e` for the start
and end of the line.

## What it does

**Agents.** The numbered chips are the agents installed on this machine. Their
order never changes, so `alt+2` always means the same agent. The last one you
used starts selected. An agent that is not on your `PATH` is marked `○`, and
Enter on one asks again before launching it. `ctrl+k` lists every kind Herdr
supports:

![The full agent list, with installed agents marked](docs/quick-prompt-agents.png)

**Destination.** `ctrl+t` picks where the agent opens. Tab and split are
remembered for next time; a workspace or worktree is for one launch only. A
new worktree gets a branch named after the first line of your prompt, leaving
out any paths ("Fix the login bug" becomes `fix-the-login-bug`), after the
preset if the prompt is empty, or a random name. The destination row shows the
branch as you type. It branches from the commit `origin/HEAD` points at when
the repository has one, otherwise from the current `HEAD`; set
`QUICK_PROMPT_WORKTREE_BASE` to use another base. The new branch does not
track its base, so a plain `git push` will not aim at `main`. The worktree option only appears inside a git repository.
If the agent never starts, the tab, split or workspace made for it is closed
again; a worktree is kept.

**Launch and stay.** `ctrl+l` launches without moving focus and keeps the
popup open with an empty prompt, so you can start several agents in a row. A
Herdr notification says where each one went.

**Directory.** `ctrl+d` lists the directory you are in, ones you launched into
before, and neighbouring projects. Type to filter, or type a path starting with
`/` or `~`:

![The directory picker, listing neighbouring projects](docs/quick-prompt-directory.png)

**Model and effort.** `ctrl+o` sets them for Claude Code and Codex. Each agent
remembers its own choice from the moment you pick it. The destination row
shows the model once it is not the default. The model lists live in
`lib/models.js`.

**Follow-ups.** `ctrl+r` lists running agents, the ones waiting on you first.
Pick one and Enter sends your prompt to it instead of starting a new agent.
`esc` goes back to launching. A quiet notification says when the follow-up
landed. A blocked agent cannot be picked until you answer it in its own pane,
since Herdr will not prompt it.

**Saving for later.** With [Scratchpad](https://github.com/Taanviir/herdr-scratchpad)
installed, `ctrl+s` turns the prompt into a note instead of launching it. The
note is filed under the directory the prompt would have started in, and
remembers the agent and branch you were looking at. From Scratchpad, `ctrl+n`
brings notes back here as a prompt.

**Drafts and history.** Closing with `esc` keeps your prompt, agent,
destination and directory for next time. A launch that fails comes back the
same way, so you can retry. When several are waiting, the newest opens first
and the rest follow one per opening. `↑` past the first line recalls your
last 50 prompts, with the agent, preset and model each went to.

**Pasting.** Pastes work in any terminal, and `ctrl+v` reads the clipboard
itself. If you drop a macOS screenshot from its floating thumbnail, macOS
deletes the file soon after. Quick Prompt copies it, and any image whose path
has spaces or non-ASCII characters, into its `attachments/` folder and pastes
that path instead.

## Presets

A preset wraps your prompt in text you would otherwise retype, and can pick
the agent, model and destination. Press `ctrl+p` to choose one; the list shows
the highlighted preset's text around your prompt. Presets live in `presets.json` in the
plugin's config directory (`herdr plugin config-dir taanviir.quick-prompt`):

```json
[
  {
    "name": "review",
    "agent": "codex",
    "prefix": "Review the change below. Point out bugs first, style last.",
    "postfix": "Do not edit any files."
  },
  {
    "name": "fix tests",
    "agent": "claude",
    "model": "sonnet",
    "destination": "worktree",
    "prefix": "Run the test suite and fix whatever fails.",
    "task": "skip"
  }
]
```

| Field | |
| --- | --- |
| `name` | required, unique |
| `agent` | optional agent kind, as listed under `ctrl+k`; ignored in a follow-up |
| `model`, `effort` | optional, as listed under `ctrl+o`; checked against `agent` when it is set |
| `destination` | optional: `tab`, `right`, `down`, `workspace` or `worktree` |
| `prefix`, `postfix` | text sent before and after your prompt |
| `task` | `skip` launches straight away when the prompt is empty, except in a follow-up |

A preset with a mistake in it is left out, and the list says why.

## Files

Everything lives in the plugin state directory, normally
`~/.local/state/herdr/plugins/taanviir.quick-prompt/` on Linux.

| File | |
| --- | --- |
| `prefs.json` | recent agents, directories, destination, models |
| `history.json` | your last 50 prompts, with the agent, preset and model each went to; delete it to forget them |
| `draft-*.json` | unsent and failed prompts, one per file, dropped after a day |
| `attachments/` | copied screenshots, deleted after a week |
| `catalog.json` | the agents Herdr supports and which are installed, so the popup opens without asking again |
| `clipboard.json` | which clipboard tool worked for `ctrl+v` |
| `startup.jsonl` | launch timings, and why a launch failed, without prompt text |
| `crash.log` | errors from the popup and the launcher |

The two logs move to `.previous` once they pass 256 KB, so neither grows for
ever.

## From other plugins

Another plugin can open Quick Prompt with the prompt already written, so it
gets the agent picker, destinations, presets and follow-ups without building
its own. [Scratchpad](https://github.com/Taanviir/herdr-scratchpad) does this
to hand notes to an agent.

```bash
herdr plugin pane open --plugin taanviir.quick-prompt --entrypoint picker \
  --env QUICK_PROMPT_TEXT="Fix the login bug" \
  --env QUICK_PROMPT_SOURCE="My plugin" \
  --env QUICK_PROMPT_CWD="$PWD"
```

| Variable | |
| --- | --- |
| `QUICK_PROMPT_TEXT` | the prompt to start with |
| `QUICK_PROMPT_SOURCE` | named in the notice, as "From …" |
| `QUICK_PROMPT_CWD` | the directory it starts in |
| `QUICK_PROMPT_WORKSPACE`, `QUICK_PROMPT_PANE` | where tabs and splits open |

A handed-over prompt is never saved as a draft, not even when its launch fails,
since it is still in the plugin that sent it. Any draft you left stays for next
time.

## Troubleshooting

**The popup flashes and closes.** Check `crash.log` above. If it is empty,
the popup never started: check `node --version` and `herdr plugin list`.

**An agent mangles the prompt.** Claude Code, Codex, Cursor and pi get a
one-line prompt as a launch argument; everything else has it typed in. Set
`QUICK_PROMPT_NO_INLINE=1` to type it in for every agent.

Agents are named `qp-<kind>`, so scripts can keep driving them:

```bash
herdr agent read qp-codex --source recent-unwrapped --lines 120
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for running from a checkout, the code
layout, and the terminal quirks worth knowing.

## Acknowledgements

The idea came from [NEBULA](https://github.com/agentSystemLabs/nebula) by
WebDevCody.

## License

[MIT](LICENSE).
