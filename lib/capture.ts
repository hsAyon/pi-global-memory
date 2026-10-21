/**
 * Learning capture. Two paths, one data model:
 *
 *  - live: `observe()` is fed each tool_result during a run, so failures and the
 *    later success that fixed them are seen in order, with their arguments.
 *  - retrospective: `mineBranch()` walks the session branch, which is what
 *    `/memory capture` uses (and what survives a reload).
 *
 * Discipline: capture states what happened, not why we think it happened. The
 * causal story is what hallucination feeds on, so candidates carry the failing
 * text, the succeeding text, and an instruction to verify before generalizing.
 */

import type { GmEvidence, Signal } from "./types.ts";
import type { Draft } from "./record.ts";
import { hash32, normWs, slugify, truncate } from "./util.ts";
import { hardenForInjection } from "./sanitize.ts";

/** Tools whose failures are worth remembering. Everything else is noise. */
const WATCHED = new Set(["bash", "powershell", "edit", "write"]);

const ABORT_MARKERS = ["aborted", "cancelled", "canceled", "interrupted", "user requested stop"];

/**
 * Which failures are worth learning from, and which are only the agent or its runtime
 * misbehaving. A record about a rejected tool call, an abort, or a context overflow teaches
 * the next session to route around a transient fault instead of teaching anything about the
 * user's environment - and it makes the store smell like a crash log. So these never reach
 * the ledger, let alone the store.
 *
 * The harness phrases are not guesses: they are the strings pi 1.3.0 emits
 * (`Tool "<name>" not found` and `Invalid arguments for tool "<name>": ...` from tool
 * validation, `Request was aborted`, `Compaction cancelled`, `Compaction produced no summary
 * ...`, and the context-overflow patterns pi matches provider errors against). Recorded in
 * docs/NOTES.md with the file they came from.
 */
export type NoiseClass = "empty-argument" | "no-detail" | "aborted" | "harness" | "model-call" | "runtime";

const NOISE_PATTERNS: { re: RegExp; cls: NoiseClass; why: string }[] = [
	{ re: /^tool "[^"]+" not found$/i, cls: "harness", why: "pi had no such tool, so the command never ran" },
	{ re: /^tool "[^"]+" failed$/i, cls: "harness", why: "the tool implementation raised; that is a pi bug report, not knowledge" },
	{ re: /invalid arguments for tool/i, cls: "model-call", why: "argument validation rejected the call before it ran" },
	{
		re: /(must have required propert|must be (?:a )?(?:string|number|integer|boolean|array|object)|must match|expected (?:a )?(?:string|number|integer)|unterminated json|invalid json|json parse)/i,
		cls: "model-call",
		why: "schema or JSON error in the call itself",
	},
	{ re: /^request was aborted$/i, cls: "aborted", why: "the run was stopped" },
	{ re: /(compaction cancelled|compaction produced no summary)/i, cls: "runtime", why: "session management, not the task" },
	{ re: /(prompt (?:is )?too long|exceeds the context window|maximum context length|context window)/i, cls: "runtime", why: "the model ran out of context" },
	{ re: /(rate limit reached|too many requests|overloaded_?error|service unavailable)/i, cls: "runtime", why: "provider or transport trouble" },
	{
		re: /(tool call (?:was )?(?:rejected|failed)|stack trace|traceback \(most recent call last\)|panic: |segfault|oom killer)/i,
		cls: "harness",
		why: "a runtime fault, not a fact about this machine",
	},
];

/** An edit whose oldText simply did not match is a model slip, not an environment fact. */
const EDIT_MISS = /(old ?text|oldtext)[^\n]{0,48}(?:not found|no match|did not match|not present)|(?:no match|did not match)[^\n]{0,32}old ?text/i;

/**
 * Classify one errored observation. `null` means "this is a real failure in the user's
 * environment; it may be worth recording". Everything else is dropped with a reason, and the
 * counts are surfaced in /memory review so the exclusion is visible rather than silent.
 */
export function failureNoise(o: ToolObservation): { cls: NoiseClass | null; why: string } {
	const arg = normWs(primaryArg(o.toolName, o.input));
	if (arg === "") return { cls: "empty-argument", why: "the call carried no usable argument, so there is nothing to learn" };
	const text = normWs(o.text ?? "");
	if (text === "") return { cls: "no-detail", why: "the failure came back with no message" };
	// Specific phrases first: "Compaction cancelled" is a runtime fault, not merely an abort,
	// and the class shown to the user should be the useful one.
	for (const { re, cls, why } of NOISE_PATTERNS) if (re.test(text)) return { cls, why };
	if (looksAborted(text)) return { cls: "aborted", why: "the run was stopped by the user or the harness" };
	if ((o.toolName === "edit" || o.toolName === "write") && EDIT_MISS.test(text)) {
		return { cls: "model-call", why: "the edit simply did not match the file: re-read and retry, not a lesson about the project" };
	}
	return { cls: null, why: "" };
}

export interface ToolObservation {
	toolName: string;
	input: Record<string, unknown>;
	isError: boolean;
	text: string;
	atMs: number;
	callId?: string;
}

export interface Candidate {
	fingerprint: string;
	category: string;
	toolName: string;
	failing: string;
	succeeding: string | null;
	errorExcerpt: string;
	failures: number;
	sessions: string[];
	firstAt: string;
	lastAt: string;
	/** Only same-tool pairings where the arguments changed are confident enough to auto-save. */
	provenFix: boolean;
}

function primaryArg(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" || toolName === "powershell") return String(input.command ?? "");
	if (toolName === "edit") return `${String(input.path ?? "")}|${truncate(String(input.edits ?? input.oldText ?? ""), 80)}`;
	if (toolName === "write") return String(input.path ?? "");
	if (toolName === "read") return String(input.path ?? "");
	if (toolName === "grep" || toolName === "find") return String(input.pattern ?? "");
	return JSON.stringify(input).slice(0, 120);
}

/** Whitespace and quoting noise removed so retries of the same call collide. */
export function normalizeCall(toolName: string, input: Record<string, unknown>): string {
	const arg = normWs(primaryArg(toolName, input));
	return `${toolName}:${arg.toLowerCase()}`;
}

/** Fingerprint = the call identity, ignoring the parts of it that changed. */
export function callFingerprint(toolName: string, input: Record<string, unknown>): string {
	return hash32(normalizeCall(toolName, input));
}

/** Coarse intent: the verb of the call. `npm run build` -> `npm run`. */
export function intentKey(toolName: string, input: Record<string, unknown>): string {
	const arg = normWs(primaryArg(toolName, input));
	if (toolName === "bash" || toolName === "powershell") {
		const parts = arg.split(/\s+/).filter(Boolean).slice(0, 2);
		return parts.join(" ").toLowerCase();
	}
	return toolName.toLowerCase();
}

export function categoryForCall(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" || toolName === "powershell") {
		const first = normWs(primaryArg(toolName, input)).split(/\s+/)[0] ?? "";
		const cleaned = slugify(first.replace(/^[.\\/]+/, ""), 16);
		return cleaned || "cli";
	}
	if (toolName === "edit" || toolName === "write") {
		const p = String(input.path ?? "");
		const leaf = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
		const ext = leaf.includes(".") ? (leaf.split(".").pop() as string) : "";
		return slugify(ext || "repo", 16) || "repo";
	}
	return slugify(toolName, 16) || "tools";
}

function looksAborted(text: string): boolean {
	const t = text.toLowerCase();
	return ABORT_MARKERS.some((m) => t.includes(m));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			if (item && typeof item === "object") {
				const obj = item as Record<string, unknown>;
				if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

/**
 * Convert a session branch (pi's SessionEntry list) into observations.
 * Structural on purpose: it reads the documented transcript shape without
 * importing pi types at runtime.
 */
export function observationsFromBranch(branch: unknown[]): ToolObservation[] {
	const calls = new Map<string, { toolName: string; input: Record<string, unknown>; atMs: number }>();
	const out: ToolObservation[] = [];
	for (const raw of branch) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message || typeof message !== "object") continue;
		const role = String(message.role ?? "");
		if (role === "assistant") {
			const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type !== "toolCall" || typeof p.id !== "string") continue;
				calls.set(p.id, {
					toolName: String(p.name ?? ""),
					input: p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {},
					atMs: Date.now(),
				});
			}
		} else if (role === "toolResult") {
			const callId = String(message.toolCallId ?? "");
			const call = calls.get(callId);
			const toolName = String(message.toolName ?? call?.toolName ?? "");
			if (!WATCHED.has(toolName)) continue;
			out.push({
				toolName,
				input: call?.input ?? {},
				isError: message.isError === true,
				text: textOf(message.content),
				atMs: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
				callId,
			});
		}
	}
	return out;
}

export interface LedgerOptions {
	maxCandidates: number;
	sessionId: string;
}

interface LedgerEntry {
	failures: number;
	firstAt: string;
	lastAt: string;
	errorExcerpt: string;
	failing: string;
	toolName: string;
	intent: string;
	category: string;
	succeeding: string | null;
	successAt: string;
	lastInput: Record<string, unknown>;
}

/**
 * Accumulates observations for one run and derives candidates.
 * Bounded: `maxCandidates` and per-entry excerpt caps keep it cheap.
 */
export class RunLedger {
	private entries = new Map<string, LedgerEntry>();
	private dropped = new Map<NoiseClass, number>();
	private opts: LedgerOptions;

	constructor(opts: LedgerOptions) {
		this.opts = opts;
	}

	observe(o: ToolObservation): void {
		if (!WATCHED.has(o.toolName)) return;
		const noise = failureNoise(o);
		if (noise.cls) {
			// Counted, not silent: /memory review shows what was ignored and why.
			this.dropped.set(noise.cls, (this.dropped.get(noise.cls) ?? 0) + 1);
			return;
		}
		const text = hardenForInjection(String(o.text ?? "")).slice(0, 4000);
		const fp = callFingerprint(o.toolName, o.input);
		if (o.isError && !looksAborted(text)) {
			const existing = this.entries.get(fp);
			const entry =
				existing ??
				({
					failures: 0,
					firstAt: new Date(o.atMs).toISOString(),
					lastAt: new Date(o.atMs).toISOString(),
					errorExcerpt: truncate(normWs(text), 200),
					failing: truncate(normWs(primaryArg(o.toolName, o.input)), 200),
					toolName: o.toolName,
					intent: intentKey(o.toolName, o.input),
					category: categoryForCall(o.toolName, o.input),
					succeeding: null,
					successAt: "",
					lastInput: o.input,
				} satisfies LedgerEntry);
			entry.failures++;
			entry.lastAt = new Date(o.atMs).toISOString();
			entry.errorExcerpt = truncate(normWs(text), 200);
			entry.lastInput = o.input;
			this.entries.set(fp, entry);
			if (this.entries.size > this.opts.maxCandidates) {
				// Drop the oldest failure so the ledger cannot grow without bound.
				const oldest = [...this.entries.entries()].sort((a, b) => (a[1].lastAt < b[1].lastAt ? -1 : 1))[0];
				if (oldest) this.entries.delete(oldest[0]);
			}
			return;
		}
		if (!o.isError) {
			// A later success under the same intent, with different arguments, is a
			// proven fix: the failing call is recorded as avoid, the succeeding one as how.
			const intent = intentKey(o.toolName, o.input);
			const okArg = normWs(primaryArg(o.toolName, o.input));
			if (okArg === "") return; // a success with no argument cannot be anyone's fix
			for (const [fp, entry] of this.entries.entries()) {
				if (entry.toolName !== o.toolName || entry.intent !== intent) continue;
				const sameArgs = normalizeCall(o.toolName, o.input) === fpOfCallKey(o.toolName, o.input);
				entry.lastInput = o.input;
				if (entry.succeeding) continue;
				if (sameArgs) {
					// Identical call succeeded later: flaky, not a fix. Record it as a signal only.
					entry.succeeding = truncate(normWs(primaryArg(o.toolName, o.input)), 200);
					entry.successAt = new Date(o.atMs).toISOString();
					continue;
				}
				entry.succeeding = truncate(normWs(primaryArg(o.toolName, o.input)), 200);
				entry.successAt = new Date(o.atMs).toISOString();
			}
		}
	}

	private isProvenFix(e: LedgerEntry): boolean {
		return !!e.succeeding && e.succeeding !== e.failing && e.failures >= 1;
	}

	candidates(): Candidate[] {
		const out: Candidate[] = [];
		for (const [fp, e] of this.entries.entries()) {
			out.push({
				fingerprint: fp,
				category: e.category,
				toolName: e.toolName,
				failing: e.failing,
				succeeding: e.succeeding,
				errorExcerpt: e.errorExcerpt,
				failures: e.failures,
				sessions: [this.opts.sessionId],
				firstAt: e.firstAt,
				lastAt: e.lastAt,
				provenFix: this.isProvenFix(e),
			});
		}
		return out.sort((a, b) => Number(b.provenFix) - Number(a.provenFix) || b.failures - a.failures);
	}

	signals(): Signal[] {
		return this.candidates().map((c) => ({
			fingerprint: c.fingerprint,
			toolName: c.toolName,
			summary: `${c.toolName}: ${c.failing}`,
			sessionId: this.opts.sessionId,
			at: c.lastAt,
			count: c.failures,
			resolved: c.provenFix,
			successSummary: c.succeeding ?? undefined,
		}));
	}

	get size(): number {
		return this.entries.size;
	}

	/** Failures ignored as agent/runtime noise, by class. */
	dropCounts(): Record<string, number> {
		return Object.fromEntries(this.dropped.entries());
	}

	/** One line for the user: what was ignored, so the exclusion is never invisible. */
	dropSummary(): string {
		const parts = [...this.dropped.entries()].filter(([, n]) => n > 0).map(([cls, n]) => `${cls} x${n}`);
		if (parts.length === 0) return "no failures were ignored as agent or runtime noise";
		return `ignored as agent/runtime noise (never recorded): ${parts.join(", ")}`;
	}
}

function fpOfCallKey(toolName: string, input: Record<string, unknown>): string {
	return normalizeCall(toolName, input);
}

/** Build a store draft from a candidate. Facts first, inference kept out. */
export function candidateToDraft(c: Candidate, cwd: string, sessionId: string): Draft {
	const failText = truncate(c.failing, 160);
	const okText = truncate(c.succeeding ?? "", 160);
	const evidence: GmEvidence[] = [
		{ type: "session", ref: `session:${sessionId}`, note: `${c.failures} failed call(s) observed` },
		{ type: "command", ref: okText || failText },
	];
	if (c.provenFix) {
		return {
			kind: "mistake",
			category: c.category,
			title: `${c.category}: "${okText}" worked after "${failText}" failed`,
			statement: `Observed in ${cwd}: ${c.toolName} call "${failText}" failed ${c.failures}x; a later ${c.toolName} call "${okText}" succeeded. Re-check before generalizing beyond this environment.`,
			avoid: `"${failText}" failed: ${truncate(c.errorExcerpt, 160)}`,
			how: `Use "${okText}" instead, then confirm the result.`,
			tags: [c.category, "auto-captured"],
			cues: [failText.slice(0, 60), truncate(c.errorExcerpt, 60)],
			confidence: 1,
			evidence,
		};
	}
	return {
		kind: "mistake",
		category: c.category,
		title: `${c.category}: ${c.toolName} "${failText}" failed ${c.failures}x`,
		statement: `Observed in ${cwd}: ${c.toolName} call "${failText}" failed ${c.failures}x with no later success in that session. Cause unknown; do not treat as a rule until verified.`,
		avoid: `"${failText}" -> ${truncate(c.errorExcerpt, 160)}`,
		tags: [c.category, "unresolved"],
		cues: [failText.slice(0, 60), truncate(c.errorExcerpt, 60)],
		confidence: 1,
		evidence,
	};
}

/** Mine a whole session branch at once (used by `/memory capture` and `/memory review`). */
export function mineBranch(branch: unknown[], sessionId: string, maxCandidates = 40): { candidates: Candidate[]; signals: Signal[]; drops: Record<string, number> } {
	const ledger = new RunLedger({ maxCandidates, sessionId });
	for (const o of observationsFromBranch(branch)) ledger.observe(o);
	return { candidates: ledger.candidates(), signals: ledger.signals(), drops: ledger.dropCounts() };
}
