/**
 * Accuracy engine. A memory that is wrong is worse than no memory: it sends the
 * agent down a path with confidence. So the store treats verification as a
 * first-class operation:
 *
 *  - dispute: live evidence contradicts a cited command -> flag, downgrade, stop
 *    injecting it, and tell the agent it must re-verify.
 *  - verify: live evidence repeats a cited command successfully -> bump
 *    lastVerified and, after repetition, raise confidence.
 *  - audit: staleness, duplicates, contradictions, hedged wording, and privacy
 *    drift across the whole store, with concrete proposed actions.
 *
 * Every rule here keys off observable facts (a call happened, a timestamp aged
 * out, two records cite the same command), never off a model's opinion.
 */

import type { GmConfig, GmRecord } from "./types.ts";
import type { Signal } from "./types.ts";
import { detectHedges, scanPrivacy } from "./trust.ts";
import { normWs, nowIso, truncate } from "./util.ts";
import { valueScore } from "./record.ts";

/**
 * Does this live call match something the record asserts?
 * Exact normalized equality, or one contains the other with a length ratio that
 * keeps "npm test" from matching "npm test -- --coverage something".
 */

export type CallOutcome = "success" | "error";

export interface Classified {
	dispute: { rec: GmRecord; cited: string; why: string }[];
	confirm: { rec: GmRecord; cited: string; why: string }[];
}

/**
 * Decide what a live call says about the active records.
 *
 * A record has two claims: what works (`statement`/`how`) and what fails
 * (`avoid`). So:
 *   success + cited-positive -> confirmed;  error + cited-positive -> disputed
 *   error   + cited-negative -> confirmed;  success + cited-negative -> disputed
 * Disputes require an exact normalized match, because a false dispute would
 * delete trust the store has earned. Confirmations tolerate containment.
 */
export function classifyCall(records: GmRecord[], toolName: string, input: Record<string, unknown>, outcome: CallOutcome): Classified {
	const callText = normWs(String(input?.command ?? primaryArgFor(toolName, input) ?? "")).toLowerCase();
	const result: Classified = { dispute: [], confirm: [] };
	if (callText.length < 3) return result;
	for (const r of records) {
		if (r.status !== "active") continue;
		// An explicit `avoid` citation wins: the record deliberately labels that call
		// as the bad one, so treating the same string as a positive claim would be wrong.
		const negative = matchIn(r.avoid ?? "", callText);
		const positive = negative ? undefined : matchIn(`${r.statement} ${r.how ?? ""}`, callText);
		const exactPositive = positive?.how === "exact" ? positive : undefined;
		const exactNegative = negative?.how === "exact" ? negative : undefined;
		if (outcome === "error") {
			if (exactPositive && !r.flags.includes("disputed")) {
				result.dispute.push({ rec: r, cited: exactPositive.matched, why: `this record says "${exactPositive.matched}" works, and it just failed` });
			}
			if (negative) result.confirm.push({ rec: r, cited: negative.matched, why: `this record says to avoid "${negative.matched}", and it just failed again` });
		} else {
			if (positive) result.confirm.push({ rec: r, cited: positive.matched, why: `this record recommends "${positive.matched}", and it just worked` });
			if (exactNegative) {
				result.dispute.push({ rec: r, cited: exactNegative.matched, why: `this record says to avoid "${exactNegative.matched}", and it just succeeded` });
			}
		}
	}
	return result;
}

function primaryArgFor(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "edit" || toolName === "write" || toolName === "read") return String(input.path ?? "");
	if (toolName === "grep" || toolName === "find") return String(input.pattern ?? "");
	return "";
}

function matchIn(haystack: string, callText: string): { matched: string; how: "exact" | "contained" } | undefined {
	if (!haystack) return undefined;
	const lower = normWs(haystack).toLowerCase();
	for (const m of lower.matchAll(/["'`]([^"'`]{3,160})["'`]/g)) {
		const cited = normWs(m[1]);
		if (cited === callText) return { matched: cited, how: "exact" };
	}
	for (const m of lower.matchAll(/["'`]([^"'`]{3,160})["'`]/g)) {
		const cited = normWs(m[1]);
		const longer = Math.max(cited.length, callText.length);
		const shorter = Math.min(cited.length, callText.length);
		if (shorter >= 10 && shorter / longer >= 0.7 && (cited.includes(callText) || callText.includes(cited))) {
			return { matched: cited, how: "contained" };
		}
	}
	return undefined;
}

export interface HealChange {
	id: string;
	kind: "disputed" | "verified" | "cleared-dispute";
	detail: string;
}

export function applyDispute(rec: GmRecord, at = nowIso()): HealChange {
	if (!rec.flags.includes("disputed")) rec.flags = [...rec.flags, "disputed"];
	rec.stats.disputedAt = at;
	rec.stats.updated = at;
	const before = rec.confidence;
	rec.confidence = Math.max(1, rec.confidence - 1);
	return {
		id: rec.id,
		kind: "disputed",
		detail: `live evidence contradicted a cited command: confidence ${before} -> ${rec.confidence}; excluded from prompt hits until re-verified`,
	};
}

export function applyVerify(rec: GmRecord, at = nowIso(), raiseOnRepeat = true): HealChange {
	const count = (rec.stats.verifiedCount ?? 0) + 1;
	rec.stats.verifiedCount = count;
	rec.stats.lastVerified = at;
	rec.stats.updated = at;
	const cleared = rec.flags.includes("disputed");
	if (cleared) rec.flags = rec.flags.filter((f) => f !== "disputed");
	rec.stats.disputedAt = undefined;
	let kind: HealChange["kind"] = "verified";
	if (raiseOnRepeat && count >= 2 && rec.confidence < 3) {
		rec.confidence = Math.min(3, rec.confidence + 1);
		kind = "verified";
	}
	return { id: rec.id, kind, detail: cleared ? `re-verified after dispute (${count} confirmations)` : `confirmed by live evidence (${count} confirmations)` };
}

export type FindingSeverity = "high" | "medium" | "low";

export interface Finding {
	severity: FindingSeverity;
	id: string;
	issue: string;
	detail: string;
	action: "retire" | "verify" | "merge" | "redact" | "edit" | "review";
	suggestIds?: string[];
}
export function auditStore(records: GmRecord[], cfg: GmConfig, cwd: string): Finding[] {
	const now = Date.now();
	const findings: Finding[] = [];
	const active = records.filter((r) => r.status === "active");

	for (const r of active) {
		const ageDays = (now - Date.parse(r.stats.updated || r.stats.created)) / 86_400_000;
		if (r.flags.includes("disputed")) {
			findings.push({
				severity: "high",
				id: r.id,
				issue: "disputed",
				detail: r.stats.disputedAt ? `contradicted by live evidence on ${r.stats.disputedAt}; retest or retire` : "flagged disputed",
				action: "verify",
			});
		}
		if (r.confidence <= 1 && r.stats.hits === 0 && ageDays > cfg.tentativeTtlDays) {
			findings.push({
				severity: "low",
				id: r.id,
				issue: "tentative-expired",
				detail: `confidence 1, never used, ${Math.round(ageDays)}d old -> retire (keeps the catalog high-signal)`,
				action: "retire",
			});
		}
		if (r.confidence >= 2 && (r.stats.verifiedCount ?? 0) === 0 && !r.stats.lastVerified && ageDays > cfg.staleDays) {
			findings.push({
				severity: "medium",
				id: r.id,
				issue: "never-verified",
				detail: `claims confidence ${r.confidence} but has no verification record and is ${Math.round(ageDays)}d old -> retest or lower confidence`,
				action: "verify",
			});
		}
		const hedges = detectHedges(`${r.title} ${r.statement} ${r.avoid ?? ""} ${r.how ?? ""}`);
		if (hedges.length > 0) {
			findings.push({
				severity: "medium",
				id: r.id,
				issue: "hedged-wording",
				detail: `unreliable phrasing (${hedges.slice(0, 4).join(", ")}) -> verify and rewrite, or retire`,
				action: "edit",
			});
		}
		const scan = scanPrivacy(`${r.title} ${r.statement} ${r.why ?? ""} ${r.how ?? ""} ${r.avoid ?? ""} ${r.notes ?? ""}`);
		if (scan.piiCount > 0) {
			findings.push({
				severity: "high",
				id: r.id,
				issue: "private-content",
				detail: `stored record contains personal identifiers (${scan.pii.map((p) => p.name).join(", ")}) -> redact now`,
				action: "redact",
			});
		}
		if (r.stats.hits === 0 && ageDays > 90 && valueScore(r, now) < 2.5) {
			findings.push({
				severity: "low",
				id: r.id,
				issue: "low-value",
				detail: `never surfaced and scores ${valueScore(r, now).toFixed(1)} -> retire to keep retrieval fast and relevant`,
				action: "retire",
			});
		}
	}

	// Contradictions: two active records that cite the same command with opposite
	// intent. This is the failure mode that makes agents distrust the whole store.
	for (let i = 0; i < active.length; i++) {
		for (let j = i + 1; j < active.length; j++) {
			const a = active[i];
			const b = active[j];
			const clash = commandClash(a, b);
			if (!clash) continue;
			findings.push({
				severity: "high",
				id: a.id,
				issue: "contradiction",
				detail: `${a.id} and ${b.id} both cite "${clash}" with opposite advice -> run one test, keep the winner, retire the other`,
				action: "review",
				suggestIds: [a.id, b.id],
			});
		}
	}

	return findings;
}

interface Clash {
	command: string;
}

function commandClash(a: GmRecord, b: GmRecord): string | undefined {	const aAvoid = new Set(negativeCommands(a));
	const bPositive = new Set(positiveCommands(b));
	for (const c of aAvoid) if (bPositive.has(c)) return c;
	const bAvoid = new Set(negativeCommands(b));
	const aPositive = new Set(positiveCommands(a));
	for (const c of bAvoid) if (aPositive.has(c)) return c;
	return undefined;
}

function negativeCommands(r: GmRecord): string[] {
	const text = normWs(`${r.avoid ?? ""}`.toLowerCase());
	if (!text) return [];
	const out: string[] = [];
	for (const m of text.matchAll(/["'`]([^"'`]{3,120})["'`]/g)) out.push(normWs(m[1]));
	return out;
}

function positiveCommands(r: GmRecord): string[] {
	const text = normWs(`${r.how ?? ""} ${r.statement}`.toLowerCase());
	const out: string[] = [];
	for (const m of text.matchAll(/["'`]([^"'`]{3,120})["'`]/g)) out.push(normWs(m[1]));
	for (const e of r.evidence) if (e.type === "command") out.push(normWs(e.ref.toLowerCase()));
	return out;
}

export function renderFindings(findings: Finding[], budget = 3000): { text: string; shown: number; omitted: number } {
	const order: FindingSeverity[] = ["high", "medium", "low"];
	const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.id.localeCompare(b.id));
	const lines: string[] = [];
	let used = 0;
	for (const f of sorted) {
		const line = `- [${f.severity}] ${f.id} ${f.issue}: ${truncate(f.detail, 200)} -> /memory ${f.action}${f.suggestIds ? ` ${f.suggestIds.join(" ")}` : ""}`;
		if (used + line.length > budget && lines.length > 0) break;
		used += line.length + 1;
		lines.push(line);
	}
	return { text: lines.join("\n"), shown: lines.length, omitted: sorted.length - lines.length };
}

/** Fold capture signals into the audit view so review has one place to look. */
export function signalsToFindings(signals: Signal[]): Finding[] {
	return signals.map((s) => ({
		severity: s.resolved ? ("medium" as FindingSeverity) : ("low" as FindingSeverity),
		id: s.fingerprint,
		issue: s.resolved ? "proven-fix" : "unresolved-failure",
		detail: `${s.summary}${s.successSummary ? ` -> later succeeded: ${truncate(s.successSummary, 120)}` : " (no later success seen)"} [${s.toolName}] x${s.count} at ${s.at}`,
		action: s.resolved ? "verify" : "review",
	}));
}

