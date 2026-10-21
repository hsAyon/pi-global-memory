/**
 * Record serialization, validation, and ranking.
 *
 * On-disk format: YAML-subset frontmatter (scalars and one-line string arrays,
 * which we always emit as JSON so parsing is unambiguous) plus fixed markdown
 * sections. Chosen because it is greppable by a human, diffable in git, and
 * readable by any other agent without this extension.
 */

import type { GmEntry, GmEvidence, GmKind, GmPrivacyMode, GmRecord, GmScope, GmSketchyMode, GmStatus } from "./types.ts";
import { EVIDENCE_TYPES, KINDS, STATUSES } from "./types.ts";
import * as nodePath from "node:path";
import { assessExplorationDiary, assessRuntimeNoise, assessTrust, assessUsefulness, maskPrivacy, qualityScore, usefulnessVerdict } from "./trust.ts";
import { harden, isSafeRelativePath, sanitizeIdToken } from "./sanitize.ts";
import {
	clamp,
	displayPath,
	hash32,
	isAbsoluteish,
	normWs,
	nowIso,
	slugify,
	tokenSimilarity,
	truncate,
	uniqueStrings,
	expandHome,
	pathContains,
} from "./util.ts";

const LIMITS = {
	title: 90,
	statement: 700,
	why: 300,
	how: 700,
	avoid: 300,
	notes: 400,
	tags: 12,
	cues: 16,
	evidence: 8,
	tagChars: 40,
	cueChars: 60,
	evidenceRef: 300,
	evidenceNote: 120,
	scopePath: 300,
};

const BODY_HEADINGS: { key: "Statement" | "Why" | "How" | "Avoid" | "Notes"; field: "statement" | "why" | "how" | "avoid" | "notes" }[] = [
	{ key: "Statement", field: "statement" },
	{ key: "Why", field: "why" },
	{ key: "How", field: "how" },
	{ key: "Avoid", field: "avoid" },
	{ key: "Notes", field: "notes" },
];

export interface Draft {
	id?: string;
	kind?: string;
	category?: string;
	title?: string;
	statement?: string;
	why?: string;
	how?: string;
	avoid?: string;
	notes?: string;
	tags?: unknown;
	cues?: unknown;
	confidence?: number;
	status?: string;
	scope?: GmScope;
	supersedes?: unknown;
	evidence?: unknown;
}

export interface ValidationResult {
	ok: boolean;
	record?: GmRecord;
	problems: string[];
	redacted: string[];
	suspect: boolean;
	/** Explanatory notes from the privacy/sketchy gates (non-blocking). */
	notes: string[];
	quality: number;
	qualityReasons: string[];
	/** "is it worth keeping" rubric, decided at write time. */
	usefulness: number;
	usefulnessReasons: string[];
}

function newId(title: string, kind: string): string {
	const base = slugify(title, 26) || slugify(kind, 10) || "rec";
	return `gm-${base}-${hash32(`${base}|${kind}|${nowIso()}|${Math.random()}`).slice(0, 4)}`;
}

function parseScalar(raw: string): string {
	const v = raw.trim();
	if (v.startsWith('"')) {
		try {
			const parsed = JSON.parse(v);
			return typeof parsed === "string" ? parsed : "";
		} catch {
			return v.slice(1, v.endsWith('"') ? -1 : undefined);
		}
	}
	return v;
}

function parseStringArray(raw: string): string[] {
	const v = raw.trim();
	if (v === "") return [];
	if (v.startsWith("[")) {
		try {
			const parsed = JSON.parse(v);
			if (Array.isArray(parsed)) return uniqueStrings(parsed, 64).map((s) => String(s));
		} catch {
			/* fall through to lenient split */
		}
		const inner = v.replace(/^\[/, "").replace(/\]$/, "");
		return uniqueStrings(
			inner
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter((s) => s.length > 0),
			64,
		);
	}
	return uniqueStrings([v], 1);
}

/** Split frontmatter from body. Returns undefined when the fence is malformed. */
function splitFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | undefined {
	const text = String(content ?? "").replace(/^\uFEFF/, "");
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return undefined;
	const meta: Record<string, unknown> = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1);
		if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) continue;
		meta[key] = raw.trim().startsWith("[") ? parseStringArray(raw) : parseScalar(raw);
	}
	return { meta, body: m[2] ?? "" };
}

function splitBody(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	let current = "";
	const buf: string[] = [];
	const flush = () => {
		if (current) out[current] = buf.join("\n").trim();
		buf.length = 0;
	};
	for (const line of String(body ?? "").split(/\r?\n/)) {
		const m = /^##\s+([A-Za-z ]+)\s*$/.exec(line);
		if (m) {
			flush();
			current = m[1].trim();
			continue;
		}
		buf.push(line);
	}
	flush();
	return out;
}

function encodeEvidence(e: GmEvidence): string {
	const ref = truncate(normWs(e.ref), LIMITS.evidenceRef);
	const note = e.note ? `|${truncate(normWs(e.note), LIMITS.evidenceNote)}` : "";
	return `${e.type}|${ref}${note}`;
}

function decodeEvidence(values: string[]): GmEvidence[] {
	const out: GmEvidence[] = [];
	for (const v of values) {
		const parts = String(v ?? "").split("|");
		const type = String(parts[0] ?? "").trim();
		const ref = String(parts[1] ?? "").trim();
		if (!ref) continue;
		out.push({
			type: (EVIDENCE_TYPES as readonly string[]).includes(type) ? (type as GmEvidence["type"]) : "artifact",
			ref,
			note: parts.slice(2).join("|").trim() || undefined,
		});
	}
	return out;
}

export function serializeRecord(r: GmRecord): string {
	const lines: string[] = ["---"];
	lines.push(`id: ${r.id}`);
	lines.push(`kind: ${r.kind}`);
	lines.push(`category: ${r.category}`);
	lines.push(`title: ${JSON.stringify(r.title)}`);
	lines.push(`tags: ${JSON.stringify(r.tags)}`);
	lines.push(`cues: ${JSON.stringify(r.cues)}`);
	lines.push(`confidence: ${r.confidence}`);
	lines.push(`status: ${r.status}`);
	lines.push(`scope: ${r.scope.kind}`);
	lines.push(`scopePath: ${JSON.stringify(r.scope.path ?? "")}`);
	lines.push(`supersedes: ${JSON.stringify(r.supersedes)}`);
	lines.push(`supersededBy: ${JSON.stringify(r.supersededBy ?? "")}`);
	lines.push(`evidence: ${JSON.stringify(r.evidence.map(encodeEvidence))}`);
	lines.push(`flags: ${JSON.stringify(r.flags)}`);
	lines.push(`contradicts: ${JSON.stringify(r.contradicts ?? [])}`);
	lines.push(`hits: ${r.stats.hits}`);
	lines.push(`created: ${r.stats.created}`);
	lines.push(`updated: ${r.stats.updated}`);
	lines.push(`lastUsed: ${JSON.stringify(r.stats.lastUsed ?? "")}`);
	lines.push(`lastVerified: ${JSON.stringify(r.stats.lastVerified ?? "")}`);
	lines.push(`disputedAt: ${JSON.stringify(r.stats.disputedAt ?? "")}`);
	lines.push(`verifiedCount: ${r.stats.verifiedCount ?? 0}`);
	lines.push("---", "");
	for (const h of BODY_HEADINGS) {
		const value = r[h.field];
		if (!value) continue;
		lines.push(`## ${h.key}`, value.trim(), "");
	}
	return `${lines.join("\n")}\n`.replace(/\n{4,}/g, "\n\n\n");
}

/** Parse one file. Returns a problem string when the record must be skipped. */
export function parseRecordFile(content: string, file: string): { record?: GmRecord; problem?: string } {
	const split = splitFrontmatter(content);
	if (!split) return { problem: "no frontmatter fence" };
	const meta = split.meta;
	const body = splitBody(split.body);
	const id = sanitizeIdToken(String(meta.id ?? ""), 64);
	if (!id || !id.startsWith("gm-")) return { problem: `invalid id ${String(meta.id ?? "")}` };
	const kind = String(meta.kind ?? "");
	if (!(KINDS as readonly string[]).includes(kind)) return { problem: `unknown kind ${kind}` };
	const statusRaw = String(meta.status ?? "active");
	const status = (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as GmStatus) : "active";
	const category = sanitizeIdToken(String(meta.category ?? ""), 32) || "misc";
	const title = truncate(normWs(String(meta.title ?? "")), LIMITS.title);
	const statement = String(body.Statement ?? "").trim();
	if (!title) return { problem: "missing title" };
	if (!statement) return { problem: "missing Statement section" };
	const scopeKind = String(meta.scope ?? "global") === "project" ? "project" : "global";
	const scopePath = String(meta.scopePath ?? "").trim();
	if (scopeKind === "project" && !scopePath) return { problem: "project scope without scopePath" };

	const record: GmRecord = {
		id,
		kind: kind as GmKind,
		category,
		title,
		statement,
		why: String(body.Why ?? "").trim() || undefined,
		how: String(body.How ?? "").trim() || undefined,
		avoid: String(body.Avoid ?? "").trim() || undefined,
		notes: String(body.Notes ?? "").trim() || undefined,
		tags: uniqueStrings(meta.tags ?? [], LIMITS.tags).map((t) => truncate(t, LIMITS.tagChars)),
		cues: uniqueStrings(meta.cues ?? [], LIMITS.cues).map((c) => truncate(c, LIMITS.cueChars)),
		confidence: clamp(parseInt(String(meta.confidence ?? "1"), 10) || 1, 1, 3),
		status,
		scope: { kind: scopeKind, path: scopePath || undefined },
		supersedes: uniqueStrings(meta.supersedes ?? [], 8).map((s) => sanitizeIdToken(s, 64)).filter(Boolean),
		supersededBy: String(meta.supersededBy ?? "").trim() || undefined,
		evidence: decodeEvidence(parseStringArraySafe(meta.evidence)),
		contradicts: uniqueStrings(meta.contradicts ?? [], 8).map((s) => sanitizeIdToken(s, 64)).filter(Boolean),
		stats: {
			hits: Math.max(0, parseInt(String(meta.hits ?? "0"), 10) || 0),
			created: String(meta.created ?? nowIso()),
			updated: String(meta.updated ?? nowIso()),
			lastUsed: String(meta.lastUsed ?? "").trim() || undefined,
			lastVerified: String(meta.lastVerified ?? "").trim() || undefined,
			disputedAt: String(meta.disputedAt ?? "").trim() || undefined,
			verifiedCount: Math.max(0, parseInt(String(meta.verifiedCount ?? "0"), 10) || 0),
		},
		flags: uniqueStrings(meta.flags ?? [], 8).map((f) => sanitizeIdToken(f, 32)).filter(Boolean),
		file,
	};
	return { record };
}

function parseStringArraySafe(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x ?? ""));
	if (typeof v === "string") return parseStringArray(v);
	return [];
}

export interface NormalizeOptions {
	maxRecordChars: number;
	redact: "block" | "mask" | "off";
	requireEvidence: boolean;
	restrictProjectPaths: boolean;
	privacy: GmPrivacyMode;
	sketchy: GmSketchyMode;
	minQuality: number;
	/** Usefulness floor: a draft scoring below this is discarded, not stored. */
	minUsefulness: number;
	cwd: string;
	existingIds: Set<string>;
	/** Id being updated (its own file is allowed). */
	selfId?: string;
}

/** Validate and normalize a draft into a storable record. */
export function normalizeDraft(draft: Draft, opts: NormalizeOptions): ValidationResult {
	const problems: string[] = [];
	const redacted: string[] = [];
	const notesOut: string[] = [];
	const flagsOut: string[] = [];
	const defangedOut: string[] = [];
	let suspect = false;

	const hard = (value: string): string => {
		const res = harden(value, opts.redact);
		if (res.secretHits.length > 0) redacted.push(...res.secretHits);
		if (res.defanged) {
			suspect = true;
			for (const h of res.defangHits) if (!defangedOut.includes(h)) defangedOut.push(h);
		}
		return res.text;
	};

	const kindRaw = normWs(String(draft.kind ?? "")).toLowerCase();
	const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as GmKind) : undefined;
	if (!kind) problems.push(`kind must be one of: ${KINDS.join(", ")}`);

	const category = sanitizeIdToken(normWs(String(draft.category ?? "")).toLowerCase(), 32) || slugify(kind ?? "misc", 16) || "misc";

	const title = truncate(normWs(hard(String(draft.title ?? ""))), LIMITS.title);
	if (!title) problems.push("title is required (one line)");
	if (opts.minQuality > 0 && /^(fix|note|update|info|misc|test)\b/i.test(title)) problems.push("title is too generic; state the actual learning");

	const statement = truncate(hard(String(draft.statement ?? "")).replace(/\s+/g, " "), LIMITS.statement);
	if (statement.length < 12) problems.push("statement must state the learning in one concrete sentence (>= 12 chars)");

	const why = truncate(hard(String(draft.why ?? "")).replace(/\s+/g, " "), LIMITS.why);
	const how = truncate(hard(String(draft.how ?? "")).replace(/\s+/g, " "), LIMITS.how);
	const avoid = truncate(hard(String(draft.avoid ?? "")).replace(/\s+/g, " "), LIMITS.avoid);
	const notes = truncate(hard(String(draft.notes ?? "")), LIMITS.notes);

	const tags = uniqueStrings(draft.tags ?? [], LIMITS.tags)
		.map((t) => sanitizeIdToken(t, LIMITS.tagChars).replace(/^-+|-+$/g, ""))
		.filter(Boolean);
	const cues = uniqueStrings(draft.cues ?? [], LIMITS.cues)
		.map((c) => truncate(normWs(c), LIMITS.cueChars))
		.filter((c) => c.length >= 2);

	const conf = clamp(parseInt(String(draft.confidence ?? "2"), 10) || 2, 1, 3);

	const rawEvidence = Array.isArray(draft.evidence) ? draft.evidence : draft.evidence ? [draft.evidence] : [];
	const evidence: GmEvidence[] = [];
	for (const e of rawEvidence.slice(0, LIMITS.evidence)) {
		if (typeof e === "string") {
			const ref = truncate(normWs(e), LIMITS.evidenceRef);
			if (ref) evidence.push({ type: guessEvidenceType(ref), ref });
			continue;
		}
		if (e && typeof e === "object") {
			const obj = e as Record<string, unknown>;
			const ref = truncate(normWs(String(obj.ref ?? "")), LIMITS.evidenceRef);
			if (!ref) continue;
			const type = String(obj.type ?? "").trim().toLowerCase();
			evidence.push({
				type: (EVIDENCE_TYPES as readonly string[]).includes(type) ? (obj.type as GmEvidence["type"]) : guessEvidenceType(ref),
				ref,
				note: obj.note ? truncate(normWs(String(obj.note)), LIMITS.evidenceNote) : undefined,
			});
		}
	}
	if (opts.requireEvidence && evidence.length === 0) {
		problems.push(
			"evidence is required: name the command, file path, session, or URL that proves this (facts over guesses). Use kind=fact only for something you verified in this session",
		);
	}

	const scopeRaw = draft.scope && typeof draft.scope === "object" ? draft.scope : { kind: "global" };
	let scope: GmScope = { kind: scopeRaw.kind === "project" ? "project" : "global" };
	if (scope.kind === "project") {
		const p = String(scopeRaw.path ?? "").trim();
		const abs = p ? expandHome(p) : opts.cwd;
		if (!isAbsoluteish(abs)) {
			problems.push("scope.path must be absolute (or omit it to use the current working directory)");
		} else {
			const norm = displayPath(normalizeAbs(abs));
			if (norm.length > LIMITS.scopePath) problems.push("scope.path too long");
			if (opts.restrictProjectPaths && !pathContains(opts.cwd, norm) && !pathContains(norm, opts.cwd)) {
				problems.push(`scope.path must be the current working directory or one of its ancestors/children (cwd: ${displayPath(opts.cwd)})`);
			}
			scope = { kind: "project", path: norm };
		}
	}

	const statusRaw = normWs(String(draft.status ?? "active")).toLowerCase();
	const status = (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as GmStatus) : "active";
	const supersedes = uniqueStrings(draft.supersedes ?? [], 8)
		.map((s) => sanitizeIdToken(s, 64))
		.filter((s) => s && s !== (draft.id ?? ""));

	for (const s of supersedes) {
		if (!opts.existingIds.has(s)) problems.push(`supersedes: unknown record id ${s}`);
	}

	const bodyChars = statement.length + why.length + how.length + avoid.length + notes.length;
	if (bodyChars > opts.maxRecordChars) {
		problems.push(`body is ${bodyChars} chars; keep it under ${opts.maxRecordChars} (be concise: the whole point is faster recall)`);
	}

	// Privacy and reliability posture. Private by default: personal identifiers and
	// confidential-sounding text are refused unless the operator relaxes the gate.
	let fTitle = title;
	let fStatement = statement;
	let fWhy = why;
	let fHow = how;
	let fAvoid = avoid;
	let fNotes = notes;
	const trust = assessTrust({ title: fTitle, statement: fStatement, why: fWhy, how: fHow, avoid: fAvoid, notes: fNotes }, opts.privacy, opts.sketchy);
	for (const b of trust.block) problems.push(b);
	// Knowledge, not a crash log: a draft about the model, pi, or the runtime failing is
	// refused, because such a record teaches the next session to work around a transient
	// fault and nobody can re-verify it. The durable rule it implies is still welcome.
	const runtime = assessRuntimeNoise([fTitle, fStatement, fWhy, fHow, fAvoid, fNotes]);
	if (runtime.noise) {
		problems.push(`refused as an agent/runtime fault report: ${runtime.why}. Record the durable rule instead - the flag, path, setting, or command that actually explains the behaviour, with the evidence you saw. If the fault is a real bug in pi or the model runner, report it upstream rather than storing it.`);
	}
	// The other class-level veto: an exploration diary. A missed search paired with one that worked is
	// worth nothing unless something actually changed, and auto-capture used to file four such "fixes"
	// from a single scratch session.
	const diary = assessExplorationDiary({ title: fTitle, statement: fStatement, why: fWhy, how: fHow, avoid: fAvoid });
	if (diary.diary) {
		problems.push(`refused as an exploration diary: ${diary.why}. If the miss did have a cause - a file that must be generated, a path that moved, a package that must be installed - name that change in how, with the command that fixes it.`);
	}
	// A draft carrying an unrenderable value is a logging artefact. Six records once reached the store
	// whose "failed" and "worked" text was literally `[object Object]`, because the call arguments were
	// stringified instead of read. Nothing about them is re-checkable.
	if (/\[object (?:Object|Map|Set|Array|Promise)\]/.test([fTitle, fStatement, fWhy, fHow, fAvoid, fNotes].join(" "))) {
		problems.push("refused because the draft carries an unrenderable value ([object Object]): what it describes did not survive being logged. Re-read the source or re-run the command and write the text you actually saw.");
	}
	if (opts.privacy === "standard") {
		const masked = maskPrivacy([fTitle, fStatement, fWhy, fHow, fAvoid, fNotes].join("\u0001"));
		if (masked.changed.length > 0) {
			const parts = masked.text.split("\u0001");
			fTitle = parts[0] ?? fTitle;
			fStatement = parts[1] ?? fStatement;
			fWhy = parts[2] ?? fWhy;
			fHow = parts[3] ?? fHow;
			fAvoid = parts[4] ?? fAvoid;
			fNotes = parts[5] ?? fNotes;
			notesOut.push(`masked personal identifiers: ${masked.changed.join(", ")}`);
		}
	}
	notesOut.push(...trust.notes);
	for (const f of trust.flags) if (!flagsOut.includes(f)) flagsOut.push(f);
	if (defangedOut.length > 0) {
		if (!flagsOut.includes("injection_suspect")) flagsOut.push("injection_suspect");
		notesOut.push(`instruction-shaped text was defanged (${defangedOut.join(", ")}) and the record is flagged for review`);
	}
	const confFinal = trust.forceConfidence !== undefined ? Math.min(conf, trust.forceConfidence) : conf;

	const quality = qualityScore({
		title: fTitle,
		statement: fStatement,
		cues,
		tags,
		evidenceCount: evidence.length,
		confidence: confFinal,
	});
	if (quality.score < opts.minQuality) {
		problems.push(
			`reliability score ${quality.score}/10 is below minQuality ${opts.minQuality}. Score parts: ${quality.reasons.join(
				"; ",
			)}. Raise it by naming the exact command/file/error, adding a retrieval cue, or citing a second source. Set minQuality 0 to allow anyway`,
		);
	}

	// Quality asks "is this well-formed and reliable?" Usefulness asks the question that decides
	// whether the store should carry it at all: will it change what a future session does? An
	// accurate, well-cited generality is still clutter, and clutter is the cost this package exists
	// to avoid, so a thin draft is discarded here rather than stored and pruned later.
	const usefulness = assessUsefulness({
		title: fTitle,
		statement: fStatement,
		why: fWhy,
		how: fHow,
		avoid: fAvoid,
		notes: fNotes,
		cues,
		tags,
		category,
		kind: kind ?? "fact",
		evidenceTypes: evidence.map((e) => e.type),
	});
	const verdict = usefulnessVerdict(usefulness.score, opts.minUsefulness);
	if (verdict === "discard") {
		problems.push(
			`discarded as not useful enough to keep: score ${usefulness.score}/10 is below minUsefulness ${opts.minUsefulness}. ${usefulness.reasons.join("; ")}. Discarding is the right outcome for textbook facts, vague advice, and session trivia - if the record really is worth a slot, name the flag/path/command or error text it teaches, and what was learned the hard way.`,
		);
	} else if (verdict === "flag") {
		if (!flagsOut.includes("low-value")) flagsOut.push("low-value");
		notesOut.push(`stored but flagged low-value (usefulness ${usefulness.score}/10): ${usefulness.reasons[usefulness.reasons.length - 1] ?? ""}; /memory audit retires flagged records that never earn a lookup`);
	}

	let id = sanitizeIdToken(String(draft.id ?? ""), 64);
	if (id && !id.startsWith("gm-")) id = `gm-${id}`.slice(0, 64);
	if (id && opts.existingIds.has(id) && id !== opts.selfId) problems.push(`id ${id} already exists`);
	if (!id) id = newId(title, kind ?? "misc");

	const record: GmRecord = {
		id,
		kind: kind ?? "fact",
		category,
		title: fTitle,
		statement: fStatement,
		why: fWhy || undefined,
		how: fHow || undefined,
		avoid: fAvoid || undefined,
		notes: fNotes || undefined,
		tags,
		cues,
		confidence: confFinal,
		status,
		scope,
		supersedes,
		evidence,
		contradicts: [],
		stats: { hits: 0, created: nowIso(), updated: nowIso(), verifiedCount: 0 },
		flags: flagsOut,
	};

	if (problems.length === 0 && opts.redact === "block" && redacted.length > 0) {
		problems.push(`credential-looking content blocked (${[...new Set(redacted)].join(", ")}); redact it and retry`);
	}

	return {
		ok: problems.length === 0 && !!record,
		record: problems.length === 0 ? record : undefined,
		problems,
		redacted: [...new Set(redacted)],
		suspect,
		notes: notesOut,
		quality: quality.score,
		qualityReasons: quality.reasons,
		usefulness: usefulness.score,
		usefulnessReasons: usefulness.reasons,
	};
}

/** Absolute, separator-normalized, without a trailing slash. */
function normalizeAbs(p: string): string {
	const expanded = expandHome(p);
	// path.resolve keeps the current drive for drive-letter inputs on Windows.
	const resolved = /^[a-zA-Z]:[\\/]/.test(expanded) ? expanded : nodePath.resolve(expanded);
	return resolved.replace(/[\\/]+$/, "");
}

function guessEvidenceType(ref: string): GmEvidence["type"] {
	if (/^https?:\/\//i.test(ref)) return "url";
	if (/^(\/|[a-zA-Z]:[\\/]|\.\/|\.\.\/|~\/)/.test(ref)) return "file";
	if (/^(gm-|session:|sess)/i.test(ref)) return "session";
	if (/(^|\s)(npx|npm|git|docker|make|py|python|node|pnpm|cargo|go|curl|ketch|pi)\s/.test(ref) || /^(bash|sh|pwsh|cmd):/i.test(ref)) return "command";
	return "artifact";
}

export function recordToEntry(r: GmRecord, score?: number): GmEntry {
	return {
		id: r.id,
		kind: r.kind,
		category: r.category,
		title: r.title,
		confidence: r.confidence,
		status: r.status,
		hits: r.stats.hits,
		updated: r.stats.updated,
		scope: r.scope,
		tags: r.tags,
		disputed: r.flags.includes("disputed"),
		flags: r.flags,
		score,
		file: r.file ? displayPath(r.file) : undefined,
	};
}

/** Value used for catalog selection, ranking, and pruning. Deterministic and explainable. */
export function valueScore(r: GmRecord, now = Date.now()): number {
	const ageDays = Math.max(0, (now - Date.parse(r.stats.lastVerified || r.stats.updated || r.stats.created)) / 86_400_000);
	const hits = Math.log1p(r.stats.hits) * 1.6;
	const conf = r.confidence * 1.5;
	const tentative = r.confidence <= 1 ? -1.2 : 0;
	const decay = Math.min(2, (ageDays / 365) * 2);
	const auto = r.flags.includes("auto") ? -0.4 : 0;
	// A disputed record is treated as unreliable until re-verified, whatever its
	// old confidence was. Accuracy outranks volume.
	const disputed = r.flags.includes("disputed") ? -4 : 0;
	const verified = Math.min(1.5, (r.stats.verifiedCount ?? 0) * 0.5);
	return conf + hits + tentative - decay + auto + verified + disputed;
}

export function similarity(a: GmRecord, b: GmRecord): number {
	const at = `${a.title} ${a.statement} ${a.how ?? ""}`;
	const bt = `${b.title} ${b.statement} ${b.how ?? ""}`;
	const base = tokenSimilarity(at, bt);
	const sameCat = a.category === b.category ? 0.06 : 0;
	const tagOverlap = a.tags.filter((t) => b.tags.includes(t)).length;
	return clamp(base + sameCat + Math.min(0.1, tagOverlap * 0.03), 0, 1);
}

export function scopeMatches(r: GmRecord, cwd: string): boolean {
	if (r.scope.kind !== "project" || !r.scope.path) return true;
	return pathContains(r.scope.path, cwd);
}

export function recordFileName(r: GmRecord): string {
	const cat = isSafeRelativePath(r.category) ? r.category : "misc";
	return `${cat}/${r.id}.md`;
}
