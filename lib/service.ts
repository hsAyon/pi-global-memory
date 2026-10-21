/**
 * Shared behaviour for the tools and the /memory command, with no pi imports.
 *
 * Everything that decides *whether* an action is allowed lives here, in one
 * function (`posture`), so the answer is the same for the model, the user, and
 * the auto-capture path, and so it can be explained when it refuses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GmConfig, GmRecord, SearchQuery, Signal } from "./types.ts";
import type { Draft, ValidationResult } from "./record.ts";
import { CONFIG_DEFAULTS } from "./types.ts";
import { MemoryStore, StoreError } from "./store.ts";
import { buildSearchIndex, discriminativeTokens, renderHits, renderRecord, searchRecords, type SearchHit, type SearchIndex } from "./search.ts";
import { normalizeDraft, scopeMatches, similarity, valueScore } from "./record.ts";
import { auditStore, renderFindings, signalsToFindings, type Finding } from "./heal.ts";
import { displayPath, nowIso, truncate } from "./util.ts";

export interface RunInfo {
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	projectTrusted: boolean;
	/** True for pi --no-session style in-memory sessions. */
	ephemeral: boolean;
	/** Interactive TUI, RPC, print/json: gates dialog-only actions. */
	hasUI: boolean;
	mode: string;
}

export interface Posture {
	use: boolean;
	record: boolean;
	reasons: string[];
	/** Session overrides the user set with /memory use|record. */
	overrides: { use?: boolean; record?: boolean };
	writesUsed: number;
	writesAllowed: number;
}

export class MemoryService {
	cfg: GmConfig;
	store: MemoryStore;
	private idx?: SearchIndex;
	private indexBuiltAt = 0;
	private indexSize = -1;
	writes = 0;
	overrides: { use?: boolean; record?: boolean } = {};
	private pendingVerify = new Set<string>();
	private pendingDispute = new Set<string>();

	constructor(cfg: GmConfig, store: MemoryStore) {
		this.cfg = cfg;
		this.store = store;
	}

	/** Prepare the on-disk root. Private by default: 0700 dir plus a defensive .gitignore. */
	ensureStore(): void {
		this.store.ensure();
		const ignore = path.join(this.store.root, ".gitignore");
		const wanted = this.cfg.gitAutoCommit
			? ""
			: [
					"# pi-global-memory: knowledge can contain project-internal detail.",
					"# Untrack the store unless you have deliberately opted in.",
					"# To track it with git, delete this file and set gitAutoCommit true.",
					"*",
					"!/.gitignore",
					"",
				].join("\n");
		try {
			const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : undefined;
			if (wanted === "") {
				if (current !== undefined && current.includes("pi-global-memory:")) fs.rmSync(ignore, { force: true });
			} else if (current === undefined || (current.includes("pi-global-memory:") && current !== wanted)) {
				fs.writeFileSync(ignore, wanted, { mode: 0o600 });
			}
		} catch {
			/* best effort: a read-only mount should not break lookups */
		}
	}

	async refresh(force = false): Promise<void> {
		const loaded = await this.store.load(force);
		if (force || this.indexSize !== loaded.records.length || Date.now() - this.indexBuiltAt > this.cfg.reloadTtlMs) {
			this.idx = buildSearchIndex(loaded.records);
			this.indexBuiltAt = Date.now();
			this.indexSize = loaded.records.length;
		}
	}

	/** Reset per-session state (new session, toggles not inherited). */
	beginSession(): void {
		this.writes = 0;
		this.overrides = {};
		this.pendingVerify.clear();
		this.pendingDispute.clear();
	}

	posture(info: RunInfo): Posture {
		const reasons: string[] = [];
		let use = this.cfg.use;
		let record = this.cfg.record;
		if (!this.cfg.enabled) {
			use = false;
			record = false;
			reasons.push("disabled by config enabled=false");
		}
		if (this.overrides.use === false) {
			use = false;
			reasons.push("/memory use off for this session");
		}
		if (this.overrides.use === true) use = true;
		if (this.overrides.record === false) {
			record = false;
			reasons.push("/memory record off for this session");
		}
		if (this.overrides.record === true) record = true;
		if (this.cfg.readOnly) {
			record = false;
			reasons.push("config readOnly=true");
		}
		if (this.cfg.respectSessionPrivacy && info.ephemeral && record) {
			record = false;
			reasons.push("ephemeral session (pi --no-session): not writing knowledge from a non-persisted session");
		}
		if (this.cfg.requireProjectTrustForWrites && !info.projectTrusted && record) {
			record = false;
			reasons.push("project trust is denied: writes refused until the project is trusted");
		}
		if (record && this.writes >= this.cfg.maxWritesPerSession) {
			record = false;
			reasons.push(`session write quota reached (${this.cfg.maxWritesPerSession}); use /memory config set maxWritesPerSession N to raise it`);
		}
		return { use, record, reasons, overrides: { ...this.overrides }, writesUsed: this.writes, writesAllowed: this.cfg.maxWritesPerSession };
	}

	private ensureIndex(): SearchIndex {
		if (!this.idx) this.idx = buildSearchIndex(this.store.cacheRecords());
		return this.idx;
	}

	// --- read side ---

	async lookup(query: SearchQuery, info: RunInfo): Promise<{ text: string; ids: string[]; total: number; truncated: boolean }> {
		await this.refresh();
		const records = this.store.cacheRecords();
		const hits = searchRecords(records, this.ensureIndex(), query, info.cwd, this.cfg);
		const rendered = renderHits(hits, this.cfg.searchMaxChars);
		this.store.touch(hits.slice(0, Math.max(1, this.cfg.maxHits)).map((h) => h.entry.id));
		const head = query.text
			? `global memory: ${hits.length} match(es) for "${truncate(query.text, 80)}"${query.category ? ` in ${query.category}` : ""}`
			: `global memory: ${hits.length} record(s)`;
		const tail = rendered.omitted > 0 ? `\n(${rendered.omitted} more not shown; raise limit or narrow the query)` : "";
		return {
			text: `${head}\n${rendered.text}${tail}`,
			ids: hits.slice(0, rendered.shown).map((h) => h.entry.id),
			total: hits.length,
			truncated: rendered.omitted > 0,
		};
	}

	/** Prompt-time relevance: rarest query terms, disputed records dropped. */
	hitsForPrompt(promptText: string, info: RunInfo): SearchHit[] {
		const records = this.store.cacheRecords();
		if (records.length === 0) return [];
		const idx = this.ensureIndex();
		const tokens = discriminativeTokens(idx, promptText, 10);
		if (tokens.length === 0) return [];
		return searchRecords(records, idx, { text: tokens.join(" "), limit: this.cfg.maxHits, excludeDisputed: !this.cfg.includeDisputed }, info.cwd, this.cfg).filter((h) => this.cfg.includeTentative || h.entry.confidence >= 2);
	}

	readIds(ids: string[], info: RunInfo): { text: string; found: string[]; missing: string[] } {
		const parts: string[] = [];
		const found: string[] = [];
		const missing: string[] = [];
		let used = 0;
		for (const id of ids) {
			const rec = this.store.byId(id);
			if (!rec) {
				missing.push(id);
				continue;
			}
			if (!scopeMatches(rec, info.cwd)) {
				missing.push(`${id} (scoped to ${rec.scope.path}, not this project)`);
				continue;
			}
			const rendered = renderRecord(rec, this.cfg.readMaxChars);
			if (used + rendered.text.length > this.cfg.readMaxChars * 2 && found.length > 0) {
				missing.push(`${rec.id} (omitted: read budget reached)`);
				continue;
			}
			used += rendered.text.length;
			parts.push(rendered.text);
			found.push(rec.id);
		}
		if (found.length > 0) this.store.touch(found);
		return { text: parts.join("\n\n"), found, missing };
	}

	catalog(info: RunInfo, limit: number): { text: string; total: number; shown: number } {
		const records = this.store.cacheRecords().filter((r) => r.status !== "retired" && scopeMatches(r, info.cwd));
		const ranked = records
			.map((r) => ({ r, s: valueScore(r) }))
			.sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id))
			.slice(0, Math.max(1, limit));
		const lines = ranked.map(({ r }) => {
			const mark = r.confidence <= 1 ? "~" : "";
			const dispute = r.flags.includes("disputed") ? "!" : "";
			const verified = r.stats.verifiedCount ? ` verified:${r.stats.verifiedCount}x` : "";
			return `- ${dispute}${r.id} ${mark}[${r.kind}/${r.category}] c${r.confidence} hits:${r.stats.hits}${verified} ${r.title}`;
		});
		const cats = new Map<string, number>();
		for (const r of records) cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
		const catLine = [...cats.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([c, n]) => `${c}(${n})`)
			.join(" ");
		return { text: `${records.length} live records. Categories: ${catLine}\n\n${lines.join("\n")}`, total: records.length, shown: lines.length };
	}

	// --- write side ---

	private findTwin(rec: GmRecord): { id: string; sim: number; blocking: boolean } | undefined {
		let best: { id: string; sim: number } | undefined;
		for (const other of this.store.cacheRecords()) {
			if (other.id === rec.id || other.status === "retired") continue;
			const sim = similarity(rec, other);
			if (!best || sim > best.sim) best = { id: other.id, sim };
		}
		if (!best) return undefined;
		// Only a same-category near-duplicate is a real duplicate. Refusing a
		// different learning because its phrasing resembles another record is worse
		// than tolerating the overlap: the model retries with force and wastes the
		// turn this store exists to save. Cross-category similarity is advisory.
		const sameCategory = this.store.byId(best.id)?.category === rec.category;
		if (sameCategory && best.sim >= this.cfg.dedupThreshold) return { ...best, blocking: true };
		if (!sameCategory && best.sim >= this.cfg.dedupThreshold + 0.12) return { ...best, blocking: false };
		return undefined;
	}

	async add(draft: Draft, info: RunInfo, opts: { force?: boolean; note?: string; autoFlags?: string[] } = {}): Promise<ValidationResult & { id?: string; twin?: { id: string; sim: number; blocking: boolean } }> {
		await this.refresh();
		const res = normalizeDraft(draft, {
			maxRecordChars: this.cfg.maxRecordChars,
			redact: this.cfg.redactSecrets,
			requireEvidence: this.cfg.requireEvidence,
			restrictProjectPaths: this.cfg.restrictProjectPaths,
			privacy: this.cfg.privacy,
			sketchy: this.cfg.sketchy,
			minQuality: this.cfg.minQuality,
			cwd: info.cwd,
			existingIds: this.store.idSet(),
		});
		if (!res.ok || !res.record) return res;
		for (const f of opts.autoFlags ?? []) if (!res.record.flags.includes(f)) res.record.flags.push(f);

		const twin = this.findTwin(res.record);
		if (twin?.blocking && !opts.force) {
			return {
				...res,
				ok: false,
				record: undefined,
				twin,
				problems: [
					...res.problems,
					`"${twin.id}" already covers this in category ${res.record.category} (similarity ${twin.sim.toFixed(2)}). Prefer memory_save {action:"update", id:"${twin.id}"}; pass force:true only if these are genuinely different learnings. Keeping the store small is the point.`,
				],
			};
		}
		if (twin && !twin.blocking) {
			res.notes.push(`near-duplicate wording in another category: ${twin.id} (similarity ${twin.sim.toFixed(2)}); saved anyway, consider /memory merge later`);
		}

		const counts = this.store.counts();
		if (counts.active >= this.cfg.maxActiveRecords) {
			return {
				...res,
				ok: false,
				record: undefined,
				problems: [...res.problems, `store has ${counts.active} active records, at maxActiveRecords (${this.cfg.maxActiveRecords}). Retire stale ones (/memory audit) before adding more.`],
			};
		}

		const written = await this.store.put(res.record, opts.note ?? `add ${res.record.id}`);
		this.writes++;
		await this.refresh(true);
		return { ...res, id: res.record.id, record: res.record, notes: [...res.notes, `wrote ${written.file}`] };
	}

	async update(id: string, patch: Draft, info: RunInfo): Promise<ValidationResult & { id?: string }> {
		await this.refresh();
		const existing = this.store.byId(id);
		if (!existing) return { ok: false, problems: [`no record ${id}`], redacted: [], suspect: false, notes: [], quality: 0, qualityReasons: [] };
		const merged: Draft = {
			id: existing.id,
			kind: patch.kind ?? existing.kind,
			category: patch.category ?? existing.category,
			title: patch.title ?? existing.title,
			statement: patch.statement ?? existing.statement,
			why: patch.why ?? existing.why,
			how: patch.how ?? existing.how,
			avoid: patch.avoid ?? existing.avoid,
			notes: patch.notes ?? existing.notes,
			tags: patch.tags ?? existing.tags,
			cues: patch.cues ?? existing.cues,
			confidence: patch.confidence ?? existing.confidence,
			status: patch.status ?? existing.status,
			scope: patch.scope ?? existing.scope,
			supersedes: patch.supersedes ?? existing.supersedes,
			evidence: patch.evidence ?? existing.evidence,
		};
		const res = normalizeDraft(merged, {
			maxRecordChars: this.cfg.maxRecordChars,
			redact: this.cfg.redactSecrets,
			requireEvidence: this.cfg.requireEvidence,
			restrictProjectPaths: this.cfg.restrictProjectPaths,
			privacy: this.cfg.privacy,
			sketchy: this.cfg.sketchy,
			minQuality: this.cfg.minQuality,
			cwd: info.cwd,
			existingIds: this.store.idSet(),
			selfId: existing.id,
		});
		if (!res.ok || !res.record) return res;
		res.record.stats = {
			...existing.stats,
			updated: nowIso(),
			verifiedCount: existing.stats.verifiedCount,
			disputedAt: existing.stats.disputedAt,
		};
		res.record.contradicts = existing.contradicts ?? [];
		for (const f of existing.flags) if (!res.record.flags.includes(f) && f !== "disputed") res.record.flags.push(f);
		if (patch.confidence !== undefined && patch.confidence > existing.confidence) res.record.stats.lastVerified = nowIso();
		await this.store.put(res.record, `update ${existing.id}`);
		this.writes++;
		await this.refresh(true);
		return { ...res, id: res.record.id };
	}

	/** Model/user asserts fresh evidence: clears a dispute and can raise confidence. */
	async verify(id: string, note: string, info: RunInfo): Promise<{ ok: boolean; message: string }> {
		await this.refresh();
		const rec = this.store.byId(id);
		if (!rec) return { ok: false, message: `no record ${id}` };
		const before = { confidence: rec.confidence, flags: [...rec.flags] };
		const count = (rec.stats.verifiedCount ?? 0) + 1;
		rec.stats.verifiedCount = count;
		rec.stats.lastVerified = nowIso();
		rec.stats.updated = nowIso();
		rec.stats.disputedAt = undefined;
		rec.flags = rec.flags.filter((f) => f !== "disputed");
		if (count >= 2 && rec.confidence < 3 && rec.flags.length === 0) rec.confidence = Math.min(3, rec.confidence + 1);
		if (note) rec.notes = [rec.notes, `verify: ${truncate(note, 200)}`].filter(Boolean).join("\n");
		await this.store.put(rec, `verify ${rec.id}`);
		this.writes++;
		await this.refresh(true);
		return {
			ok: true,
			message: `${rec.id}: confidence ${before.confidence} -> ${rec.confidence}, dispute cleared, confirmations ${count}`,
		};
	}

	queueVerify(ids: string[]): void {
		for (const id of ids) this.pendingVerify.add(id);
	}

	queueDispute(ids: string[]): void {
		for (const id of ids) this.pendingDispute.add(id);
	}

	get pendingHeal(): { verify: string[]; dispute: string[] } {
		return { verify: [...this.pendingVerify], dispute: [...this.pendingDispute] };
	}

	clearHealQueues(): void {
		this.pendingVerify.clear();
		this.pendingDispute.clear();
	}

	async retire(ids: string[], note: string): Promise<{ changed: string[]; missing: string[] }> {
		const res = await this.store.setStatus(ids, "retired", note);
		this.writes++;
		await this.refresh(true);
		return res;
	}

	async restore(ids: string[]): Promise<{ changed: string[]; missing: string[] }> {
		const res = await this.store.setStatus(ids, "active", `restore ${ids.join(",")}`);
		this.writes++;
		await this.refresh(true);
		return res;
	}

	async supersede(winnerId: string, loserIds: string[]): Promise<{ ok: boolean; message: string }> {
		const winner = this.store.byId(winnerId);
		if (!winner) return { ok: false, message: `no record ${winnerId}` };
		const missing: string[] = [];
		for (const id of loserIds) {
			const loser = this.store.byId(id);
			if (!loser) {
				missing.push(id);
				continue;
			}
			loser.status = "superseded";
			loser.supersededBy = winnerId;
			loser.stats.updated = nowIso();
			await this.store.put(loser, `superseded by ${winnerId}`);
		}
		winner.supersedes = [...new Set([...(winner.supersedes ?? []), ...loserIds.filter((id) => this.store.byId(id))])];
		winner.stats.updated = nowIso();
		await this.store.put(winner, `supersedes ${winner.supersedes.join(",")}`);
		this.writes++;
		await this.refresh(true);
		return { ok: true, message: `${winnerId} now supersedes ${winner.supersedes.join(", ")}${missing.length ? `; not found: ${missing.join(", ")}` : ""}` };
	}

	async audit(info: RunInfo): Promise<{ findings: Finding[]; text: string }> {
		await this.refresh();
		const records = this.store.cacheRecords().filter((r) => scopeMatches(r, info.cwd));
		const findings = auditStore(records, this.cfg, info.cwd);
		const signals = this.cfg.signals ? this.store.listSignals() : [];
		const all = [...findings, ...signalsToFindings(signals)];
		return { findings: all, text: renderFindings(all).text };
	}

	async flush(): Promise<{ stats: number; verify: number; dispute: number }> {
		const heal = this.pendingHeal;
		let verify = 0;
		let dispute = 0;
		if (heal.verify.length > 0 || heal.dispute.length > 0) {
			await this.store.withLock(async () => {
				for (const id of heal.verify) {
					const rec = this.store.byId(id);
					if (!rec) continue;
					rec.stats.verifiedCount = (rec.stats.verifiedCount ?? 0) + 1;
					rec.stats.lastVerified = nowIso();
					if (rec.flags.includes("disputed")) rec.flags = rec.flags.filter((f) => f !== "disputed");
					rec.stats.disputedAt = undefined;
					if ((rec.stats.verifiedCount ?? 0) >= 2 && rec.confidence < 3) rec.confidence = Math.min(3, rec.confidence + 1);
					this.store.writeRecordNow(rec);
					verify++;
				}
				for (const id of heal.dispute) {
					const rec = this.store.byId(id);
					if (!rec) continue;
					if (!rec.flags.includes("disputed")) rec.flags = [...rec.flags, "disputed"];
					rec.stats.disputedAt = nowIso();
					rec.confidence = Math.max(1, rec.confidence - 1);
					rec.stats.updated = nowIso();
					this.store.writeRecordNow(rec);
					dispute++;
				}
			});
			this.clearHealQueues();
		}
		const stats = await this.store.flushStats();
		return { stats, verify, dispute };
	}

	statusSummary(info: RunInfo): string {
		const c = this.store.counts();
		const p = this.posture(info);
		const mode = !this.cfg.enabled ? "off" : p.use ? (p.record ? "use+record" : "use-only") : "read-blocked";
		return `GM ${mode}: ${c.active} records (${c.categories ? Object.keys(c.categories).length : 0} categories), ${c.retired} retired, ${c.invalid} unreadable${c.invalid ? "!" : ""}`;
	}

	exportAll(): string {
		return JSON.stringify(
			{
				version: 1,
				exportedAt: nowIso(),
				root: displayPath(this.store.root),
				records: this.store.cacheRecords().map((r) => ({ ...r, file: undefined })),
			},
			null,
			1,
		);
	}
}

export interface ImportResult {
	added: number;
	skipped: { id: string; reason: string }[];
	problems: string[];
}

/** Import must pass the same gates as any other write. No bypass path. */
export async function importRecords(service: MemoryService, text: string, info: RunInfo): Promise<ImportResult> {
	const result: ImportResult = { added: 0, skipped: [], problems: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		result.problems.push(`not valid JSON: ${String((err as Error)?.message ?? err)}`);
		return result;
	}
	const raw = Array.isArray(parsed) ? parsed : (parsed as { records?: unknown[] })?.records;
	if (!Array.isArray(raw)) {
		result.problems.push("expected a JSON array of records, or an object with a records array");
		return result;
	}
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			result.skipped.push({ id: "?", reason: "not an object" });
			continue;
		}
		const r = item as Record<string, unknown>;
		const scopeRaw = (r.scope ?? { kind: "global" }) as { kind?: string; path?: string };
		const draft: Draft = {
			id: typeof r.id === "string" ? r.id : undefined,
			kind: typeof r.kind === "string" ? r.kind : undefined,
			category: typeof r.category === "string" ? r.category : undefined,
			title: typeof r.title === "string" ? r.title : undefined,
			statement: typeof r.statement === "string" ? r.statement : undefined,
			why: typeof r.why === "string" ? r.why : undefined,
			how: typeof r.how === "string" ? r.how : undefined,
			avoid: typeof r.avoid === "string" ? r.avoid : undefined,
			notes: typeof r.notes === "string" ? r.notes : undefined,
			tags: r.tags,
			cues: r.cues,
			confidence: typeof r.confidence === "number" ? r.confidence : undefined,
			status: typeof r.status === "string" ? r.status : undefined,
			scope: { kind: scopeRaw.kind === "project" ? "project" : "global", path: scopeRaw.path },
			evidence: r.evidence,
			supersedes: r.supersedes,
		};
		const res = await service.add(draft, info);
		if (res.ok && res.id) result.added++;
		else result.skipped.push({ id: draft.id ?? draft.title ?? "?", reason: res.problems[0] ?? "rejected" });
	}
	return result;
}

export function storeErrorText(err: unknown): string {
	if (err instanceof StoreError) return `${err.code}: ${err.message}`;
	return String((err as Error)?.message ?? err);
}

export const DEFAULTS_REF = CONFIG_DEFAULTS;
export type { GmRecord, Signal };
