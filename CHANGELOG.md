# Changelog

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
- **Tests**: 84 tests (store, gates, retrieval, prompt budgets, self-heal, capture,
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
