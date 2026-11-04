# lib/shared

These files are the same in herdr-quick-prompt, herdr-scratchpad and
herdr-projects.

- Edit them in herdr-quick-prompt only.
- Then run `node tools/sync-shared.js` there. It copies this folder into the
  sibling checkouts (or the paths you pass) and updates `checksums.json` in
  every repo.
- `test/shared.test.js` fails in any of them if a file here no longer matches
  `checksums.json`.

Nothing in here may require a file outside this folder.
