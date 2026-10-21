# Changelog

## 0.3.0 - 2026-10-22


One new command, the command layer put under test, dead code removed, and the write
path made cheaper without changing what it writes.


### Added


- **`/memory inspect <file> [passphrase=]`** - read a container's metadata (record
  count, export time, note, encryption and authentication status) without importing
  anything. Inspect a container you did not make before you import it.
- **`test/commands.test.ts`** - drives the command layer with a fake pi context. It now
  proves, end to end, the properties the documentation claimed: `delete-all` stages a
  token, deletes nothing until the token is presented, writes exactly one backup
  container first, and that backup restores; long listings go to a file instead of the
  terminal; a rejected config value names the accepted values.
- **`test/hygiene.test.ts`** - with no compiler in the pipeline: no unused imports,
  no exported symbol nothing references, every relative import resolves, and no shipped
  file reaches into `test/`, `scripts/`, or `docs/`.
- `/memory status` reports which pi release the build was verified against.


### Fixed


- `/memory inspect` referenced an options object that did not exist in that scope; the
  new command test caught it.
- Two container tamper tests were flaky because they assumed the digest lives in the
  body (it lives in the header) and because some base64 bit flips are not observable.
  Replaced with: change a hex digit of `payloadSha256` and require the tamper verdict;
  flip a payload byte and require that nothing imports silently.
- The payload digest is compared with `timingSafeEqual` behind a length guard instead
  of `!==` on hex strings.


### Changed


- **Removed exports nothing called** (`citedCommands`, `healNote`, `matchesCited`,
  `findContradicted`, `recordText`, `isRetired`, `configAsPlainObject`, `envVarNames`,
  `specKeys`, `storeRootToken`, `jsonSafe`, `CONFIDENCE`, `CONFIG_KEYS`,
  `captureNoteFor`, `DEFAULTS_REF`, `draftForTest`) plus unused imports. Dead exports
  become a second, undocumented API surface.
- `node:crypto` is confined to the container codec and the token helper, and `node:zlib`
  to the container codec, enforced in the offline test.
- README states what each install source puts on disk: npm takes the published tarball
  (no tests or scripts), git clones the repository (development folders present but
  never imported), a local path is loaded in place.


### Performance


- Writes no longer re-parse the whole store. Every write path used to call a forced
  reload to rebuild `index.json` and `INDEX.md`; the read cache is now updated in place
  and the indexes render from it. Measured on this machine: ~71 ms to ~43 ms per write
  at 200 records, against ~6 ms for the file write itself. A new test asserts the
  incremental indexes are byte-identical to a full rescan, including after a retire
  moves a file between `records/` and `archive/`.
- `tokenSimilarity` memoises token sets (bounded), which the duplicate scan was
  recomputing for the whole store on every write.

## 0.2.0 - 2026-10-22

Record management, a secure container format, user-facing configuration, and
git-based versioning of records made strictly contained.

### Added

- **High-level views**: `/memory overview` (per-category counts with disputed and
  never-verified totals), `/memory ls [category] [sort=…] [retired]` (one line per
  record: id, confidence, hits, age, warnings), both written to a file rather than
  into context.
- **Interactive browser**: `/memory browse [category]` - pick a category, then a
  record, then `verify / retire / restore / DELETE`. Deleting one record requires a
  confirm *and* typing the record id, so it cannot be done by picking a menu item.
- **Delete everything**: `/memory delete-all` with a two-step token confirmation
  (first call stages and explains, second must present the 6-character token, which
  expires in 10 minutes). It always writes a container backup first and prints the
  restore command. `confirmDestructive: false` cannot bypass it.
- **Container format** (`.gmect`) for `/memory export` / `/memory import`:
  deflate-raw compression, SHA-256 payload digest, optional **AES-256-GCM** with a
  scrypt-derived key (the header is authenticated data, so editing the file breaks
  the tag), versioned header, decompression-bomb cap, and record-count caps.
  Plain JSON import is still accepted for hand-written files.
- **Export privacy gate**: records whose text looks like a secret, personal
  identifier, or confidential material are skipped and reported unless you pass
  `allowprivate` deliberately.
- **Configuration that explains itself**: `/memory config list` groups every key in
  plain language with the effect of changing it, `/memory config explain <key>`
  shows type/default/allowed values/effect, `/memory config where` shows which
  source is winning. Validation and documentation now come from one registry
  (`lib/configspec.ts`), and a rejected value names the expected shape or suggests
  the key you meant.
- **Versioning discipline**: `lib/version.ts` is the single source for the
  extension version and the store/container format versions; `package.json` gained a
  `files` allowlist. `test/version.test.ts` pins version, changelog head, and the
  rule that every file reachable from `index.ts` is published and nothing
  development-only is reachable.

### Changed

- **Git inside the extension is now containment-first.** It exists for one job:
  internal versioning of records. Every invocation uses `--git-dir`/`--work-tree`
  plus `GIT_DIR`/`GIT_WORK_TREE` pointed at `<store>/.git`, so git's upward
  repository discovery can never reach a parent repo (your project, your home
  directory). Global and system git config are overridden with an empty file inside
  the store, hooks are disabled via `core.hooksPath`, `fsmonitor`/`gc.auto`/signing
  are off, subcommands run through an allow-list, credential and ssh helpers fail
  closed, and everything keeps `GIT_ALLOW_PROTOCOL=none` plus timeouts and output
  caps. Commits are attributed to `pi-global-memory <memory@localhost>` unless you
  set an identity inside the store repo.
- **Store versioning posture is explicit.** With `gitAutoCommit: true` the store
  keeps its own history of `records/`, `archive/`, and indexes, while `out/`,
  `backups/`, `pending/`, `*.gmect`, `.lock` and the isolation config stay
  untracked. With the default `false`, nothing in the store is tracked.
- `index.json` no longer embeds an absolute store path (a committed store no longer
  differs between machines) and declares the store format version.
- Passphrases are read from `PI_GLOBAL_MEMORY_PASSPHRASE` first; passing one as a
  command argument still works but warns, because arguments land in the session
  transcript.

### Fixed

- Catalog truncation no longer cuts off the "how to get the rest" pointer.
- Near-duplicate refusal is limited to same-category candidates; cross-category
  similarity is advisory, so the model is not pushed into `force` retries.
- Tool action vocabularies are literal unions, so pi validates them before the
  handler sees a value.

## 0.1.0 - 2026-10-21

First working release. Verified against pi 1.3.0.

### Added

- **Prompt layer**: two named, budgeted system-prompt sections - `global_memory`
  (catalog + usage rules, 1800 chars) and `global_memory_hits` (per-run matches,
  900 chars) - so a changing run does not resend the catalog.
- **Tools**: `memory_lookup` (search / read / catalog / categories / stats / audit,
  declared read-only) and `memory_save`
  (add / update / verify / retire / restore / supersede).
- **Commands**: `/memory` with `status on off use record pause toggle search catalog
  read audit review accept verify retire restore merge delete prune doctor config
  export import reindex selftest`.
- **Store**: one Markdown file per record under `records/<category>/<id>.md`,
  `archive/` for retired records, derived `index.json` + `INDEX.md`, exclusive
  locking, atomic writes, path confinement, batched usage counters, optional
  local-only git auto-commit.
- **Retrieval**: field-weighted inverted index with IDF, phrase and multi-term
  bonuses, confidence/verification/usage priors, project-scope bonus, and a
  `minSearchScore` floor so weak matches return "no match" instead of a guess.
- **Reliability gates**: mandatory evidence citation, 0-10 `qualityScore` rubric
  with `minQuality` floor, hedge demotion, cross-check of near-duplicates,
  `valueScore` decay, `tentativeTtlDays` / `staleDays` expiry, `/memory audit`.
- **Self-healing**: live tool results are classified against the records that were
  surfaced; contradictions dispute the record (confidence drop, `DISPUTED`,
  removed from prompt injection), confirmations raise `verifiedCount` and can
  restore confidence. Queued during the run, flushed once at `agent_end`.
- **Privacy/security**: `privacy: strict` and `sketchy: block` by default, secret
  blocking/masking, instruction-shape defang on the way in and out, ephemeral
  session (`--no-session`) recording suppression, project-trust requirement for
  writes, per-session write quota, size caps, no network APIs (enforced by test).
- **Toggles**: `/memory use|record|on|off|pause`, `--no-global-memory`,
  `--global-memory-use`, `--global-memory-record`, `PI_GLOBAL_MEMORY_*`,
  `globalMemory` in pi settings, `<store>/config.json`, optional `toggleShortcut`.
- **Auto-capture**: `autoCapture: "fixes"` mines failed-call -> proven-fix chains
  at `agent_end`; candidates are flagged `auto`, marked tentative, and listed by
  `/memory review` / `/memory accept`.
- **Tests**: 85 tests (store, gates, retrieval, prompt budgets, self-heal, capture,
  config, extension wiring against a mock pi API, offline/network invariants) plus
  `scripts/load-check.mjs`, which loads the extension through pi's real loader and
  asserts registrations and schema validation.
- **Docs**: README (config reference, store layout, record anatomy), SECURITY.md
  (threat model and invariants), DESIGN.md (decisions and rejected alternatives),
  docs/NOTES.md (pi API facts with file/line evidence).

### Known limitations

- Catalog injection lists a ranked sample, not the whole store; beyond
  `maxIndexEntries` the agent must search.
- Token retrieval has no synonym recall; `cues` are the designed mitigation.
- One shared store per agent directory (project-scoped records, not per-project stores).
- File modes are tightened only on POSIX platforms; on Windows the parent ACL applies.
