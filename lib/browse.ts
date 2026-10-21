/**
 * Human-facing record browser: see the store at a glance, then act on one record.
 *
 * Two surfaces, same data:
 *  - `/memory ls` (and its file output) for anything non-interactive,
 *  - `/memory browse` driving pi's `ctx.ui.select` menus, including deletion.
 *
 * Deletion rules live here so they cannot be skipped by calling the wrong command:
 * a single delete needs one confirmation, and deleting the whole store needs two
 * confirmations plus a typed token, and always writes a container backup first.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GmRecord } from "./types.ts";
import type { MemoryService, RunInfo } from "./service.ts";
import { displayPath, nowIso, randomToken } from "./util.ts";
import { renderRecord } from "./search.ts";
import { CONTAINER_EXT } from "./container.ts";

export type SortKey = "updated" | "created" | "hits" | "confidence" | "age" | "value";
export const SORT_KEYS: SortKey[] = ["value", "updated", "created", "hits", "confidence", "age"];

export interface ListRow {
	id: string;
	category: string;
	kind: string;
	title: string;
	confidence: number;
	status: string;
	flags: string[];
	hits: number;
	verified: number;
	ageDays: number;
	updated: string;
	lowValue: boolean;
	disputed: boolean;
}

function ageDays(r: GmRecord, now = Date.now()): number {
	const stamp = Date.parse(r.stats.lastVerified || r.stats.updated || r.stats.created);
	if (!Number.isFinite(stamp)) return -1;
	return Math.max(0, Math.round((now - stamp) / 86_400_000));
}

export function listRows(
	service: MemoryService,
	opts: { category?: string; sort?: SortKey; includeRetired?: boolean; query?: string; limit?: number } = {},
): { rows: ListRow[]; total: number } {
	const all = service.store.cacheRecords();
	const filtered = all.filter((r) => {
		if (!opts.includeRetired && r.status === "retired") return false;
		if (opts.category && r.category !== opts.category) return false;
		if (opts.query) {
			const q = opts.query.toLowerCase();
			const blob = `${r.id} ${r.title} ${r.statement} ${r.tags.join(" ")} ${r.cues.join(" ")}`.toLowerCase();
			if (!blob.includes(q)) return false;
		}
		return true;
	});
	const sort = opts.sort ?? "value";
	const value = new Map(filtered.map((r) => [r.id, service.valueScoreOf(r)]));
	filtered.sort((a, b) => {
		switch (sort) {
			case "updated":
				return (b.stats.updated || "").localeCompare(a.stats.updated || "");
			case "created":
				return (b.stats.created || "").localeCompare(a.stats.created || "");
			case "hits":
				return b.stats.hits - a.stats.hits;
			case "confidence":
				return b.confidence - a.confidence;
			case "age":
				return ageDays(b) - ageDays(a);
			default:
				return (value.get(b.id) ?? 0) - (value.get(a.id) ?? 0);
		}
	});
	const total = filtered.length;
	const limited = opts.limit && opts.limit > 0 ? filtered.slice(0, opts.limit) : filtered;
	const rows: ListRow[] = limited.map((r) => ({
		id: r.id,
		category: r.category,
		kind: r.kind,
		title: r.title,
		confidence: r.confidence,
		status: r.status,
		flags: r.flags,
		hits: r.stats.hits,
		verified: r.stats.verifiedCount ?? 0,
		ageDays: ageDays(r),
		updated: (r.stats.updated || r.stats.created || "").slice(0, 10),
		disputed: r.flags.includes("disputed"),
		lowValue: r.flags.includes("low-value"),
	}));
	return { rows, total };
}

export function categoryOverview(service: MemoryService): { category: string; live: number; retired: number; disputed: number; neverVerified: number }[] {
	const map = new Map<string, { live: number; retired: number; disputed: number; neverVerified: number }>();
	for (const r of service.store.cacheRecords()) {
		const row = map.get(r.category) ?? { live: 0, retired: 0, disputed: 0, neverVerified: 0 };
		if (r.status === "retired") row.retired++;
		else row.live++;
		if (r.flags.includes("disputed")) row.disputed++;
		if (!r.stats.lastVerified && r.confidence <= 1) row.neverVerified++;
		map.set(r.category, row);
	}
	return [...map.entries()]
		.map(([category, v]) => ({ category, ...v }))
		.sort((a, b) => b.live - a.live || a.category.localeCompare(b.category));
}

/** The high-level view: one line per record, grouped, with the command to act on it. */
export function renderListing(
	service: MemoryService,
	opts: { category?: string; sort?: SortKey; includeRetired?: boolean; query?: string } = {},
): string {
	const counts = service.store.counts();
	const { rows, total } = listRows(service, opts);
	const lines: string[] = [];
	lines.push(`${counts.active} live record(s)${counts.retired ? `, ${counts.retired} retired` : ""}${counts.invalid ? `, ${counts.invalid} unreadable (!)` : ""}`);
	lines.push(`store: ${displayPath(service.store.root)}`);
	lines.push(
		`sort: ${opts.sort ?? "value"}   view one: /memory read <id>   fix it: /memory verify <id> | /memory retire <id> | /memory delete <id> force`,
	);
	lines.push("");
	if (rows.length === 0) {
		lines.push("(nothing matches)");
		return lines.join("\n");
	}

	const byCat = new Map<string, ListRow[]>();
	for (const r of rows) {
		const list = byCat.get(r.category) ?? [];
		list.push(r);
		byCat.set(r.category, list);
	}
	for (const [category, list] of byCat) {
		lines.push(`## ${category} (${list.length})`);
		for (const r of list) {
			const marks = [
				r.disputed ? "DISPUTED" : "",
				r.confidence <= 1 ? "tentative" : "",
				r.lowValue ? "low-value" : "",
				r.verified ? `verified x${r.verified}` : "",
				r.status !== "active" ? r.status : "",
				r.flags.includes("auto") ? "auto" : "",
			]
				.filter(Boolean)
				.join(",");
			lines.push(`  ${r.id}  c${r.confidence} hits:${r.hits} age:${r.ageDays}d  ${r.title}${marks ? `  [${marks}]` : ""}`);
		}
		lines.push("");
	}
	if (total > rows.length) lines.push(`(${total - rows.length} more not shown: /memory ls --limit ${total})`);
	return lines.join("\n");
}

export function renderOverview(service: MemoryService): string {
	const counts = service.store.counts();
	const rows = categoryOverview(service);
	const lines: string[] = [];
	lines.push(`global memory: ${counts.active} live record(s) in ${rows.length} category/categories`);
	lines.push(`store: ${displayPath(service.store.root)}`);
	lines.push("");
	lines.push("category        live  retired  disputed  never-verified");
	for (const r of rows) lines.push(`${r.category.padEnd(15)} ${String(r.live).padStart(4)} ${String(r.retired).padStart(7)} ${String(r.disputed).padStart(8)} ${String(r.neverVerified).padStart(14)}`);
	lines.push("");
	lines.push("browse one category: /memory ls <category>   pick interactively: /memory browse");
	return lines.join("\n");
}

/* ------------------------------------------------------------------ deletes */

export interface PendingDoom {
	token: string;
	issuedAt: string;
	expiresAt: number;
	recordCount: number;
	categories: string[];
}

/** In-memory only: a staged delete-all must not survive a restart. */
const pendingDoom = new Map<string, PendingDoom>();

export function stagedDeleteAll(root: string): PendingDoom | undefined {
	const p = pendingDoom.get(root);
	if (!p) return undefined;
	if (Date.now() > p.expiresAt) {
		pendingDoom.delete(root);
		return undefined;
	}
	return p;
}

export function stageDeleteAll(service: MemoryService): PendingDoom {
	const counts = service.store.counts();
	const token = randomToken();
	const staged: PendingDoom = {
		token,
		issuedAt: nowIso(),
		expiresAt: Date.now() + 10 * 60_000,
		recordCount: counts.active + counts.retired,
		categories: categoryOverview(service).map((c) => c.category),
	};
	pendingDoom.set(service.store.root, staged);
	return staged;
}

export function clearStage(root: string): void {
	pendingDoom.delete(root);
}

export function doomWarningText(service: MemoryService, staged: PendingDoom): string {
	const counts = service.store.counts();
	return [
		`DELETE EVERY RECORD - this cannot be undone from the UI.`,
		`about to delete: ${staged.recordCount} record(s) (${counts.active} live, ${counts.retired} retired) across ${staged.categories.length} categories: ${staged.categories.slice(0, 12).join(", ")}`,
		`a container backup is written first and its path is reported; the store keeps config.json and indexes`,
		``,
		`this confirmation expires in 10 minutes and cannot be bypassed by config (confirmDestructive does not apply)`,
		`type the token to proceed:  ${staged.token}`,
		`  UI:      /memory delete-all confirm ${staged.token}`,
		`  or:      /memory delete-all confirm ${staged.token} (works headless too)`,
		`encrypted backup: set PI_GLOBAL_MEMORY_PASSPHRASE before running it`,
	].join("\n");
}

/**
 * Two-step delete-all. The first call stages a token; the second must present it.
 * `confirmId` is what the caller typed. Refuses everything else.
 */
export async function commitDeleteAll(
	service: MemoryService,
	info: RunInfo,
	confirmId: string | undefined,
): Promise<{ ok: boolean; message: string; backupFile?: string; deleted?: number }> {
	const staged = stagedDeleteAll(service.store.root);
	if (!staged) {
		const fresh = stageDeleteAll(service);
		return { ok: false, message: `${doomWarningText(service, fresh)}\n\nNothing was deleted. Run the command again with the token above.` };
	}
	if (!confirmId || confirmId.trim().toUpperCase() !== staged.token) {
		return { ok: false, message: `token missing or wrong. Nothing was deleted.\n${doomWarningText(service, staged)}` };
	}
	clearStage(service.store.root);
	const passphrase = process.env.PI_GLOBAL_MEMORY_PASSPHRASE?.trim() || undefined;
	const res = await service.wipeEverything(info, { passphrase });
	return {
		ok: true,
		deleted: res.files,
		backupFile: res.backupFile,
		message: [
			`deleted all records: ${res.files} file(s) removed.`,
			`backup container: ${res.backupFile}`,
			`${res.backupRecords} record(s) inside, ${res.encrypted ? "encrypted with AES-256-GCM" : "not encrypted"}.`,
			`restore with: /memory import ${res.backupFile}${res.encrypted ? " <passphrase>" : ""}`,
			``,
			`the backup is a plain file on disk: delete it yourself when you are done with it (rm "${res.backupFile.replace(/\.[^"\\]*$/, ".cmd")}" won't help - use your shell).`,
		].join("\n"),
	};
}

/* ------------------------------------------------------- interactive browse */

const PAGE = 20;

export interface BrowseDeps {
	runInfo: () => RunInfo;
	refreshStatus: () => void;
}

/**
 * Select-driven browser. Kept to pi's documented dialogs (select/confirm/input) so
 * it works in the TUI without a custom component, and every destructive step asks.
 */
export async function browseInteractive(ctx: ExtensionCommandContext, service: MemoryService, deps: BrowseDeps, startCategory?: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`no interactive UI in ${ctx.mode} mode. Use:\n${renderOverview(service)}\n\n${renderListing(service, { category: startCategory })}`, "info");
		return;
	}
	let category = startCategory;
	let sort: SortKey = "value";

	for (;;) {
		const overview = categoryOverview(service);
		const choices: string[] = [];
		if (category) choices.push("<all categories>", "<change sort>");
		else choices.push("<change sort>");
		for (const c of overview) choices.push(`${c.category} (${c.live}${c.disputed ? `, ${c.disputed} disputed` : ""})`);
		if (choices.length === 1) {
			ctx.ui.notify("the store is empty. Save one with memory_save or /memory save", "info");
			return;
		}
		const picked = await ctx.ui.select(`global memory: ${service.store.counts().active} live records`, choices);
		if (!picked) return;
		if (picked === "<all categories>") {
			category = undefined;
			continue;
		}
		if (picked === "<change sort>") {
			const next = await ctx.ui.select("sort records by", SORT_KEYS);
			if (next && SORT_KEYS.includes(next as SortKey)) sort = next as SortKey;
			continue;
		}
		category = picked.split(" ")[0];
		const { rows, total } = listRows(service, { category, sort });
		const items: string[] = rows.slice(0, PAGE).map((r) => `${r.id} | c${r.confidence} hits:${r.hits} age:${r.ageDays}d${r.disputed ? " DISPUTED" : ""} | ${r.title.slice(0, 70)}`);
		if (total > PAGE) items.push(`<next page: ${total - PAGE} more>`);
		items.push("<back>");
		const row = await ctx.ui.select(`${category} (${total})`, items);
		if (!row || row === "<back>") continue;
		if (row === "<next page>") {
			const rest = rows.slice(PAGE).map((r) => `${r.id} | ${r.title.slice(0, 70)}`);
			const picked2 = await ctx.ui.select(`${category} - more`, [...rest, "<back>"]);
			if (!picked2 || picked2 === "<back>") continue;
			await recordMenu(ctx, service, deps, picked2.split(" |")[0]);
			continue;
		}
		await recordMenu(ctx, service, deps, row.split(" |")[0]);
	}
}

async function recordMenu(ctx: ExtensionCommandContext, service: MemoryService, deps: BrowseDeps, id: string): Promise<void> {
	const rec = service.store.byId(id);
	if (!rec) {
		ctx.ui.notify(`no record ${id}`, "error");
		return;
	}
	const detail = renderRecord(rec, service.cfg.readMaxChars).text;
	ctx.ui.notify(`${id}\n${detail}`, "info");
	for (;;) {
		const action = await ctx.ui.select(`${id} - what to do?`, ["leave it", "verify it (I re-tested)", "retire it", "restore it", "DELETE permanently", "back"]);
		if (!action || action === "back" || action === "leave it") return;
		if (action === "verify it (I re-tested)") {
			const note = (await ctx.ui.input("what did you re-test?", "one line"))?.trim();
			const res = await service.verify(id, note || "confirmed in /memory browse", deps.runInfo());
			ctx.ui.notify(res.message, res.ok ? "info" : "error");
			deps.refreshStatus();
			continue;
		}
		if (action === "retire it") {
			const res = await service.retire([id], "retired from /memory browse");
			ctx.ui.notify(`retired ${res.changed.join(", ") || "(nothing)"}; file moved under archive/`, "info");
			deps.refreshStatus();
			return;
		}
		if (action === "restore it") {
			const res = await service.restore([id], "restored from /memory browse");
			ctx.ui.notify(`restored ${res.changed.join(", ") || "(nothing)"}`, "info");
			deps.refreshStatus();
			continue;
		}
		if (action === "DELETE permanently") {
			const sure = await ctx.ui.confirm(
				"delete one record permanently?",
				`${id}\n${rec.title}\n\nThis removes the file for good (git history may still hold it). Prefer "retire it" unless the record is wrong AND sensitive.`,
			);
			if (!sure) continue;
			const typed = await ctx.ui.input(`type the record id to confirm deletion`, "gm-...");
			if ((typed ?? "").trim() !== id) {
				ctx.ui.notify(`did not type ${id}; nothing was deleted`, "warning");
				continue;
			}
			const res = await service.store.hardDelete([id], "deleted from /memory browse");
			await service.refresh(true);
			ctx.ui.notify(res.deleted.length ? `deleted ${id}` : `nothing deleted (${id} not found)`, "warning");
			deps.refreshStatus();
			return;
		}
	}
}

/** Path helper so commands and browse agree on where exports/backups land. */
export function containerPath(kind: string, passphrase: boolean): string {
	const stamp = nowIso().replace(/[:.]/g, "-");
	return `${kind}-${stamp}${CONTAINER_EXT}${passphrase ? ".enc" : ""}`;
}
