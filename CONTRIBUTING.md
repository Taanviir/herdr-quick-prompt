# Contributing

Thanks for looking. This is a small plugin with no dependencies and no build
step — a checkout and Node 18+ is the whole setup.

## Running from a checkout

```bash
git clone https://github.com/Taanviir/herdr-quick-prompt
cd herdr-quick-prompt
herdr plugin link .
```

`plugin link` registers the working directory itself, so edits take effect on
the next invocation. There is nothing to rebuild.

```bash
herdr plugin action invoke taanviir.quick-prompt.open   # open the popup
herdr plugin log list --plugin taanviir.quick-prompt    # action stdout/stderr
herdr plugin unlink taanviir.quick-prompt               # when you are done
```

Note that `plugin install` refuses to run over a linked plugin, so unlink before
testing the published copy.

## Layout

| File | Role |
| --- | --- |
| `herdr-plugin.toml` | Manifest: the `open` and `setup` actions, and the `picker` popup pane |
| `bin/open.js` | Resolves the caller's location and opens the popup |
| `bin/setup.js` | Writes the keybinding into the user's `config.toml` |
| `bin/picker.js` | The modal TUI: rendering, keys, paste |
| `bin/launch.js` | Detached worker: creates the tab or split, starts the agent, delivers the prompt |
| `lib/herdr.js` | Herdr CLI wrapper — every call goes through `HERDR_BIN_PATH` |
| `lib/agents.js` | Agent catalog, `PATH` detection, which kinds take an inline prompt |
| `lib/editor.js` | The prompt buffer: grapheme clusters, wrapping, cursor |
| `lib/text.js` | Terminal-cell width and paste sanitising |
| `lib/ui.js` | Colours, padding, truncation, path shortening |
| `lib/clipboard.js` | Reading the system clipboard for `ctrl+v` |
| `lib/dirs.js` | Directory suggestions and path completion for `ctrl+d` |
| `lib/state.js` | Preferences and launch requests under `HERDR_PLUGIN_STATE_DIR` |

## Things that will bite you

**Never measure text with `.length`.** Width and cursor arithmetic is in
terminal cells, not UTF-16 units — CJK is two cells wide, an emoji is one
grapheme of several code units, a combining accent is zero. `lib/text.js` owns
this; everything else goes through `displayWidth` and `clusters`.

**The picker must not move its working directory.** The manifest launches it as
the relative path `bin/picker.js`, so it only resolves from the plugin root. The
directory the user invoked from travels as `QUICK_PROMPT_CWD` instead.

**A popup's output goes nowhere.** Pane commands do not appear in
`herdr plugin log list`, so a crash is just a window that blinks once. Uncaught
errors are appended to `crash.log` in the state directory — check there first.

**A lone ESC byte is the Escape key.** Readline cannot tell `esc` from the start
of an arrow key, so it waits 500ms before deciding — which is a very long time to
watch a modal you just cancelled. Terminals send real escape sequences in one
write, so a one-byte read containing `\x1b` is acted on immediately, and the
keypress readline emits half a second later is dropped.

**Herdr owns the popup's frame and size.** It draws the border and title, and
hands the process fewer rows and columns than the manifest declares — three
columns and two rows go to the frame. Cells the picker never writes show the
panes behind it, so every row is padded to the full width.

## Testing

Run the picker in any pane to poke at it by hand:

```bash
QUICK_PROMPT_CWD="$PWD" node bin/picker.js
```

That will not catch layout bugs, though: a pane is tall and has no popup chrome.
For anything about rendering, paste, or keys, drive it on a pty at the popup's
real size — a paste is only bytes arriving at once, so it can be replayed
exactly:

```python
import os, pty, fcntl, termios, struct, time
pid, fd = pty.fork()
if pid == 0:
    os.environ["QUICK_PROMPT_CWD"] = os.getcwd()
    os.execvp("node", ["node", "bin/picker.js"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 10, 73, 0, 0))
time.sleep(0.9)
os.write(fd, b"\x1b[200~pasted\r\ntext\x1b[201~")   # a bracketed paste
```

Then read the output back and check it: no line wider than the terminal, the
prompt where you expect it, and — for paste — that nothing launched.

When changing anything the user can launch, remember that `bin/launch.js` starts
a real agent in a real tab. Point `HERDR_BIN_PATH` at `/bin/true` to exercise the
path without one.

## Screenshots

The images in the README are generated, not cropped, so they cannot drift from
what the code prints:

```bash
python3 tools/screenshot.py docs/quick-prompt.png --type "refactor the auth module"
python3 tools/screenshot.py docs/quick-prompt-agents.png --keys '\x0b'
python3 tools/screenshot.py docs/quick-prompt-directory.png --keys '\x04'
python3 tools/screenshot.py docs/quick-prompt-split.png --recent codex \
    --type "add a migration for the invoices table" --keys '\x14\x14'
```

It runs the picker on a pty at the popup's real size and draws the captured
output with Herdr's default palette. Needs Pillow and DejaVu Sans Mono;
nothing at runtime does.

The directory picker lists real directories, so the run gets a fixture `HOME`
(`PROJECTS` in the script) rather than yours — otherwise the images would
change with whoever regenerated them. Resizing the popup means changing `ROWS`
to match and regenerating all four.

## Style

Match what is there: plain CommonJS, no dependencies, no build step. Comments
explain why something is the way it is — a terminal quirk, an ordering
constraint — not what the line does.

## Releasing

Versions live in two places and must agree: `version` in `herdr-plugin.toml`
and `version` in `package.json`. A release is a merge to `main` that bumps
them: commit the bump as `Version X.Y.Z` in the PR, and when it lands the
`Release` workflow runs the tests and publishes `vX.Y.Z` with generated notes
and the `herdr plugin install --ref vX.Y.Z` command. A merge that leaves the
version alone publishes nothing. Nothing is built or uploaded; the tag is the
artifact.
