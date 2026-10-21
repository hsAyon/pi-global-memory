/**
 * The store: one directory, markdown records inside it, generated indexes.
 *
 * Invariants enforced here:
 *  - every path the store touches is confined to the store root (no traversal,
 *    no symlink escape),
 *  - writes are lock-guarded and atomic, so two pi sessions cannot corrupt it,
 *  - the model-facing read path never deletes anything,
 *  - hit counters are flushed in one batch, not per lookup, to keep git diffs
 *    and write volume low.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GmConfig, GmRecord, GmStatus, LoadedStore, Signal } from "./types.ts";
import { displayPath, ensureDir, exists, hash32, listFiles, nowIso, readTextLimited, relPath, run, tightenMode, writeFileAtomic } from "./util.ts";
import { parseRecordFile, recordFileName, recordToEntry, serializeRecord, similarity as similarityOf, valueScore } from "./record.ts";

const RECORD_MAX_BYTES = 64_000;
const LOCK_NAME = ".lock";
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 25;

export class StoreError extends Error {
	code: "outside-store" | "locked" | "not-found" | "invalid" | "quota";
	constructor(code: StoreError["code"], message: string) {
		super(message);
		this.code = code;
		this.name = "StoreError";
	}
}

export interface StoreCounts {
	active: number;
	superseded: number;
	retired: number;
	invalid: number;
	categories: Record<string, number>;
	bytes: number;
	files: number;
}

export class MemoryStore {
	readonly root: string;
	private cfg: GmConfig;
	private cache?: { records: GmRecord[]; invalid: { file: string; reason: string }[]; at: number };
	private touched = new Map<string, number>();
	private gitChecked = false;
	private gitUsable = false;

	constructor(root: string, cfg: GmConfig) {
		this.root = path.resolve(root);
		this.cfg = cfg;
	}

	/** Swap in a re-read config (used by /memory config set and CLI flags). */
	updateConfig(cfg: GmConfig): void {
		this.cfg = cfg;
		this.gitChecked = false;
		this.gitUsable = false;
	}

	get config(): GmConfig {
		return this.cfg;
	}

	ensure(): void {
		ensureDir(this.root);
		ensureDir(path.join(this.root, "records"));
		ensureDir(path.join(this.root, "archive"));
		ensureDir(path.join(this.root, "pending"));
	}

	inside(target: string): string {
		const abs = path.resolve(target);
		const rel = path.relative(this.root, abs);
		if (rel === "") return abs;
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new StoreError("outside-store", `refused path outside the memory root: ${displayPath(abs)} (root: ${displayPath(this.root)})`);
		}
		// A symlink inside the root must not resolve outside it.
		const parts = rel.split(/[\\/]+/);
		let cursor = this.root;
		for (const part of parts) {
			cursor = path.join(cursor, part);
			try {
				const real = fs.realpathSync(cursor);
				const realRel = path.relative(this.root, real);
				if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
					throw new StoreError("outside-store", `refused symlink escaping the memory root: ${displayPath(cursor)}`);
				}
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT") break; // final component may not exist yet
				if (err instanceof StoreError) throw err;
				break;
			}
		}
		return abs;
	}

	safeJoin(rel: string): string {
		if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
			throw new StoreError("outside-store", `refused unsafe relative path: ${rel}`);
		}
		const parts = rel.split(/[\\/]+/);
		for (const p of parts) {
			if (!p || p === "." || p === "..") throw new StoreError("outside-store", `refused unsafe path segment in ${rel}`);
		}
		return this.inside(path.join(this.root, ...parts));
	}

	async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
		const lockPath = path.join(this.root, LOCK_NAME);
		const token = `${process.pid}|${Math.random().toString(36).slice(2)}`;
		let acquired = false;
		for (let attempt = 0; attempt < LOCK_ATTEMPTS && !acquired; attempt++) {
			try {
				ensureDir(this.root);
				const fd = fs.openSync(lockPath, "wx", 0o600);
				try {
					fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso(), token }), "utf8");
				} finally {
					fs.closeSync(fd);
				}
				tightenMode(lockPath);
				acquired = true;
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "EEXIST") {
					let age = Number.POSITIVE_INFINITY;
					try {
						age = Date.now() - fs.statSync(lockPath).mtimeMs;
					} catch {
						age = Number.POSITIVE_INFINITY;
					}
					if (age > LOCK_STALE_MS) {
						try {
							fs.rmSync(lockPath, { force: true });
						} catch {
							/* another process may already have taken it */
						}
						continue;
					}
					await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
					continue;
				}
				throw new StoreError("locked", `cannot create store lock: ${String((err as Error)?.message ?? err)}`);
			}
		}
		if (!acquired) throw new StoreError("locked", `memory store is busy (lock held for > ${LOCK_STALE_MS / 1000}s): ${displayPath(lockPath)}`);
		try {
			return await fn();
		} finally {
			this.releaseLock(lockPath, token);
		}
	}

	/** Idempotent, ownership-checked lock release. */
	private releaseLock(lockPath: string, token: string): void {
		try {
			const current = fs.readFileSync(lockPath, "utf8");
			// If someone broke our stale lock, do not delete theirs.
			if (!current.includes(token)) return;
		} catch {
			return; // already gone
		}
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			/* idempotent cleanup */
		}
	}

	/** Read every record file. Cached for cfg.reloadTtlMs so lookups stay cheap. */
	async load(force = false): Promise<LoadedStore> {
		const fresh = this.cache && Date.now() - this.cache.at < this.cfg.reloadTtlMs;
		if (!force && fresh) return { records: this.cache!.records, invalid: this.cache!.invalid, generatedAt: new Date(this.cache!.at).toISOString() };
		const files = [...listFiles(path.join(this.root, "records"), ".md", this.cfg.maxActiveRecords * 4 + 200), ...listFiles(path.join(this.root, "archive"), ".md", this.cfg.maxActiveRecords * 2 + 100)];
		const records: GmRecord[] = [];
		const invalid: { file: string; reason: string }[] = [];
		for (const file of files) {
			const raw = readTextLimited(file, RECORD_MAX_BYTES);
			if (raw === undefined) {
				invalid.push({ file: relPath(this.root, file), reason: "missing or larger than 64 KB" });
				continue;
			}
			const parsed = parseRecordFile(raw, file);
			if (parsed.problem || !parsed.record) {
				invalid.push({ file: relPath(this.root, file), reason: parsed.problem ?? "unparsable" });
				continue;
			}
			const hit = this.touched.get(parsed.record.id);
			if (hit) parsed.record.stats.hits += hit;
			records.push(parsed.record);
		}
		this.cache = { records, invalid, at: Date.now() };
		return { records, invalid, generatedAt: new Date(this.cache.at).toISOString() };
	}

	invalidate(): void {
		this.cache = undefined;
	}

	/** Records from the last load, without triggering IO. Empty until first load. */
	cacheRecords(): GmRecord[] {
		return this.cache?.records ?? [];
	}

	/**
	 * Write one record without taking the lock. Only valid inside a withLock
	 * callback (used by the batched self-heal flush).
	 */
	writeRecordNow(rec: GmRecord): void {
		writeFileAtomic(this.recordPath(rec), serializeRecord(rec));
		if (this.cache) {
			const at = this.cache.records.findIndex((r) => r.id === rec.id);
			if (at >= 0) this.cache.records[at] = rec;
			else this.cache.records.push(rec);
		}
	}

	recordPath(r: GmRecord): string {
		const base = r.status === "retired" ? "archive" : "records";
		return this.safeJoin(path.join(base, recordFileName(r)));
	}

	byId(id: string): GmRecord | undefined {
		if (!this.cache) return undefined;
		const key = String(id ?? "").trim().toLowerCase();
		return this.cache.records.find((r) => r.id.toLowerCase() === key);
	}

	idSet(): Set<string> {
		return new Set((this.cache?.records ?? []).map((r) => r.id));
	}

	/** Insert or replace a record and rebuild the derived indexes. */
	async put(record: GmRecord, note: string): Promise<{ file: string; created: boolean }> {
		return await this.withLock(async () => {
			this.ensure();
			const target = this.recordPath(record);
			const created = !exists(target);
			// Remove any previous copy (category, status, or id may have moved it).
			for (const existing of this.cache?.records ?? []) {
				if (existing.id !== record.id || !existing.file) continue;
				if (existing.file !== target) {
					this.inside(existing.file);
					try {
						fs.rmSync(existing.file, { force: true });
					} catch {
						/* the write below is what matters */
					}
				}
			}
			writeFileAtomic(target, serializeRecord(record));
			const loaded = await this.load(true);
			const idx = this.indexPayload(loaded.records);
			writeFileAtomic(this.safeJoin("index.json"), idx.json);
			writeFileAtomic(this.safeJoin("INDEX.md"), idx.md);
			await this.maybeGitCommit(note);
			return { file: displayPath(target), created };
		});
	}

	async setStatus(ids: string[], status: GmStatus, note: string): Promise<{ changed: string[]; missing: string[] }> {
		return await this.withLock(async () => {
			const changed: string[] = [];
			const missing: string[] = [];
			for (const id of ids) {
				const rec = this.byId(id);
				if (!rec) {
					missing.push(id);
					continue;
				}
				rec.status = status;
				rec.stats.updated = nowIso();
				const target = this.recordPath(rec);
				if (rec.file && rec.file !== target) {
					this.inside(rec.file);
					try {
						fs.rmSync(rec.file, { force: true });
					} catch {
						/* ignore */
					}
				}
				writeFileAtomic(target, serializeRecord(rec));
				changed.push(rec.id);
			}
			if (changed.length > 0) {
				const loaded = await this.load(true);
				const idx = this.indexPayload(loaded.records);
				writeFileAtomic(this.safeJoin("index.json"), idx.json);
				writeFileAtomic(this.safeJoin("INDEX.md"), idx.md);
				await this.maybeGitCommit(note);
			}
			return { changed, missing };
		});
	}

	/** Permanent delete. Callers must have obtained explicit user confirmation. */
	async hardDelete(ids: string[], note: string): Promise<{ deleted: string[]; missing: string[] }> {
		return await this.withLock(async () => {
			const deleted: string[] = [];
			const missing: string[] = [];
			for (const id of ids) {
				const rec = this.byId(id);
				if (!rec) {
					missing.push(id);
					continue;
				}
				if (rec.file) {
					this.inside(rec.file);
					fs.rmSync(rec.file, { force: true });
				}
				deleted.push(rec.id);
			}
			if (deleted.length > 0) {
				const loaded = await this.load(true);
				const idx = this.indexPayload(loaded.records);
				writeFileAtomic(this.safeJoin("index.json"), idx.json);
				writeFileAtomic(this.safeJoin("INDEX.md"), idx.md);
				await this.maybeGitCommit(note);
			}
			return { deleted, missing };
		});
	}

	/** Record that a record was surfaced. Batched; call flushStats() at quiet points. */
	touch(ids: string[]): void {
		for (const id of ids) {
			const key = String(id ?? "").trim();
			if (!key) continue;
			this.touched.set(key, (this.touched.get(key) ?? 0) + 1);
		}
	}

	async flushStats(): Promise<number> {
		if (this.touched.size === 0) return 0;
		const pending = [...this.touched.keys()];
		let written = 0;
		const records: GmRecord[] = [];
		for (const id of pending) {
			const rec = this.byId(id);
			if (!rec) continue;
			rec.stats.hits += this.touched.get(id) ?? 0;
			rec.stats.lastUsed = nowIso();
			records.push(rec);
			written++;
		}
		this.touched.clear();
		if (records.length === 0) return 0;
		return await this.withLock(async () => {
			for (const rec of records) writeFileAtomic(this.recordPath(rec), serializeRecord(rec));
			return written;
		});
	}

	counts(): StoreCounts {
		const records = this.cache?.records ?? [];
		const categories: Record<string, number> = {};
		let bytes = 0;
		let files = 0;
		let active = 0;
		let superseded = 0;
		let retired = 0;
		for (const r of records) {
			if (r.status === "active") active++;
			else if (r.status === "retired") retired++;
			else superseded++;
			if (r.status !== "retired") categories[r.category] = (categories[r.category] ?? 0) + 1;
			try {
				if (r.file) {
					bytes += fs.statSync(r.file).size;
					files++;
				}
			} catch {
				/* ignore */
			}
		}
		return { active, superseded, retired, invalid: this.cache?.invalid.length ?? 0, categories, bytes, files };
	}

	/** Deterministic derived indexes. index.json for machines, INDEX.md for humans. */
	indexPayload(records: GmRecord[]): { json: string; md: string } {
		const live = records.filter((r) => r.status !== "retired").sort((a, b) => (a.category === b.category ? valueScore(b) - valueScore(a) : a.category.localeCompare(b.category)));
		const generatedAt = nowIso();
		const index = {
			version: 1,
			generatedAt,
			root: displayPath(this.root),
			count: live.length,
			categories: Object.entries(
				live.reduce<Record<string, number>>((acc, r) => {
					acc[r.category] = (acc[r.category] ?? 0) + 1;
					return acc;
				}, {}),
			)
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name, count]) => ({ name, count })),
			records: live.map((r) => recordToEntry(r)),
		};
		const md: string[] = [
			"# Global memory index",
			"",
			`Generated ${generatedAt} by pi-global-memory. ${live.length} live records. Do not hand-edit: it is rewritten on every write.`,
			"",
			"Machine-readable copy: `index.json`. Records themselves: `records/<category>/<id>.md`.",
			"",
		];
		let currentCat = "";
		for (const r of live) {
			if (r.category !== currentCat) {
				currentCat = r.category;
				md.push("", `## ${currentCat}`, "");
			}
			const flags = [r.confidence <= 1 ? "tentative" : `confidence ${r.confidence}`, r.scope.kind === "project" ? `scope ${r.scope.path}` : "", r.flags.includes("auto") ? "auto" : ""].filter(Boolean).join(", ");
			md.push(`- \`${r.id}\` (${r.kind}, ${flags}) ${r.title}`);
			md.push(`  ${r.statement}`);
		}
		const invalid = this.cache?.invalid ?? [];
		if (invalid.length > 0) {
			md.push("", "## Unreadable files", "");
			for (const i of invalid) md.push(`- \`${i.file}\`: ${i.reason}`);
		}
		return { json: `${JSON.stringify(index, null, 1)}\n`, md: `${md.join("\n")}\n` };
	}

	async rebuildIndex(): Promise<{ records: number; invalid: number }> {
		return await this.withLock(async () => {
			const loaded = await this.load(true);
			const idx = this.indexPayload(loaded.records);
			writeFileAtomic(this.safeJoin("index.json"), idx.json);
			writeFileAtomic(this.safeJoin("INDEX.md"), idx.md);
			return { records: loaded.records.length, invalid: loaded.invalid.length };
		});
	}

	// --- pending signals (raw failure ledger feeding /memory review) ---

	private signalsFile(): string {
		return this.safeJoin(path.join("pending", "signals.jsonl"));
	}

	async appendSignal(sig: Signal): Promise<void> {
		return await this.withLock(async () => {
			const file = this.signalsFile();
			const existing = this.readSignalsRaw();
			if (existing.length >= this.cfg.maxSignals) {
				// Keep the ledger bounded by folding duplicates instead of growing.
				const kept = existing.filter((s) => s.fingerprint !== sig.fingerprint);
				kept.push(sig);
				writeFileAtomic(file, `${kept.map((s) => JSON.stringify(s)).join("\n")}\n`);
				return;
			}
			const withoutDup = existing.filter((s) => s.fingerprint !== sig.fingerprint);
			writeFileAtomic(file, `${[...withoutDup, sig].map((s) => JSON.stringify(s)).join("\n")}\n`);
		});
	}

	private readSignalsRaw(): Signal[] {
		let text: string | undefined;
		try {
			text = fs.readFileSync(this.signalsFile(), "utf8");
		} catch {
			return [];
		}
		const out: Signal[] = [];
		for (const line of text.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			try {
				const parsed = JSON.parse(t) as Signal;
				if (parsed && typeof parsed.fingerprint === "string") out.push(parsed);
			} catch {
				/* skip malformed line */
			}
		}
		return out;
	}

	listSignals(): Signal[] {
		return this.readSignalsRaw().sort((a, b) => (a.at < b.at ? 1 : -1));
	}

	async clearSignals(fingerprints?: string[]): Promise<number> {
		return await this.withLock(async () => {
			const file = this.signalsFile();
			if (!fingerprints || fingerprints.length === 0) {
				if (exists(file)) fs.rmSync(file, { force: true });
				return this.readSignalsRaw().length;
			}
			const drop = new Set(fingerprints);
			const kept = this.readSignalsRaw().filter((s) => !drop.has(s.fingerprint));
			if (kept.length === 0) {
				if (exists(file)) fs.rmSync(file, { force: true });
			} else {
				writeFileAtomic(file, `${kept.map((s) => JSON.stringify(s)).join("\n")}\n`);
			}
			return drop.size;
		});
	}

	// --- optional git bookkeeping (local only: never pushes, protocol refused) ---

	/**
	 * Hard offline settings. `GIT_ALLOW_PROTOCOL=none` makes any networked git
	 * subcommand fail closed, so an operator cannot be tricked into a push or
	 * fetch by a crafted commit message or path.
	 */
	private gitEnv(): Record<string, string> {
		return { GIT_ALLOW_PROTOCOL: "none", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
	}

	private gitArgs(args: string[]): string[] {
		return ["-c", "protocol.ext.allow=never", "-c", "core.hooksPath=.git/hooks-disabled", "-C", this.root, ...args];
	}

	private async maybeGitCommit(message: string): Promise<void> {
		if (!this.cfg.gitAutoCommit) return;
		if (!this.gitChecked) {
			this.gitChecked = true;
			const probe = await run("git", this.gitArgs(["rev-parse", "--is-inside-work-tree"]), this.root, 5000, this.gitEnv());
			this.gitUsable = probe.code === 0 && probe.stdout.trim() === "true";
		}
		if (!this.gitUsable) return;
		if (/[\r\n"]/g.test(message)) message = message.replace(/[\r\n"]+/g, " ").slice(0, 120);
		// Pathspec "." keeps the commit scoped to the store directory even when the
		// store sits inside a larger work tree, so unrelated user changes stay out.
		const add = await run("git", this.gitArgs(["add", "-A", "--", "."]), this.root, 8000, this.gitEnv());
		if (add.code !== 0) return;
		await run("git", this.gitArgs(["commit", "-q", "-m", `global-memory: ${message}`, "--", "."]), this.root, 8000, this.gitEnv());
	}

	async gitStatus(): Promise<{ usable: boolean; dirty: number; head: string }> {
		const probe = await run("git", this.gitArgs(["rev-parse", "--is-inside-work-tree"]), this.root, 5000, this.gitEnv());
		if (probe.code !== 0 || probe.stdout.trim() !== "true") return { usable: false, dirty: 0, head: "" };
		const status = await run("git", this.gitArgs(["--no-pager", "status", "--porcelain", "--", "."]), this.root, 8000, this.gitEnv());
		const head = await run("git", this.gitArgs(["--no-pager", "log", "-1", "--format=%h %s"]), this.root, 5000, this.gitEnv());
		return { usable: true, dirty: status.stdout.trim() === "" ? 0 : status.stdout.trim().split("\n").length, head: head.stdout.trim() };
	}

	/** Structural self-check used by `/memory doctor`. */
	async doctor(): Promise<{ problems: string[]; notes: string[] }> {
		const problems: string[] = [];
		const notes: string[] = [];
		const loaded = await this.load(true);
		const counts = this.counts();
		for (const inv of loaded.invalid) problems.push(`${inv.file}: ${inv.reason}`);
		const seen = new Map<string, string>();
		for (const r of loaded.records) {
			const prev = seen.get(r.id);
			if (prev) problems.push(`duplicate id ${r.id} in ${prev} and ${relPath(this.root, r.file ?? "")}`);
			else seen.set(r.id, relPath(this.root, r.file ?? ""));
			if (r.flags.includes("injection_suspect")) notes.push(`${r.id} contains defanged instruction-shaped text`);
			if (r.status === "active" && r.confidence <= 1 && r.stats.hits === 0) {
				const age = (Date.now() - Date.parse(r.stats.updated)) / 86_400_000;
				if (age > this.cfg.tentativeTtlDays) notes.push(`${r.id} is tentative, unused, and ${Math.round(age)}d old: retire it`);
			}
			if (r.status === "active" && r.scope.kind === "project" && r.scope.path && r.id.length > 64) problems.push(`${r.id}: id too long`);
		}
		if (counts.active > this.cfg.maxActiveRecords) {
			problems.push(`${counts.active} active records exceeds maxActiveRecords (${this.cfg.maxActiveRecords}); run /memory prune`);
		}
		const lockPath = path.join(this.root, LOCK_NAME);
		if (exists(lockPath)) {
			try {
				const age = Date.now() - fs.statSync(lockPath).mtimeMs;
				if (age > LOCK_STALE_MS) problems.push(`stale lock file present (${Math.round(age / 1000)}s): ${displayPath(lockPath)}`);
				else notes.push("another process currently holds the store lock");
			} catch {
				/* ignore */
			}
		}
		if (!exists(path.join(this.root, "index.json"))) notes.push("index.json missing: run /memory reindex");
		const dup = this.findDuplicatePairs(loaded.records, this.cfg.dedupThreshold);
		for (const pair of dup.slice(0, 10)) notes.push(`possible duplicate: ${pair[0]} / ${pair[1]} (similarity ${pair[2]})`);
		return { problems, notes };
	}

	/** O(n^2) on purpose: only safe for a store kept deliberately small. */
	findDuplicatePairs(records: GmRecord[], threshold: number): [string, string, number][] {
		const live = records.filter((r) => r.status === "active");
		const out: [string, string, number][] = [];
		for (let i = 0; i < live.length; i++) {
			for (let j = i + 1; j < live.length; j++) {
				const a = live[i];
				const b = live[j];
				if (a.category !== b.category && a.kind !== b.kind) continue;
				const sim = similarityOf(a, b);
				if (sim >= threshold) out.push([a.id, b.id, Math.round(sim * 100) / 100]);
			}
		}
		return out.sort((x, y) => y[2] - x[2]);
	}
}

export function storeRootToken(root: string): string {
	return hash32(displayPath(path.resolve(root)));
}
