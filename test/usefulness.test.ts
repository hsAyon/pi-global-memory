/**
 * Usefulness: a record has to be worth keeping, not merely correct.
 *
 * Reliability (the other rubric) asks whether a draft is well-formed and checkable. This file is about
 * the second question - does it deserve one of the store's slots? - because a store full of accurate
 * nothing is still a worse store: every entry costs catalog space and dilutes retrieval.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { cleanup, GOOD_DRAFT, makeService, tempDir } from "./helpers.ts";
import { auditStore } from "../lib/heal.ts";
import { assessUsefulness, usefulnessVerdict } from "../lib/trust.ts";

function fresh(name: string, over = {}) {
	const dir = tempDir(`gm-use-${name}-`);
	return { dir, ...makeService(dir, over) };
}

describe("useless drafts are discarded, not stored", () => {
	const junk: [string, Record<string, unknown>][] = [
		[
			"vague advice",
			{ kind: "fact", category: "builds", title: "be careful with the config", statement: "be careful with the configuration and double check things before shipping", evidence: [{ type: "session", ref: "session:junk" }] },
		],
		[
			"session trivia",
			{ kind: "mistake", category: "builds", title: "errors during the build", statement: "this session saw 3 errors while running the build in /tmp/scratch-work", evidence: [{ type: "session", ref: "session:junk" }] },
		],
		[
			"textbook fact",
			{ kind: "fact", category: "npm", title: "npm installs dependencies", statement: "npm install installs the dependencies listed in package.json into node_modules", evidence: [{ type: "url", ref: "https://docs.npmjs.com/cli/install" }] },
		],
		[
			"transcript of what was typed",
			{
				kind: "mistake",
				category: "cd",
				title: "cd: \"cd /srv/app && grep -rln something src/\" worked after \"cd /srv/app && head -40 src/x.ts\"",
				statement: 'bash call "cd /srv/app && head -40 src/x.ts && grep -n test src/x.ts" failed 1x; a later bash call "cd /srv/app && grep -rln something src/ && grep -c import src/a.ts" succeeded',
				avoid: `head: cannot open 'src/x.ts' for reading: No such file or directory`,
				how: "cd /srv/app && grep -rln something src/",
				cues: ["cannot open", "No such file or directory"],
				evidence: [{ type: "command", ref: "cd /srv/app && grep -rln something src/" }],
			},
		],
	];

	for (const [label, draft] of junk) {
		test(`refuses: ${label}`, async () => {
			const b = fresh(`junk-${label.replace(/\W/g, "")}`);
			try {
				const res = await b.service.add(draft as never, b.info, { allowPrivate: true });
				assert.ok(!res.ok, `${label} should not have been stored`);
				if (label === "transcript of what was typed") {
					assert.match(res.problems.join(" "), /exploration diary/, "a diary refusal has to say why a diary is worthless");
				} else {
					assert.match(res.problems.join(" "), /not useful enough/);
					assert.match(res.problems.join(" "), /score \d+\/10/);
				}
				assert.equal(b.service.store.counts().active, 0, "a discarded draft must leave nothing behind");
				assert.match(b.service.statusSummary(b.info), /discarded 1 draft\(s\) as not worth keeping/, "the discard has to be visible");
			} finally {
				cleanup(b.dir);
			}
		});
	}

	test("the refusal teaches the writer what would make it worth keeping", async () => {
		const b = fresh("teach");
		try {
			const res = await b.service.add({ kind: "fact", category: "misc", title: "note", statement: "builds can fail" }, b.info);
			const text = res.problems.join(" ");
			assert.match(text, /not useful enough/);
			assert.match(text, /names nothing concrete|too thin to act on|dumping ground/);
			assert.match(text, /Discarding is the right outcome/);
		} finally {
			cleanup(b.dir);
		}
	});
});

describe("useful drafts are stored", () => {
	test("a CLI quirk with the error text and the working form", async () => {
		const b = fresh("cli-quirk");
		try {
			const res = await b.service.add(
				{
					kind: "mistake",
					category: "ketch",
					title: "ketch search takes the query as a positional argument",
					statement: "ketch search takes the query as a positional argument; passing it as --query fails with Error: unknown flag: --query",
					avoid: `"ketch search --query x" -> Error: unknown flag: --query`,
					how: "ketch search <query> [flags]",
					cues: ["unknown flag", "--query"],
					evidence: [
						{ type: "command", ref: "ketch search vector stores --limit 5" },
						{ type: "url", ref: "https://example.invalid/ketch/docs/search" },
					],
				},
				b.info,
				{ allowPrivate: true },
			);
			assert.ok(res.ok, res.problems.join("; "));
			assert.ok(res.usefulness >= 7, `expected a high usefulness score, got ${res.usefulness}: ${res.usefulnessReasons.join("; ")}`);
			const stored = b.service.store.byId(res.id!)!;
			assert.ok(!stored.flags.includes("low-value"), `a strong record should not be flagged: ${JSON.stringify(stored.flags)}`);
		} finally {
			cleanup(b.dir);
		}
	});

	test("a shared fixture record passes without help", async () => {
		const b = fresh("fixture");
		try {
			const res = await b.service.add({ ...GOOD_DRAFT }, b.info);
			assert.ok(res.ok, res.problems.join("; "));
			assert.ok(res.usefulness >= 5, `GOOD_DRAFT should read as useful, got ${res.usefulness}`);
		} finally {
			cleanup(b.dir);
		}
	});

	test("auto-captured drafts face a higher bar than asked-for writes", async () => {
		const b = fresh("auto-bar", { minUsefulness: 0, minQuality: 0, requireEvidence: false });
		const thin = { kind: "fact", category: "misc", title: "note", statement: "be careful with builds", evidence: [{ type: "session", ref: "session:bar" }] };
		try {
			const manual = await b.service.add(thin, b.info, { allowPrivate: true });
			assert.ok(manual.ok, `with both floors at 0 an ordinary write may store a weak record: ${manual.problems.join("; ")}`);
			assert.ok(manual.usefulness < 1, `expected a near-zero usefulness score, got ${manual.usefulness}`);
			const auto = await b.service.add(thin, b.info, { allowPrivate: true, autoFlags: ["auto"], note: "auto-capture attempt" });
			assert.ok(!auto.ok, "an unattended auto-capture of the same draft must be held to floor+1");
			assert.match(auto.problems.join(" "), /not useful enough/);
		} finally {
			cleanup(b.dir);
		}
	});
});

describe("a borderline record is stored flagged, and the flag has teeth", () => {
	test("a record that only just clears the floor is stored flagged", async () => {
		const draft = {
			kind: "fact",
			category: "docker",
			title: "docker builder prune clears only the build cache",
			statement: "docker builder prune clears the build cache and nothing else, unlike docker system prune",
			evidence: [{ type: "command", ref: "docker builder prune" }],
			cues: [],
		};
		// Set the floor exactly at the draft's score so it lands in the flag band rather than
		// depending on where the rubric happens to place one example today.
		const scored = assessUsefulness({
			title: draft.title,
			statement: draft.statement,
			why: "",
			how: "",
			avoid: "",
			notes: "",
			cues: draft.cues,
			tags: [],
			category: draft.category,
			kind: draft.kind,
			evidenceTypes: ["command"],
		});
		const b = fresh("flagged", { minUsefulness: scored.score });
		try {
			const res = await b.service.add(draft, b.info, { allowPrivate: true });
			assert.ok(res.ok, res.problems.join("; "));
			const stored = b.service.store.byId(res.id!)!;
			assert.ok(stored.flags.includes("low-value"), `expected low-value in ${JSON.stringify(stored.flags)}`);
			assert.match(res.notes.join(" "), /flagged low-value/, "the write result should say it was flagged");
		} finally {
			cleanup(b.dir);
		}
	});

	test("a flagged record that never earns a lookup is retired by the audit", () => {
		const b = fresh("teeth", { tentativeTtlDays: 7 });
		try {
			const rec = {
				...GOOD_DRAFT,
				id: "gm-flagged-teeth-0001",
				kind: "fact" as const,
				status: "active" as const,
				flags: ["low-value"],
				confidence: 2,
				stats: { hits: 0, created: new Date(Date.now() - 40 * 86_400_000).toISOString(), updated: new Date(Date.now() - 40 * 86_400_000).toISOString(), verifiedCount: 0 },
			};
			const findings = auditStore([rec as never], b.service.cfg, b.info.cwd);
			assert.ok(
				findings.some((f) => f.issue === "flagged-low-value" && f.action === "retire"),
				`expected a flagged-low-value retire finding, got: ${findings.map((f) => f.issue).join(",")}`,
			);
			// and a record that did earn lookups is not touched on this account
			const used = { ...rec, stats: { hits: 6, created: rec.stats.created, updated: rec.stats.updated, verifiedCount: 1 } };
			const findings2 = auditStore([used as never], b.service.cfg, b.info.cwd);
			assert.ok(!findings2.some((f) => f.issue === "flagged-low-value"), "a looked-up record is not retired for its flag");
		} finally {
			cleanup(b.dir);
		}
	});
});

describe("the rubric is legible and its bands are stable", () => {
	test("every adjustment is explained, so a refusal can be acted on", () => {
		const u = assessUsefulness({
			title: "be careful with the config",
			statement: "be careful with the configuration and double check things before shipping",
			why: "",
			how: "",
			avoid: "",
			notes: "",
			cues: [],
			tags: [],
			category: "misc",
			kind: "fact",
			evidenceTypes: ["session"],
		});
		assert.ok(u.reasons.length >= 4, `expected a reason per adjustment, got ${JSON.stringify(u.reasons)}`);
		assert.ok(u.reasons.some((r) => /vacuous advice/.test(r)));
		assert.ok(u.reasons.some((r) => /dumping ground/.test(r)));
	});

	test("the bands are discard, flag, store", () => {
		assert.equal(usefulnessVerdict(3, 4), "discard");
		assert.equal(usefulnessVerdict(4, 4), "flag");
		assert.equal(usefulnessVerdict(6, 4), "flag");
		assert.equal(usefulnessVerdict(7, 4), "store");
		assert.equal(usefulnessVerdict(0, 0), "flag", "with the gate off, everything is at least flag-worthy, never discarded");
	});
});
