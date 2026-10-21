/**
 * Prompt injection. This is the only place the store reaches model context, and
 * it is budgeted twice: a stable catalog section and a per-run hits section.
 *
 * They are separate sections on purpose: pi diffs prompt sections by name, so a
 * changing hits section does not resend the stable catalog. Budgets are enforced
 * by reserving the parts that must survive (counts plus the pointer to the
 * lookup tool) and filling the rest with entries.
 */

import type { GmConfig, GmRecord } from "./types.ts";
import type { SearchHit } from "./search.ts";
import { hardenForInjection } from "./sanitize.ts";
import { displayPath, truncate } from "./util.ts";

export const CATALOG_SECTION = "global_memory";
export const HITS_SECTION = "global_memory_hits";

export interface CatalogInput {
	cfg: GmConfig;
	records: GmRecord[];
	storeDir: string;
	cwd: string;
	/** Pre-ranked catalog lines from renderCatalog, so ordering is decided once. */
	catalogLines: string[];
	catalogTotal: number;
	catalogShown: number;
}

function headerLines(cfg: GmConfig, storeDir: string, budget: number): string[] {
	const full = [
		`Global memory: a local, offline, git-friendly knowledge store at ${displayPath(storeDir)}. It is not on the internet; nothing here is fetched.`,
		"Before researching, debugging, or repeating a procedure, check whether it is already known:",
		'- `memory_lookup` {action:"search", query:"2-4 keywords"}, then {action:"read", ids:[...]} for the evidence, or {action:"catalog"} for the full list.',
		'- A record is past verified evidence, not a live fact. If current evidence contradicts it, trust the evidence and correct it with memory_save {action:"verify"|"update"|"retire"}.',
		"- Save only learnings you can cite (command, file path, URL, session). Never store secrets, personal identifiers, transcripts, or guesses.",
	];
	// Under a tight budget the rules still have to fit, so they get shorter, not dropped.
	const compact = [
		`Global memory (local, offline store) at ${displayPath(storeDir)}.`,
		'Check it before researching, debugging, or repeating a procedure: memory_lookup {action:"search"|"read"|"catalog"}. Records are past evidence: correct any that live evidence contradicts. Save only cited, verified facts; never secrets or personal identifiers.',
	];
	return budget < 1400 ? compact : full;
}

export function buildCatalogSection(input: CatalogInput): string | undefined {
	if (input.cfg.inject === "off" || !input.cfg.enabled) return undefined;
	const categories = new Map<string, number>();
	for (const r of input.records) {
		if (r.status === "retired") continue;
		categories.set(r.category, (categories.get(r.category) ?? 0) + 1);
	}
	if (categories.size === 0) return undefined;

	const budget = input.cfg.catalogMaxChars;
	if (budget <= 300) return undefined;

	const catSummary = [...categories.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 18)
		.map(([c, n]) => `${c}(${n})`)
		.join(" ");

	// Reserve the parts that must survive truncation: counts and the pointer.
	const countsLine = `Live records: ${input.catalogTotal}. Categories: ${catSummary}.`;
	// Worst-case tail text, so the reservation holds whatever the real count turns out to be.
	const tailReserve = `(+${input.catalogTotal} not listed: memory_lookup {"action":"catalog","limit":200}, or search by keyword.)`;
	const head = headerLines(input.cfg, input.storeDir, budget);
	const reserve = head.join("\n").length + countsLine.length + tailReserve.length + 4;

	const lines: string[] = [];
	let used = reserve;
	for (const line of input.catalogLines) {
		const cost = line.length + 1;
		if (used + cost > budget) break;
		used += cost;
		lines.push(hardenForInjection(line));
	}

	// What the agent sees next is what was left out by both the ranking limit and
	// the character budget, counted together.
	const hidden = input.catalogTotal - lines.length;
	const tail = hidden > 0 ? `(+${hidden} not listed: memory_lookup {"action":"catalog","limit":200}, or search by keyword.)` : "All live records are listed above.";

	const content = [...head, countsLine, ...lines, tail].filter(Boolean).join("\n");
	if (content.length > budget) {
		// Last resort: keep the rules, the counts, and the pointer; drop entries.
		const fallback = [...head, countsLine, tail].join("\n");
		if (fallback.length <= budget) return fallback;
		return fallback.slice(0, budget - 1) + "\u2026";
	}
	return content;
}

export interface HitsInput {
	cfg: GmConfig;
	hits: SearchHit[];
	records: Map<string, GmRecord>;
}

/** Per-run relevance: the records that match the prompt the user just typed. */
export function buildHitsSection(input: HitsInput): string | undefined {
	if (input.cfg.inject !== "catalog+hits" || !input.cfg.enabled) return undefined;
	const budget = input.cfg.hitsMaxChars;
	if (budget <= 0 || input.hits.length === 0) return undefined;

	const lead = "Likely relevant from global memory - apply these instead of re-deriving them:";
	const footer = 'Full detail, including evidence: memory_lookup {"action":"read","ids":["..."]}';
	const lines: string[] = [lead];
	let used = lead.length + footer.length + 2;
	let shown = 0;
	for (const hit of input.hits) {
		const rec = input.records.get(hit.entry.id);
		if (!rec) continue;
		const conf = rec.confidence <= 1 ? "tentative" : `confidence ${rec.confidence}`;
		const dispute = rec.flags.includes("disputed") ? "DISPUTED - retest first: " : "";
		const body = hardenForInjection(truncate(rec.statement, 240));
		const line = `- ${rec.id} [${rec.kind}/${rec.category}, ${conf}] ${dispute}${body}`;
		if (used + line.length > budget && shown > 0) break;
		if (used + line.length > budget) break;
		used += line.length + 1;
		lines.push(line);
		shown++;
	}
	if (shown === 0) return undefined;
	lines.push(footer);
	const content = lines.join("\n");
	if (content.length > budget) {
		const fallback = `${lead}\n${lines.slice(1, shown).join("\n")}`;
		return fallback.length <= budget ? fallback : fallback.slice(0, budget - 1) + "\u2026";
	}
	return content;
}
