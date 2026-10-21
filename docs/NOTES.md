# NOTES — facts, decisions, sources

Working notes for this extension. Every claim about pi is pinned to a file in the
installed release, so later edits do not have to re-derive it (and so a future
reader can tell a verified fact from a guess).

## Environment observed while building

| Fact | Evidence |
|---|---|
| pi coding agent version 1.3.0 | `@earendil-works/pi-coding-agent/package.json` (`"version": "1.3.0"`) |
| Local install root | `~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent` |
| Local Node | `node --version` -> `v24.18.0` |
| ketch available locally | `which ketch` -> `/d/ketch/ketch`, `ketch --version` -> `ketch v0.19.0` |
| OS shell is git-bash on Windows; cwd uses `D:/...` | observed in this repo |

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
