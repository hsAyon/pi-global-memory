/**
 * pi-global-memory - indexed, budgeted, on-demand global memory for pi.
 *
 * Read side: a small catalog plus per-run relevant records injected as two
 * separate prompt sections, and `memory_lookup` for on-demand retrieval.
 * Write side: `memory_save`, reviewable capture from real failures, and an
 * accuracy engine that disputes records live evidence contradicts.
 *
 * Offline by construction: node builtins only, no network, no model calls, no
 * background services. See docs/SECURITY.md and test/offline.test.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GmConfig } from "./lib/types.ts";
import { defaultStoreDir, resolveConfig } from "./lib/config.ts";
import { MemoryStore } from "./lib/store.ts";
import { MemoryService, storeErrorText, type RunInfo } from "./lib/service.ts";
import { registerMemoryTools } from "./lib/tools.ts";
import { handleMemoryCommand, type CommandDeps } from "./lib/commands.ts";
import { buildCatalogSection, buildHitsSection, CATALOG_SECTION, HITS_SECTION } from "./lib/prompt.ts";
import { renderCatalog } from "./lib/search.ts";
import { RunLedger, candidateToDraft } from "./lib/capture.ts";
import { classifyCall } from "./lib/heal.ts";
import { displayPath, parseJsonSafe, writeFileAtomic } from "./lib/util.ts";

export const VERSION = "0.1.0";

interface SessionState {
	info: RunInfo;
	ledger: RunLedger;
	healed: { disputes: number; confirms: number };
	captured: string[];
	announced: boolean;
}

function readConfigFile(dir: string): { value?: Record<string, unknown>; problem?: string } {
	const file = path.join(dir, "config.json");
	let text: string;
	try {
		if (!fs.existsSync(file)) return {};
		const st = fs.statSync(file);
		if (st.size > 64_000) return { problem: `${file} is larger than 64 KB; ignoring it` };
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { problem: `cannot read ${file}: ${String((err as Error)?.message ?? err)}` };
	}
	const parsed = parseJsonSafe<unknown>(text, null);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: `${file} is not a JSON object` };
	const value: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (k.startsWith("$") || k.startsWith("_")) continue;
		value[k] = v;
	}
	return { value };
}

function textOfContent(content: unknown): string {
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

/** pi --no-session keeps a session in memory: no file, but real entries. */
function detectEphemeral(ctx: ExtensionContext): boolean {
	try {
		const sm = ctx.sessionManager as unknown as { getSessionFile?: () => string | undefined; getBranch?: () => unknown[] };
		const file = typeof sm.getSessionFile === "function" ? sm.getSessionFile() : undefined;
		if (file) return false;
		const branch = typeof sm.getBranch === "function" ? sm.getBranch() : [];
		for (const entry of branch) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			if (e.type !== "message") continue;
			const msg = e.message as Record<string, unknown> | undefined;
			const role = String(msg?.role ?? "");
			if (role === "user" || role === "assistant") return true;
		}
		return false;
	} catch {
		return false;
	}
}

export default function globalMemoryExtension(pi: ExtensionAPI): void {
	// --- configuration: env > settings.json:globalMemory > <store>/config.json ---
	const env = process.env;
	const preliminaryDir = env.PI_GLOBAL_MEMORY_DIR && env.PI_GLOBAL_MEMORY_DIR.trim() ? path.resolve(env.PI_GLOBAL_MEMORY_DIR.trim()) : defaultStoreDir(env);
	const fileCfg = readConfigFile(preliminaryDir);
	let settings: unknown;
	try {
		settings = pi.getSettings() as unknown;
	} catch {
		settings = undefined;
	}
	const resolved = resolveConfig({ env, settings, file: fileCfg.value });
	let cfg: GmConfig = resolved.config;
	const configProblems = [...resolved.problems, ...(fileCfg.problem ? [fileCfg.problem] : [])];

	const store = new MemoryStore(cfg.dir, cfg);
	const service = new MemoryService(cfg, store);

	let state: SessionState = {
		info: { cwd: process.cwd(), sessionId: "unknown", projectTrusted: true, ephemeral: false, hasUI: false, mode: "unknown" },
		ledger: new RunLedger({ maxCandidates: 40, sessionId: "unknown" }),
		healed: { disputes: 0, confirms: 0 },
		captured: [],
		announced: false,
	};

	function makeInfo(ctx: ExtensionContext): RunInfo {
		const sm = ctx.sessionManager as unknown as { getSessionId?: () => string; getSessionFile?: () => string | undefined };
		const info: RunInfo = {
			cwd: ctx.cwd,
			sessionId: typeof sm.getSessionId === "function" ? sm.getSessionId() : "unknown",
			sessionFile: typeof sm.getSessionFile === "function" ? sm.getSessionFile() : undefined,
			projectTrusted: safeTrusted(ctx),
			ephemeral: detectEphemeral(ctx),
			hasUI: ctx.hasUI,
			mode: ctx.mode,
		};
		state.info = info;
		return info;
	}

	function safeTrusted(ctx: ExtensionContext): boolean {
		try {
			return ctx.isProjectTrusted();
		} catch {
			// Fail closed: unknown trust means no writes.
			return false;
		}
	}

	function applyConfig(next: GmConfig): void {
		cfg = next;
		service.cfg = next;
		store.updateConfig(next);
		service.ensureStore();
	}

	function updateStatus(ctx?: ExtensionContext): void {
		if (!cfg.enabled || !cfg.statusLine || !ctx?.hasUI) {
			try {
				ctx?.ui.setStatus("global-memory", undefined);
			} catch {
				/* no UI in this mode */
			}
			return;
		}
		try {
			ctx.ui.setStatus("global-memory", service.statusSummary(state.info));
		} catch {
			/* non-fatal */
		}
	}

	function writeConfigPatch(patch: Record<string, unknown>): { ok: boolean; message: string } {
		const parsedPatch = parsePatchValues(patch);
		const nextFile = { ...(fileCfg.value ?? {}), ...parsedPatch };
		const file2 = path.join(cfg.dir, "config.json");
		try {
			writeFileAtomic(file2, `${JSON.stringify(nextFile, null, 1)}\n`);
			fileCfg.value = nextFile;
			const reread = resolveConfig({ env, settings, file: nextFile });
			applyConfig(reread.config);
			configProblems.length = 0;
			configProblems.push(...reread.problems);
			return { ok: reread.problems.length === 0, message: `wrote ${file2}${reread.problems.length ? `; problems: ${reread.problems.join("; ")}` : ""}` };
		} catch (err) {
			return { ok: false, message: storeErrorText(err) };
		}
	}

	function parsePatchValues(patch: Record<string, unknown>): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [key, raw] of Object.entries(patch)) {
			// /memory config set sends strings; resolveConfig does the typed coercion.
			out[key] = typeof raw === "string" ? coerceRaw(raw) : raw;
		}
		return out;
	}

	function coerceRaw(raw: string): unknown {
		const s = raw.trim();
		if (s === "true") return true;
		if (s === "false") return false;
		if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
		return s;
	}

	// --- tools and command ---
	registerMemoryTools(pi, { service, runInfo: () => state.info });

	pi.registerCommand("memory", {
		description: "Global memory: status, on/off, search, catalog, audit, review, config (local, offline store)",
		handler: async (args, ctx) => {
			makeInfo(ctx);
			const deps: CommandDeps = {
				service,
				runInfo: () => state.info,
				configProblems: () => configProblems,
				configSources: () => resolved.sources,
				writeConfig: writeConfigPatch,
				toggleStatus: () => updateStatus(ctx),
				version: VERSION,
			};
			try {
				await handleMemoryCommand(args, ctx, deps);
			} catch (err) {
				ctx.ui.notify(`memory command failed: ${storeErrorText(err)}`, "error");
			}
		},
	});

	// --- CLI flags: opt in per invocation, and a hard disable for the session ---
	pi.registerFlag("no-global-memory", { description: "Disable pi-global-memory for this process", type: "boolean", default: false });
	pi.registerFlag("global-memory-record", { description: "global memory recording: on|off", type: "string" });
	pi.registerFlag("global-memory-use", { description: "global memory usage (read + injection): on|off", type: "string" });

	// --- lifecycle ---
	pi.on("session_start", async (_event, ctx) => {
		const flagOff = pi.getFlag("no-global-memory") === true;
		if (flagOff) applyConfig({ ...cfg, enabled: false });
		const recFlag = String(pi.getFlag("global-memory-record") ?? "").toLowerCase();
		const useFlag = String(pi.getFlag("global-memory-use") ?? "").toLowerCase();
		if (recFlag === "off" || useFlag === "off") {
			applyConfig({ ...cfg, record: recFlag === "off" ? false : cfg.record, use: useFlag === "off" ? false : cfg.use });
		} else if (recFlag === "on" || useFlag === "on") {
			applyConfig({ ...cfg, record: recFlag === "on" ? true : cfg.record, use: useFlag === "on" ? true : cfg.use });
		}

		makeInfo(ctx);
		service.beginSession();
		state.ledger = new RunLedger({ maxCandidates: 40, sessionId: state.info.sessionId });
		state.healed = { disputes: 0, confirms: 0 };
		state.captured = [];
		state.announced = false;
		if (!cfg.enabled) {
			if (ctx.hasUI) ctx.ui.notify("pi-global-memory: disabled (config enabled=false or --no-global-memory)", "info");
			return;
		}
		try {
			service.ensureStore();
			await service.refresh(true);
		} catch (err) {
			ctx.ui.notify(`pi-global-memory could not open ${displayPath(cfg.dir)}: ${storeErrorText(err)}`, "error");
			applyConfig({ ...cfg, enabled: false });
			return;
		}
		updateStatus(ctx);
		if (ctx.hasUI) {
			const counts = store.counts();
			const p = service.posture(state.info);
			ctx.ui.notify(
				`global memory: ${counts.active} record(s) in ${displayPath(cfg.dir)} | use=${p.use} record=${p.record}${p.reasons.length ? ` (${p.reasons[0]})` : ""} | /memory help`,
				"info",
			);
			if (configProblems.length > 0) ctx.ui.notify(`global memory config: ${configProblems.join("; ")}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			await service.flush();
		} catch {
			/* best effort */
		}
		store.invalidate();
	});

	// --- read side: two budgeted sections, kept apart so pi can diff them ---
	pi.on("before_agent_start", async (event, ctx) => {
		makeInfo(ctx);
		const info = state.info;
		if (event.messageType !== "user") return;
		if (!cfg.enabled || !cfg.use) {
			// Withdraw the tools rather than let the model call into a refused store.
			syncActiveTools(false);
			return;
		}
		syncActiveTools(true);
		await service.refresh();
		const posture = service.posture(info);
		const sections = (event.systemPromptOptions as { sections?: Record<string, string> }).sections;
		if (!sections) (event.systemPromptOptions as Record<string, unknown>).sections = {};
		const target = (event.systemPromptOptions as { sections: Record<string, string> }).sections;

		if (cfg.inject !== "off") {
			const scoped = store.cacheRecords().filter((r) => r.status !== "retired");
			const cat = renderCatalog(scoped, cfg);
			const section = buildCatalogSection({
				cfg,
				records: scoped,
				storeDir: cfg.dir,
				cwd: info.cwd,
				catalogLines: cat.text ? cat.text.split("\n") : [],
				catalogTotal: cat.total,
				catalogShown: cat.shown,
			});
			if (section) target[CATALOG_SECTION] = section;
			else delete target[CATALOG_SECTION];
		}

		if (cfg.inject === "catalog+hits") {
			const hits = service.hitsForPrompt(event.prompt ?? "", info);
			const byId = new Map(store.cacheRecords().map((r) => [r.id, r] as const));
			const section = buildHitsSection({ cfg, hits, records: byId });
			if (section) target[HITS_SECTION] = `${section}\n${posture.record ? "" : "(recording is off right now: report a correction instead of saving it)"}`.trim();
			else delete target[HITS_SECTION];
		}
	});

	function syncActiveTools(want: boolean): void {
		try {
			const active = pi.getActiveTools();
			const names = ["memory_lookup", "memory_save"];
			const has = names.every((n) => active.includes(n));
			if (want && !has) pi.setActiveTools([...active, ...names.filter((n) => !active.includes(n))]);
			if (!want && has) pi.setActiveTools(active.filter((n) => !names.includes(n)));
		} catch {
			/* tool set sync is best effort */
		}
	}

	// --- self-heal + capture: watch real tool outcomes ---
	pi.on("agent_start", async () => {
		state.ledger = new RunLedger({ maxCandidates: 40, sessionId: state.info.sessionId });
		state.healed = { disputes: 0, confirms: 0 };
		state.captured = [];
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled) return;
		const info = makeInfo(ctx);
		const posture = service.posture(info);
		const toolName = event.toolName;
		if (toolName === "memory_lookup" || toolName === "memory_save") return;

		const input = (event.input ?? {}) as Record<string, unknown>;
		const contentText = textOfContent(event.content);

		if (posture.record && cfg.signals) {
			state.ledger.observe({ toolName, input, isError: event.isError, text: contentText, atMs: Date.now(), callId: event.toolCallId });
		}

		if (cfg.selfHeal === "off") return;
		const records = store.cacheRecords();
		if (records.length === 0) return;
		const cls = classifyCall(records, toolName, input, event.isError ? "error" : "success");
		if (cls.dispute.length > 0 && cfg.selfHeal !== "off") {
			service.queueDispute(cls.dispute.map((d) => d.rec.id));
			state.healed.disputes += cls.dispute.length;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`global memory: DISPUTING ${cls.dispute.map((d) => d.rec.id).join(", ")} - ${cls.dispute[0].why}. Re-test and run /memory verify, or retire it.`,
					"warning",
				);
			}
		}
		if (cls.confirm.length > 0 && cfg.autoVerify) {
			service.queueVerify(cls.confirm.map((c) => c.rec.id));
			state.healed.confirms += cls.confirm.length;
		}
	});

	// --- end of run: persist what the run proved, then prune the noise ---
	pi.on("agent_end", async (_event, ctx) => {
		if (!cfg.enabled) return;
		const info = makeInfo(ctx);
		const posture = service.posture(info);
		let written: string[] = [];
		if (posture.record && cfg.autoCapture === "fixes") {
			for (const c of state.ledger.candidates()) {
				if (!c.provenFix) continue;
				if (state.captured.includes(c.fingerprint)) continue;
				const res = await service.add(candidateToDraft(c, info.cwd, info.sessionId), info, { autoFlags: ["auto"], note: "auto-capture: proven fix" });
				if (res.ok && res.id) {
					written.push(res.id);
					state.captured.push(c.fingerprint);
				}
			}
		}
		if (posture.record && cfg.signals) {
			for (const sig of state.ledger.signals()) {
				try {
					await store.appendSignal(sig);
				} catch {
					/* the ledger is a convenience, not a correctness path */
				}
			}
		}
		let heal: { stats: number; verify: number; dispute: number } = { stats: 0, verify: 0, dispute: 0 };
		try {
			heal = await service.flush();
		} catch {
			/* next run retries; never break the session over a write failure */
		}
		if (ctx.hasUI && (written.length > 0 || heal.dispute > 0 || heal.verify > 0)) {
			const parts: string[] = [];
			if (written.length > 0) parts.push(`captured ${written.length} learning(s): ${written.join(", ")}`);
			if (heal.dispute > 0) parts.push(`disputed ${heal.dispute}`);
			if (heal.verify > 0) parts.push(`re-verified ${heal.verify}`);
			ctx.ui.notify(`global memory: ${parts.join("; ")}`, "info");
		}
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		makeInfo(ctx);
		await service.refresh();
		updateStatus(ctx);
	});

	if (cfg.toggleShortcut) {
		try {
			pi.registerShortcut(cfg.toggleShortcut as never, {
				description: "Toggle global memory use+recording for this session",
				handler: (ctx) => {
					const p = service.posture(state.info);
					const next = !(p.use && p.record);
					service.overrides.use = next;
					service.overrides.record = next;
					updateStatus(ctx);
					if (ctx.hasUI) ctx.ui.notify(`global memory: ${next ? "ON" : "OFF"} for this session`, "info");
				},
			});
		} catch (err) {
			configProblems.push(`toggleShortcut "${cfg.toggleShortcut}" is not a valid keybinding id: ${String((err as Error)?.message ?? err)}`);
		}
	}

	// Nothing here opens a socket, timer, or watcher. The only process this
	// extension can start is a local git add/commit, and only when the operator
	// opts in with gitAutoCommit (with git's network protocol layer disabled).
}
