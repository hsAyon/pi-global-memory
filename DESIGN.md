# Design

Goals, decisions, and the alternatives that were rejected - so a future reader can tell which properties are load-bearing and which were a judgement call.

## Design goals (in priority order)

1. **Never research something twice** - the store must be discoverable *before* the agent starts working, cheaply.
2. **Cost a known, small slice of context** - the store's value must not be paid for in tokens every turn.
3. **Accuracy over coverage** - a wrong record causes confident errors; an absent record only causes re-derivation. So unreliable content is refused, and contradicted content self-demotes.
4. **Private by default, configurable explicitly** - the user opts out of safety, never into it by accident.
5. **Offline and auditable** - plaintext files, no network, no hidden state, no model calls.

## Non-goals

Personal assistant features, conversation transcription, embeddings/vector search, cross-machine sync (git does that, outside the extension), multi-user sharing, "memory that the agent silently rewrites about itself".

## Decision 1 - two prompt sections, not one blob and not the whole prompt

pi assembles the system prompt from named sections and diffs them by name, so a section whose text changed is the only one resent. That makes a split free:

- `global_memory` - stable: how to use the store, per-category counts, and the top `maxIndexEntries` catalog lines. Changes only when the store changes.
- `global_memory_hits` - per-run: up to `maxHits` records matching the user's latest prompt. Changes every run.

Merging them into one section would resend the whole catalog on every run; replacing the whole system prompt would break pi's own diffing and every other extension's sections.

The catalog *is* injected on purpose: the agent has to know what exists to decide to look it up. That is the whole mechanism - a pointer costs ~1.8 KB, a re-research loop costs tens of thousands of tokens.

Budgets are enforced structurally (`buildCatalogSection` in `lib/prompt.ts`): reserve the header, counts, and the "how to get the rest" pointer first, then fill with entries, then recompute what was omitted. A naive `slice(0, budget)` truncation was the first attempt and it cut off the pointer - the failure mode this ordering exists to prevent, pinned by a test that seeds 48 records under a 900-char budget.

## Decision 2 - two tools, not one mega-tool

`memory_lookup` (declared `readOnlyHint: true`) and `memory_save` (writes). Separate tools let the user's tool policy, pi's read-only modes, and the model's own planning distinguish reading from writing, and keep each description short enough to be followed. Actions are closed TypeBox literal unions so an invented action is rejected by pi's validator instead of reaching a handler: `memory_lookup` = search/read/catalog/categories/stats/audit; `memory_save` = add/update/verify/retire/restore/supersede.

Output is capped (`searchMaxChars`, `readMaxChars`) and the read path tells the model what was omitted, so retrieval cannot smuggle a large payload into context.

## Decision 3 - Markdown files as the source of truth

`records/<category>/<id>.md` with YAML-ish front-matter, plus derived `index.json` and `INDEX.md`.

| Alternative | Why rejected |
| --- | --- |
| SQLite + FTS5 | Needs a native or WASM dependency, opaque to `git diff` and to `grep`, and unusable by other agents without the extension. The store is small by policy (`maxActiveRecords: 400`), so a plain inverted index built in memory is microseconds. |
| One JSONL file | Machine-friendly, human-hostile: merge conflicts on every write, no per-record `git blame`. |
| Embeddings / vector store | Needs a model, a cache, and a network or a local embedding runtime; unverifiable similarity; and the failure mode is "confidently retrieved the wrong thing" - directly against goal 3. Retrieval here is exact-token weighted field matching plus cues, which a human can reason about: if a record is not found, the cues are wrong, and `/memory audit` shows that. |
| Let pi's own session/context do it | Sessions are per-conversation and huge; the point is durable, curated, cross-session knowledge at a fraction of the cost. |

Derived files are rewritten wholesale on every write and marked "do not hand-edit", so there is exactly one source of truth to reason about.

## Decision 4 - retrieval is field-weighted token search, tuned for cues

`buildSearchIndex` (`lib/search.ts`) indexes fields with different weights:

```
title 4 · cues 3 · id 2.5 · tags 2.2 · category 1.5 · statement 1.2 · how 1 · avoid 1 · why 0.8 · notes 0.6
```

plus inverse-document-frequency, a phrase bonus (`+2` when a ≥4-token phrase appears verbatim), a multi-term bonus (`+0.5` per extra matched term, capped at 3), and priors:

```
+ (confidence - 1) * 0.3            # trust better-ranked records first
+ log1p(hits) * 0.15                # a record that gets used is worth surfacing
+ min(1, verifiedCount * 0.3)       # re-tested records rank higher
+ 0.4 when scope.kind === "project" # project truth beats general truth in this repo
```

Below `minSearchScore` (1.2) the answer is "no match", not a weak guess - a bad suggestion invites the agent to act on it. Disputed records are excluded from prompt hits by default but still appear in explicit `search`, marked `DISPUTED`: you should be able to find a wrong record in order to fix it.

`cues` (exact error text, flags, symbols) are worth more than prose: they are the difference between "found the docker record" and "found nothing, so re-researched it".

## Decision 5 - reliability is scored, not asserted

`qualityScore` (0-10, in `lib/trust.ts`) is a rubric applied at write time: findable title (≥12 chars), title names something concrete, title states a rule/action, statement developed (≥40 chars), concise (≤320), condition-specific, evidence present, evidence cross-checked, cues present. Writes below `minQuality` (3) are refused with the rubric printed, so the model can fix the draft rather than retry blindly.

`valueScore` (in `lib/record.ts`) ranks for maintenance/pruning and includes the accuracy terms: `-4` for `disputed`, `+0.5` per verification (capped), `-1.2` for tentative, age decay up to `-2`, `-0.4` for auto-captured-but-unreviewed.

Duplicate handling (`MemoryService.findTwin`): same category and similarity ≥ `dedupThreshold` (0.72) → refuse and point at `update`; different category but similarity ≥ threshold+0.12 → accept with an advisory note. A hard cross-category block was the first attempt and it mis-fired on formulaic phrasing, which made the model retry with `force` - burning exactly the turn the store exists to save.

## Decision 6 - self-healing is bounded, queued, and legible

"Low rank knowledge" here means *unreliable*: hedged, unsourced, stale, or contradicted. The rule the design enforces is that live evidence always outranks memory.

`classifyCall` (`lib/heal.ts`) compares each live tool call against the records surfaced in that run, using commands extracted from `how`/`avoid` (`citedCommands`, matched exactly or contained):

| Live outcome | Record said | Verdict |
| --- | --- | --- |
| error | "do/run X" (recommended) | **dispute** - the advice did not work |
| error | "avoid X" | **confirm** - the warning held |
| success | "avoid X" | **dispute** - the warning no longer holds |
| success | "run X" | **confirm** (`autoVerify`) |

`applyDispute` sets `flags: ["disputed"]`, `disputedAt`, drops confidence one rung, and adds the contradicting id to `contradicts`. `applyVerify` clears the dispute, bumps `verifiedCount`/`lastVerified`, and can raise confidence after repeats. Changes are queued during the run and flushed once at `agent_end` under the store lock (`flushQueued`), so accuracy maintenance costs one write per run instead of one per tool call, and a mid-run crash loses only the queue.

`selfHeal` levels: `on` (dispute and confirm), `dispute-only` (never raise confidence automatically), `off`.

`auditStore` reports the states that cannot be detected from a single call: disputed, expired-tentative, never-verified, hedged wording, private content, low-value, and records that contradict each other. That is the loop a human uses to keep a long-lived store honest; `/memory prune` and `tentativeTtlDays`/`staleDays` retire what nothing exercises.

## Decision 7 - consent gates before capability gates

Order in `posture()` (`lib/service.ts`): `enabled` → `use`/`record` → `readOnly` → ephemeral session (`--no-session`) → project trust → quota. Reads and writes are separate switches because "stop spending context" and "stop writing" are different decisions; `/memory use off` keeps the store on disk and out of the prompt, and withdraws the tools from pi's active tool list so the model is not tempted.

Refusals are errors, never silent no-ops, and always name the switch: a silent drop would teach the model that memory is unreliable.

## Decision 8 - writes are boring and safe

`MemoryStore` (one place that touches the file system): exclusive `O_EXCL` lock with stale-lock recovery, temp-file-then-`rename` atomic writes, `safeJoin`/`inside` confinement for every path, caps on file counts and read sizes (`readTextLimited`, `listFiles` cap) so a hostile or corrupt store cannot make the extension allocate unboundedly, and batched usage counters (`touch` → `flushStats`) so a lookup does not rewrite every record it touched.

Optional git auto-commit is local-only by construction: `GIT_ALLOW_PROTOCOL=none`, `-c protocol.ext.allow=never`, `core.hooksPath=.git/hooks-disabled`, `GIT_TERMINAL_PROMPT=0`, and no networked subcommand exists in the source. `test/offline.test.ts` asserts the hardening strings are present and fails if `push`/`fetch`/`pull`/`clone`/`ls-remote`/`submodule` ever appear.

## Module map

```
index.ts        pi wiring: config, tools, commands, flags, sections, lifecycle, self-heal queue, capture
lib/types.ts    types + CONFIG_DEFAULTS (the single source for every default)
lib/config.ts   precedence and validation (env > settings.json > store config.json > defaults)
lib/store.ts    the only file-system and git layer (locks, atomic writes, confinement, indexes)
lib/record.ts   serialize/parse, normalizeDraft (all record-level gates), similarity, valueScore
lib/trust.ts    privacy scan, hedge detection, secret redaction policy, qualityScore rubric
lib/sanitize.ts secret patterns, defang, harden/hardenForInjection
lib/search.ts   inverted index, scoring, hit rendering, catalog lines
lib/prompt.ts   the two budgeted prompt sections (the only store→context path)
lib/heal.ts     cited-command extraction, call classification, dispute/verify, audit findings
lib/capture.ts  session mining: failed call → proven fix chains
lib/service.ts  the policy layer: posture, add/update/verify/retire/restore/supersede, dedup, audit, batching
lib/schemas.ts  TypeBox tool parameters (host package; closed vocabularies)
lib/tools.ts    memory_lookup / memory_save handlers
lib/commands.ts /memory subcommands
```

Nothing under `lib/` imports pi except `lib/schemas.ts` (typebox) and the type-only import in `lib/tools.ts`/`lib/commands.ts`, so the whole core runs under plain `node --test`.

## Testing strategy

| Layer | File | What it protects |
| --- | --- | --- |
| Store | `test/store.test.ts` | confinement, atomicity, parallel writers, retire/restore, hard delete, corrupt-record isolation, batched counters, private dir + untracked default |
| Gates | `test/gates.test.ts` | secrets refused, privacy posture, hedge demotion, evidence requirement, quality floor, dedup refusal |
| Retrieval | `test/retrieval.test.ts` | cue-driven ranking, `minSearchScore` "no match", disputed exclusion, budgets under a 48-record store |
| Prompt | same file | two sections, hard caps, truncation keeps the pointer, other pi sections untouched |
| Self-heal | `test/heal.test.ts` | the four-way classification table, dispute/verify state, audit findings |
| Capture | `test/capture.test.ts` | failed→fixed chains mined from a branch, no secrets captured |
| Config | `test/config.test.ts` | precedence, strict validation, private-by-default, budgets small enough to be worth it |
| Wiring | `test/extension.test.ts` | index.ts against a mock `ExtensionAPI`: registrations, toggles, ephemeral session, untrusted project, self-heal flush, auto-capture, `--no-global-memory` |
| Invariants | `test/offline.test.ts` | no network APIs anywhere; only the allow-listed spawn helper; git hardening strings present; no networked git subcommands |
| Real host | `scripts/load-check.mjs` | pi's own jiti loader + registration bookkeeping accept the extension; schemas compile and reject invented actions |

`npm run verify` runs the suite and the load check. The load check exists because a mock API can drift from pi's; it uses `discoverAndLoadExtensions` from the installed pi package, starts no agent loop, and performs no network I/O.

## Known trade-offs

- The catalog is a ranked *sample*, not the whole store: past `maxIndexEntries` the agent must search. Making the sample bigger costs context on every turn for every user; the pointer line keeps the cost of being wrong at one extra tool call.
- Token search has no synonym recall ("cache invalidation" will not find a record titled "bust the layer cache") - cues are the designed answer, and it is a deliberate swap of recall for auditability.
- Usage counters are approximate (batched, best-effort under contention); they drive ranking and pruning, never correctness.
- Auto-capture is conservative by default (`autoCapture: "fixes"`) and its records carry an `auto` flag and lower value until reviewed (`/memory review`, `/memory accept`).
- One store per agent directory: there is no per-project store isolation, only project-*scoped* records inside the shared store.
