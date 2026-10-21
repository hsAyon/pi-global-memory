/**
 * Input hardening. Everything that enters the store, and everything the store
 * puts back into a model's context, passes through here.
 *
 * Two independent jobs:
 *  1. Secret redaction - credentials must never become durable knowledge.
 *  2. Injection defanging - a record is untrusted text once some other agent
 *     wrote it, so instruction-shaped content is neutralized before re-entry.
 */

export interface SanitizeResult {
	text: string;
	/** Names of the patterns that matched, never the matched secret itself. */
	hits: string[];
	suspect: boolean;
	/** Credential patterns only, so a defanged instruction never looks like a secret. */
	secretHits: string[];
	/** Instruction-shaped patterns. */
	defangHits: string[];
	defanged: boolean;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202e\u202d\u2066\u2067\u2068\u2069\ufeff]/g;

export function stripControlChars(text: string): string {
	return String(text ?? "")
		.replace(CONTROL_CHARS, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n");
}

interface SecretRule {
	name: string;
	re: RegExp;
}

/**
 * High-signal credential shapes. False positives are cheap here (a redaction
 * marker in a memory note), false negatives are expensive.
 */
const SECRET_RULES: SecretRule[] = [
	{ name: "aws-access-key", re: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|ANPA|AROA)[0-9A-Z]{16}\b/g },
	{ name: "github-token", re: /\b(?:gh[pousr]|ghu)_[0-9A-Za-z_]{20,}\b/g },
	{ name: "github-fine-grained", re: /\bgithub_pat_[0-9A-Za-z_]{20,}\b/g },
	{ name: "slack-token", re: /\bxox[aprsbe]-[0-9A-Za-z-]{10,}\b/g },
	{ name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	{ name: "deepseek-key", re: /\bsk-[0-9a-f]{32,}\b/g },
	{ name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
	{ name: "stripe-key", re: /\b[sp]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
	{ name: "npm-token", re: /\bnpm_[0-9A-Za-z]{36}\b/g },
	{ name: "sendgrid-key", re: /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}\b/g },
	{ name: "telegram-bot-token", re: /\b\d{8,10}:AA[0-9A-Za-z_-]{30,}\b/g },
	{ name: "jwt", re: /\beyJ[0-9A-Za-z_-]{6,}\.eyJ[0-9A-Za-z_-]{6,}\.[0-9A-Za-z_-]{8,}\b/g },
	{ name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
	{ name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
	{
		name: "credential-assignment",
		re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token)\b\s*[:=]\s*["'][^"'\s]{6,}["']|\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*(?!\s*$)[^\s"',;]{6,}/gi,
	},
];

/**
 * Replace credential-looking spans. `mode`:
 *  - "block": report so the caller refuses the write (default).
 *  - "mask":  replace the value with [REDACTED:<name>] and keep the text.
 *  - "off":   no inspection (documented as unsafe; kept for forensics work).
 */
export function redactSecrets(text: string, mode: "block" | "mask" | "off"): SanitizeResult {
	const hits: string[] = [];
	if (mode === "off") return { text, hits, suspect: false, secretHits: [], defangHits: [], defanged: false };
	let out = text;
	for (const rule of SECRET_RULES) {
		rule.re.lastIndex = 0;
		if (!rule.re.test(out)) continue;
		rule.re.lastIndex = 0;
		hits.push(rule.name);
		if (mode === "mask") {
			rule.re.lastIndex = 0;
			out = out.replace(rule.re, `[REDACTED:${rule.name}]`);
		}
	}
	return { text: out, hits, suspect: hits.length > 0, secretHits: hits, defangHits: [], defanged: false };
}

const TAG_BLOCKLIST = new Set([
	"system",
	"assistant",
	"user",
	"instruction",
	"instructions",
	"thinking",
	"antml",
	"tool",
	"tools",
	"global_memory",
	"global_memory_hits",
	"pi",
	"skill",
	"skills",
	"prompt",
]);

const INJECTION_RULES: { name: string; re: RegExp }[] = [
	{
		name: "override-instructions",
		re: /\b(?:ignore|disregard|discard|forget|skip|override|bypass)\b[\s\S]{0,60}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the|system)\b[\s\S]{0,40}?\b(?:instructions?|prompts?|rules?|directives?|guidelines?|context)\b/gi,
	},
	{ name: "role-claim", re: /^\s*(?:system|assistant|developer|tool)\s*:/gim },
	{ name: "persona-shift", re: /\byou\s+are\s+now\b|\bact\s+as\s+(?:a\s+)?(?:system|developer|root)\b|\bpretend\s+you\s+(?:are|have)\b/gi },
	{ name: "new-instructions", re: /\b(?:new|updated|real|actual)\s+(?:system\s+)?instructions?\s*[:=-]/gi },
	{
		name: "secret-exfiltration",
		re: /\b(?:reveal|print|show|output|dump|exfiltrate|send|paste)\b[\s\S]{0,40}?\b(?:system\s+prompt|api\s+key|api\s+keys|credentials?|secrets?|tokens?|\.env)\b/gi,
	},
	{ name: "exfil-channel", re: /\b(?:curl|wget|fetch|Invoke-WebRequest|nc|netcat)\b[\s\S]{0,40}?\b(?:\$|\{)?\s*(?:API_KEY|TOKEN|SECRET|PASSWORD)/gi },
	{ name: "instruction-tag", re: /<\/?(?:instructions?|system_prompt|system-prompt)\b[^>]*>/gi },
];

/** Neutralize a tag only when its name is in the blocklist, so code stays readable. */
function neutralizeTags(text: string): { text: string; matched: boolean } {
	let matched = false;
	const out = String(text ?? "").replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]*)\b[^>]*>/g, (whole, name: string) => {
		if (!TAG_BLOCKLIST.has(String(name).toLowerCase())) return whole;
		matched = true;
		return `[tag:${name}]`;
	});
	return { text: out, matched };
}

/**
 * Replace instruction-shaped content with a visible marker. The marker is
 * deliberate: a later reader (human or model) sees that content was removed
 * rather than silently trusting a rewritten memory.
 */
export function defangInjection(text: string): SanitizeResult {
	let out = String(text ?? "");
	const hits: string[] = [];
	for (const rule of INJECTION_RULES) {
		rule.re.lastIndex = 0;
		if (!rule.re.test(out)) continue;
		rule.re.lastIndex = 0;
		hits.push(rule.name);
		out = out.replace(rule.re, `[defanged:${rule.name}]`);
	}
	const tags = neutralizeTags(out);
	out = tags.text;
	if (tags.matched) hits.push("blocked-tag");
	return { text: out, hits, suspect: hits.length > 0, secretHits: [], defangHits: hits, defanged: hits.length > 0 };
}

/** Full pipeline for anything the store will persist. */
export function harden(text: string, redactMode: "block" | "mask" | "off"): SanitizeResult {
	const stripped = stripControlChars(text);
	const red = redactSecrets(stripped, redactMode);
	const def = defangInjection(red.text);
	return {
		text: def.text,
		hits: [...red.secretHits, ...def.defangHits],
		suspect: red.secretHits.length > 0 || def.defangHits.some((h) => h !== "blocked-tag"),
		secretHits: red.secretHits,
		defangHits: def.defangHits,
		defanged: def.defangHits.length > 0,
	};
}

/** Same pipeline, but for text leaving the store on its way into a prompt. */
export function hardenForInjection(text: string): string {
	const stripped = stripControlChars(text);
	const red = redactSecrets(stripped, "mask");
	const def = defangInjection(red.text);
	return def.text;
}

/** Identifiers must be safe to use as file names, CLI arguments, and index keys. */
export function sanitizeIdToken(text: string, max = 48): string {
	const s = String(text ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^\.+/, "")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return s.slice(0, max);
}

export function isSafeRelativePath(rel: string): boolean {
	const s = String(rel ?? "");
	if (!s) return false;
	if (s.includes("\0")) return false;
	if (/^[a-zA-Z]:/.test(s)) return false;
	if (s.startsWith("/") || s.startsWith("\\")) return false;
	const parts = s.split(/[\\/]+/);
	for (const p of parts) {
		if (!p || p === "." || p === "..") return false;
	}
	return true;
}
