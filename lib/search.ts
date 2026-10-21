/**
 * Retrieval. No model call, no embeddings: an inverted-term index with field
 * weights, built in memory over a store that is kept deliberately small.
 *
 * The budget rule that shapes this file: a search result must be cheaper to
 * read than the research it replaces, so results are one-line entries plus the
 * matched cues, and the full text is a second, explicit call.
 */

import type { GmConfig, GmEntry, GmRecord, SearchQuery } from "./types.ts";
import { recordToEntry, scopeMatches, valueScore } from "./record.ts";
import { displayPath, normWs, tokenize } from "./util.ts";

interface FieldVector {
	weight: number;
	tokens: Map<string, number>;
}

export interface IndexedRecord {
	id: string;
	fields: FieldVector[];
	len: number;
	blob: string;
}

export interface SearchIndex {
	records: Map<string, IndexedRecord>;
	df: Map<string, number>;
	n: number;
	builtAt: number;
}

const FIELD_WEIGHTS: { field: keyof GmRecord; weight: number }[] = [
	{ field: "title", weight: 4 },
	{ field: "cues", weight: 3 },
	{ field: "tags", weight: 2.2 },
	{ field: "id", weight: 2.5 },
	{ field: "category", weight: 1.5 },
	{ field: "statement", weight: 1.2 },
	{ field: "how", weight: 1 },
	{ field: "avoid", weight: 1 },
	{ field: "why", weight: 0.8 },
	{ field: "notes", weight: 0.6 },
];

function fieldValue(rec: GmRecord, field: keyof GmRecord): string {
	const v = rec[field];
	if (Array.isArray(v)) return (v as string[]).join(" ");
	if (typeof v === "string") return v;
	if (field === "id") return rec.id;
	return "";
}

export function buildSearchIndex(records: GmRecord[]): SearchIndex {
	const out = new Map<string, IndexedRecord>();
	const df = new Map<string, number>();
	for (const r of records) {
		const seen = new Set<string>();
		const fields: FieldVector[] = [];
		let len = 0;
		for (const fw of FIELD_WEIGHTS) {
			const tokens = new Map<string, number>();
			for (const t of tokenize(fieldValue(r, fw.field))) {
				tokens.set(t, (tokens.get(t) ?? 0) + 1);
				len++;
				seen.add(t);
			}
			if (tokens.size > 0) fields.push({ weight: fw.weight, tokens });
		}
		out.set(r.id, { id: r.id, fields, len, blob: normWs(`${r.title}. ${r.statement}`).toLowerCase() });
		for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
	}
	return { records: out, df, n: records.length, builtAt: Date.now() };
}

function idf(idx: SearchIndex, token: string): number {
	const d = idx.df.get(token) ?? 0;
	return Math.max(0.25, Math.log(1 + idx.n / (1 + d)));
}

/** Pick the most discriminative tokens of a text: rarest first, then length. */
export function discriminativeTokens(idx: SearchIndex, text: string, k: number): string[] {
	const tokens = [...new Set(tokenize(text))];
	return tokens
		.map((t) => ({ t, df: idx.df.get(t) ?? idx.n + 1 }))
		.sort((a, b) => a.df - b.df || b.t.length - a.t.length)
		.slice(0, k)
		.map((x) => x.t);
}

export interface SearchHit {
	entry: GmEntry;
	score: number;
	matched: string[];
}

export function searchRecords(records: GmRecord[], idx: SearchIndex, query: SearchQuery, cwd: string, cfg: GmConfig): SearchHit[] {
	const byId = new Map(records.map((r) => [r.id, r] as const));
	const qTokens = [...new Set(tokenize(query.text))];
	if (query.text && qTokens.length === 0) qTokens.push(normWs(query.text).toLowerCase());
	const phrase = normWs(query.text).toLowerCase();
	const hits: SearchHit[] = [];

	for (const [id, ir] of idx.records) {
		const rec = byId.get(id);
		if (!rec) continue;
		if (query.includeRetired !== true && (rec.status === "retired" || rec.status === "superseded")) continue;
		if (!scopeMatches(rec, cwd)) continue;
		if (query.category && rec.category !== query.category.toLowerCase()) continue;
		if (query.kind && rec.kind !== query.kind) continue;
		if (query.minConfidence && rec.confidence < query.minConfidence) continue;
		if (query.scope && query.scope !== "any" && rec.scope.kind !== query.scope) continue;
		const disputed = rec.flags.includes("disputed");
		if (query.excludeDisputed && disputed) continue;
		if (query.tags && query.tags.length > 0) {
			const want = query.tags.map((t) => t.toLowerCase());
			const have = rec.tags.map((t) => t.toLowerCase());
			if (!want.some((w) => have.includes(w))) continue;
		}

		let score = 0;
		const matched: string[] = [];
		for (const t of qTokens) {
			let best = 0;
			for (const f of ir.fields) {
				const tf = f.tokens.get(t);
				if (!tf) continue;
				const v = f.weight * (1 + 0.2 * Math.min(tf - 1, 4));
				if (v > best) best = v;
			}
			if (best > 0) {
				score += best * idf(idx, t);
				matched.push(t);
			}
		}
		if (matched.length === 0) continue;
		score /= Math.sqrt(Math.max(1, qTokens.length));
		if (phrase.length >= 4 && ir.blob.includes(phrase)) score += 2;
		if (matched.length >= 2) score += 0.5 * Math.min(matched.length - 1, 3);
		score += (rec.confidence - 1) * 0.3;
		score += Math.log1p(rec.stats.hits) * 0.15;
		score += Math.min(1, (rec.stats.verifiedCount ?? 0) * 0.3);
		if (disputed) score -= 1.5;
		if (rec.scope.kind === "project") score += 0.4; // project truth beats general truth here
		if (rec.flags.includes("auto")) score -= 0.3;
		if (score < cfg.minSearchScore) continue;
		hits.push({ entry: recordToEntry(rec, Math.round(score * 100) / 100), score, matched: matched.slice(0, 10) });
	}

	hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));
	return hits.slice(0, Math.max(0, query.limit));
}

/** Render hits as budgeted one-line entries. Keeps tool output off the bill. */
export function renderHits(hits: SearchHit[], budget: number): { text: string; shown: number; omitted: number } {
	const lines: string[] = [];
	let used = 0;
	let shown = 0;
	for (const h of hits) {
		const scope = h.entry.scope.kind === "project" ? ` @${displayPath(h.entry.scope.path ?? "")}` : "";
		const conf = h.entry.confidence <= 1 ? "~" : String(h.entry.confidence);
		const dispute = h.entry.disputed ? " DISPUTED" : "";
		const line = `- ${h.entry.id} [${h.entry.kind}/${h.entry.category}] c${conf} hits:${h.entry.hits} score:${h.entry.score}${dispute}${scope} ${h.entry.title}`;
		if (used + line.length > budget && shown > 0) break;
		used += line.length + 1;
		lines.push(line);
		shown++;
	}
	return { text: lines.join("\n"), shown, omitted: hits.length - shown };
}

/** Budgeted full-record text for `memory_lookup read`. */
export function renderRecord(r: GmRecord, budget: number): { text: string; truncated: boolean } {
	const parts: string[] = [];
	parts.push(`### ${r.id} - ${r.title}`);
	parts.push(`kind=${r.kind} category=${r.category} confidence=${r.confidence} status=${r.status} hits=${r.stats.hits} updated=${r.stats.updated}`);
	if (r.flags.includes("disputed")) parts.push(`DISPUTED on ${r.stats.disputedAt ?? "unknown date"}: a command this record cites failed in live use. Retest before applying, then memory_save {action:"verify"} or retire it.`);
	if (r.stats.verifiedCount) parts.push(`verified ${r.stats.verifiedCount}x by live evidence (last ${r.stats.lastVerified})`);
	if (r.contradicts && r.contradicts.length) parts.push(`in tension with: ${r.contradicts.join(", ")}`);
	parts.push(`scope=${r.scope.kind}${r.scope.path ? ` path=${displayPath(r.scope.path)}` : ""}`);
	parts.push(`statement: ${r.statement}`);
	if (r.why) parts.push(`why: ${r.why}`);
	if (r.how) parts.push(`how: ${r.how}`);
	if (r.avoid) parts.push(`avoid: ${r.avoid}`);
	if (r.notes) parts.push(`notes: ${r.notes}`);
	if (r.tags.length) parts.push(`tags: ${r.tags.join(", ")}`);
	if (r.cues.length) parts.push(`cues: ${r.cues.join(" | ")}`);
	if (r.evidence.length) parts.push(`evidence: ${r.evidence.map((e) => `${e.type}:${e.ref}${e.note ? ` (${e.note})` : ""}`).join(" | ")}`);
	if (r.supersedes.length) parts.push(`supersedes: ${r.supersedes.join(", ")}`);
	if (r.supersededBy) parts.push(`supersededBy: ${r.supersededBy}`);
	if (r.flags.length) parts.push(`flags: ${r.flags.join(", ")}`);
	const full = parts.join("\n");
	if (full.length <= budget) return { text: full, truncated: false };
	return { text: `${full.slice(0, budget)}\n[truncated at ${budget} chars; file: ${r.file ? displayPath(r.file) : "unknown"}]`, truncated: true };
}

export function renderCatalog(records: GmRecord[], cfg: GmConfig): { text: string; shown: number; total: number } {
	const live = records.filter((r) => r.status === "active" || r.status === "superseded");
	const ranked = live
		.map((r) => ({ r, s: valueScore(r) }))
		.sort((a, b) => b.s - a.s || (a.r.id < b.r.id ? -1 : 1));
	const picked = ranked.slice(0, cfg.maxIndexEntries);
	const lines = picked.map(({ r }) => {
		const mark = r.confidence <= 1 ? "~" : "";
		const dispute = r.flags.includes("disputed") ? "!" : "";
		return `- ${dispute}${r.id} ${mark}[${r.category}] ${r.title}`;
	});
	return { text: lines.join("\n"), shown: picked.length, total: live.length };
}
