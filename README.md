# pi-global-memory

A neat, efficient, local, offline, git-friendly **global memory** for the [pi](https://pi.dev) coding agent: verified facts, research findings, proven fixes, mistakes and their corrections, patterns, workflows, and environment facts - retrieved on demand instead of re-derived every session.

The problem it removes: the agent researching the same proxy/lockfile/port-flag/CLI-quirk question three times in one week, or repeating a mistake it already paid for.

The cost it accepts: about **2.7 KB of stable prompt text** plus a per-run hits section (≤900 chars), and two tools the model can call when the catalog says an answer exists.

```
global memory: 412 live records  ->  catalog in context (~1.8 KB)  ->  "git(63) docker(48) windows(31) ..."
agent asks: memory_lookup {"action":"search","query":"docker layer cache"}
agent reads: memory_lookup {"action":"read","ids":["gm-docker-layer-cache-ignores-4f70"]}
```

- **Offline by construction.** No network API is referenced anywhere in the extension; a test enforces it (`test/offline.test.ts`). Git bookkeeping runs with `GIT_ALLOW_PROTOCOL=none` and `protocol.ext.allow=never`, so even the optional auto-commit cannot reach a remote.
- **Private by default.** Personal identifiers, confidential-sounding text, secrets, transcripts, and hedged guesses are refused unless you explicitly relax the posture.
- **Accuracy first.** A memory that live evidence contradicts gets *disputed* automatically, drops out of prompt injection, and is corrected or retired - a wrong memory is worse than none.
- **Auditable.** Every record is one Markdown file with front-matter metadata: `records/<category>/<id>.md`. `grep`, `git diff`, and other agents can read the store without this extension.

Status: `0.1.0`, verified against pi **1.3.0** (`npm run check` loads it through pi's real extension host). See [CHANGELOG.md](CHANGELOG.md).

---

## Install

From this folder:

```bash
pi install ./D:/AI/proj/pi-global-memory     # writes a declaration to ~/.pi/agent/settings.json
pi install ./D:/AI/proj/pi-global-memory --local   # project-scoped: .pi/settings.json (loaded after project trust)
```

Or point pi at it for one run:

```bash
pi --extension ./index.ts
```

Or add it to `~/.pi/agent/settings.json` yourself:

```json
{
  "extensions": ["D:/AI/proj/pi-global-memory"],
  "globalMemory": { "gitAutoCommit": true }
}
```

Pi supplies the host packages this extension imports (`@earendil-works/pi-coding-agent`, `typebox`) - they are declared as `peerDependencies` and must not be bundled; inside pi they are resolved by pi's own module aliases, so no install step is needed to use the package.

Then start pi and run:

```
/memory status
```

The store is created at `~/.pi/agent/global-memory` (or `$PI_CODING_AGENT_DIR/global-memory`), mode `700`, with a `.gitignore` that keeps the store itself untracked.

---

## What the model sees

Two named system-prompt sections, budgeted and diffed separately by pi (so a changing hits section does not resend the catalog):

| Section | Budget (default) | Content |
| --- | --- | --- |
| `global_memory` | 1800 chars | how to use the store + record counts per category + top `maxIndexEntries` (40) catalog lines |
| `global_memory_hits` | 900 chars | up to 3 records that match the prompt you just typed |

If the catalog is truncated, the section says so and tells the model how to get the rest. Records that are `disputed` never enter the prompt unless `includeDisputed: true`.

## Tools (model-facing)

| Tool | Actions | Notes |
| --- | --- | --- |
| `memory_lookup` | `search`, `read`, `catalog`, `categories`, `stats`, `audit` | declared read-only (`readOnlyHint: true`); output capped by `searchMaxChars` / `readMaxChars` |
| `memory_save` | `add`, `update`, `verify`, `retire`, `restore`, `supersede` | refuses when recording is off, and says why plus which switch to flip |

Closed vocabularies are TypeBox literal unions, so pi rejects a hallucinated action before the handler sees it (`npm run check` asserts this).

## Commands (user-facing)

```
/memory status                 posture, paths, counts, which config sources are active
/memory on | off               session toggle for BOTH use and recording
/memory use on|off             read side only (tool + prompt injection)
/memory record on|off          write side only (model saves, auto-capture, command writes)
/memory pause                  recording off for the rest of this session
/memory toggle                 flip the current posture
/memory search <keywords> | catalog [limit] | read <id>... | audit
/memory review | accept [n]    failed calls seen this session, and their proven fixes
/memory verify <id> [note]     you re-tested it: clears a dispute, can raise confidence
/memory retire <id>... | restore <id>... | merge <keep> <drop>...
/memory delete <id>... force   permanent removal (confirmation-gated; git history keeps the copy)
/memory prune                  propose retirement of expired/low-value records
/memory doctor                 structural + privacy scan
/memory config [list|get k|set k v|reset] | export [file] | import <file>
/memory reindex | selftest
```

Long output (catalog, audit, review) is written to a file and the notification shows the path, so it never floods the terminal or the context.

## Toggles

Read and write are switched independently, because "stop spending context on it" and "stop writing new things" are different decisions.

| Scope | How |
| --- | --- |
| This session | `/memory off`, `/memory on`, `/memory use off`, `/memory record off`, `/memory pause` |
| Every session | `/memory config set use false`, `set record false`, `set enabled false` |
| One process | `pi --no-global-memory`, `pi --global-memory-use off`, `pi --global-memory-record off` |
| Environment | `PI_GLOBAL_MEMORY_DISABLE=1`, `PI_GLOBAL_MEMORY_USE=off`, `PI_GLOBAL_MEMORY_RECORD=off` |
| Keyboard | `pi config globalMemory toggleShortcut ctrl+alt+m` (then that key flips use+record) |

Anything injected is reported by the status line (`GM use+record 412`), and refusals name the switch that would allow the action.

---

## Privacy, trust, and session modes

Defaults are deliberately strict: `privacy: "strict"`, `sketchy: "block"`, `redactSecrets: "block"`, `requireEvidence: true`, `minQuality: 3`, `respectSessionPrivacy: true`, `requireProjectTrustForWrites: true`.

- **`--no-session` (in-memory session) is honoured**: recording is suppressed for the whole session because nothing about it is persisted to read back; reads still work. Set `respectSessionPrivacy: false` if you want memory to survive an ephemeral session anyway.
- **Untrusted project → no writes** (reads stay available) while `requireProjectTrustForWrites: true`.
- **Secrets and personal identifiers** are refused (`block`), or masked (`mask`), never stored verbatim.
- **Stored text is defanged** (`<system>`, role-override phrasing, "ignore previous instructions") before it is written, so a record can't become a prompt-injection payload on the way back out.
- **Hedged wording is demoted or refused** - "maybe", "I think", "should probably" is not a fact.

Full model, invariants, and what this does *not* protect against: [SECURITY.md](SECURITY.md).

## Accuracy and self-healing

`selfHeal: "on"` (default) watches the tool results of the current run against the records that were surfaced:

| Live evidence | Verdict written to the store |
| --- | --- |
| a command the record *recommends* fails | record is **disputed**, confidence drops one rung, it stops being injected |
| a command the record *warned against* fails | record **confirmed**; repeated confirmations can raise confidence |
| a command the record *warned against* succeeds | record **disputed** (the warning no longer holds) |
| a command the record recommends succeeds | **confirmed** (`autoVerify: true`) |

Disputes and confirmations are queued during the run and flushed once at `agent_end`, so accuracy maintenance costs one write per run, not one per tool call. `/memory audit` reports disputed, stale, never-verified, hedged, private, low-value, and mutually contradictory records, and `/memory verify|update|retire` clears them. `tentativeTtlDays: 60` expires unverified tentative records automatically.

Details and scoring: [DESIGN.md](DESIGN.md).

---

## On disk

```
~/.pi/agent/global-memory/
  records/<category>/<id>.md      one record per file (the source of truth)
  archive/                        retired/superseded records (reversible)
  pending/signals.jsonl           failed calls observed this session
  index.json, INDEX.md            derived; rewritten on every write - never hand-edit
  config.json                     written by /memory config set
  .gitignore                      store contents stay untracked by default
  .lock                           exclusive lock; parallel writers are safe
```

A real record (`records/docker/gm-docker-layer-cache-ignores-4f70.md`):

```markdown
---
id: gm-docker-layer-cache-ignores-4f70
kind: mistake
category: docker
title: "Docker layer cache ignores edited package.json without --no-cache"
tags: ["docker","build","cache"]
cues: ["old node_modules","layer cache","--no-cache","COPY . ."]
confidence: 2
status: active
scope: global
evidence: ["command|docker build --no-cache -t app:dev ."]
flags: []
contradicts: []
hits: 0
created: 2026-10-21T17:36:18.611Z
updated: 2026-10-21T17:36:18.611Z
verifiedCount: 0
---

## Statement
After changing package.json, run docker build --no-cache (or bust the COPY layer) or the image keeps the old node_modules and the failure looks like a dependency bug.

## Why
Reproduced twice in this repo: an edit to package.json produced an image whose node_modules still matched the previous lockfile.

## How
docker build --no-cache -t app:dev . then docker run --rm app:dev node -p require=dep/package.json.version

## Avoid
Do not reinstall inside the container to fix this; the layer is cached, the host copy is not stale.
```

`cues` are retrieval hooks (exact error text, flags, symbols) - they are the single biggest precision win.

## Configuration

Precedence, highest wins: **environment** → **`globalMemory` in pi's settings.json** → **`<store>/config.json`** → built-in defaults. Unknown or malformed keys are reported (in `/memory status`, never silently applied).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `use` | `true` | read side: tools + prompt injection |
| `record` | `true` | write side: model saves, auto-capture, command writes |
| `dir` | `$PI_CODING_AGENT_DIR/global-memory` | store location |
| `inject` | `catalog+hits` | `off` \| `catalog` \| `catalog+hits` |
| `catalogMaxChars` | `1800` | hard budget for the catalog section |
| `hitsMaxChars` | `900` | hard budget for the hits section |
| `maxIndexEntries` | `40` | catalog lines in context |
| `maxHits` | `3` | records per run in the hits section |
| `searchMaxChars` / `readMaxChars` | `3000` / `4000` | tool output caps |
| `minSearchScore` | `1.2` | below this, "no match" beats a weak suggestion |
| `readOnly` | `false` | hard no-write mode |
| `maxWritesPerSession` | `25` | write quota |
| `maxRecordChars` | `1600` | per-record size cap (conciseness is enforced, not hoped for) |
| `requireEvidence` | `true` | no citation, no record |
| `dedupThreshold` | `0.72` | same-category near-duplicates are refused in favour of `update` |
| `redactSecrets` | `block` | `block` \| `mask` \| `off` |
| `autoCapture` | `fixes` | `off` \| `fixes` \| `all`: turn proven fix→working chains into records automatically |
| `signals` / `maxSignals` | `true` / `300` | failed-call ledger (`pending/signals.jsonl`) |
| `tentativeTtlDays` / `staleDays` | `60` / `120` | automatic expiry of unverified, ageing records |
| `maxActiveRecords` | `400` | soft ceiling; `/memory prune` proposes retirements |
| `confirmDestructive` | `true` | hard delete, prune, bulk retire ask first |
| `statusLine` | `true` | show `GM ...` in the footer |
| `reloadTtlMs` | `30000` | re-read the store after this much staleness |
| `gitAutoCommit` | `false` | local `git add`/`commit` after writes (never networked) |
| `restrictProjectPaths` | `true` | project-scope records must stay inside the cwd |
| `includeTentative` | `true` | tentative records may be surfaced (marked) |
| `privacy` | `strict` | `strict` \| `standard` \| `off` |
| `sketchy` | `block` | unreliable/low-rank content: `block` \| `flag` \| `off` |
| `minQuality` | `3` | reliability score 0-10 required to store |
| `respectSessionPrivacy` | `true` | `--no-session`/in-memory ⇒ no recording |
| `requireProjectTrustForWrites` | `true` | untrusted project ⇒ no writes |
| `toggleShortcut` | `""` | pi keybinding id that flips use+record |
| `selfHeal` | `on` | `on` \| `dispute-only` \| `off` |
| `autoVerify` | `true` | a recommended command that works counts as a confirmation |
| `includeDisputed` | `false` | surface disputed records in the prompt |

Git-friendly store: keep `gitAutoCommit: false` and commit the store yourself from a shell (`cd ~/.pi/agent/global-memory && git init && git add -A`), or set `gitAutoCommit: true` and let the extension make local commits. Sync/push stays a human command - the extension will not do it.

---

## Development

```bash
npm install       # only for development: typebox as a devDependency so tests can run outside pi
npm test          # 85 tests: store, gates, retrieval, prompt budgets, self-heal, capture, config, wiring, offline invariants
npm run check     # loads index.ts through pi's real extension host; asserts registrations + schema validation
npm run verify    # both
```

Inside pi nothing is installed for this package: pi aliases `typebox` and `@earendil-works/pi-coding-agent` for extensions, so `npm install` is only what lets `npm test` and `npm run check` run under plain node.

Design decisions and alternatives considered: [DESIGN.md](DESIGN.md). Implementation notes with evidence from pi's own docs/types: [docs/NOTES.md](docs/NOTES.md).

## Attribution and prior art

- Written for this repository from scratch. **No third-party source code is reused** - no dependencies beyond pi's host-provided peer packages (`@earendil-works/pi-coding-agent`, `typebox`).
- Prior art found during research (via `ketch`), reviewed for ideas and not copied: [`pi-memory-extension`](https://pi.dev/packages/pi-memory-extension) by `appleface2050`, listed on pi.dev. It stores plain notes; this package differs in the budgeted two-section prompt design, evidence-gated records, reliability/privacy gates, and automatic contradiction tracking.
- pi API usage (extension factory, `before_agent_start` sections, tool/command/flag/shortcut registration, settings schema tolerance) follows pi 1.3.0's own documentation and type declarations; citations are in [docs/NOTES.md](docs/NOTES.md).
- Conceptual ancestry worth naming: memory-bank / note-based agent memory as popularised by Cline's memory-bank, and retrieval-over-embeddings argumentation common in RAG writing. No code taken.

## License

MIT - see [LICENSE](LICENSE).
