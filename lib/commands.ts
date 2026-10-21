/**
 * `/memory` - the user-facing control surface.
 *
 * Priorities, in order: make the two privacy toggles one keystroke away, make
 * the store inspectable without dumping it into context, and never let a
 * destructive action happen without a confirmation in interactive mode.
 *
 * Long output is written to a file under the store and previewed, never streamed
 * into the transcript: a 200-line catalog does not belong in the context window.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MemoryService, storeErrorText, type RunInfo } from "./service.ts";
import { candidateToDraft, mineBranch } from "./capture.ts";
import { configKeys, parseConfigPatch } from "./config.ts";
import { hintFor, renderConfigList, renderExplain, specFor } from "./configspec.ts";
import { CONTAINER_MAGIC, describeContainer, inspectContainer } from "./container.ts";
import { browseInteractive, commitDeleteAll, containerPath, renderListing, renderOverview, type SortKey } from "./browse.ts";
import { displayPath, tightenMode, truncate } from "./util.ts";
import { CONFIG_DEFAULTS } from "./types.ts";
import { VERIFIED_PI_VERSION } from "./version.ts";

export interface CommandDeps {
	service: MemoryService;
	runInfo: () => RunInfo;
	configProblems: () => string[];
	configSources: () => string[];
	writeConfig: (patch: Record<string, unknown>) => { ok: boolean; message: string };
	toggleStatus: () => void;
	version: string;
}

export function tokenizeArgs(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(input)) !== null) {
		const v = m[1] ?? m[2] ?? m[3] ?? "";
		if (v !== "") out.push(v);
	}
	return out;
}

/** Deliver text without putting it in model context. */
function deliver(ctx: ExtensionCommandContext, service: MemoryService, title: string, body: string): void {
	const text = body.trim() === "" ? "(no output)" : body;
	if (ctx.mode !== "tui") {
		process.stdout.write(`${title}\n${text}\n`);
		return;
	}
	const dir = path.join(service.store.root, "out");
	let file = "";
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		file = path.join(dir, `${title.replace(/[^\w-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
		fs.writeFileSync(file, `${title}\n\n${text}\n`, { mode: 0o600 });
	} catch {
		file = "(could not write the file; showing the head only)";
	}
	const head = text.split("\n").slice(0, 12).join("\n");
	const more = text.split("\n").length > 12 ? `\n... ${text.split("\n").length - 12} more lines` : "";
	ctx.ui.notify(`${title}\n${head}${more}\nfull output: ${file}`, "info", );
}

async function confirmDestructive(ctx: ExtensionCommandContext, service: MemoryService, title: string, body: string, force: boolean): Promise<boolean> {
	if (force) return true;
	if (!service.cfg.confirmDestructive) return true;
	if (!ctx.hasUI) {
		ctx.ui.notify(`refusing ${title} without confirmation: re-run with the word "force" and haveUI, or set confirmDestructive true`, "error");
		return false;
	}
	return await ctx.ui.confirm(title, body);
}

export async function handleMemoryCommand(rawArgs: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
	const args = tokenizeArgs(rawArgs ?? "");
	const sub = (args[0] ?? "status").toLowerCase();
	const rest = args.slice(1);
	const { service } = deps;
	const info = deps.runInfo();

	switch (sub) {
		case "help":
		case "?": {
			deliver(
				ctx,
				service,
				"memory-help",
				[
					"/memory status                 posture, paths, counts, config sources",
					"/memory on | off               session toggle for BOTH use and recording (off = nothing read, nothing written)",
					"/memory use on|off             read side only (tool + prompt injection)",
					"/memory record on|off          write side only (model saves, auto-capture, command writes)",
					"/memory pause                  recording off for the rest of this session",
					"/memory toggle                 flip the current posture",
					"/memory search <keywords>      query the store",
					"/memory catalog [limit]        ranked catalog (written to a file, not into context)",
					"/memory read <id> [<id>...]    full records incl. evidence",
					"/memory audit                  accuracy findings: disputed, stale, hedged, duplicate, private",
					"/memory review                 failed calls seen this session, with proven fixes",
					"/memory accept [n]             turn reviewed failures/fixes into records (mined from this session)",
					"/memory verify <id> [note]     assert you re-tested it: clears a dispute, can raise confidence",
					"/memory retire <id>...         stop using a record (file moves to archive/, reversible)",
					"/memory restore <id>...",
					"/memory merge <keep> <drop>... winner absorbs the losers as superseded",
					"/memory delete <id>... force   permanent removal (needs confirmation; git history keeps the copy)",
					"/memory prune                    propose retirement of expired/low-value records",
					"/memory doctor                   structural and privacy scan of the store",
					"/memory config [list|get k|set k v|reset]",
					"/memory export [file] | /memory import <file>",
					"/memory reindex | /memory selftest",
					"",
					"/memory ls [category] [sort=value|updated|created|hits|confidence|age] [retired]",
				"                               one line per record: id, confidence, hits, age, warnings",
				"/memory overview                 per-category counts, disputed and never-verified totals",
				"/memory browse [category]        interactive: pick a record, then verify / retire / restore / delete it",
				"/memory delete-all               EVERY record: needs a typed token, always writes a container backup first",
				"/memory inspect <file> [passphrase=]   what a container holds, is it authenticated - without importing",
				"/memory export [file] [all] [category=<slug>] [enc] [note=<text>] [allowprivate]",
				"                               compressed integrity-checked container (.gmect); enc = AES-256-GCM",
				"/memory import <file> [passphrase=<text>]   container or plain JSON; records re-pass the write gates",
				"/memory config list | explain <key> | get <key> | set <key> <value> | where",
				"",
				`Privacy posture now: privacy=${service.cfg.privacy} sketchy=${service.cfg.sketchy} respectSessionPrivacy=${service.cfg.respectSessionPrivacy} requireProjectTrust=${service.cfg.requireProjectTrustForWrites}`,
					"Defaults are private and reliable-only: personal identifiers, confidential-sounding text, and hedged claims are refused. Relax with /memory config set privacy standard|off and sketchy flag|off.",
				].join("\n"),
			);
			return;
		}

		case "on":
			service.overrides.use = true;
			service.overrides.record = true;
			deps.toggleStatus();
			ctx.ui.notify("global memory: ON for this session (use + record). Durable default: /memory config set use true / record true.", "info");
			return;
		case "off":
			service.overrides.use = false;
			service.overrides.record = false;
			deps.toggleStatus();
			ctx.ui.notify("global memory: OFF for this session. Nothing is read or written. (Already-written records stay on disk; /memory delete removes them.)", "warning");
			return;
		case "use": {
			const v = (rest[0] ?? "").toLowerCase();
			service.overrides.use = v === "on" || v === "true" ? true : v === "off" || v === "false" ? false : undefined;
			deps.toggleStatus();
			ctx.ui.notify(`global memory read: ${service.overrides.use === undefined ? "config default" : service.overrides.use ? "on" : "off"}`, "info");
			return;
		}
		case "record": {
			const v = (rest[0] ?? "").toLowerCase();
			service.overrides.record = v === "on" || v === "true" ? true : v === "off" || v === "false" ? false : undefined;
			deps.toggleStatus();
			ctx.ui.notify(`global memory recording: ${service.overrides.record === undefined ? "config default" : service.overrides.record ? "on" : "off"}`, "info");
			return;
		}
		case "pause":
			service.overrides.record = false;
			deps.toggleStatus();
			ctx.ui.notify("global memory recording paused for this session. /memory record on resumes.", "info");
			return;
		case "toggle": {
			const p = service.posture(info);
			const next = !(p.use && p.record);
			service.overrides.use = next;
			service.overrides.record = next;
			deps.toggleStatus();
			ctx.ui.notify(`global memory: ${next ? "ON" : "OFF"} for this session`, "info");
			return;
		}

		case "status": {
			const p = service.posture(info);
			const git = await service.store.gitStatus();
			const lines = [
				`global-memory v${deps.version}`,
				`enabled=${service.cfg.enabled} use=${p.use} record=${p.record}`,
				...(p.reasons.length ? [`why: ${p.reasons.join("; ")}`] : []),
				`store: ${service.store.root} (ephemeral-session guard=${service.cfg.respectSessionPrivacy ? "on" : "off"}, projectTrustRequired=${service.cfg.requireProjectTrustForWrites ? "on" : "off"})`,
				`verified against pi ${VERIFIED_PI_VERSION}, this build is ${deps.version}`,
				service.statusSummary(info),
				`writes this session: ${p.writesUsed}/${p.writesAllowed}; quota-blocked=${!service.posture(info).record && p.writesUsed >= service.cfg.maxWritesPerSession}`,
				`session: id=${info.sessionId} file=${info.sessionFile ?? "(in-memory)"} ephemeral=${info.ephemeral} trusted=${info.projectTrusted} mode=${info.mode}`,
				`privacy=${service.cfg.privacy} sketchy=${service.cfg.sketchy} minQuality=${service.cfg.minQuality} redactSecrets=${service.cfg.redactSecrets}`,
				`injection: mode=${service.cfg.inject} catalogMaxChars=${service.cfg.catalogMaxChars} hitsMaxChars=${service.cfg.hitsMaxChars} maxIndexEntries=${service.cfg.maxIndexEntries}`,
				`capture: autoCapture=${service.cfg.autoCapture} signals=${service.cfg.signals}; accuracy: selfHeal=${service.cfg.selfHeal} autoVerify=${service.cfg.autoVerify}`,
				`git: ${git.usable ? `work tree, ${git.dirty} uncommitted, HEAD "${git.head}"${service.cfg.gitAutoCommit ? ", autoCommit on" : ", autoCommit off"}` : "not a git work tree"}`,
				`config sources: ${deps.configSources().join(" > ")}`,
				...(deps.configProblems().length ? [`config problems: ${deps.configProblems().join("; ")}`] : []),
			];
			deliver(ctx, service, "memory-status", lines.join("\n"));
			return;
		}

		case "search": {
			if (rest.length === 0) {
				ctx.ui.notify("usage: /memory search <keywords>", "error");
				return;
			}
			const res = await service.lookup({ text: rest.join(" "), limit: 15 }, info);
			deliver(ctx, service, "memory-search", res.text);
			return;
		}
		case "catalog":
		case "index": {
			const limit = Number(rest[0] ?? 200);
			const res = service.catalog(info, Number.isFinite(limit) ? limit : 200);
			deliver(ctx, service, "memory-catalog", res.text);
			return;
		}
		case "read": {
			if (rest.length === 0) {
				ctx.ui.notify("usage: /memory read <id> [<id>...]", "error");
				return;
			}
			const res = service.readIds(rest, info);
			deliver(ctx, service, "memory-read", `${res.text}${res.missing.length ? `\nmissing: ${res.missing.join(", ")}` : ""}`);
			return;
		}
		case "audit": {
			const res = await service.audit(info);
			deliver(ctx, service, "memory-audit", res.text || "accuracy audit: no findings. The store is consistent.");
			if (res.findings.length > 0) ctx.ui.notify(`accuracy audit: ${res.findings.length} finding(s) - full list in the out/ file`, "warning");
			return;
		}
		case "review": {
			const mined = mineBranch(ctx.sessionManager.getBranch(), info.sessionId);
			const signals = service.store.listSignals();
			const lines = [
				`this session: ${mined.candidates.length} candidate(s) from failed tool calls`,
				...mined.candidates
					.slice(0, 25)
					.map((c) => `- [${c.provenFix ? "proven fix" : "unresolved"}] ${c.category} ${c.toolName}: "${truncate(c.failing, 90)}" failed ${c.failures}x${c.succeeding ? ` -> "${truncate(c.succeeding, 90)}" worked` : ""}`),
				"",
				`pending signal ledger on disk: ${signals.length}`,
				...signals.slice(0, 15).map((s) => `- ${s.fingerprint} ${s.summary} x${s.count}${s.resolved ? " (resolved)" : ""}`),
				"",
				"Accept the ones worth keeping: /memory accept all|<n>",
			];
			deliver(ctx, service, "memory-review", lines.join("\n"));
			return;
		}
		case "accept": {
			const picked = (rest[0] ?? "all").toLowerCase();
			const mined = mineBranch(ctx.sessionManager.getBranch(), info.sessionId);
			const wanted = mined.candidates.filter((c) => (picked === "all" ? true : picked === "fixes" ? c.provenFix : Number.isFinite(Number(picked)) ? mined.candidates.indexOf(c) === Number(picked) - 1 : c.fingerprint === picked));
			if (wanted.length === 0) {
				ctx.ui.notify("nothing matched to accept. /memory review first.", "warning");
				return;
			}
			const ok = await confirmDestructive(ctx, service, "memory-accept", `write ${wanted.length} record(s) from this session's evidence?`, false);
			if (!ok) return;
			const written: string[] = [];
			const rejected: string[] = [];
			for (const c of wanted) {
				const res = await service.add(candidateToDraft(c, info.cwd, info.sessionId), info, { autoFlags: ["auto"], note: "accept from /memory review" });
				if (res.ok && res.id) written.push(res.id);
				else rejected.push(`${c.fingerprint}: ${res.problems[0] ?? "rejected"}`);
			}
			if (written.length > 0) await service.store.clearSignals(wanted.map((c) => c.fingerprint));
			deliver(ctx, service, "memory-accept", [`accepted ${written.length} record(s): ${written.join(", ")}`, ...(rejected.length ? [`rejected: ${rejected.join("; ")}`] : [])].join("\n"));
			deps.toggleStatus();
			return;
		}
		case "verify": {
			const id = rest[0];
			if (!id) {
				ctx.ui.notify("usage: /memory verify <id> [what you re-tested]", "error");
				return;
			}
			const res = await service.verify(id, rest.slice(1).join(" ") || "verified by the user via /memory verify", info);
			ctx.ui.notify(res.message, res.ok ? "info" : "error");
			return;
		}
		case "retire": {
			if (rest.length === 0) {
				ctx.ui.notify("usage: /memory retire <id> [<id>...]", "error");
				return;
			}
			const res = await service.retire(rest, "user /memory retire");
			ctx.ui.notify(`retired: ${res.changed.join(", ") || "(none)"}${res.missing.length ? `; not found: ${res.missing.join(", ")}` : ""}`, "info");
			deps.toggleStatus();
			return;
		}
		case "restore": {
			if (rest.length === 0) {
				ctx.ui.notify("usage: /memory restore <id> [<id>...]", "error");
				return;
			}
			const res = await service.restore(rest);
			ctx.ui.notify(`restored: ${res.changed.join(", ") || "(none)"}`, "info");
			return;
		}
		case "merge": {
			if (rest.length < 2) {
				ctx.ui.notify("usage: /memory merge <keeper-id> <loser-id> [<loser-id>...]", "error");
				return;
			}
			const res = await service.supersede(rest[0], rest.slice(1));
			ctx.ui.notify(res.message, res.ok ? "info" : "error");
			return;
		}
		case "delete": {
			const force = rest.includes("force");
			const ids = rest.filter((a) => a !== "force");
			if (ids.length === 0) {
				ctx.ui.notify('usage: /memory delete <id> [<id>...] force   (permanent; git history still holds the copy)', "error");
				return;
			}
			const ok = await confirmDestructive(ctx, service, "memory-delete", `PERMANENTLY delete ${ids.length} record(s): ${ids.join(", ")}?`, force);
			if (!ok) return;
			const res = await service.store.hardDelete(ids, `user deleted ${ids.length} record(s)`);
			await service.refresh(true);
			ctx.ui.notify(`deleted: ${res.deleted.join(", ") || "(none)"}${res.missing.length ? `; not found: ${res.missing.join(", ")}` : ""}`, "warning");
			deps.toggleStatus();
			return;
		}
		case "ls":
		case "list":
		case "overview": {
			// The high-level view, written to a file rather than dumped into context.
			const opts = parseOptions(rest);
			const first = rest[0] && !rest[0].includes("=") ? rest[0] : undefined;
			const category = opts.values.category ?? first;
			const sort = (opts.values.sort as SortKey | undefined) ?? "value";
			const body = sub === "overview" && !category ? renderOverview(service) : renderListing(service, { category, sort, includeRetired: opts.flags.has("retired"), query: opts.values.where });
			deliver(ctx, service, "memory-ls", body);
			ctx.ui.notify("act on one record: /memory read <id> - verify <id> - retire <id> - delete <id> force, or /memory browse to pick interactively", "info");
			return;
		}
		case "browse": {
			const opts = parseOptions(rest);
			await browseInteractive(ctx, service, { runInfo: deps.runInfo, refreshStatus: deps.toggleStatus }, opts.values.category ?? rest[0]);
			deps.toggleStatus();
			return;
		}
		case "inspect": {
			// Look at a container without importing anything: what is in it, is it encrypted,
			// does it verify. Useful before trusting a file somebody sent you.
			const opts = parseOptions(rest);
			const file = opts.positional[0];
			if (!file) {
				ctx.ui.notify("usage: /memory inspect <file.gmect> [passphrase=<text>]", "error");
				return;
			}
			const pw = resolvePassphrase(opts, false);
			try {
				const text = fs.readFileSync(file, "utf8");
				const info = inspectContainer(text);
				const bits = [`container: ${describeContainer(text, pw.passphrase)}`];
				if (info.encrypted && !pw.passphrase) bits.push("metadata is readable; a passphrase is needed to see the records");
				if (!info.encrypted) bits.push("importing this file re-runs every write gate, so a hostile file cannot inject a record the rules would refuse");
				ctx.ui.notify(bits.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(`cannot inspect: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			return;
		}

		case "delete-all": {
			// Two-step and token-gated, always backed up. confirmDestructive cannot bypass it.
			const token = rest.find((a) => /^[0-9A-Fa-f]{6}$/.test(a));
			const res = await commitDeleteAll(service, info, token);
			ctx.ui.notify(res.message, res.ok ? "warning" : "error");
			deps.toggleStatus();
			return;
		}
		case "prune": {
			const findings = await service.audit(info);
			const retireable = findings.findings.filter((f) => f.action === "retire");
			if (retireable.length === 0) {
				ctx.ui.notify("prune: nothing expired or low-value.", "info");
				return;
			}
			const ok = await confirmDestructive(
				ctx,
				service,
				"memory-prune",
				`retire ${retireable.length} record(s)?\n${retireable.slice(0, 8).map((f) => `- ${f.id} ${f.issue}`).join("\n")}`,
				rest.includes("force"),
			);
			if (!ok) return;
			const res = await service.retire(retireable.map((f) => f.id), "prune");
			ctx.ui.notify(`pruned (retired) ${res.changed.length} record(s)`, "info");
			deps.toggleStatus();
			return;
		}
		case "doctor": {
			const rep = await service.store.doctor();
			const privacy = await service.audit(info);
			const privacyFindings = privacy.findings.filter((f) => f.issue === "private-content" || f.issue === "hedged-wording");
			deliver(
				ctx,
				service,
				"memory-doctor",
				[
					`problems (${rep.problems.length}):`,
					...(rep.problems.length ? rep.problems.map((p) => `- ${p}`) : ["- none"]),
					`notes (${rep.notes.length}):`,
					...(rep.notes.length ? rep.notes.map((n) => `- ${n}`) : ["- none"]),
					`privacy/reliability findings (${privacyFindings.length}):`,
					...(privacyFindings.length ? privacyFindings.map((f) => `- [${f.severity}] ${f.id} ${f.issue}: ${truncate(f.detail, 160)}`) : ["- none"]),
				].join("\n"),
			);
			if (rep.problems.length > 0) ctx.ui.notify(`memory store doctor found ${rep.problems.length} problem(s)`, "warning");
			return;
		}
		case "config": {
			const what = (rest[0] ?? "list").toLowerCase();
			if (what === "list") {
				deliver(ctx, service, "memory-config", renderConfigList(service.cfg, deps.configSources(), deps.configProblems()));
				return;
			}
			if (what === "explain") {
				const key = rest[1] ?? "";
				if (!key) {
					deliver(ctx, service, "memory-config", renderConfigList(service.cfg, deps.configSources(), deps.configProblems()));
					return;
				}
				ctx.ui.notify(renderExplain(key), specFor(key) ? "info" : "error");
				return;
			}
			if (what === "get") {
				const key = rest[1] as keyof typeof CONFIG_DEFAULTS;
				if (!key) {
					ctx.ui.notify("usage: /memory config get <key>    (list keys: /memory config list)", "error");
					return;
				}
				ctx.ui.notify(`${key} = ${JSON.stringify((service.cfg as unknown as Record<string, unknown>)[key] ?? "")}\n${hintFor(key)}`, specFor(key) ? "info" : "error");
				return;
			}
			if (what === "where" || what === "sources") {
				ctx.ui.notify(
					`sources, left wins: ${deps.configSources().join(" > ")}\nstore config file: ${displayPath(path.join(service.store.root, "config.json"))}\npi settings: the "globalMemory" key in your pi settings.json\nenvironment: PI_GLOBAL_MEMORY_*`,
					"info",
				);
				return;
			}
			if (what === "set") {
				const key = rest[1];
				const value = rest.slice(2).join(" ");
				if (!key || value === "") {
					ctx.ui.notify(`usage: /memory config set <key> <value>\nlist: /memory config list   explain one: /memory config explain <key>\nkeys: ${configKeys().join(", ")}`, "error");
					return;
				}
				const patch = parseConfigPatch(key, value);
				if (patch.problems.length > 0) {
					ctx.ui.notify(`not changed.\n${patch.problems.join("\n")}`, "error");
					return;
				}
				const res = deps.writeConfig(patch.patch);
				ctx.ui.notify(res.message, res.ok ? "info" : "error");
				deps.toggleStatus();
				return;
			}
			ctx.ui.notify("usage: /memory config [list | explain <key> | get <key> | set <key> <value> | where]", "error");
			return;
		}
		case "export": {
			// Container export: compressed, integrity-checked, optionally encrypted.
			// Options are positional and order-free: a file path, `all`, `category=<slug>`,
			// `enc`, `passphrase=<text>`, `note=<text>`, `allowprivate`.
			const opts = parseOptions(rest);
			const pw = resolvePassphrase(opts, opts.flags.has("enc"));
			const res = service.exportRecords({
				passphrase: pw.passphrase,
				note: opts.values.note,
				includeRetired: opts.flags.has("all"),
				category: opts.values.category,
				allowPrivate: opts.flags.has("allowprivate"),
			});
			const target = opts.positional[0] ?? path.join(service.outDir(), containerPath("export", Boolean(pw.passphrase)));
			try {
				fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
				fs.writeFileSync(target, res.text, { mode: 0o600 });
				tightenMode(target);
				const skippedText = res.skipped.length
					? `\nskipped by the privacy gate (${res.skipped.length}):\n${res.skipped.slice(0, 10).map((s) => `  - ${s.id}: ${s.reason}`).join("\n")}`
					: "";
				ctx.ui.notify(
					`exported ${res.packed} record(s) -> ${target}\n${describeContainer(res.text, pw.passphrase)}${pw.warning ? `\n${pw.warning}` : ""}${skippedText}`,
					res.skipped.length ? "warning" : "info",
				);
			} catch (err) {
				ctx.ui.notify(`export failed: ${storeErrorText(err)}`, "error");
			}
			return;
		}
		case "import": {
			// /memory import <file> [passphrase=<text>] - container (preferred) or plain JSON.
			const opts = parseOptions(rest);
			const file = opts.positional[0];
			if (!file) {
				ctx.ui.notify("usage: /memory import <file> [passphrase=<text>]\ncontainers are compressed and integrity-checked; a passphrase opens an AES-256-GCM container. Imported records always re-pass the write gates.", "error");
				return;
			}
			let text = "";
			try {
				text = fs.readFileSync(file, "utf8");
			} catch (err) {
				ctx.ui.notify(`cannot read ${file}: ${storeErrorText(err)}`, "error");
				return;
			}
			if (text.split(/\r?\n/)[0]?.trim() === CONTAINER_MAGIC) {
				const pw = resolvePassphrase(opts, false);
				let summary = "";
				try {
					summary = describeContainer(text, pw.passphrase);
				} catch (err) {
					ctx.ui.notify(`container not readable: ${storeErrorText(err)}`, "error");
					return;
				}
				const res = await service.importContainer(text, pw.passphrase, info);
				const lines = [
					`container: ${summary}`,
					`imported ${res.added} record(s)${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}`,
					res.authenticated
						? "authenticated: the AES-GCM tag verified, so this file is exactly what was exported"
						: "integrity: payload digest matched. A plain container detects corruption, not forgery - use /memory export <file> enc for authenticity.",
					...res.problems.map((p) => `problem: ${p}`),
					...res.skipped.slice(0, 40).map((s) => `- ${s.id}: ${s.reason}`),
				];
				deliver(ctx, service, "memory-import", lines.join("\n"));
				deps.toggleStatus();
				return;
			}
			const { importRecords } = await import("./service.ts");
			const res = await importRecords(service, text, info);
			deliver(ctx, service, "memory-import", [`plain JSON import: ${res.added} record(s)${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}`, ...res.problems.map((p) => `problem: ${p}`), ...res.skipped.slice(0, 40).map((s) => `- ${s.id}: ${s.reason}`)].join("\n"));
			deps.toggleStatus();
			return;
		}
		case "reindex": {
			const res = await service.store.rebuildIndex();
			await service.refresh(true);
			ctx.ui.notify(`reindexed ${res.records} record(s); ${res.invalid} unreadable`, res.invalid > 0 ? "warning" : "info");
			return;
		}
		case "selftest": {
			const lines = await runSelftest(service, info);
			deliver(ctx, service, "memory-selftest", lines.join("\n"));
			return;
		}
		default:
			ctx.ui.notify(`unknown /memory subcommand "${sub}". Try /memory help.`, "error");
	}
}

/** Invariants checked in-place, so an operator can verify a install without reading source. */
async function runSelftest(service: MemoryService, info: RunInfo): Promise<string[]> {
	const out: string[] = [];
	const push = (name: string, ok: boolean, detail = "") => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);

	push("store root is absolute", path.isAbsolute(service.store.root), service.store.root);
	let escaped = false;
	try {
		service.store.safeJoin("../escape-attempt");
		escaped = true;
	} catch {
		escaped = false;
	}
	push("path traversal refused", !escaped);

	const rec = await service.add(
		{
			kind: "fact",
			category: "selftest",
			title: "selftest record: memory round-trip works",
			statement: "Created by /memory selftest to prove write, index, and read paths work end to end in this installation.",
			evidence: [{ type: "command", ref: "/memory selftest" }],
			cues: ["selftest", "round trip"],
			confidence: 2,
		},
		info,
		{ note: "selftest" },
	);
	push("write + gates accept a clean record", rec.ok && !!rec.id, rec.ok ? rec.id : rec.problems.join("; "));
	if (rec.id) {
		const read = service.readIds([rec.id], info);
		push("read returns the record", read.found.length === 1);
		const search = await service.lookup({ text: "selftest round trip", limit: 5 }, info);
		push("search finds it", search.ids.includes(rec.id));
		const res = await service.retire([rec.id], "selftest cleanup");
		push("retire moves it out of the catalog", res.changed.length === 1);
		await service.store.hardDelete([rec.id], "selftest cleanup");
		await service.refresh(true);
		push("hard delete cleans up", !service.store.byId(rec.id));
	}

	const injected = service.cfg.catalogMaxChars;
	push("catalog budget within a sane range", injected > 0 && injected <= 6000, `catalogMaxChars=${injected}`);
	push("private-by-default posture", service.cfg.privacy === "strict" && service.cfg.sketchy === "block", `privacy=${service.cfg.privacy} sketchy=${service.cfg.sketchy}`);
	return out;
}

/** `key=value` pairs and bare flags, after any positional path. Quoted values keep spaces. */
export function parseOptions(args: string[]): { positional: string[]; values: Record<string, string>; flags: Set<string> } {
	const positional: string[] = [];
	const values: Record<string, string> = {};
	const flags = new Set<string>();
	for (const a of args) {
		const eq = a.indexOf("=");
		if (eq > 0) {
			values[a.slice(0, eq).toLowerCase()] = a.slice(eq + 1);
			continue;
		}
		const bare = a.toLowerCase();
		if (["all", "enc", "allowprivate", "retired", "force", "yes"].includes(bare)) {
			flags.add(bare);
			continue;
		}
		positional.push(a);
	}
	return { positional, values, flags };
}

/**
 * Passphrase resolution, deliberately cautious: command arguments end up in the pi
 * session transcript, so the environment variable is the recommended route and every
 * other route says out loud what it cost.
 */
function resolvePassphrase(opts: { values: Record<string, string> }, askedForEncryption: boolean): { passphrase?: string; warning?: string } {
	const fromEnv = (process.env.PI_GLOBAL_MEMORY_PASSPHRASE ?? "").trim();
	if (fromEnv) return { passphrase: fromEnv, warning: "passphrase read from PI_GLOBAL_MEMORY_PASSPHRASE (never stored in the file)" };
	const arg = opts.values.passphrase ?? opts.values.pw;
	if (arg) return { passphrase: arg, warning: "warning: the passphrase was a command argument, so it is visible in this session transcript. Prefer PI_GLOBAL_MEMORY_PASSPHRASE." };
	if (askedForEncryption) return { warning: "no passphrase found, so the container was NOT encrypted. Set PI_GLOBAL_MEMORY_PASSPHRASE (recommended) or pass passphrase=<text>." };
	return {};
}
