/**
 * The user-facing description of every configuration key.
 *
 * This is the single source of truth for: validation ranges and enum members
 * (lib/config.ts reads it), `/memory config list`, `/memory config explain`,
 * error messages, and the README table (pinned by test/config.test.ts, so the
 * docs cannot drift away from the code).
 *
 * Wording rule for this file: describe what a value *does to the user's data*,
 * not what the implementation calls it.
 */

import type { GmConfig } from "./types.ts";
import { AUTOCAPTURE_MODES, CONFIG_DEFAULTS, INJECT_MODES, PRIVACY_MODES, REDACT_MODES, SELFHEAL_MODES, SKETCHY_MODES } from "./types.ts";

export type ConfigGroup = "switches" | "context-budget" | "accuracy" | "privacy" | "auto-capture" | "storage";

export interface ConfigSpec {
	key: keyof GmConfig;
	group: ConfigGroup;
	type: "bool" | "enum" | "int" | "float" | "path" | "string";
	/** Human one-liner. Shown by /memory config list and in README. */
	description: string;
	/** What changes when you set it, including the cost of the unsafe value. */
	effect: string;
	values?: readonly string[];
	range?: [number, number];
	/** true = relaxing it weakens privacy/safety, so say so loudly. */
	sensitive?: boolean;
	/** Set when the key only matters to someone maintaining the store. */
	advanced?: boolean;
}

export const GROUP_ORDER: ConfigGroup[] = ["switches", "context-budget", "accuracy", "privacy", "auto-capture", "storage"];

export const GROUP_LABELS: Record<ConfigGroup, string> = {
	switches: "On/off switches (the ones you will actually use)",
	"context-budget": "How much context window memory is allowed to cost",
	accuracy: "How much the store insists on being right",
	privacy: "What may be written at all",
	"auto-capture": "What the extension remembers without being asked",
	storage: "Where records live and how they are kept",
};

export const CONFIG_SPEC: ConfigSpec[] = [
	// ---- switches ----
	{
		key: "enabled",
		group: "switches",
		type: "bool",
		description: "Master switch: memory reading, recording, and prompt injection.",
		effect: "false = the extension does nothing at all: no prompt sections, no tools, no writes. Cheapest way to opt out completely.",
		sensitive: true,
	},
	{
		key: "use",
		group: "switches",
		type: "bool",
		description: "Let memory be READ: the two prompt sections plus memory_lookup/memory_save as tools.",
		effect: "false = nothing from the store enters the model context and the tools are withdrawn; the store itself is untouched on disk. Faster and cheaper, but the agent will re-derive things you already knew.",
	},
	{
		key: "record",
		group: "switches",
		type: "bool",
		description: "Let memory be WRITTEN: model saves, auto-capture, and /memory writes.",
		effect: "false = every write path refuses with an explanation; reads keep working. Use this in a repo whose knowledge you do not want persisted.",
		sensitive: true,
	},
	{
		key: "readOnly",
		group: "switches",
		type: "bool",
		description: "Hard read-only mode for the whole store, overriding everything else.",
		effect: "true = no write path can succeed, even memory_save with force. Useful while reviewing a store you do not want changed.",
	},
	{
		key: "respectSessionPrivacy",
		group: "switches",
		type: "bool",
		description: "Honour pi's ephemeral sessions (pi --no-session): record nothing about them.",
		effect: "false = an in-memory session may still write durable memory. Keep true unless you deliberately want ephemeral sessions to leave traces.",
		sensitive: true,
	},
	{
		key: "requireProjectTrustForWrites",
		group: "switches",
		type: "bool",
		description: "Require pi's project trust before writing memory while inside that project.",
		effect: "false = any checkout, including one you have not trusted, can put text into your global store. Reads are unaffected either way.",
		sensitive: true,
	},
	{
		key: "toggleShortcut",
		group: "switches",
		type: "string",
		description: 'A pi keybinding id (e.g. "app.toggleMemory") that flips use+record in one keystroke.',
		effect: "Empty = no keybinding; /memory on|off still works. The id must exist in your pi keybindings.",
	},

	// ---- context budget ----
	{
		key: "inject",
		group: "context-budget",
		type: "enum",
		values: INJECT_MODES,
		description: "What is placed in the system prompt: nothing (off), the catalog only, or catalog + per-run hits.",
		effect: "off = zero context cost, and the agent must call memory_lookup on its own initiative. catalog+hits is the default because that is what makes the agent check memory before researching.",
	},
	{
		key: "catalogMaxChars",
		group: "context-budget",
		type: "int",
		range: [0, 6000],
		description: "Hard character budget for the catalog section of the prompt.",
		effect: "Roughly 4 chars per token, so 1800 is ~450 tokens every turn. Raise only if your store outranks the sample and searching feels too slow.",
	},
	{
		key: "hitsMaxChars",
		group: "context-budget",
		type: "int",
		range: [0, 4000],
		description: "Hard budget for the per-run 'these records look relevant' section.",
		effect: "0 disables hits: the agent then has to search instead of being handed matches.",
	},
	{
		key: "maxIndexEntries",
		group: "context-budget",
		type: "int",
		range: [0, 300],
		description: "How many catalog lines (id + one-liner) are listed in the prompt.",
		effect: "Past this the section says how to get the rest. More lines = a bigger permanent per-turn cost; the pointer line is cheap on purpose.",
	},
	{
		key: "maxHits",
		group: "context-budget",
		type: "int",
		range: [0, 12],
		description: "Maximum records surfaced per run by relevance to your prompt.",
		effect: "Above ~4 the extra hits are usually noise that the model has to wade through.",
	},
	{
		key: "searchMaxChars",
		group: "context-budget",
		type: "int",
		range: [500, 20000],
		description: "Cap on one memory_lookup search result.",
		effect: "Bigger caps let one tool call flood context; the value here is the ceiling, not the target.",
	},
	{
		key: "readMaxChars",
		group: "context-budget",
		type: "int",
		range: [500, 20000],
		description: "Cap on one rendered record when reading (statement, evidence, procedure).",
		effect: "A record is capped at maxRecordChars on disk anyway; this protects against reading many at once.",
	},
	{
		key: "minSearchScore",
		group: "context-budget",
		type: "float",
		range: [0, 20],
		description: "Score floor below which the answer is 'no match' rather than a weak suggestion.",
		effect: "Lower = more recall, more confidently-wrong nudges. Raise if the agent keeps acting on unrelated records.",
		sensitive: true,
	},

	// ---- accuracy ----
	{
		key: "requireEvidence",
		group: "accuracy",
		type: "bool",
		description: "Refuse any record that cannot cite a command, file path, URL, or session.",
		effect: "false = guesses can be stored. That is the main way a store becomes untrustworthy, so this stays on unless you are importing notes you do not trust.",
		sensitive: true,
	},
	{
		key: "minQuality",
		group: "accuracy",
		type: "int",
		range: [0, 10],
		description: "Reliability score (0-10 rubric) a draft must reach to be stored.",
		effect: "0 accepts thin records; the rubric rewards a findable title, a concise condition-specific statement, cues, and cited evidence. Refusals print the rubric so the model can fix the draft.",
	},
	{
		key: "selfHeal",
		group: "accuracy",
		type: "enum",
		values: SELFHEAL_MODES,
		description: "Correct records that live evidence contradicts: on, dispute-only, or off.",
		effect: "on = a cited command that fails disputes the record (it leaves the prompt, confidence drops); a warned-against command that fails confirms it. dispute-only never raises confidence automatically. off = wrong records stay until you audit them by hand.",
		sensitive: true,
	},
	{
		key: "autoVerify",
		group: "accuracy",
		type: "bool",
		description: "Count a recommended command working in a live run as a verification.",
		effect: "false = verifiedCount only grows when you run /memory verify or memory_save {action:\"verify\"}.",
	},
	{
		key: "includeDisputed",
		group: "accuracy",
		type: "bool",
		description: "Allow disputed records into the prompt again.",
		effect: "false (default) = a contradicted record stops being suggested but is still findable by explicit search, marked DISPUTED, so it can be fixed. true = you accept acting on knowledge known to be shaky.",
		sensitive: true,
	},
	{
		key: "dedupThreshold",
		group: "accuracy",
		type: "float",
		range: [0, 1],
		description: "Similarity at which a same-category near-duplicate is refused in favour of updating the existing record.",
		effect: "Lower = stricter (more refusals, smaller store); higher = more near-duplicates accumulate and searches return several variants of one fact.",
	},
	{
		key: "tentativeTtlDays",
		group: "accuracy",
		type: "int",
		range: [0, 3650],
		description: "Days a tentative (confidence 1, never verified) record survives before it is proposed for retirement.",
		effect: "0 = never expire tentative records.",
	},
	{
		key: "staleDays",
		group: "accuracy",
		type: "int",
		range: [1, 3650],
		description: "Age after which /memory audit flags a record as stale (not re-verified for a long time).",
		effect: "Advisory only: nothing is deleted for being stale.",
	},
	{
		key: "includeTentative",
		group: "accuracy",
		type: "bool",
		description: "Surface tentative records at all (they are always labelled as such).",
		effect: "false = only supported/verified records are suggested; more misses, less noise.",
	},
	{
		key: "maxActiveRecords",
		group: "accuracy",
		type: "int",
		range: [10, 20000],
		description: "Soft ceiling on live records before /memory prune proposes retirements.",
		effect: "A big store is not free: retrieval stays fast, but the catalog sample covers a smaller share and duplicate advice accumulates.",
	},

	// ---- privacy ----
	{
		key: "privacy",
		group: "privacy",
		type: "enum",
		values: PRIVACY_MODES,
		description: "How strongly personal or confidential-sounding content is kept out of the store.",
		effect: "strict (default) refuses personal identifiers and confidentiality wording; standard blocks only clear identifiers; off lets anything be written - only choose this if you own the whole path the store travels, including any remote you push it to.",
		sensitive: true,
	},
	{
		key: "sketchy",
		group: "privacy",
		type: "enum",
		values: SKETCHY_MODES,
		description: "What to do with low-reliability or low-rank content (unsourced, hedged, hearsay-shaped).",
		effect: "block (default) refuses it; flag stores it marked so it ranks lower; off treats it as ordinary. 'Low rank' here means unreliable, not unpopular.",
		sensitive: true,
	},
	{
		key: "redactSecrets",
		group: "privacy",
		type: "enum",
		values: REDACT_MODES,
		description: "Secrets in record text: refuse the write, mask them out, or do nothing.",
		effect: "block (default) is the safe choice: a masked secret is still a leak of shape and context. off exists for importing your own already-public notes.",
		sensitive: true,
	},
	{
		key: "restrictProjectPaths",
		group: "privacy",
		type: "bool",
		description: "Keep project-scoped records inside the current working directory tree.",
		effect: "false = a record can claim any path prefix as its scope, which makes project knowledge leak into unrelated checkouts.",
		sensitive: true,
	},

	// ---- auto-capture ----
	{
		key: "autoCapture",
		group: "auto-capture",
		type: "enum",
		values: AUTOCAPTURE_MODES,
		description: "Remember proven fixes without being asked: off, fixes only, or everything notable.",
		effect: "fixes (default) mines failed-call -> working-call chains, stores them marked 'auto' and tentative, and lists them in /memory review for you to accept. off = nothing is ever written unless the model or you ask.",
		sensitive: true,
	},
	{
		key: "signals",
		group: "auto-capture",
		type: "bool",
		description: "Keep the local ledger of failed calls (pending/signals.jsonl) used by /memory review.",
		effect: "false = no ledger; self-heal still works within a run, but you lose the review queue.",
	},
	{
		key: "maxSignals",
		group: "auto-capture",
		type: "int",
		range: [10, 5000],
		description: "How many failed-call entries the ledger keeps before trimming.",
		effect: "Larger is more history to review; the file is plaintext on your machine either way.",
	},

	// ---- storage ----
	{
		key: "dir",
		group: "storage",
		type: "path",
		description: "Where the store lives (one directory of Markdown files plus indexes).",
		effect: "Default $PI_CODING_AGENT_DIR/global-memory. Changing it does not move existing records - use /memory export then import.",
	},
	{
		key: "maxRecordChars",
		group: "storage",
		type: "int",
		range: [200, 8000],
		description: "Size cap for a single record file.",
		effect: "Conciseness is enforced rather than hoped for: one fact per record keeps retrieval precise and prompt cost predictable.",
	},
	{
		key: "maxWritesPerSession",
		group: "storage",
		type: "int",
		range: [0, 500],
		description: "Write quota per session (model saves, auto-capture, self-heal writes).",
		effect: "0 = effectively read-only for the session. Keeps a run-away model from filling the store with noise.",
	},
	{
		key: "reloadTtlMs",
		group: "storage",
		type: "int",
		range: [0, 600000],
		description: "How stale the in-memory view of the store may be before it is re-read from disk.",
		effect: "Matters when several pi sessions share one store: lower = you see the other session's writes sooner.",
		advanced: true,
	},
	{
		key: "gitAutoCommit",
		group: "storage",
		type: "bool",
		description: "Make a local git commit after each write (never pushes, never contacts a remote).",
		effect: "true removes the defensive .gitignore inside the store so the store can be versioned. Pushing stays your command, from a shell.",
		sensitive: true,
	},
	{
		key: "confirmDestructive",
		group: "storage",
		type: "bool",
		description: "Ask before hard deletes, prune, and bulk retire.",
		effect: "false lets those run unattended. Note /memory delete-all always asks twice plus a typed token, whatever this is set to.",
		sensitive: true,
	},
	{
		key: "statusLine",
		group: "storage",
		type: "bool",
		description: "Show the 'GM use+record 412' line in pi's footer.",
		effect: "One line, so you always know memory is being read and written.",
	},
];

const byKey = new Map<string, ConfigSpec>(CONFIG_SPEC.map((s) => [s.key as string, s]));

export function specFor(key: string): ConfigSpec | undefined {
	return byKey.get(key);
}

/** Every key in CONFIG_DEFAULTS must have a spec entry (enforced by test). */
export function undocumentedKeys(): string[] {
	return Object.keys(CONFIG_DEFAULTS).filter((k) => !byKey.has(k));
}

export function boolSpecKeys(): (keyof GmConfig)[] {
	return CONFIG_SPEC.filter((s) => s.type === "bool").map((s) => s.key);
}

export function numericSpecKeys(): Partial<Record<keyof GmConfig, [number, number]>> {
	const out: Partial<Record<keyof GmConfig, [number, number]>> = {};
	for (const s of CONFIG_SPEC) {
		if (s.type === "int" || s.type === "float") out[s.key] = s.range ?? [0, 1e9];
	}
	return out;
}

export function enumSpecKeys(): Partial<Record<keyof GmConfig, readonly string[]>> {
	const out: Partial<Record<keyof GmConfig, readonly string[]>> = {};
	for (const s of CONFIG_SPEC) {
		if (s.type === "enum") out[s.key] = s.values ?? [];
	}
	return out;
}

export function stringSpecKeys(): (keyof GmConfig)[] {
	return CONFIG_SPEC.filter((s) => s.type === "string").map((s) => s.key);
}

function valueHint(s: ConfigSpec): string {
	if (s.type === "enum") return `one of: ${s.values?.join(" | ")}`;
	if (s.type === "bool") return "true | false";
	if (s.range) return s.type === "float" ? `number ${s.range[0]}..${s.range[1]}` : `integer ${s.range[0]}..${s.range[1]}`;
	if (s.type === "path") return "absolute path, or ~/path";
	return "short string";
}

/** One-line hint used in error messages, so a typo tells you what to type. */
export function hintFor(key: string): string {
	const s = specFor(key);
	return s ? `${s.type} (${valueHint(s)})` : "unknown key";
}

export function renderConfigList(cfg: GmConfig, sources: string[], problems: string[]): string {
	const lines: string[] = [];
	lines.push("Configuration for pi-global-memory. Change one with:  /memory config set <key> <value>");
	lines.push(`Sources in precedence order (left wins): ${sources.join(" > ")}`);
	lines.push("Keys marked [!] affect privacy or safety - read the effect before relaxing one.");
	lines.push("");
	for (const group of GROUP_ORDER) {
		const specs = CONFIG_SPEC.filter((s) => s.group === group);
		if (specs.length === 0) continue;
		lines.push(`## ${GROUP_LABELS[group]}`);
		for (const s of specs) {
			const current = (cfg as unknown as Record<string, unknown>)[s.key as string];
			const isDefault = JSON.stringify(current) === JSON.stringify((CONFIG_DEFAULTS as unknown as Record<string, unknown>)[s.key as string]);
			lines.push(`${s.sensitive ? "[!] " : "    "}${String(s.key)} = ${JSON.stringify(current ?? "")}${isDefault ? "  (default)" : "  (set)"}   ${valueHint(s)}`);
			lines.push(`        ${s.description}`);
			lines.push(`        effect: ${s.effect}`);
		}
		lines.push("");
	}
	if (problems.length > 0) {
		lines.push("## Rejected settings (they were NOT applied)");
		for (const p of problems) lines.push(`- ${p}`);
		lines.push("");
	}
	lines.push("Everything here is read from, and written to, files you can inspect:");
	lines.push("  pi settings.json key \"globalMemory\"  |  <store>/config.json  |  PI_GLOBAL_MEMORY_* environment variables.");
	return lines.join("\n");
}

export function renderExplain(key: string): string {
	const s = specFor(key);
	if (!s) {
		const near = CONFIG_SPEC.filter((x) => String(x.key).startsWith(key.slice(0, 3))).map((x) => x.key);
		return `No such setting "${key}". Did you mean: ${near.slice(0, 8).join(", ") || "(nothing similar)"}\nList all with: /memory config list`;
	}
	return [
		`${s.key}   ${s.sensitive ? "[privacy/safety relevant]" : ""}`,
		`  type:     ${hintFor(key)}`,
		`  default:  ${JSON.stringify((CONFIG_DEFAULTS as unknown as Record<string, unknown>)[key])}`,
		`  group:    ${GROUP_LABELS[s.group]}`,
		`  what:     ${s.description}`,
		`  effect:   ${s.effect}`,
		`  set with: /memory config set ${s.key} <value>`,
	].join("\n");
}

/** Used when a set fails: name the key, the expected shape, and the fix. */
export function explainProblem(key: string | undefined, detail: string): string {
	if (!key) return detail;
	const s = specFor(key);
	if (!s) return `${detail}\nUnknown key. See /memory config list.`;
	return `${detail}\n${s.key}: ${hintFor(key)}\n  ${s.description}\n  Try: /memory config explain ${s.key}`;
}
