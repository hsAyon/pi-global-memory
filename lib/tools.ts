/**
 * The two model-facing tools. Two, not one: the read side is safe and always
 * available, the write side is gated by the user's recording posture, and
 * separating them lets the annotations and the refusal text stay honest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LookupParams, SaveParams } from "./schemas.ts";
import type { Draft } from "./record.ts";
import type { MemoryService, RunInfo } from "./service.ts";
import { storeErrorText } from "./service.ts";
import type { GmKind } from "./types.ts";
import { clamp, truncate } from "./util.ts";

export interface ToolDeps {
	service: MemoryService;
	runInfo: () => RunInfo;
}

interface ToolResultText {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

function textResult(text: string, details: Record<string, unknown>, isError = false): ToolResultText {
	return { content: [{ type: "text", text }], details, isError };
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.map((x) => String(x ?? "")).filter((s) => s.length > 0) : [];
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function draftFrom(params: Record<string, unknown>): Draft {
	const scopeRaw = params.scope && typeof params.scope === "object" ? (params.scope as Record<string, unknown>) : undefined;
	return {
		kind: asString(params.kind),
		category: asString(params.category),
		title: asString(params.title),
		statement: asString(params.statement),
		why: asString(params.why),
		how: asString(params.how),
		avoid: asString(params.avoid),
		notes: asString(params.notes),
		tags: asStringArray(params.tags),
		cues: asStringArray(params.cues),
		confidence: asNumber(params.confidence),
		evidence: Array.isArray(params.evidence) ? params.evidence : asStringArray(params.evidence),
		supersedes: asStringArray(params.supersedes),
		scope: scopeRaw ? { kind: asString(scopeRaw.kind) === "project" ? "project" : "global", path: asString(scopeRaw.path) } : undefined,
	};
}

export function registerMemoryTools(pi: ExtensionAPI, deps: ToolDeps): void {
	const { service } = deps;

	pi.registerTool({
		name: "memory_lookup",
		label: "Global memory lookup",
		description: [
			"Read the local, offline knowledge store of verified learnings (facts, research findings, proven fixes).",
			"Use BEFORE researching, debugging, or repeating a procedure: a record usually replaces a whole discovery loop.",
			"actions: search (query=2-4 keywords), read (ids=[...]) for full detail incl. evidence, catalog (ranked list), categories, stats, audit (accuracy findings).",
			"Records are past evidence, not live facts: if something contradicts one, use current evidence and report it (the store self-heals via memory_save verify/retire).",
		].join(" "),
		promptSnippet: "Read the local global-memory store (verified learnings) instead of re-researching: search/read/catalog/audit.",
		parameters: LookupParams,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const info = deps.runInfo();
			const posture = service.posture(info);
			if (!posture.use) {
				return textResult(
					`global memory usage is OFF for this session (${posture.reasons.join("; ")}). Continue without it; the user can re-enable with /memory use on.`,
					{ ok: false, action: asString(params.action) ?? "?" },
					true,
				);
			}
			const action = (asString(params.action) ?? "search").toLowerCase();
			try {
				switch (action) {
					case "search": {
						const query = asString(params.query) ?? "";
						if (!query) return textResult('search needs query, e.g. {"action":"search","query":"docker layer cache"}', { ok: false }, true);
						const res = await service.lookup(
							{
								text: query,
								limit: clamp(asNumber(params.limit) ?? 8, 1, 50),
								category: asString(params.category)?.toLowerCase(),
								kind: asString(params.kind) as GmKind | undefined,
								tags: asStringArray(params.tags),
								includeRetired: params.includeRetired === true,
								minConfidence: asNumber(params.minConfidence),
								scope: asString(params.scope) as "any" | "global" | "project" | undefined,
							},
							info,
						);
						if (res.total === 0) {
							return textResult(
								`no global-memory record matches "${truncate(query, 60)}". Do the work normally; if you learn something reusable, save it with memory_save.`,
								{ ok: true, ids: [], total: 0 },
							);
						}
						return textResult(
							`${res.text}\n\nNext: memory_lookup {"action":"read","ids":[...]} for the evidence and the exact procedure.`,
							{ ok: true, ids: res.ids, total: res.total, truncated: res.truncated },
						);
					}
					case "read": {
						const ids = asStringArray(params.ids).slice(0, 8);
						if (ids.length === 0) return textResult("read needs ids=[\"gm-...\"] (max 8).", { ok: false }, true);
						const res = service.readIds(ids, info);
						const missing = res.missing.length ? `\nnot loaded: ${res.missing.join(", ")}` : "";
						if (res.found.length === 0) return textResult(`none of ${ids.join(", ")} is available.${missing}`, { ok: false, ids }, true);
						return textResult(`${res.text}${missing}`, { ok: true, found: res.found, missing: res.missing });
					}
					case "catalog": {
						const res = service.catalog(info, clamp(asNumber(params.limit) ?? 40, 1, 200));
						return textResult(res.text, { ok: true, total: res.total, shown: res.shown });
					}
					case "categories": {
						const counts = service.store.counts();
						const line = Object.entries(counts.categories)
							.sort((a, b) => b[1] - a[1])
							.map(([c, n]) => `${c}(${n})`)
							.join(" ");
						return textResult(`categories with live records: ${line || "(none)"}`, { ok: true, categories: counts.categories });
					}
					case "stats": {
						const counts = service.store.counts();
						return textResult(
							`store ${service.store.root}: ${counts.active} active, ${counts.superseded} superseded, ${counts.retired} retired, ${counts.invalid} unreadable, ${counts.files} files, ${(counts.bytes / 1024).toFixed(1)} KB. writes this session: ${posture.writesUsed}/${posture.writesAllowed}. record=${posture.record} use=${posture.use}`,
							{ ok: true, counts, posture },
						);
					}
					case "audit": {
						const res = await service.audit(info);
						if (res.findings.length === 0) return textResult("accuracy audit: nothing to fix. The store looks consistent.", { ok: true, findings: 0 });
						return textResult(
							`accuracy audit (${res.findings.length} finding(s)):\n${res.text}\n\nFix the high-severity ones first: accuracy beats coverage. Use memory_save {"action":"verify"|"retire"|"update"} or /memory review.`,
							{ ok: true, findings: res.findings.length },
						);
					}
					default:
						return textResult(`unknown action "${action}". Use search, read, catalog, categories, stats, or audit.`, { ok: false }, true);
				}
			} catch (err) {
				return textResult(`memory_lookup failed: ${storeErrorText(err)}`, { ok: false }, true);
			}
		},
	});

	pi.registerTool({
		name: "memory_save",
		label: "Global memory save",
		description: [
			"Persist a verified learning so future sessions do not re-derive it. Recording can be switched off by the user, in which case this refuses.",
			"Rules: cite evidence (command/file/URL/session); no secrets, personal identifiers, transcripts, or guesses; hedged wording is refused; near-duplicates are refused in favour of updating the existing id.",
			"actions: add, update (id + changed fields), verify (id + note: you re-tested it), retire (ids=[...]: wrong or obsolete), restore (id: un-retire), supersede (id + supersedes).",
			"Retire or correct a record the moment live evidence contradicts it. A wrong memory is worse than none.",
		].join(" "),
		promptSnippet: "Save/correct/retire a verified learning in the local global-memory store (evidence required).",
		parameters: SaveParams,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const info = deps.runInfo();
			const posture = service.posture(info);
			const action = (asString(params.action) ?? "add").toLowerCase();
			if (!posture.record) {
				return textResult(
					`global memory recording is OFF (${posture.reasons.join("; ")}). Nothing was written. Do not retry: finish the task, and tell the user /memory record on enables it.`,
					{ ok: false, action, reason: posture.reasons },
					true,
				);
			}
			try {
				switch (action) {
					case "add": {
						const res = await service.add(draftFrom(params), info, { force: params.force === true, note: "memory_save add" });
						if (!res.ok || !res.record) {
							return textResult(
								`not saved.\n- ${res.problems.join("\n- ")}${res.notes.length ? `\nnotes: ${res.notes.join("; ")}` : ""}`,
								{ ok: false, problems: res.problems, twin: res.twin, quality: res.quality },
								true,
							);
						}
						return textResult(
							`saved ${res.id} (reliability ${res.quality}/10)${res.notes.length ? `\nnotes: ${res.notes.join("; ")}` : ""}${res.twin ? `\nheads-up: similar record ${res.twin.id} exists (similarity ${res.twin.sim.toFixed(2)}).` : ""}`,
							{ ok: true, id: res.id, quality: res.quality, twin: res.twin },
						);
					}
					case "update": {
						const id = asString(params.id);
						if (!id) return textResult("update needs id.", { ok: false }, true);
						const res = await service.update(id, draftFrom(params), info);
						if (!res.ok || !res.record) return textResult(`not updated.\n- ${res.problems.join("\n- ")}`, { ok: false, problems: res.problems }, true);
						return textResult(`updated ${res.id} (reliability ${res.quality}/10)`, { ok: true, id: res.id, quality: res.quality });
					}
					case "verify": {
						const id = asString(params.id);
						if (!id) return textResult("verify needs id (and a one-line note of what you re-tested).", { ok: false }, true);
						const res = await service.verify(id, asString(params.note) ?? "re-tested in a live run", info);
						return textResult(res.message, { ok: res.ok }, !res.ok);
					}
					case "retire": {
						const ids = asStringArray(params.ids).concat(asString(params.id) ? [asString(params.id) as string] : []);
						if (ids.length === 0) return textResult("retire needs ids=[\"gm-...\"] (or id).", { ok: false }, true);
						const res = await service.retire(ids, "memory_save retire");
						return textResult(
							`retired ${res.changed.join(", ") || "(none)"}${res.missing.length ? `; not found: ${res.missing.join(", ")}` : ""}. Retired records leave the catalog and the index immediately; the file stays under archive/ for git history.`,
							{ ok: true, changed: res.changed, missing: res.missing },
						);
					}
					case "restore": {
						const ids = asStringArray(params.ids).concat(asString(params.id) ? [asString(params.id) as string] : []);
						if (ids.length === 0) return textResult("restore needs id or ids=[\"gm-...\"].", { ok: false }, true);
						const res = await service.restore(ids, "memory_save restore");
						return textResult(
							`restored ${res.changed.join(", ") || "(none)"}${res.missing.length ? `; not found: ${res.missing.join(", ")}` : ""}. Restored records re-enter the catalog and the search index on the next refresh.`,
							{ ok: true, changed: res.changed, missing: res.missing },
						);
					}
					case "supersede": {
						const id = asString(params.id);
						const losers = asStringArray(params.supersedes);
						if (!id || losers.length === 0) return textResult("supersede needs id (the keeper) and supersedes=[ids that were wrong or are now outdated].", { ok: false }, true);
						const res = await service.supersede(id, losers);
						return textResult(res.message, { ok: res.ok }, !res.ok);
					}
					default:
						return textResult(`unknown action "${action}". Use add, update, verify, retire, restore, or supersede.`, { ok: false }, true);
				}
			} catch (err) {
				return textResult(`memory_save failed: ${storeErrorText(err)}`, { ok: false }, true);
			}
		},
	});
}
