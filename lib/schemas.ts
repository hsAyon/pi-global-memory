/**
 * TypeBox parameter schemas for the two model-facing tools.
 *
 * This is the only module (besides index.ts and commands.ts) that touches
 * host-provided packages, which keeps the rest of the extension testable with
 * plain node.
 *
 * Closed vocabularies (action, kind, scope) are literal unions so pi's schema
 * validation rejects a hallucinated action before it reaches the handler, and so
 * the model sees the allowed set in the tool schema, not only in prose.
 */

import { Type } from "typebox";

const one = (...values: string[]) => Type.Union(values.map((v) => Type.Literal(v)));

const LOOKUP_ACTIONS = ["search", "read", "catalog", "categories", "stats", "audit"] as const;
const SAVE_ACTIONS = ["add", "update", "verify", "retire", "restore", "supersede"] as const;
const KINDS = ["fact", "mistake", "research", "pattern", "workflow", "environment"] as const;

const evidenceSchema = Type.Array(
	Type.Union([
		Type.String({ description: 'Shortcut: the reference alone, e.g. "npm run build --no-cache", a file path, or a URL.' }),
		Type.Object({
			type: Type.Optional(one("command", "file", "url", "session", "artifact", "doc", "note", "manual", "auto")),
			ref: Type.String({ description: "The exact command, path, URL, or session id that proves the claim." }),
			note: Type.Optional(Type.String({ description: "Optional short context for the citation." })),
		}),
	]),
	{ description: "Required citation(s). A record with no evidence is refused: facts over guesses." },
);

const scopeSchema = Type.Object({
	kind: Type.Optional(one("global", "project")),
	path: Type.Optional(Type.String({ description: "Project path prefix; omit to use the current working directory." })),
});

export const LookupParams = Type.Object({
	action: one(...LOOKUP_ACTIONS),
	query: Type.Optional(Type.String({ description: "2-4 keywords, not a sentence. Include exact error text or flags when you have them." })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "Record ids for action=read (max 8 per call)." })),
	category: Type.Optional(Type.String({ description: "Restrict to one category slug (see action=categories)." })),
	kind: Type.Optional(one(...KINDS)),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Any-of tag filter." })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Max results, default 8, max 50." })),
	includeRetired: Type.Optional(Type.Boolean({ description: "Include retired/superseded records (archaeology only)." })),
	minConfidence: Type.Optional(Type.Number({ minimum: 1, maximum: 3, description: "1 tentative, 2 supported, 3 repeatedly verified." })),
	scope: Type.Optional(one("any", "global", "project")),
});

export const SaveParams = Type.Object({
	action: one(...SAVE_ACTIONS),
	id: Type.Optional(Type.String({ description: "Target id for update/verify/restore/supersede." })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "Target ids for retire." })),
	kind: Type.Optional(one(...KINDS)),
	category: Type.Optional(Type.String({ description: "Slug, one word where possible: git, docker, windows, pi." })),
	title: Type.Optional(Type.String({ maxLength: 200, description: "One line, <=90 chars: the searchable summary. Name the thing, not 'fix note'." })),
	statement: Type.Optional(Type.String({ maxLength: 2000, description: "The learning, <=700 chars, as a fact or an instruction." })),
	why: Type.Optional(Type.String({ maxLength: 900, description: "Observed reason, <=300 chars. No speculation." })),
	how: Type.Optional(Type.String({ maxLength: 2000, description: "The procedure that works, <=700 chars." })),
	avoid: Type.Optional(Type.String({ maxLength: 900, description: "What failed and must not be repeated, <=300 chars." })),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20, description: "Up to 12 short tags." })),
	cues: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 30, description: "Up to 16 retrieval cues: error text, flags, symbols. Big precision win." })),
	confidence: Type.Optional(Type.Number({ minimum: 1, maximum: 3, description: "1 tentative, 2 supported, 3 verified repeatedly. Do not inflate." })),
	evidence: Type.Optional(evidenceSchema),
	scope: Type.Optional(scopeSchema),
	supersedes: Type.Optional(Type.Array(Type.String(), { description: "Ids this record replaces; they become superseded." })),
	note: Type.Optional(Type.String({ maxLength: 400, description: "verify only: what you re-tested, in one line." })),
	force: Type.Optional(Type.Boolean({ description: "add only: skip the near-duplicate guard. Rarely correct." })),
});
