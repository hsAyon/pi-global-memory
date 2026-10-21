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
- **Only knowledge is recorded.** Records come from the agent citing evidence, or from a mistake it
  actually corrected in front of it. Failures of the agent or its runtime - a rejected tool call, an
  abort, a compaction error, a model-runner fault, a context overflow, a system error - are
  classified as noise, never stored, and counted in `/memory review` so the exclusion is visible.

- **Accuracy first.** A memory that live evidence contradicts gets *disputed* automatically, drops out of prompt injection, and is corrected or retired - a wrong memory is worse than none.
- **Auditable.** Every record is one Markdown file with front-matter metadata: `records/<category>/<id>.md`. `grep`, `git diff`, and other agents can read the store without this extension.

> **Experimental.** This package changes how pi behaves: it inserts sections into your system
> prompt, registers tools the model can call, writes a store outside the repository, and can capture
> learnings automatically at the end of a run. It is verified against one pi release (**1.3.0**) and
> nothing more. Record and container formats are versioned, but they may still change between
> releases without a migration path, so treat the store as disposable: `/memory export` before you
> upgrade, `/memory import` after. Do not put anything in it that you could not afford to lose or
> to have read by whoever can read your home directory. Bug reports welcome; expect rough edges.


Current version `0.3.0`, verified against pi **1.3.0** (`npm run check` loads it through pi's real
extension host). See [CHANGELOG.md](CHANGELOG.md) for what changed.

---

## Install


Three ways, with different answers to "what lands on disk":


```bash
# 1. from npm: pi fetches the published tarball, which is exactly index.ts, lib/,
#    README.md, SECURITY.md, CHANGELOG.md, LICENSE, package.json - no tests, no scripts
pi install npm:pi-global-memory


# 2. from git: pi clones the repository, so the development folders are present on disk,
#    but nothing in the shipped code imports them (pinned by test)
pi install git:github.com/hsAyon/pi-global-memory@v0.2.1


# 3. from a checkout: loaded in place, nothing is copied
pi install /path/to/pi-global-memory
pi install /path/to/pi-global-memory --local   # project-scoped: .pi/settings.json, loaded after project trust
```


For a single run without installing:


```bash
pi -e /path/to/pi-global-memory        # or: pi --extension ./index.ts
```


Or add it to your pi settings yourself:


```json
{
  "extensions": ["/path/to/pi-global-memory"],
  "globalMemory": { "gitAutoCommit": true }
}
```


Pi provides the packages this extension imports (`@earendil-works/pi-coding-agent`, `typebox`) -
they are `peerDependencies`, must not be bundled, and inside pi they resolve through pi's own
module mapping, so using the package needs no install step. `npm install` locally (typebox as a
devDependency) is only needed to run the tests standalone.

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
/memory overview               per-category counts, disputed and never-verified totals
/memory ls [category] [sort=value|updated|created|hits|confidence|age] [retired]
                               one line per record: id, confidence, hits, age, warnings
/memory browse [category]      interactive: pick a record, then verify / retire / restore / delete
/memory search <keywords> | catalog [limit] | read <id>... | audit
/memory verify <id> [note] | retire <id>... | restore <id>... | merge <keep> <drop>...
/memory delete <id>... force   one record, permanently
/memory delete-all             EVERY record: two confirmations + a typed token, always backed up
/memory review | accept [n] | prune | doctor | selftest | reindex
/memory inspect <file> [passphrase=]  what a container holds, is it authenticated - without importing anything
/memory export [file] [all] [category=<slug>] [enc] [note=<text>] [allowprivate]
/memory import <file> [passphrase=<text>]
/memory config list | explain <key> | get <key> | set <key> <value> | where
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

## Viewing, deleting, and moving records


**See the store at a level above the individual record.** `/memory overview` prints one row per
category (live, retired, disputed, never-verified). `/memory ls [category] [sort=…]` prints one
line per record - id, confidence, hits, age in days, and warnings such as `DISPUTED` or
`tentative` - written to a file under the store so a 400-record store never floods the terminal or
the context window. `/memory browse [category]` is the interactive version: category, then record,
then an action (show, verify, retire, restore, delete).


**Deleting is deliberately awkward.** One record: `/memory delete <id> force`, or in `browse` a
confirm dialog *and* typing the record's own id. Everything: `/memory delete-all`, which never runs
in one step -


1. the first call deletes nothing and reports the scope plus a single-use token (expires in 10 minutes),
2. the second call must present that token: `/memory delete-all confirm 3F9A2C`,
3. a container backup of the whole store (including retired records) is written **first**, and the
   message prints the file and the restore command:


```
/memory import <store>/backups/pre-delete-all-2026-10-22T00-00-00-000Z.gmect [passphrase=<text>]
```


`confirmDestructive: false` does **not** bypass this; it is the one floor that setting cannot lower.
Set `PI_GLOBAL_MEMORY_PASSPHRASE` beforehand if you want that backup encrypted.


## Portable copies: the container format


`/memory export` writes a `.gmect` container instead of a raw JSON dump:


```
GMEM1
{"v":1,"kind":"pi-global-memory","exportedAt":"…","recordCount":412,
 "encoding":"deflate-raw","integrity":"sha256","cipher":"aes-256-gcm"|null,
 "kdf":"scrypt"|null,"payloadSha256":"…","note":"…"}
<base64 body, 76-char wrapped>
```


- **Compressed** (deflate) - typically ~10x smaller than the JSON.
- **Integrity-checked** - the payload's SHA-256 is verified on import, so truncation or a hand edit
  is reported rather than half-imported.
- **Optionally encrypted** - `enc` plus a passphrase gives AES-256-GCM with a scrypt-derived key.
  The header is authenticated data, so editing `recordCount` or the timestamp breaks the tag. A
  plain container detects *corruption*; only an encrypted one detects *forgery*. Anything leaving
  the machine should be encrypted.
- **Bounded** - decompression is capped, record counts are capped, unknown versions and ciphers are
  refused. A downloaded file cannot make the extension allocate unboundedly.
- **Gated** - imported records re-pass every write gate (evidence, secrets, privacy, quality), and
  export skips records that look secret or personal unless you pass `allowprivate` deliberately.


Passphrases: `PI_GLOBAL_MEMORY_PASSPHRASE` is read first. Passing `passphrase=…` works but warns,
because command arguments end up in the pi session transcript.

Before importing a file you did not make, look at it: `/memory inspect <file>` prints the record
count, export time, note, and whether it is encrypted and authenticated. It imports nothing, and a
damaged or hostile file is reported rather than half-read.


## Versioning: the extension's, and the records'


**Package versioning.** `lib/version.ts` is the single source for the extension version and for the
two on-disk format versions (`STORE_FORMAT` for records/indexes, `CONTAINER_FORMAT` for exported
files). `index.json` declares the store format; every container stamps its own. `test/version.test.ts`
fails if `package.json`, `CHANGELOG.md`, and `lib/version.ts` disagree, or if a file that runs at
runtime is not published, or if anything development-only is reachable from `index.ts`.


**What installs clean.** `package.json` declares `files`, so an installed package is exactly
`index.ts`, `lib/`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`.
Tests, the load-check script, and the development notes in `docs/` are never part of the install and
are never imported by the extension (pinned by test).


**Versioning your records.** `gitAutoCommit: false` (default) leaves the store untracked - the store
writes its own `.gitignore` that ignores everything. Set it to `true` and the store keeps *its own*
local history, contained by construction:


- every git call names `--git-dir <store>/.git --work-tree <store>` (plus matching `GIT_DIR`/
  `GIT_WORK_TREE` env), so git's upward repository discovery can never reach your project or home
  repository - a store nested inside a real repo is never committed to by it (`test/git.test.ts` proves it);
- `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` point at an empty file inside the store, so your global
  aliases, credential helpers, proxies, and `fsmonitor` are unreachable; hooks are disabled with
  `core.hooksPath`; signing and auto-gc are off;
- offline: `GIT_ALLOW_PROTOCOL=none`, `protocol.ext.allow=never`, credential/ssh helpers fail closed,
  and subcommands go through an allow-list (`rev-parse`, `init`, `add`, `commit`, `status`, `log`,
  `config`, `ls-files`) - `push`/`fetch`/`pull`/`clone` are not reachable and the offline test fails
  the build if they ever appear;
- with versioning on, `records/`, `archive/`, and the indexes are tracked while `out/`, `backups/`,
  `pending/`, `*.gmect`, `.lock`, and the isolation config stay untracked.


Commits are attributed to `pi-global-memory <memory@localhost>` unless you set an identity inside
the store repository. Pushing remains your command, from a shell.

## What gets recorded - and what never is


The store is worth having only if it stays credible. Two rules decide what enters it:


**1. A record is initiated by the agent, with evidence.** The agent writes through `memory_save`,
which refuses a record with no citation (a command, a file, a URL, a session, an artifact) and refuses
hedged wording ("maybe", "I think", "appears to"). The point is facts over guesses: a record should be
something the agent *saw*, not something it inferred.


**2. Auto-capture keeps only proven fixes, from real environment failures.** At the end of a run the
extension looks at what actually happened: a call that failed and a later, different call that
succeeded in the same intent. That pair is written as a `mistake` record at confidence 1, worded as
what was observed rather than a causal story, and told to be re-verified. Unresolved failures become
*signals* in a pending ledger that you decide about (`/memory review`, `/memory accept`) - nothing
unresolved is written silently.


**Never recorded**, at either layer, because these are faults in the agent or its runtime and not
facts about your environment:


| Excluded | Why it would be harmful instead |
| --- | --- |
| tool calls rejected by argument validation, unknown tool names, schema/JSON errors | the command never ran: there is nothing about your machine in the outcome |
| aborted or cancelled calls, `Request was aborted` | the run was stopped, not informed |
| compaction events and errors (`Compaction cancelled`, no-summary notices) | session management internals; a record here would teach future sessions to work around pi |
| context overflow, `prompt is too long`, maximum-context messages | a transient sizing fault |
| rate limits, overloaded, service-unavailable, provider transport trouble | it will be different next time, and the record outlives it |
| model-runner faults, `stop reason`, truncated output, stack traces, `Tool "x" failed` | a bug report for pi or the runner, not knowledge |
| an `edit` whose `oldText` simply did not match | a slip while editing: re-read and retry, that is not a project rule |


The gate on the *write* path is separate from the capture classifier, so an agent cannot save one of
these on purpose either: a draft that pairs an agent-runtime subject (pi, the model, the harness, the
runtime, compaction, a tool call) with a failure predicate is refused, and told to record the durable
rule instead - the flag, path, or setting that actually explains the behaviour. Legitimate knowledge
*about* pi is fine: "pi keeps sessions in memory under `--no-session`, so nothing persists" passes
without difficulty. The fault report does not; the fact it implies does.


`/memory review` ends with what was ignored and how much, so this filtering is never silent:
`ignored as agent or runtime noise (never recorded): model-call x1, runtime x2`.

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
| `searchMaxChars` | `3000` | cap on one `memory_lookup` search result |
| `readMaxChars` | `4000` | cap on one rendered record |
| `minSearchScore` | `1.2` | below this, "no match" beats a weak suggestion |
| `readOnly` | `false` | hard no-write mode |
| `maxWritesPerSession` | `25` | write quota |
| `maxRecordChars` | `1600` | per-record size cap (conciseness is enforced, not hoped for) |
| `requireEvidence` | `true` | no citation, no record |
| `dedupThreshold` | `0.72` | same-category near-duplicates are refused in favour of `update` |
| `redactSecrets` | `block` | `block` \| `mask` \| `off` |
| `autoCapture` | `fixes` | `off` \| `fixes` \| `all`: turn proven fix→working chains into records automatically |
| `signals` / `maxSignals` | `true` / `300` | failed-call ledger (`pending/signals.jsonl`) |
| `tentativeTtlDays` | `60` | days a never-verified tentative record survives before retirement is proposed |
| `staleDays` | `120` | age after which `/memory audit` flags a record as stale (nothing is deleted for being stale) |
| `signals` | `true` | keep the local failed-call ledger used by `/memory review` |
| `maxSignals` | `300` | how many failed-call entries the ledger keeps |
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

## Attribution

Written by an AI coding agent, at the direction of the repo owner, who asked to be
credited accordingly:

- **Author:** pi coding agent using **Qwen 3.8 Flash Next GSQ RCO IQ3_S** on the **Strata** engine.
- **Direction and requirements:** **hsAyon** (repo owner) - the brief (local, offline, git-friendly global memory; private by default; accuracy first), the clarification that "low rank knowledge" means *unreliable* knowledge, and the destructive-action and compressed-export requirements.
- **No third-party code is reused.** Imports are Node built-ins (`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:zlib`, `node:child_process` for local git only) plus pi's host-provided peer packages `@earendil-works/pi-coding-agent` and `typebox`.
- **Prior art, reviewed for ideas and not copied:** [`pi-memory-extension`](https://pi.dev/packages/pi-memory-extension) by `appleface2050` (Markdown notes loaded into context), and pi's own `examples/extensions/claude-rules.ts` (MIT, shipped with pi 1.3.0), which demonstrates the "list files in the prompt, let the agent read them" pattern generalised here with scoring and budgets. Details and pi API citations: [docs/NOTES.md](docs/NOTES.md).

Anything copied or adapted from a third party must be recorded here and in
[docs/NOTES.md](docs/NOTES.md) with URL and license, keeping the upstream
copyright header intact.

## License

MIT - see [LICENSE](LICENSE). Copyright (c) 2026 hsAyon.
