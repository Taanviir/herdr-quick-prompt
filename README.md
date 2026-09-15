# Quick Prompt

A [Herdr](https://herdr.dev) plugin. Press a key, pick a coding agent, type a
prompt — Quick Prompt opens a new tab, starts that agent there, and delivers the
prompt for you.

```
 Quick Prompt                        ~/projects/budgit
 ─────────────────────────────────────────────────────
 agent  cod▏
  ▸ codex                                           ●
    opencode                                        ●
    mastracode                                      ○
 ─────────────────────────────────────────────────────
 ↑↓ select · type to filter · enter continue · esc cancel
```

## Install

```bash
herdr plugin install <owner>/herdr-quick-prompt
```

Requires **Node 18 or newer** on `PATH` — that is the only dependency, and there
is no build step.

Herdr plugins cannot register their own keybindings, so add one to
`~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "taanviir.quick-prompt.open"
description = "Quick Prompt"
```

Then `herdr server reload-config`. The default prefix is `ctrl+b`, so the
binding is **ctrl+b** then **shift+c**.

You can also open it without a key:

```bash
herdr plugin action invoke taanviir.quick-prompt.open
```

## Using it

**Agent step** — `↑`/`↓` to select, type to filter, `enter` to continue, `esc` to
cancel. A filled dot marks agents found on your `PATH`; the rest are kinds Herdr
supports but that are not installed here. Recently used agents sort to the top.

**Prompt step** — type the prompt, `enter` to launch, `ctrl+j` for a newline,
`esc` to go back to the agent list (your draft is kept). Launching with an empty
prompt just opens the agent in a new tab. Editing keys: `ctrl+a`/`ctrl+e`,
`ctrl+w`, `ctrl+u`, arrows, backspace, delete.

The new tab is labelled with the first line of your prompt, opens in the
directory of the pane you invoked from, and the agent is named `qp-<kind>` so you
can keep driving it from scripts:

```bash
herdr agent read qp-codex --source recent-unwrapped --lines 120
```

## How it works

| File | Role |
| --- | --- |
| `herdr-plugin.toml` | Manifest: the `open` action and the `picker` popup pane |
| `bin/open.js` | Action entrypoint; resolves the caller's cwd and opens the popup |
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
kinds appear as soon as Herdr supports them. Recents live in
`HERDR_PLUGIN_STATE_DIR`.

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
