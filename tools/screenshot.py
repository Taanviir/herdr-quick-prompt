#!/usr/bin/env python3
"""Render the picker to a PNG.

Runs bin/picker.js on a real pty at the popup's real size, captures the final
repaint, and draws it with the colours Herdr's default theme uses, inside a
frame standing in for the one Herdr paints around the popup.

    python3 tools/screenshot.py docs/quick-prompt.png --type "refactor the auth module"

Requires Pillow and DejaVu Sans Mono. Development only: nothing at runtime
needs it.
"""

import argparse
import fcntl
import os
import pty
import re
import select
import shutil
import struct
import termios
import time

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_SIZE = 17
PAD = 14          # inside the frame
MARGIN = 18       # around the frame
COLS, ROWS = 73, 10

# Catppuccin Mocha, which is Herdr's default theme.
BASE = "#1e1e2e"
TEXT = "#cdd6f4"
BRIGHT = "#f5f6fa"
DIM = "#6c7086"
ACCENT = "#89dceb"
GREEN = "#a6e3a1"
YELLOW = "#f9e2af"

SGR = re.compile(r"\x1b\[([0-9;]*)m")
OTHER_ESCAPE = re.compile(r"\x1b\[[?0-9;]*[a-zA-Z]")
# The pty turns \n into \r\n, leaving a carriage return at the end of each line.
CONTROL = re.compile(r"[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
CURSOR_AT = re.compile(r"\x1b\[(\d+);(\d+)H")


def capture(keys, state_dir):
    """Run the picker, send `keys`, return (final screen text, cursor row/col)."""
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["QUICK_PROMPT_CWD"] = os.path.expanduser("~/projects/budgit")
        os.environ["HERDR_PLUGIN_STATE_DIR"] = state_dir
        os.execvp("node", ["node", "bin/picker.js"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    time.sleep(0.9)
    for chunk in keys:
        os.write(fd, chunk)
        time.sleep(0.4)

    buf = b""
    deadline = time.time() + 1.0
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        buf += data
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass

    text = buf.decode("utf8", "replace")
    screen = text.split("\x1b[2J\x1b[H")[-1]
    at = CURSOR_AT.findall(screen)
    cursor = (int(at[-1][0]) - 1, int(at[-1][1]) - 1) if at else None
    return screen, cursor


def cells(line):
    """Split one line into (text, foreground, background) runs."""
    runs = []
    fg, bg = TEXT, None
    pos = 0
    for match in SGR.finditer(line):
        chunk = CONTROL.sub("", OTHER_ESCAPE.sub("", line[pos:match.start()]))
        if chunk:
            runs.append((chunk, fg, bg))
        codes = [c for c in match.group(1).split(";") if c]
        if not codes or codes == ["0"]:
            fg, bg = TEXT, None
        elif codes == ["30", "46"]:
            fg, bg = BASE, ACCENT
        else:
            for code in codes:
                fg = {"2": DIM, "97": BRIGHT, "36": ACCENT, "32": GREEN, "33": YELLOW}.get(code, fg)
        pos = match.end()
    tail = CONTROL.sub("", OTHER_ESCAPE.sub("", line[pos:]))
    if tail:
        runs.append((tail, fg, bg))
    return runs


def render(screen, cursor, out_path):
    font = ImageFont.truetype(FONT, FONT_SIZE)
    cell_w = font.getlength("M")
    cell_h = FONT_SIZE + 6

    frame_w = int(cell_w * COLS) + PAD * 2
    frame_h = cell_h * ROWS + PAD * 2
    image = Image.new("RGB", (frame_w + MARGIN * 2, frame_h + MARGIN * 2), BASE)
    draw = ImageDraw.Draw(image)

    # The frame Herdr draws around a popup, with its title.
    box = (MARGIN, MARGIN, MARGIN + frame_w, MARGIN + frame_h)
    draw.rounded_rectangle(box, radius=6, outline=ACCENT, width=1)
    draw.rectangle((MARGIN + 12, MARGIN - 9, MARGIN + 12 + int(cell_w * 13), MARGIN + 9), fill=BASE)
    draw.text((MARGIN + 16, MARGIN - 9), "Quick Prompt", font=font, fill=ACCENT)

    lines = screen.split("\r\n")
    for row in range(ROWS):
        line = lines[row] if row < len(lines) else ""
        x = MARGIN + PAD
        y = MARGIN + PAD + row * cell_h
        for text, fg, bg in cells(line):
            width = font.getlength(text)
            if bg:
                draw.rectangle((x, y - 2, x + width, y + cell_h - 2), fill=bg)
            draw.text((x, y), text, font=font, fill=fg)
            x += width

    if cursor:
        row, col = cursor
        x = MARGIN + PAD + cell_w * col
        y = MARGIN + PAD + row * cell_h
        draw.rectangle((x, y - 1, x + cell_w, y + cell_h - 3), fill=TEXT)

    image.save(out_path)
    print(f"{out_path}  {image.width}x{image.height}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--type", default="", help="text to type before capturing")
    parser.add_argument("--keys", default="", help="extra raw bytes, python escapes")
    parser.add_argument("--recent", default="claude", help="agent to start selected")
    args = parser.parse_args()

    state = "/tmp/qp-screenshot-state"
    shutil.rmtree(state, ignore_errors=True)
    os.makedirs(state)
    with open(os.path.join(state, "prefs.json"), "w") as handle:
        handle.write('{"recents":["%s"],"destination":"tab"}' % args.recent)

    keys = []
    if args.type:
        keys.append(("\x1b[200~" + args.type + "\x1b[201~").encode())
    if args.keys:
        keys.append(args.keys.encode().decode("unicode_escape").encode())

    screen, cursor = capture(keys, state)
    render(screen, cursor, args.output)
    shutil.rmtree(state, ignore_errors=True)


if __name__ == "__main__":
    main()
