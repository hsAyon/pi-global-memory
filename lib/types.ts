/**
 * Data model and configuration types for pi-global-memory.
 *
 * This module is runtime-light on purpose: it holds the value constants and the
 * shapes only, so every other module (and the tests) can import it without
 * pulling in pi, typebox, or the filesystem.
 */

/** What kind of learning a record holds. Drives capture rules and prompt markers. */
export const KINDS = [
	"fact", // stable environment/tool truth
	"mistake", // what went wrong and what worked instead
	"research", // findings gathered from external sources
	"pattern", // a repeatedly useful approach
	"workflow", // an ordered procedure that works
	"environment", // machine/tooling specifics
] as const;
export type GmKind = (typeof KINDS)[number];

export const STATUSES = ["active", "superseded", "retired"] as const;
export type GmStatus = (typeof STATUSES)[number];

export const EVIDENCE_TYPES = ["command", "file", "url", "session", "artifact", "doc"] as const;
export type GmEvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Confidence ladder. Kept deliberately small so models can reason about it. */

/**
 * Evidence is what makes a record a fact instead of a guess.
 * Encoded on disk as one string per entry: `type|ref|note` (note optional).
 */
export interface GmEvidence {
	type: GmEvidenceType;
	ref: string;
	note?: string;
}

export interface GmScope {
	kind: "global" | "project";
	/** Normalized absolute path prefix. Required when kind is "project". */
	path?: string;
}

export interface GmStats {
	hits: number;
	created: string;
	updated: string;
	lastUsed?: string;
	lastVerified?: string;
	/** When live evidence contradicted this record. Drives self-healing. */
	disputedAt?: string;
	/** How many times live evidence confirmed it. */
	verifiedCount?: number;
}

export interface GmRecord {
	id: string;
	kind: GmKind;
	/** Categorical index key, slug, one word where possible: "git", "docker", "pi". */
	category: string;
	/** One line, <= 90 chars. This is what the agent sees in the injected catalog. */
	title: string;
	/** The learning itself, <= 700 chars, stated as a fact or an instruction. */
	statement: string;
	why?: string;
	how?: string;
	avoid?: string;
	notes?: string;
	tags: string[];
	/** Extra retrieval cues (error strings, flag names, symbols). Cheap precision. */
	cues: string[];
	confidence: number;
	status: GmStatus;
	scope: GmScope;
	supersedes: string[];
	supersededBy?: string;
	evidence: GmEvidence[];
	stats: GmStats;
	/** Machine-set markers: "auto", "injection_suspect", "disputed", "hedged", "privacy_masked", "low-value". */
	flags: string[];
	/** Ids this record is in tension with (same cited command, opposite advice). */
	contradicts: string[];
	/** Absolute path of the backing file, filled at load time. */
	file?: string;
}

/** Compact entry used in indexes, tool results, and prompt injection. */
export interface GmEntry {
	id: string;
	kind: GmKind;
	category: string;
	title: string;
	confidence: number;
	status: GmStatus;
	hits: number;
	updated: string;
	scope: GmScope;
	tags: string[];
	score?: number;
	file?: string;
	disputed?: boolean;
	flags?: string[];
}

export const SELFHEAL_MODES = ["on", "dispute-only", "off"] as const;
export type GmSelfHeal = (typeof SELFHEAL_MODES)[number];

export const INJECT_MODES = ["catalog+hits", "catalog", "off"] as const;
export type GmInjectMode = (typeof INJECT_MODES)[number];

export const REDACT_MODES = ["block", "mask", "off"] as const;
export type GmRedactMode = (typeof REDACT_MODES)[number];

export const AUTOCAPTURE_MODES = ["off", "fixes"] as const;
export type GmAutoCapture = (typeof AUTOCAPTURE_MODES)[number];

export const PRIVACY_MODES = ["strict", "standard", "off"] as const;
export type GmPrivacyMode = (typeof PRIVACY_MODES)[number];
export const SKETCHY_MODES = ["block", "flag", "off"] as const;
export type GmSketchyMode = (typeof SKETCHY_MODES)[number];

export interface GmConfig {
	enabled: boolean;
	/** Read side: tool availability plus prompt injection. */
	use: boolean;
	/** Write side: model, capture, and command writes. */
	record: boolean;
	/** Root of the store. Everything the extension writes lives under it. */
	dir: string;
	inject: GmInjectMode;
	/** Budgets. These are the levers that keep the store off the context bill. */
	catalogMaxChars: number;
	hitsMaxChars: number;
	maxIndexEntries: number;
	maxHits: number;
	searchMaxChars: number;
	readMaxChars: number;
	/** Minimum normalized search score worth returning. */
	minSearchScore: number;
	/** When true the tools refuse every write. */
	readOnly: boolean;
	maxWritesPerSession: number;
	maxRecordChars: number;
	requireEvidence: boolean;
	dedupThreshold: number;
	redactSecrets: GmRedactMode;
	autoCapture: GmAutoCapture;
	signals: boolean;
	maxSignals: number;
	tentativeTtlDays: number;
	staleDays: number;
	maxActiveRecords: number;
	confirmDestructive: boolean;
	statusLine: boolean;
	/** Reload the store when it changed on disk (other pi sessions write it too). */
	reloadTtlMs: number;
	/** Commit store changes with git when the store root is inside a work tree. */
	gitAutoCommit: boolean;
	/** Never let a model claim a project scope outside the cwd or its ancestors. */
	restrictProjectPaths: boolean;
	/** Inject records that are only tentatively supported. */
	includeTentative: boolean;
	/** Privacy posture for writes. strict refuses personal identifiers and confidential-sounding text. */
	privacy: GmPrivacyMode;
	/** How to treat hedged, unverifiable wording ("i think", "probably"). */
	sketchy: GmSketchyMode;
	/** Below this explainable 0..10 quality score a write is refused. */
	minQuality: number;
	/** Usefulness floor for keeping a record at all (0-10). */
	minUsefulness: number;
	/** Auto-disable recording in ephemeral sessions (pi --no-session). */
	respectSessionPrivacy: boolean;
	/** Refuse writes while project trust is denied. */
	requireProjectTrustForWrites: boolean;
	/** Opt-in keybinding id that toggles use+record (example: "ctrl+shift+m"). */
	toggleShortcut: string;
	/** Accuracy engine posture: dispute on contradiction, auto-verify on confirmation. */
	selfHeal: GmSelfHeal;
	/** Confirm a record automatically when live evidence repeats its cited command. */
	autoVerify: boolean;
	/** Exclude disputed records from prompt hits (they still appear in search). */
	includeDisputed: boolean;
}

export const CONFIG_DEFAULTS: GmConfig = {
	enabled: true,
	use: true,
	record: true,
	dir: "",
	inject: "catalog+hits",
	catalogMaxChars: 1800,
	hitsMaxChars: 900,
	maxIndexEntries: 40,
	maxHits: 3,
	searchMaxChars: 3000,
	readMaxChars: 4000,
	minSearchScore: 1.2,
	readOnly: false,
	maxWritesPerSession: 25,
	maxRecordChars: 1600,
	requireEvidence: true,
	dedupThreshold: 0.72,
	redactSecrets: "block",
	autoCapture: "fixes",
	signals: true,
	maxSignals: 300,
	tentativeTtlDays: 60,
	staleDays: 120,
	maxActiveRecords: 400,
	confirmDestructive: true,
	statusLine: true,
	reloadTtlMs: 30000,
	gitAutoCommit: false,
	restrictProjectPaths: true,
	includeTentative: true,
	privacy: "strict",
	sketchy: "block",
	minQuality: 3,
	minUsefulness: 4,
	respectSessionPrivacy: true,
	requireProjectTrustForWrites: true,
	toggleShortcut: "",
	selfHeal: "on",
	autoVerify: true,
	includeDisputed: false,
};

/** Keys the user may set through settings.json, config.json, or env. */

export interface LoadedStore {
	records: GmRecord[];
	/** Records that failed validation and were skipped. Fail closed. */
	invalid: { file: string; reason: string }[];
	generatedAt: string;
}

export interface SearchQuery {
	text: string;
	limit: number;
	category?: string;
	kind?: GmKind;
	tags?: string[];
	includeRetired?: boolean;
	minConfidence?: number;
	scope?: "any" | "global" | "project";
	/** Prompt hits drop disputed records; explicit searches keep them by default. */
	excludeDisputed?: boolean;
}

export interface Signal {
	fingerprint: string;
	toolName: string;
	summary: string;
	sessionId: string;
	at: string;
	count: number;
	/** True once a matching success was observed in the same run. */
	resolved?: boolean;
	successSummary?: string;
}
