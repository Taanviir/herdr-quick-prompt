"use strict";

// shift+enter and ctrl+enter reach a pane as a bare \r unless the pane asks
// for the kitty keyboard protocol. Asking for it also moves Escape and every
// ctrl and alt chord onto CSI u, which readline cannot parse, so each CSI u key
// is turned back into what a legacy terminal sends, and a modified Enter into
// \n: the newline key.
const KITTY_ON = "\x1b[>1u";
const KITTY_OFF = "\x1b[<u";

const CSI_U = /\x1b\[(\d+)(?::\d*)*(?:;(\d+)(?::\d+)*)?u/g;
const SHIFT = 1;
const ALT = 2;
const CTRL = 4;

function legacyKeys(text) {
  return text.replace(CSI_U, (_, code, mods = "1") => {
    const bits = Number(mods) - 1;
    const key = Number(code);
    if (key === 13) return bits ? "\n" : "\r";

    let bytes;
    if (key === 27) bytes = "\x1b";
    else if (key === 127) bytes = bits & CTRL ? "\b" : "\x7f";
    else if (key === 9) bytes = bits & SHIFT ? "\x1b[Z" : "\t";
    else if (bits & CTRL && key >= 97 && key <= 122) bytes = String.fromCharCode(key - 96);
    else if (bits & CTRL && key === 32) bytes = "\x00";
    else if (key >= 32 && key < 0xe000) bytes = String.fromCodePoint(key);
    else return ""; // keypad and media keys the picker has no use for
    return bits & ALT ? `\x1b${bytes}` : bytes;
  });
}

module.exports = { KITTY_ON, KITTY_OFF, legacyKeys };
