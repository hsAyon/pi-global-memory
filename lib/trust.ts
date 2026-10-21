/**
 * Trust and privacy gating for anything written to the store.
 *
 * Default posture is private: personal identifiers, confidential-sounding
 * material, and hedged ("I think", "probably") claims are refused, not stored.
 * Both gates are configurable for operators who want them relaxed:
 *   privacy: strict | standard | off      (default strict = refuse)
 *   sketchy: block  | flag   | off       (default block  = refuse)
 *
 * A refusal is a feature: a record that leaks a coworker's email or states a
 * guess as fact costs more context than it saves, and it is exactly the kind of
 * content that makes later agents loop, because it cannot be trusted.
 */

import { escapeRegExp } from "./util.ts";

export const PRIVACY_MODES = ["strict", "standard", "off"] as const;
export type GmPrivacyMode = (typeof PRIVACY_MODES)[number];

export const SKETCHY_MODES = ["block", "flag", "off"] as const;
export type GmSketchyMode = (typeof SKETCHY_MODES)[number];

interface Pattern {
	name: string;
	re: RegExp;
	/** strong identifiers are refused even in "standard" mode. */
	strong: boolean;
}

/**
 * Identifier shapes, not topics. "docker" is a fine memory; an email address
 * inside one is not. Rules are shape-based so they cannot be argued away by
 * wording.
 */
const PII_PATTERNS: Pattern[] = [
	{ name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, strong: false },
	{ name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, strong: true },
	{
		name: "phone",
		// Separators are required on purpose: a bare digit run inside a token,
		// hash, or id is not a phone number.
		re: /\b(?:\+\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b\+\d{7,15}\b/g,
		strong: true,
	},
	{
		name: "card-number",
		// Grouped or network-prefixed card shapes only. A bare 13-16 digit run is
		// usually a timestamp or an id, so it is deliberately not matched.
		re: /\b(?:\d{4}[ -]){3}\d{4}\b|\b4\d{15}(?:\d{3})?\b|\b5[1-5]\d{14}\b|\b3[47]\d{13}\b|\b6(?:011|5\d{2})\d{12}\b/g,
		strong: true,
	},
	{ name: "iban", re: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]\s?){11,30}\b/g, strong: true },
	{ name: "ipv4-with-port", re: /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g, strong: false },
	{ name: "handle", re: /(?:^|\s)@[A-Za-z0-9_]{3,20}\b/g, strong: false },
	{ name: "person-with-title", re: /\b(?:Mr|Mrs|Ms|Dr)\.\s+[A-Z][a-z]+\b/g, strong: false },
];

const CONFIDENTIAL_MARKERS: string[] = [
	"confidential",
	"internal only",
	"do not share",
	"do not distribute",
	"not for external",
	"nda",
	"restricted access",
	"personally identifiable",
	"\bpii\b",
	"patient record",
	"medical record",
	"bank account",
	"credit card number",
	"passport number",
	"driver'?s license",
	"social security",
	"salary",
	"compensation",
	"home address",
	"private chat",
	"dm from",
	"customer list",
	"client list",
	"victim",
	"subpoena",
	"layoff",
];

const MARKER_RE = new RegExp(`(?:${CONFIDENTIAL_MARKERS.map((m) => (m.includes("\\b") ? m : escapeRegExp(m))).join("|")})`, "gi");

/** Claims that are guesses by construction. */
const HEDGE_PATTERNS: string[] = [
	"i think",
	"i believe",
	"i guess",
	"probably",
	"maybe",
	"might be",
	"could be that",
	"not sure",
	"unsure",
	"as far as i know",
	"rumor",
	"heard that",
	"allegedly",
	"supposedly",
	"unverified",
	"i assume",
	"seems like",
	"it seems",
	"haven't tested",
	"have not tested",
	"didn't test",
	"did not test",
	"tbd",
	"todo: verify",
	"needs verification",
	"unconfirmed",
	"conjecture",
];

export interface TrustScan {
	pii: { name: string; count: number; strong: boolean }[];
	markers: string[];
	hedges: string[];
	piiCount: number;
	strongPii: boolean;
}

function countMatches(text: string, re: RegExp): number {
	re.lastIndex = 0;
	let n = 0;
	while (re.exec(text) !== null) n++;
	re.lastIndex = 0;
	return n;
}

export function scanPrivacy(text: string): TrustScan {
	const body = String(text ?? "");
	const pii: TrustScan["pii"] = [];
	let piiCount = 0;
	let strongPii = false;
	for (const rule of PII_PATTERNS) {
		const n = countMatches(body, rule.re);
		if (n === 0) continue;
		pii.push({ name: rule.name, count: n, strong: rule.strong });
		piiCount += n;
		if (rule.strong) strongPii = true;
	}
	const markers: string[] = [];
	MARKER_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MARKER_RE.exec(body)) !== null) {
		const key = m[0].toLowerCase();
		if (!markers.includes(key)) markers.push(key);
		MARKER_RE.lastIndex = m.index + 1;
	}
	return { pii, markers, hedges: [], piiCount, strongPii };
}

export function detectHedges(text: string): string[] {
	const lower = String(text ?? "").toLowerCase();
	const found: string[] = [];
	for (const h of HEDGE_PATTERNS) {
		if (lower.includes(h) && !found.includes(h)) found.push(h);
	}
	return found;
}

/** Replace identifier-shaped content with a typed marker. */
export function maskPrivacy(text: string): { text: string; changed: string[] } {
	let out = String(text ?? "");
	const changed: string[] = [];
	for (const rule of PII_PATTERNS) {
		rule.re.lastIndex = 0;
		if (!rule.re.test(out)) continue;
		rule.re.lastIndex = 0;
		out = out.replace(rule.re, `[PRIVATE:${rule.name}]`);
		changed.push(rule.name);
	}
	return { text: out, changed };
}

export interface TrustDecision {
	block: string[];
	notes: string[];
	forceConfidence?: number;
	flags: string[];
}

/**
 * Decide what to do with a draft body. `mode` and `sketchy` come from config, so
 * the operator always owns the posture.
 */
export function assessTrust(parts: { title: string; statement: string; why: string; how: string; avoid: string; notes: string }, mode: GmPrivacyMode, sketchy: GmSketchyMode): TrustDecision {
	const body = [parts.title, parts.statement, parts.why, parts.how, parts.avoid, parts.notes].join(" \n ");
	const block: string[] = [];
	const notes: string[] = [];
	const flags: string[] = [];
	let forceConfidence: number | undefined;

	if (mode !== "off") {
		const scan = scanPrivacy(body);
		if (scan.strongPii || (scan.piiCount > 0 && mode === "strict")) {
			const detail = scan.pii.map((p) => `${p.name} x${p.count}`).join(", ");
			block.push(
				`private content refused (${detail}). Personal identifiers do not belong in durable memory. Options: remove them from the text, set privacy:"standard" to mask weak identifiers, or privacy:"off" to allow (not recommended)`,
			);
		} else if (scan.piiCount > 0) {
			notes.push(`personal identifiers present (${scan.pii.map((p) => p.name).join(", ")}): masking them in the stored record`);
			flags.push("privacy_masked");
		}
		if (scan.markers.length > 0) {
			if (mode === "strict") {
				block.push(
					`confidential-sounding content refused (${scan.markers.slice(0, 6).join(", ")}). Set privacy:"standard" if this is deliberately non-sensitive`,
				);
			} else {
				notes.push(`confidential markers present (${scan.markers.slice(0, 6).join(", ")}); keep this record project-scoped`);
				flags.push("confidential_marker");
			}
		}
	}

	if (sketchy !== "off") {
		const hedges = detectHedges(body);
		if (hedges.length > 0) {
			if (sketchy === "block") {
				block.push(
					`unreliable wording refused (${hedges.slice(0, 5).join(", ")}). Record only what you actually verified, or retest and then save; sketchy:"flag" stores it as tentative instead`,
				);
			} else {
				notes.push(`hedged wording (${hedges.slice(0, 5).join(", ")}): stored as tentative (confidence 1)`);
				flags.push("hedged");
				forceConfidence = 1;
			}
		}
	}

	return { block, notes, forceConfidence, flags };
}

export interface QualityResult {
	score: number;
	reasons: string[];
}

/**
 * Cheap explainable quality score, 0..10. It is a guard against vague memory,
 * not a rubric for style: short, specific, cited, cue-rich records are the ones
 * that save future agents from re-deriving things.
 */
export function qualityScore(input: { title: string; statement: string; cues: string[]; tags: string[]; evidenceCount: number; confidence: number }): QualityResult {
	const reasons: string[] = [];
	let score = 0;

	if (input.title.length >= 12) {
		score += 1;
		reasons.push("title length ok (+1)");
	} else reasons.push("title too short to be findable (-0)");
	if (/["'`]|[\w./-]{6,}|\d/.test(input.title)) {
		score += 1;
		reasons.push("title names something concrete (+1)");
	}
	if (/\b(always|never|use|avoid|run|set|call|must|prefer|fix|worked|works|fails?|failed|succeeds?|requires?|needs|only)\b/i.test(input.title)) {
		score += 1;
		reasons.push("title states an action or rule (+1)");
	}

	const len = input.statement.length;
	if (len >= 40) {
		score += 1;
		reasons.push("statement developed (+1)");
	}
	if (len <= 320) {
		score += 1;
		reasons.push("statement concise (+1)");
	} else reasons.push("statement long for a memory: trim it (0)");
	if (/\bbecause\b|\bwhen\b|\bafter\b|\bbefore\b|\bif\b|[0-9]|\/|--|\b\w+\.\w+/i.test(input.statement)) {
		score += 1;
		reasons.push("statement is condition-specific (+1)");
	}

	if (input.evidenceCount >= 1) {
		score += 1;
		reasons.push("has evidence (+1)");
	} else reasons.push("no evidence (0)");
	if (input.evidenceCount >= 2) {
		score += 1;
		reasons.push("cross-checked evidence (+1)");
	}
	if (input.cues.length >= 2) {
		score += 1;
		reasons.push("retrieval cues present (+1)");
	}
	if (input.tags.length >= 1 && input.tags.length <= 8) reasons.push("tags ok (0)");

	return { score: Math.max(0, Math.min(10, score)), reasons };
}

/**
 * Is this draft knowledge, or a fault report about the agent and its runtime?
 *
 * The store is meant to hold what was learned about the user's environment: a flag that was
 * missing, a path that is authoritative, a setting that has to change. It is not a crash log.
 * Recording "the model runner failed", "compaction error", "pi crashed", or "tool call rejected"
 * is actively harmful: the next session reads it as guidance and starts routing around a
 * transient fault, and the store fills with entries nobody can verify.
 *
 * So this gate looks for a *runtime subject* stated next to a *failure predicate*. A record that
 * merely mentions pi, sessions, or compaction without a failure claim passes: "pi keeps sessions
 * in memory under --no-session, so nothing persists" is a real fact about the tool. The gate
 * rejects the failure log, never the durable rule it implies, and says so.
 */
/**
 * Is this draft knowledge, or a fault report about the agent and its runtime?
 *
 * The store holds what was learned about the user's environment: a missing flag, an authoritative
 * path, a setting that has to change. It is not a crash log. Recording "the model runner failed",
 * "compaction error", or "pi crashed" is actively harmful: the next session reads it as guidance
 * to route around a transient fault, and nobody can re-verify it. So this looks for an
 * agent-runtime subject stated near a failure predicate. A record that merely mentions pi without
 * a failure claim passes - "pi keeps sessions in memory under --no-session" is a real fact about
 * the tool. The gate rejects the fault report, never the durable rule it implies, and says so.
 */
const RUNTIME_PHRASES = [
	"model runner",
	"model failure",
	"model failed",
	"runner failure",
	"pi crashed",
	"pi coding agent failed",
	"harness error",
	"harness failure",
	"compaction error",
	"compaction failed",
	"session error",
	"system error",
	"runtime error",
	"tool call was rejected",
	"tool call rejected",
	"context overflow",
	"output truncated",
	"stop reason",
];


/** Subjects that mean "the agent or its runtime", never the user's own infrastructure. */
const RUNTIME_SUBJECT_TERMS = [
	"pi",
	"pi coding agent",
	"the model",
	"model runner",
	"model failure",
	"the harness",
	"harness",
	"agent loop",
	"the agent",
	"the runtime",
	"runtime",
	"compaction",
	"context window",
	"tool call",
	"tool result",
	"the assistant",
];


const RUNTIME_FAILURE_TERMS = [
	"crash",
	"crashed",
	"crashes",
	"crashing",
	"fail",
	"failed",
	"fails",
	"failing",
	"failure",
	"failures",
	"error",
	"errors",
	"errored",
	"threw",
	"throw",
	"throws",
	"thrown",
	"throwing",
	"exception",
	"exceptions",
	"stack trace",
	"traceback",
	"panic",
	"panicked",
	"panics",
	"segfault",
	"segmentation fault",
	"timed out",
	"timeout",
	"timeouts",
	"abort",
	"aborts",
	"aborted",
	"aborting",
	"kill",
	"killed",
	"kills",
	"oom",
	"out of memory",
	"hung",
	"froze",
	"frozen",
	"deadlock",
	"core dump",
];


export interface RuntimeNoise {
	noise: boolean;
	why: string;
}


/**
 * Words become noise only as whole words, so systemd, session, and provider stay out of the
 * subject list and a fact about the user's own infrastructure is never mistaken for a fault in
 * the agent. Matching on padded words rather than regular expressions keeps this readable.
 */
function wordPositions(padded: string, term: string): number[] {
	const needle = " " + term + " ";
	const at: number[] = [];
	let from = 0;
	for (;;) {
		const i = padded.indexOf(needle, from);
		if (i < 0) return at;
		at.push(i);
		from = i + 1;
	}
}


/** lowercase, alphanumerics only, single spaces, padded with spaces for whole-word matching. */
function words(text: string): string {
	const kept: string[] = [];
	for (const ch of text.toLowerCase()) {
		const isWord = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
		kept.push(isWord ? ch : " ");
	}
	return " " + kept.join("").split(" ").filter((p) => p.length > 0).join(" ") + " ";
}


export function assessRuntimeNoise(parts: (string | undefined | null)[]): RuntimeNoise {
	const raw = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
	const lower = raw.toLowerCase().split(" ").filter((p) => p.length > 0).join(" ");
	for (const phrase of RUNTIME_PHRASES) {
		if (lower.includes(phrase)) return { noise: true, why: "it states " + phrase + ", which describes the agent or its runtime rather than the task" };
	}
	const text = words(raw);
	for (const subject of RUNTIME_SUBJECT_TERMS) {
		const subjectAt = wordPositions(text, subject);
		if (subjectAt.length === 0) continue;
		for (const failure of RUNTIME_FAILURE_TERMS) {
			for (const s of subjectAt) {
				for (const f of wordPositions(text, failure)) {
					if (Math.abs(s - f) <= 90) {
						return { noise: true, why: "it pairs " + subject + " with " + failure + ", i.e. it reports a fault in the model, pi, or the runtime" };
					}
				}
			}
		}
	}
	return { noise: false, why: "" };
}

/**
 * Usefulness: does this deserve one of the store's slots?
 *
 * Quality (the other rubric) asks whether a record is well-formed and reliable. This asks a
 * different question: will it change what a future session does? Plenty of records are accurate,
 * well-cited, and worthless - textbook facts the model already knows, vague advice ("be careful with
 * the config"), session trivia ("this session saw 3 errors"), or claims about paths that will not
 * exist tomorrow. Every such record makes retrieval slower and the catalog noisier, which is the
 * resource this package exists to protect. So a draft is scored for usefulness at write time and
 * discarded below the floor, rather than stored and pruned later.
 *
 * Scoring is deliberately transparent (a reason per adjustment) because the refusal has to teach the
 * writer what would make a record worth keeping.
 */
const USEFUL_COMMANDS = [
	"npm", "npx", "pnpm", "yarn", "node", "bun", "git", "docker", "docker-compose", "compose", "kubectl", "helm",
	"pip", "pip3", "python", "python3", "poetry", "cargo", "rustc", "go", "make", "cmake", "gcc", "clang", "tsc",
	"eslint", "prettier", "jest", "vitest", "pytest", "curl", "wget", "apt", "apt-get", "brew", "systemctl",
	"journalctl", "ssh", "scp", "rsync", "tar", "gzip", "grep", "rg", "sed", "awk", "jq", "yq", "sqlite3", "psql",
	"aws", "gcloud", "az", "terraform", "pi", "powershell", "pwsh", "bash", "zsh", "winget", "choco", "reg",
	"sc.exe", "netsh", "taskkill", "wsl", "firewall-cmd", "openclaw", "ketch",
];

const USEFUL_HEDGES = ["maybe", "might", "possibly", "probably", "appears", "seems", "apparently", "consider", "perhaps", "usually", "generally", "typically", "somewhat", "sort", "kind"];
const USEFUL_VAGUE = ["be careful", "carefully", "double check", "double-check", "make sure", "verify things", "check things", "try to", "should probably", "it depends", "best practice", "as needed", "properly", "correctly", "appropriately"];
const USEFUL_META = ["this session", "the agent", "the model", "i think", "i believe", "we saw", "our conversation", "earlier in", "as an assistant", "my job"];
const USEFUL_EPHEMERAL = ["/tmp", "/temp", "tmpdir", "appdata", "session:", "sessionid", "today", "yesterday", "tonight", "now running", "current branch", "this worktree", "scratch"];
const USEFUL_SURPRISE = ["instead", "not", "only", "must", "requires", "cannot", "cant", "fails", "fails when", "does not", "doesn", "refused", "silently", "ignores", "overrides", "defaults to", "off by default", "on by default", "unlike", "whereas", "because", "otherwise", "surprisingly", "gotcha", "quirk", "flag", "option", "setting", "env", "environment variable"];

export interface Usefulness {
	score: number;
	reasons: string[];
}

export type UsefulnessVerdict = "discard" | "flag" | "store";

export function assessUsefulness(input: {
	title: string;
	statement: string;
	why: string;
	how: string;
	avoid: string;
	notes: string;
	cues: string[];
	tags: string[];
	category: string;
	kind: string;
	evidenceTypes: string[];
}): Usefulness {
	const body = [input.title, input.statement, input.why, input.how, input.avoid, input.notes].filter((p) => typeof p === "string" && p.length > 0).join(" ");
	const lower = body.toLowerCase();
	const words = " " + lower.split(" ").filter((p) => p.length > 0).join(" ") + " ";
	const reasons: string[] = [];
	let score = 5;

	// Concreteness: a memory that names the thing is actionable.
	let concrete = 0;
	if (/(^|[^-])--[a-z]/.test(lower) || /(^|[^a-z0-9])-{1,2}[a-z][a-z0-9-]{1,}/.test(lower)) {
		concrete++;
		reasons.push("names a flag or option (+1)");
	}
	if (/[a-z0-9_-]+\.(ts|js|cjs|mjs|json|md|py|toml|yaml|yml|lock|sh|ps1|bat|cfg|conf|ini|env|exe|sql)($|[^a-z])/.test(lower) || lower.includes("/") || lower.includes("\\")) {
		concrete++;
		reasons.push("names a file or path (+1)");
	}
	if (/[A-Z][A-Z0-9_]{2,}/.test(body)) {
		concrete++;
		reasons.push("names an environment variable or constant (+1)");
	}
	if (/[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]+/.test(lower)) {
		concrete++;
		reasons.push("names a config key or dotted setting (+1)");
	}
	const commandMention = USEFUL_COMMANDS.some((c) => words.includes(" " + c + " ") || words.includes(" " + c + ":"));
	if (commandMention) {
		concrete++;
		reasons.push("names a real command (+1)");
	}
	if (concrete > 3) {
		score -= concrete - 3;
		reasons.push("concreteness capped at +3");
		concrete = 3;
	}
	score += concrete;
	if (concrete === 0) {
		score -= 3;
		reasons.push("names nothing concrete: no flag, path, command, key, or error text (-3) - it reads like a generality the model already knows");
	}

	// Was a cost paid, or is something counter-intuitive stated?
	let cost = 0;
	if (input.how.length > 0 && input.avoid.length > 0) {
		cost++;
		reasons.push("records both the mistake and the fix (+1)");
	}
	if (USEFUL_SURPRISE.some((p) => words.includes(" " + p) || lower.includes(" " + p + " "))) {
		cost++;
		reasons.push("states a qualifier or contrast, not just a definition (+1)");
	}
	if (input.evidenceTypes.includes("command") || input.evidenceTypes.includes("file") || input.evidenceTypes.includes("artifact")) {
		cost++;
		reasons.push("evidence is a command, file, or artifact that can be re-checked (+1)");
	}
	if (["mistake", "research", "environment", "workflow", "pattern"].includes(input.kind) && /(observ|verif|test|reproduc|confirm|ran |tried )/.test(lower)) {
		cost++;
		reasons.push("says what was observed or tested (+1)");
	}
	if (cost === 0) {
		score -= 3;
		reasons.push("states no cost paid, contrast, or caveat: it can be looked up anywhere (-3)");
		const definitional = ["installs", "used to", "used for", "is a", "are a", "means", "refer to", "refers to", "allows", "enables", "provides", "contains", "consists", "defines", "sets up", "configures", "is an"].filter((p) => words.includes(" " + p));
		if (definitional.length > 0) {
			score -= 2;
			reasons.push(`reads like a dictionary definition of a tool (${definitional.slice(0, 3).join(", ")}) rather than something learned (-2)`);
		}
	}
	if (cost > 3) {
		score -= cost - 3;
		reasons.push("cost/caveat bonus capped at +3");
		cost = 3;
	}
	score += cost;

	// Will it be found when it matters?
	if (input.cues.length >= 1) {
		score += 1;
		reasons.push("carries retrieval cues (+1)");
	} else {
		reasons.push("no retrieval cues: future searches may miss it (0)");
	}
	if (input.category === "misc" || input.category === "tools" || input.category === "repo") {
		score -= 1;
		reasons.push(`category "${input.category}" is a dumping ground: name the tool or subject instead (-1)`);
	}

	// Discard-worthy patterns.
	const hedges = USEFUL_HEDGES.filter((p) => words.includes(" " + p + " "));
	if (hedges.length > 0) {
		score -= Math.min(3, hedges.length);
		reasons.push(`hedged wording (${hedges.slice(0, 4).join(", ")}): a memory is a claim, not a hypothesis (-${Math.min(3, hedges.length)})`);
	}
	const vague = USEFUL_VAGUE.filter((p) => lower.includes(p));
	if (vague.length > 0) {
		score -= 2;
		reasons.push(`vacuous advice (${vague.slice(0, 3).join(", ")}): it cannot change what a session does (-2)`);
	}
	const meta = USEFUL_META.filter((p) => lower.includes(p));
	if (meta.length > 0) {
		score -= 2;
		reasons.push(`about the conversation itself (${meta.slice(0, 3).join(", ")}), not about the task (-2)`);
	}
	const ephemeral = USEFUL_EPHEMERAL.filter((p) => lower.includes(p));
	if (ephemeral.length > 0) {
		score -= 2;
		reasons.push(`references throwaway state (${ephemeral.slice(0, 3).join(", ")}): it will not be true tomorrow (-2)`);
	}
	if (/[0-9]+ (error|errors|failure|failures|warning|warnings|times|attempts)/.test(lower) && concrete <= 1) {
		score -= 2;
		reasons.push("counts events without naming a cause or a fix (-2)");
	}
	if (input.title.length + input.statement.length < 60) {
		score -= 1;
		reasons.push("title and statement together are too thin to act on (-1)");
	}

	return { score: Math.max(0, Math.min(10, score)), reasons };
}

/**
 * Three verdicts instead of a binary gate: a draft under the floor is discarded; one barely over it
 * is stored but flagged so the audit trail can retire it if it never earns a lookup; anything
 * comfortably over it is stored normally.
 */
export function usefulnessVerdict(score: number, min: number): UsefulnessVerdict {
	if (score < min) return "discard";
	if (score < min + 3) return "flag";
	return "store";
}
