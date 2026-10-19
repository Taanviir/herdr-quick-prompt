"use strict";

// Plain \r launches. \n is ctrl+j, or shift+enter and ctrl+enter as
// lib/keys translates them. ESC \r is alt+enter, and shift+enter in terminals
// set up the way Claude Code's /terminal-setup does it.
function isNewline(chunk, key) {
  return chunk === "\n" || (key.ctrl && key.name === "j") || (key.meta && key.name === "return");
}

// The editing keys shared by the prompt and the directory field, covering what
// Linux, Windows and macOS terminals send for them. macOS terminals with Option
// as Meta send alt+b / alt+f for option+arrow, and cmd+arrow arrives as
// ctrl+a / ctrl+e or Home / End. Returns whether the key was one of these.
function editKey(editor, chunk, key) {
  switch (true) {
    case (key.name === "left" && (key.ctrl || key.meta)) || (key.meta && key.name === "b"):
      editor.wordLeft();
      break;
    case (key.name === "right" && (key.ctrl || key.meta)) || (key.meta && key.name === "f"):
      editor.wordRight();
      break;
    case key.name === "left":
      editor.move(-1);
      break;
    case key.name === "right":
      editor.move(1);
      break;
    case key.name === "home" || (key.ctrl && key.name === "a"):
      editor.toLineStart();
      break;
    case key.name === "end" || (key.ctrl && key.name === "e"):
      editor.toLineEnd();
      break;
    // ctrl+backspace arrives as a bare \b in most terminals.
    case (key.name === "backspace" && key.meta) || chunk === "\b" || (key.ctrl && key.name === "w"):
      editor.deleteWord();
      break;
    case (key.name === "delete" && (key.ctrl || key.meta)) || (key.meta && key.name === "d"):
      editor.deleteWordForward();
      break;
    case key.name === "backspace":
      editor.backspace();
      break;
    case key.name === "delete":
      editor.deleteForward();
      break;
    case key.ctrl && key.name === "u":
      editor.clear();
      break;
    case isPrintable(chunk, key):
      editor.insert(chunk);
      break;
    default:
      return false;
  }
  return true;
}

function isPrintable(chunk, key) {
  return Boolean(chunk) && !key.ctrl && !key.meta && chunk >= " " && chunk !== "\x7f";
}

module.exports = { isNewline, editKey, isPrintable };
