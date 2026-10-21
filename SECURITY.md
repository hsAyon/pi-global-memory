# Security and privacy model

This document states what `pi-global-memory` guarantees, what it does not, and which test pins each guarantee. Everything below describes the code in this repository as of `0.1.0`.

## Threat model

| Threat | Position |
| --- | --- |
| Memory contents steered through a fetched web page, log file, or issue text (indirect prompt injection) | Stored text is **defanged** before it is written, and defanged again on the way into the prompt (`hardenForInjection` in `lib/sanitize.ts`). Records are labelled as past evidence, not instructions; the prompt tells the model a record is evidence, and live evidence outranks it. |
| A secret, token, or personal identifier being persisted | `redactSecrets: "block"` refuses the write rather than storing a masked copy; `mask` redacts in place. Patterns cover common key/token shapes, PEM blocks, JWTs, cloud access keys, basic-auth URLs, plus phone/ID/card shapes (`scanPrivacy` in `lib/trust.ts`). |
| Confidential or private content leaking into a git-synced store | `privacy: "strict"` refuses text that reads like confidentiality ("confidential", "private", "internal only", NDA, credentials in prose). Reads are unaffected; only writes are refused, and the refusal names the switch. |
| Unreliable knowledge ("low rank" = not trustworthy) polluting decisions | Evidence is required (`requireEvidence`), hedged wording is demoted or refused (`detectHedges`), a 0-10 reliability score must clear `minQuality`, and contradictions found in the live run **dispute** the record (`selfHeal`). |
| The extension reaching the network | No network API is referenced in any shipped module; `test/offline.test.ts` fails the build on `http`/`https`/`fetch`/`net`/`dgram`/`tls`/`WebSocket`/`XMLHttpRequest`/`dns`. Git bookkeeping runs with `GIT_ALLOW_PROTOCOL=none`, `protocol.ext.allow=never`, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_OPTIONAL_LOCKS=0`, `core.hooksPath` pointed at `.git/hooks-disabled`, and no `push`/`fetch`/`pull`/`clone` subcommand exists in the code. |
| Store corruption from concurrent pi sessions | An exclusive `O_EXCL` lock (`.lock`, with stale-lock recovery) plus temp-file-then-`rename` atomic writes. `test/store.test.ts` exercises parallel writers. |
| Versioning of records leaking into somebody else's repository, or being influenced by global git config | The extension's git use is contained to the store: `--git-dir <store>/.git --work-tree <store>` plus `GIT_DIR`/`GIT_WORK_TREE`, so upward repository discovery is never in play; `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` point at an empty file inside the store; hooks are disabled via `core.hooksPath`; `fsmonitor`, signing, and auto-gc are off; subcommands run through an allow-list. `test/git.test.ts` proves a parent repository gains no commits. |
| A container file being tampered with, truncated, or weaponised as a decompression bomb | Payload SHA-256 verified on import; encrypted containers additionally authenticated (AES-256-GCM with the header as additional authenticated data, so header edits fail the tag). Inflate is capped (`maxOutputLength`), record counts and text size are capped, unknown versions/ciphers are refused. `test/container.test.ts` covers each path. |
| An exported copy quietly containing a secret or personal identifier | The export path re-scans each record: secret-shaped or personal/confidential text is skipped and reported unless `allowprivate` is passed deliberately. |
| A bulk delete happening by accident, or without a way back | `/memory delete-all` stages a single-use token that must be typed in a second call, expires in 10 minutes, and writes a container backup before deleting anything. `confirmDestructive: false` cannot lower this floor. |
| Path traversal out of the store (including through `category`, `id`, `scope.path`) | Every path is produced by `MemoryStore.safeJoin` and verified with `inside()`; `..`, absolute paths, and separators in ids/categories are rejected. `restrictProjectPaths` keeps project-scoped records inside the cwd. |
| A hostile or careless project steering what gets remembered | While `requireProjectTrustForWrites: true` (default), an untrusted project cannot write at all: `ctx.isProjectTrusted()` is checked on every write path, tool and command alike. |
| Context-window exhaustion | Two named prompt sections with hard character budgets enforced by construction (reserve the header/counts/pointer, then fill): `catalogMaxChars` 1800, `hitsMaxChars` 900. Tool output is capped by `searchMaxChars`/`readMaxChars`; long `/memory` output goes to a file, not the terminal. `test/retrieval.test.ts` seeds a 48-record store and asserts the section never exceeds a 900-char budget and still says how to get the rest. |
| Writing when the user asked not to | Recording is refused - not silently dropped - whenever `enabled: false`, `record: false`, `readOnly: true`, the session is ephemeral (`--no-session`) with `respectSessionPrivacy: true`, project trust is denied, or the session write quota (`maxWritesPerSession: 25`) is spent. Each refusal names the reason and the switch. |

## Session privacy modes

pi's `--no-session` produces an in-memory session that is never persisted. The extension detects that state (no session file for the active session) and, with `respectSessionPrivacy: true`, suppresses **all** recording for the session - model saves, auto-capture, and `/memory` writes - while leaving reads available, because reading a record does not persist anything about the private session. `PI_OFFLINE=1` / `--offline` do not change this posture: the extension never used the network to begin with.

Set `respectSessionPrivacy: false` only if you want an ephemeral session to be able to write durable memory.

## Write pipeline (order matters)

```
memory_save / /memory save
  → posture(): enabled, use/record, readOnly, ephemeral session, project trust, quota
  → normalizeDraft(): size caps, kind/category/scope validation, evidence requirement
  → harden(): secret block/mask, privacy scan, instruction defang
  → qualityScore() ≥ minQuality, sketchy policy, hedge detection
  → dedup guard (same category ≥ dedupThreshold refuses in favour of update)
  → store.put() under lock, atomic, index rebuild, optional local git commit
```

Any stage can refuse. Refusals return the reason list to the model verbatim, so it can fix the draft instead of guessing.

## Prompt-injection stance

The store is data, not authority. Two rules do most of the work:

1. text entering the store has instruction-shaped patterns rewritten to be inert (e.g. `<system>` tags, role-override phrasing) - without that defang being counted as a "secret hit";
2. text leaving the store is defanged again and presented as evidence with a source id, and the prompt states that live evidence outranks a record.

This reduces the blast radius of a poisoned record; it does not make records trustworthy. Disputed records leave the prompt, and `/memory audit` flags records whose content looks instructional or private.

## File-system posture

- Store root and subdirectories are created mode `0700`; record/index files are written `0600` where the platform supports it. `tightenMode` is a no-op on Windows, where the parent directory's inherited ACL applies - put the store on a private volume if that matters.
- The store ships a `.gitignore` that keeps memory contents untracked. Opting a store into git (your own `git init`, or `gitAutoCommit: true`) is an explicit act; `gitAutoCommit` runs **local** `add`/`commit` only.
- `import` re-runs the full write pipeline (secrets, privacy, quality, evidence), so a hand-made or downloaded store file cannot bypass the gates.
- `export`/`read` never follow links outside the root, and `/memory read` output is capped per record.

## What this does **not** protect against

- A hostile process that can already read your home directory: the store is plaintext Markdown, intended to be readable by you and your other agents. Encryption at rest is not implemented.
- A remote git repository you push the store to: once you push, publication is your decision and your remote's policy.
- pi itself, other extensions, or the model provider: memory that is retrieved becomes part of the model context like any other prompt text. Turning `use: false` keeps it out.
- Semantic leakage: two records can imply a secret between them even if neither matched a redactor. If a store has gone wrong, `/memory delete <id> force` plus a git history rewrite is the fix; `/memory doctor` reports candidates.
- A record that is *correct but no longer true*. Nothing self-heals a record that is never exercised; that is what `tentativeTtlDays`, `staleDays`, `/memory audit`, and `/memory prune` are for.

## Git inside the extension

Git is used for exactly one thing: internal versioning of the record files, when you opt in with
`gitAutoCommit: true`. It is contained rather than convenient:

- **Its own repository.** `--git-dir`/`--work-tree` and `GIT_DIR`/`GIT_WORK_TREE` always name the
  store. A store placed inside your project, or inside a home-directory repository, cannot be
  committed to by that repository - verified behaviourally in `test/git.test.ts`.
- **Configuration-isolated.** `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point at a deliberately
  empty file inside the store, so your aliases, credential helpers, proxies, `fsmonitor` watchers and
  other global settings are not read. Absence would still resolve to your files, hence the empty file.
- **No code execution through git.** `core.hooksPath` points at an empty `hooks-disabled` directory,
  so neither repository-local nor global hooks run; `core.fsmonitor=false` likewise.
- **Fail closed on anything remote.** `GIT_ALLOW_PROTOCOL=none`, `protocol.ext.allow=never`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_SSH_COMMAND` that exits non-zero. A remote
  attempt dies instead of prompting or popping a credential dialog.
- **Subcommand allow-list, enforced before spawn** (`rev-parse`, `init`, `add`, `commit`, `status`,
  `log`, `config`, `ls-files`). Anything else throws, and the offline test fails the build if a
  networked or history-rewriting subcommand appears in the source.
- **Bounded.** Timeouts and output caps on every call; commits are attributed to
  `pi-global-memory <memory@localhost>` unless you set an identity inside the store repository.

If you would rather the extension never spawn a process at all, leave `gitAutoCommit: false` (the
default) - then there is no git code path taken, and the store writes a `.gitignore` that keeps
itself untracked.

## Destructive actions

| Action | What it costs |
| --- | --- |
| `retire` / `restore` | nothing destructive: files move between `records/` and `archive/` |
| `delete <id>` | `confirmDestructive` confirm in the UI; in `browse`, a confirm *and* typing the record id |
| `delete-all` | two calls plus a typed single-use token; a container backup is written before deleting, whatever the settings say |

The asymmetry is deliberate: a bulk delete is the one operation the extension cannot undo from its
own UI, so it gets a floor that configuration cannot lower.

## Passphrases

`PI_GLOBAL_MEMORY_PASSPHRASE` is read first, because the environment is not copied into the session
transcript. Passing `passphrase=…` on the `/memory` command line still works and warns, since
command arguments are recorded in the transcript. Interactive prompting is not used for the same
reason: pi's input dialog is not masked. Passphrases are never stored in the container - only the
scrypt salt is.

## Reporting

This is a personal-use package with no security process. Report issues in the repository; do not file a public issue for anything that could leak a store location.
