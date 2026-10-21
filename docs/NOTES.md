# NOTES — facts, decisions, sources

Working notes for this extension. Every claim about pi is pinned to a file in the
installed release, so later edits do not have to re-derive it (and so a future
reader can tell a verified fact from a guess).

## Authorship and provenance

- Written by the pi coding agent in-session using **Qwen 3.8 Flash Next GSQ RCO
  IQ3_S** on the **Strata** engine, at the direction of **hsAyon**.
- pi reports the active model id as `Qwen3.8-Flash-Next-IQ3_S-extreme` — that id is
  the owner's local **alias** for one runtime configuration of the same model (see
  `~/.pi/agent/models.json`, provider `local`: `-Q2_0`, `-IQ3_S`,
  `-IQ3_S-extreme`), not part of the model's name. `~/.pi/agent/auth.json` lists the
  `strata` and `llama.cpp` providers. Recorded so the alias is never mistaken for
  the model name.
- No third-party code reused; prior art reviewed, not copied (see README
  Attribution).

## Environment observed while building

| Fact | Evidence |
|---|---|
| pi coding agent version 1.3.0 | `@earendil-works/pi-coding-agent/package.json` (`"version": "1.3.0"`) |
| Local install root | `~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent` |
| Local Node | `node --version` -> `v24.18.0` |
| ketch available locally | `which ketch` -> `/d/ketch/ketch`, `ketch --version` -> `ketch v0.19.0` |
| Built in a git-bash shell on Windows; the code makes no path assumptions for that (see "Packaging and version facts": shipped code is checked for absolute machine paths) |

## pi extension API facts used by this extension

Cited paths are inside the pi package (`node_modules/@earendil-works/pi-coding-agent`).

1. **Extension shape.** Default-exported factory receiving `ExtensionAPI`; jiti
   loads local TypeScript, so no build step.
   Evidence: `docs/extensions.md` ("Create and load an extension").
2. **Mutable prompt sections are the cheap injection path.** `before_agent_start`
   exposes `event.systemPromptOptions` ("mutable prompt sections; later handlers
   observe mutations made by earlier handlers") and a `sections` record.
   Evidence: `dist/core/extensions/types.d.ts:720-742`,
   `dist/core/system-prompt.d.ts:37-50`.
3. **Custom section names must match `/^[a-z][a-z0-9_-]*$/` and may not be
   `preamble`; they are rendered as `<name>content</name>` after the built-in
   sections.** So this extension injects two sections: `global_memory` (catalog,
   stable) and `global_memory_hits` (per-run). Pi diffs sections by name
   (`diffSystemPromptSections`), which is why the two are separate: a changing
   hits section does not resend the stable catalog.
   Evidence: `dist/core/system-prompt.js:7`, `:67-121`, `:76` (declaration).
4. **Returning `systemPrompt` replaces the whole prompt for the run and costs a
   full re-prompt.** Rejected in favour of sections.
   Evidence: `docs/extensions.md` ("A returned `systemPrompt` ... replaces the whole
   prompt for that run"), `dist/core/extensions/types.d.ts:1125-1129`.
5. **Settings may carry unknown keys.** `additionalProperties: true` on the
   settings schema, so a `globalMemory` object is a legal user-facing config
   surface and is returned by `pi.getSettings()`.
   Evidence: `schemas/settings.schema.json:769`; `dist/core/extensions/types.d.ts:1285-1286`.
6. **Agent directory resolution** is `PI_CODING_AGENT_DIR`, else `~/.pi/agent`
   (`CONFIG_DIR_NAME` comes from `package.json` `piConfig.configDir`, default `.pi`).
   `lib/config.ts` reimplements the same rule instead of importing pi, so the
   core stays dependency-free and unit-testable.
   Evidence: `dist/config.js:473,491-496`; `docs/configuration.md` (Agent directory).
7. **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint`) follow MCP semantics, are unverified hints, and a permission
   extension may act on them. This extension sets them truthfully and also blocks
   its own writes with its own policy.
   Evidence: `docs/extensions.md` ("Tool exposure"/annotations block).
8. **`tool_call` handlers can block a call** with `{ block: true, reason }`; a
   handler *failure* blocks the tool as a fail-safe. Used for the write policy
   (read-only mode, quota, project trust).
   Evidence: `dist/core/extensions/types.d.ts:1089-1098`; `docs/extensions.md`
   ("Errors and cleanup").
9. **Transcript tool results carry `isError`, `toolName`, `content`, `timestamp`**
   and `details`, which is what session mining reads.
   Evidence: `@earendil-works/pi-ai/dist/types.d.ts:414-430`.
10. **Session access is read-only from an extension context**: `getCwd()`,
    `getSessionDir()`, `getSessionId()`, `getSessionFile()`, `getBranch()`.
    Evidence: `dist/core/session-manager.d.ts:243-247`.
11. **Data outside one session belongs in external storage**, not session
    entries. This extension therefore owns a directory, and keeps nothing in the
    transcript except injected prompt sections.
    Evidence: `docs/extensions.md` ("State" table).
12. **Do not start watchers/timers in the factory**; long-lived work starts from
    `session_start`. The extension follows this: the factory only loads config and
    registers; the store is read on `session_start`/first use.
    Evidence: `docs/extensions.md` ("Respect the runtime lifecycle").
13. **Distribution as a pi package**: `pi.extensions` manifest in `package.json`,
    `pi-package` keyword for the gallery, host-provided packages belong in
    `peerDependencies` with `"*"`, never in `dependencies`.
    Evidence: `docs/packages.md` ("Create a package", "Declare dependencies").

## TypeScript runtime constraints (why the code looks like this)

- pi loads extensions with jiti; tests run with `node --test`, which type-strips.
  Both resolve **explicit `.ts` specifiers**, so every relative import ends in
  `.ts`. Evidence: jiti loader in `dist/core/extensions/jiti-loader.js`; Node 24
  type stripping (local Node v24.18.0).
- Type stripping erases types only: no `enum`, no `namespace`, no parameter
  properties. `const` arrays + union types are used instead (`lib/types.ts`).
- `typebox` and pi are host-provided. Only `lib/schemas.ts` and `index.ts`
  import them, so the whole core (store/search/sanitize/record/config/capture)
  is dependency-free and testable without installing anything.
  Evidence: `docs/packages.md` (host-supplied packages).

## Design decisions and their reasons

- **Two sections instead of one prompt blob.** Catalog is stable across runs;
  only the hits section churns. Pi sends a section delta, not the whole prompt.
- **Two tools, not one mega-tool and not five.** `memory_lookup` (read-only) and
  `memory_save` (write). Read/write separation lets annotations and the write
  policy be honest, and keeps each description short enough that the model uses
  them correctly.
- **Evidence is mandatory on write** (`requireEvidence`, default true). Directly
  serves "base knowledge on facts rather than guesses": a record without a
  command/file/URL/session citation is rejected with an explanatory error.
- **Generic 40-character secret rule deliberately omitted.** Git object ids are 40
  hex characters and records cite commits; a rule that broad produced false
  redactions. Evidence: `lib/sanitize.ts` rule list.
- **Hit counters are batched** (`MemoryStore.touch` + `flushStats`) so lookups do
  not rewrite files, keeping git history meaningful and write volume low.
- **No embeddings, no network.** Retrieval is an in-memory field-weighted
  inverted index over a store kept small by quotas. A store of a few hundred
  records loads in milliseconds and behaves predictably enough to reason about.
  No dependency, no key, no silent upload.
- **Retirement is soft.** `retire`/`supersede` move files to `archive/`;
  hard delete is command-only and confirmation-gated.

## Git containment: the exact controls (0.2.0)


The extension only uses git to version its own records, and only when `gitAutoCommit` is on. Controls
in `lib/store.ts`, each asserted by `test/offline.test.ts` and `test/git.test.ts`:


| Control | Why |
| --- | --- |
| `--git-dir <store>/.git --work-tree <store>` + `GIT_DIR`/`GIT_WORK_TREE` | defeats git's upward repository discovery; a store inside your project or home repo is never committed to by it |
| `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` -> an empty file in the store | absence would still resolve to the user's global config, so aliases, credential helpers, proxies and `fsmonitor` stay unreachable |
| `core.hooksPath=<store>/.git/hooks-disabled` | hooks are code execution; they must not run |
| `core.fsmonitor=false`, `commit.gpgsign=false`, `gc.auto=0`, `core.pager=cat` | no watcher, no signing prompt, no maintenance, no pager hang |
| `GIT_ALLOW_PROTOCOL=none` + `-c protocol.ext.allow=never` | no remote transport, no external helper |
| `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_SSH_COMMAND` that exits non-zero | credential/ssh attempts fail closed instead of prompting or popping a dialog |
| subcommand allow-list `rev-parse, init, add, commit, status, log, config, ls-files` | checked before spawn; `push`/`fetch`/`pull`/`clone`/`reset`/`clean`/`filter-branch` are unreachable |
| identity via `-c user.name/user.email` in the **pre-subcommand** position | git only accepts `-c` before the subcommand; putting them after `commit` makes the commit fail with no identity (this was a real bug, caught by `test/git.test.ts`) |


Store ignore posture lives in `MemoryStore.ignoreWanted()` (one place). With versioning on, `out/`,
`backups/`, `pending/`, `*.gmect`, `.lock`, `.git-empty-config` stay untracked; with it off the store
ignores everything, so an accidental `git add .` in a parent repo cannot capture knowledge.


## Container format facts (0.2.0)


- `GMEM1` + JSON header + base64 body; body = `GM1` + flags + [salt(16)+iv(12)] + payload|ciphertext + [tag(16)].
- payload = canonical JSON (sorted keys) so identical stores hash identically; digest is SHA-256.
- encryption: scrypt(N=2^14, r=8, p=1, maxmem=64 MiB) -> AES-256-GCM, header bytes as AAD, fresh salt
  and IV per export. Reusing a GCM nonce under one key is a confidentiality failure, so it is tested.
- caps: `maxOutputLength` on inflate, record count caps, container text cap. Import always re-runs the
  write gates; export re-scans and skips secret-shaped or personal records unless `allowprivate`.


## Packaging and version facts (0.2.0)


- `lib/version.ts` is the single source: `EXTENSION_VERSION`, `STORE_FORMAT` (declared in `index.json`),
  `CONTAINER_FORMAT` (stamped in every container), `VERIFIED_PI_VERSION`.
- `package.json` `files` = `index.ts`, `lib/`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`,
  `package.json`. `test/version.test.ts` walks the import graph from `pi.extensions[0]` and fails if a
  runtime file is unpublished, if `test/`, `scripts/`, or `docs/` is reachable, or if version/changelog
  disagree. It also rejects absolute machine paths in shipped code.
- Inside pi, `typebox` and pi itself come from pi's jiti aliases (`dist/core/extensions/loader.js:
  getAliases`), so nothing is bundled; the local `node_modules/typebox` copy exists only for standalone
  `node --test` runs.


## Tooling lesson: never build source text with escapes through a shell heredoc


Twice in this session a generated file ended up with a literal newline where the source needed the
two-character escape (e.g. `].join(` + quote + newline + quote + `)`), because the `backslash-n` was
interpreted on the way in rather than preserved. It parses as a syntax error only when the module is
imported, which is easy to miss. Working rules that hold: build generated strings with
`String.fromCharCode(10)` / `String.fromCharCode(92) + "n"` instead of `
` inside heredocs; run the
import smoke (`test/imports.test.ts`) immediately after generating source; and prefer the `edit` tool
with short exact anchors over whole-file rewrites, because a bad anchor can delete a region — a
`git checkout HEAD -- <file>` recovery was needed once, which is also why work is committed in small
steps.

## Release discipline (agreed with the user, 2026-10-22)


A version bump is its own commit and changes only `package.json`, `lib/version.ts`, and
`CHANGELOG.md`. Feature, fix, and performance work lands in separate commits before it, so a
release commit is the place where the version and the changelog move together and nothing else.
`npm version` is not used because it would bump only `package.json` and leave `lib/version.ts`
behind; `test/version.test.ts` fails if package.json, lib/version.ts, and the CHANGELOG head
disagree, so the three are moved by hand in one commit, then tagged `v<version>` and pushed
with `git push origin main --tags`.


Semver under 0.x: a new user-facing command or documented output is a minor bump (0.2.0 ->
0.3.0); fixes and performance work alone are a patch. On-disk format versions
(`STORE_FORMAT`, `CONTAINER_FORMAT`) are independent of the package version and only move when
the bytes change.

## Recording policy: which failure texts are harness noise (evidence from pi 1.3.0)

The phrases in `lib/capture.ts` are not guesses. Observed in the installed pi 1.3.0 build
(`dist/` bundles under the release directory):

| Text | Where it comes from | Class |
| --- | --- | --- |
| `Tool "<name>" not found` | tool-call validation (`validateToolCall`) | harness |
| `Invalid arguments for tool "<name>": <detail>` | tool-argument validation (`validateToolArguments`) | model-call |
| `Tool "<name>" failed` | pi's tool wrapper when the implementation throws | harness |
| `Request was aborted` | aborted assistant message (cancellation) | aborted |
| `Compaction cancelled`, `Compaction produced no summary; keeping the conversation as it is.` | pi's compaction path | runtime |
| `prompt is too long`, `exceeds the context window`, `maximum context length`, and friends | the context-overflow pattern list pi matches provider errors against | runtime |
| `rate limit reached; retry in Ns`, `overloaded` | provider/transport errors | runtime |

Layering note: context-overflow and rate-limit faults usually arrive as *assistant* error messages,
not tool results, so they rarely reach the ledger anyway. The markers remain as defence for mined
branches (`/memory capture`, `/memory review`) and for harness-wrapped variants.

Also established in that pass: an `edit` whose `oldText` did not match is an agent slip (re-read,
retry), while `ENOENT`/`EACCES`/`EPERM` are real environment facts and stay recordable. Whole-word
subject matching in `assessRuntimeNoise` is what keeps "the ssh session times out" and "the systemd
service fails to start" writable - `session`, `system`, and `provider` are deliberately **not**
subjects, because they describe the user's infrastructure as often as they describe the runtime.
Tests: `test/recording-policy.test.ts` (capture layer and write gate, plus the discrimination list).

## Prior art found while researching (for attribution)

Searched with ketch on 2026-10-21 (ketch v0.19.0), query
`pi coding agent earendil-works extension global memory package`, 6 results.
Correct invocation form is `ketch search "<query>" [flags]` — `ketch search --query`
fails with `unknown flag: --query`.

- `pi-memory-extension` v3.1.2 (appleface2050), listed at
  <https://pi.dev/packages/pi-memory-extension> — Markdown-based,
  human-curated, global + workspace dual-layer memory; loads whole Markdown
  files into context. **No code reused.** Read only to confirm the design space
  and to differentiate: this extension keeps per-record structured files with a
  generated index, budgets the injected text, retrieves on demand instead of
  loading whole files, and adds redaction/containment/quotas.
- pi's own `examples/extensions/claude-rules.ts` (shipped with pi 1.3.0, MIT)
  demonstrates the "list files in the system prompt, let the agent read them"
  pattern that this extension generalises with scoring and budgets. **No code
  reused**; the mechanism (appending to the system prompt) is documented pi API
  use.

If code is ever copied or adapted from a third party, add it here and to the
README Attribution section with the URL and license, and keep the upstream
copyright header intact.

## Host package resolution inside pi (verified, 2026-10-21)

| Fact | Evidence |
|---|---|
| pi resolves host packages for extensions by **jiti alias**, not by the extension's own `node_modules`: `typebox`, `typebox/compile`, `typebox/value`, `@sinclair/typebox*`, `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-tui`, `pi-ai` (+ legacy `@mariozechner/*`) are all aliased to entries inside the pi install. | `dist/core/extensions/loader.js:33-84` (`getAliases`), used at `:471-481` (`createJiti(import.meta.url, { alias: getAliases() })`) |
| `typebox` in this checkout is 1.3.27 and lives at `~/.pi/agent/install/releases/1.3.0/node_modules/typebox`; `typebox/compile` exports `Compile(schema) -> { Check(value) }` (not `Compile.Compile`). | `node -p require(...).version`, probe against `lib/schemas.ts` |
| Local packages (`pi install ./dir`) are **not** npm-installed or modified: "their dependency tree remains the package author's responsibility". Peer deps must be `"*"` and must not be bundled. | `docs/packages.md` ("Declare dependencies") |
| Consequence: `node_modules/typebox` copied into this repo exists **only** so `npm test` / `scripts/load-check.mjs` run under plain node outside pi. It is gitignored, unused inside pi, and must never become a real dependency. | this repo `.gitignore` |
| pi requires Node >= 22.19.0; `engines` in package.json mirrors that. | pi `package.json` (`"engines": { "node": ">=22.19.0" }`) |
| Loader entry point for a harness: `discoverAndLoadExtensions(configuredPaths, cwd, agentDir?, eventBus?)` returns `{ extensions, errors, warnings, runtime }`; a loaded `Extension` exposes `handlers: Map<string, HandlerFn[]>`, `tools: Map<string, RegisteredTool>`, `commands`, `flags`, `shortcuts`. | `dist/core/extensions/loader.d.ts:22`, `dist/core/extensions/types.d.ts:1720-1749` |
| Driving the *runner* instead is heavy: `new ExtensionRunner(extensions, runtime, cwd, sessionManager, modelRegistry)` plus `bindCore/bindCommandContext/setUIContext`. Not worth it for a load check, so `scripts/load-check.mjs` inspects the loaded extension and compiles the schemas instead. | `dist/core/extensions/runner.d.ts:81-140` |

## Accuracy policy: what "low rank" means here (user clarification, 2026-10-21)

"Low rank knowledge" = **unreliable** knowledge (hedged, unsourced, stale, or
contradicted), not social ranking. The binding requirement:
**always prioritise accuracy, and self-heal or update records that live evidence
contradicts.** Implemented as:

- refusal paths for hedged wording (`detectHedges`), missing evidence
  (`requireEvidence`), and sub-`minQuality` drafts (`qualityScore`);
- `selfHeal` classification of live tool results against surfaced records
  (`lib/heal.ts:classifyCall`: recommended-fails → dispute, warned-against-fails →
  confirm, warned-against-succeeds → dispute, recommended-succeeds → confirm);
- disputed records lose a confidence rung, are marked `DISPUTED`, and leave the
  prompt (`includeDisputed: false`), while staying findable by explicit search so
  they can be corrected;
- `valueScore` penalises `disputed` by -4 and rewards `verifiedCount`, so pruning
  removes untrustworthy records first;
- `auditStore` surfaces the states a single run cannot see (never verified,
  expired tentative, hedged, private, contradictory).

## Implementation lessons recorded the hard way

- **Truncation must keep the pointer.** `slice(0, budget)` cut off the
  "how to get the rest" line. `buildCatalogSection` now reserves header + counts +
  tail first, then fills entries, then recomputes the omission count.
  Pinned by `test/retrieval.test.ts` (48 records under a 900-char budget).
- **Cross-category duplicate blocking mis-fires.** Formulaic phrasing pushed
  unrelated records over the similarity bar, so the model retried with `force` and
  burned the exact turn the store exists to save. Same-category near-duplicates
  refuse; cross-category similarity is advisory only
  (`MemoryService.findTwin`, `blocking` flag).
- **`node --test test/` does not work** (node resolves `test` as a module path and
  fails with `Cannot find module ...\test`). Use `node --test` (auto-discovery) or
  an explicit file list.
- **Node's type stripping reports one opaque error for a brace slip**
  (`ERR_INVALID_TYPESCRIPT_SYNTAX` pointing at the next `case`). `test/imports.test.ts`
  imports every module once so that class of bug fails a test, not a pi session.
- **Regex-based offline auditing must not flag ordinary code**: `.exec(...)` calls
  looked like shell execution. The rule is
  `/\bexecSync\b|\bspawnSync\b|\bchild_process\b|(?<![.\w$])exec\s*\(/` and the two
  files allowed to spawn (`lib/util.ts`, `lib/store.ts`) are checked structurally
  instead (argv arrays, no `shell: true`, git hardening strings present, no
  networked git subcommands).
