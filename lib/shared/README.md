# lib/shared

These files are the same in herdr-quick-prompt and herdr-scratchpad.

- Edit them in herdr-quick-prompt only.
- Then run `node tools/sync-shared.js` there. It copies this folder into
  `../herdr-scratchpad` (or the path you pass) and updates `checksums.json`
  in both repos.
- `test/shared.test.js` fails in either repo if a file here no longer matches
  `checksums.json`.

Nothing in here may require a file outside this folder.
