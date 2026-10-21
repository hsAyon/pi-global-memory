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
import { hash32, normWs, nowIso, slugify, truncate } from "./util.ts";
import { hardenForInjection } from "./sanitize.ts";

/** Tools whose failures are worth remembering. Everything else is noise. */
const WATCHED = new Set(["bash", "powershell", "edit", "write"]);

const ABORT_MARKERS = ["aborted", "cancelled", "canceled", "interrupted", "user requested stop"];

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
	private opts: LedgerOptions;

	constructor(opts: LedgerOptions) {
		this.opts = opts;
	}

	observe(o: ToolObservation): void {
		if (!WATCHED.has(o.toolName)) return;
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

/** Mine a whole session branch at once (used by `/memory capture`). */
export function mineBranch(branch: unknown[], sessionId: string, maxCandidates = 40): { candidates: Candidate[]; signals: Signal[] } {
	const ledger = new RunLedger({ maxCandidates, sessionId });
	for (const o of observationsFromBranch(branch)) ledger.observe(o);
	return { candidates: ledger.candidates(), signals: ledger.signals() };
}

export function captureNoteFor(count: number): string {
	return `auto-capture ${count} record(s) at ${nowIso()}`;
}
