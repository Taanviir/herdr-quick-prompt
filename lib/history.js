"use strict";

// Walking back through earlier prompts, newest first. Whatever was being typed
// when the walk began is kept aside and comes back when you walk past the
// newest entry, so recalling an old prompt never costs you the new one.
class History {
  constructor(entries) {
    this.entries = entries;
    this.at = -1;
    this.draft = "";
  }

  older(text) {
    if (this.at + 1 >= this.entries.length) return null;
    if (this.at < 0) this.draft = text;
    this.at += 1;
    return this.entries[this.at];
  }

  newer() {
    if (this.at < 0) return null;
    this.at -= 1;
    return this.at < 0 ? this.draft : this.entries[this.at];
  }
}

module.exports = { History };
