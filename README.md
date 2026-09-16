# Quick Prompt

A [Herdr](https://herdr.dev) plugin. Press a key, pick a coding agent, type a
prompt — Quick Prompt opens a new tab, starts that agent there, and delivers the
prompt for you.

```
  1 claude   2 codex   3 cursor   4 opencode   5 pi           +17 ctrl+k

› refactor the auth module to use the new token format


───────────────────────────────────────────────────────────────────────
→ new tab · ~/projects/budgit                                     ctrl+t
⏎ launch · tab agent · ctrl+v paste · ctrl+j newline · esc cancel
```

## Install

```bash
herdr plugin install <owner>/herdr-quick-prompt
```

Requires **Node 18 or newer** on `PATH` — that is the only dependency, and there
is no build step.

Herdr plugins cannot register their own keybindings, so there is a second
action that adds one for you:

```bash
herdr plugin action invoke taanviir.quick-prompt.setup
```

It appends the binding to your `config.toml`, backs up the previous file, and
reloads Herdr. The default prefix is `ctrl+b`, so the binding is **ctrl+b** then
**shift+c**. Set `QUICK_PROMPT_KEY` to bind something else, and if the key is
already taken the action says so rather than shadowing it.

To do it by hand instead, add this to `~/.config/herdr/config.toml` and run
`herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "taanviir.quick-prompt.open"
description = "Quick Prompt"
```

You can also open it without a key:

```bash
herdr plugin action invoke taanviir.quick-prompt.open
```

## Using it

Everything is on one screen, and the cursor starts in the prompt — just type and
press `enter`.

| Key | |
| --- | --- |
| `⏎` | launch (an empty prompt just opens the agent) |
| `ctrl+j` | newline in the prompt |
| `ctrl+v` | paste from the system clipboard |
| `tab` / `shift+tab` | next / previous agent |
| `alt+1`…`alt+9` | jump straight to a numbered agent |
| `ctrl+k` | the full agent list, filterable by typing |
| `ctrl+t` | destination: new tab → split right → split down |
| `esc` | cancel |

Editing keys work as you would expect: `ctrl+a`/`ctrl+e`, `ctrl+w`, `ctrl+u`,
arrows, backspace, delete.

The numbered chips are the agents you actually have installed, most recently
used first, so `alt+1`–`alt+9` always mean something. Every kind Herdr supports
is behind `ctrl+k`, where a filled dot marks the installed ones. Your last agent
and destination are remembered.

Pasting works whether or not your terminal supports it. A paste arrives as a
burst of keypresses where a newline would otherwise mean "launch" and a tab
would mean "next agent", so the picker collects the whole burst and inserts it
as text: bracketed paste when the terminal marks it, and a byte-count check when
it does not. `ctrl+v` is not a terminal paste at all — the byte reaches the
application — so the picker reads your clipboard itself through `wl-paste`,
`xclip`, `xsel`, `pbpaste`, or PowerShell on WSL and Windows.

A new tab is labelled with the first line of your prompt, the agent opens in the
directory of the pane you invoked from, and it is named `qp-<kind>` so you can
keep driving it from scripts:

```bash
herdr agent read qp-codex --source recent-unwrapped --lines 120
```

## How it works

| File | Role |
| --- | --- |
| `herdr-plugin.toml` | Manifest: the `open` and `setup` actions, and the `picker` popup pane |
| `bin/open.js` | Action entrypoint; resolves the caller's cwd and opens the popup |
| `bin/setup.js` | Action entrypoint; writes the keybinding into `config.toml` |
| `bin/picker.js` | The modal TUI |
| `bin/launch.js` | Detached worker: creates the tab, starts the agent, sends the prompt |
| `lib/` | Herdr CLI wrapper, agent catalog, text buffer, terminal-width helpers |

The picker hands off to a detached worker and exits immediately, so the modal
never sits there blocking while an agent boots.

The worker delivers the prompt one of two ways. Agents whose CLI takes a prompt
as a launch argument get it that way:

```bash
herdr agent start qp-claude --kind claude --pane <p> -- "refactor the auth module"
```

The agent has the prompt before its TUI paints, which is both faster and immune
to a startup repaint eating the keystrokes. Everything else falls back to typing
into the TUI: wait for `interactive_ready`, send, then confirm the text actually
landed before retrying. Failures surface as a Herdr notification.

Set `QUICK_PROMPT_NO_INLINE=1` to force the keystroke path, for comparing the two
when an agent misbehaves with a launch argument.

The agent list is read from `herdr agent start --help` at runtime, so new agent
kinds appear as soon as Herdr supports them. Your recent agents and last
destination live in `HERDR_PLUGIN_STATE_DIR`.

The picker renders inside the popup Herdr already draws, so it has no border or
title of its own, and it never moves its own working directory: the manifest
launches it by a path relative to the plugin root, and the directory you invoked
from travels as `QUICK_PROMPT_CWD` instead.

## Troubleshooting

**The popup flashes and closes.** Something made the picker exit. Popup output
does not appear in `herdr plugin log list`, so the picker writes uncaught errors
to `crash.log` in its state directory:

```bash
cat "$(herdr plugin config-dir taanviir.quick-prompt | sed 's|/config/|/plugins/|')/crash.log"
# or, on Linux: ~/.local/state/herdr/plugins/taanviir.quick-prompt/crash.log
```

A crash that happens before the picker starts — a missing Node, a broken
install — leaves nothing there. Check `node --version` and
`herdr plugin list` in that case.

## Development

```bash
herdr plugin link .                              # no build step
herdr plugin action invoke taanviir.quick-prompt.open
herdr plugin log list --plugin taanviir.quick-prompt
herdr plugin unlink taanviir.quick-prompt
```

To try the picker outside a popup, run it in any pane:

```bash
QUICK_PROMPT_CWD="$PWD" node bin/picker.js
```

Text handling works in grapheme clusters and terminal cells rather than UTF-16
units, so CJK, emoji and combining accents wrap and delete as single visible
characters. `lib/text.js` owns that; nothing else should be measuring with
`.length`.

## Acknowledgements

The idea for this came from [NEBULA](https://github.com/agentSystemLabs/nebula)
by WebDevCody.
