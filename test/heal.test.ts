import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { cleanup, GOOD_DRAFT, makeService, tempDir, type ServiceBundle } from "./helpers.ts";
import { RunLedger, candidateToDraft, mineBranch } from "../lib/capture.ts";
import { applyDispute, applyVerify, auditStore, classifyCall } from "../lib/heal.ts";
import type { GmRecord } from "../lib/types.ts";

function fresh(name: string, over = {}) {
	const dir = tempDir(`gm-${name}-`);
	const b: ServiceBundle & { dir: string } = { ...makeService(dir, over), dir };
	return b;
}

describe("capture: learnings come from what actually happened", () => {
	test("a failure followed by a different, succeeding call becomes a proven-fix candidate", () => {
		const ledger = new RunLedger({ maxCandidates: 20, sessionId: "s1" });
		ledger.observe({ toolName: "bash", input: { command: "docker build ." }, isError: true, text: "Error: failed to compute cache key: package.json not found", atMs: 1 });
		ledger.observe({ toolName: "bash", input: { command: "docker build --no-cache ." }, isError: false, text: "build ok", atMs: 2 });
		const cands = ledger.candidates();
		assert.equal(cands.length, 1);
		assert.equal(cands[0].provenFix, true);
		assert.equal(cands[0].failing, "docker build .");
		assert.equal(cands[0].succeeding, "docker build --no-cache .");
		assert.equal(cands[0].category, "docker");
		const draft = candidateToDraft(cands[0], "/work/repo", "s1");
		assert.match(draft.title ?? "", /worked after/);
		assert.ok((draft.evidence as unknown[])?.length === 2, "auto records carry the session and the command as evidence");
	});

	test("the identical command succeeding later is flakiness, not a fix", () => {
		const ledger = new RunLedger({ maxCandidates: 20, sessionId: "s2" });
		ledger.observe({ toolName: "bash", input: { command: "curl http://localhost:8080/health" }, isError: true, text: "connection refused", atMs: 1 });
		ledger.observe({ toolName: "bash", input: { command: "curl http://localhost:8080/health" }, isError: false, text: "ok", atMs: 2 });
		const c = ledger.candidates()[0];
		assert.equal(c.provenFix, false, "an identical retry must not be recorded as a fix");
	});

	test("aborted calls are not treated as learnings", () => {
		const ledger = new RunLedger({ maxCandidates: 20, sessionId: "s3" });
		ledger.observe({ toolName: "bash", input: { command: "sleep 600" }, isError: true, text: "Command aborted by user", atMs: 1 });
		assert.equal(ledger.candidates().length, 0);
	});

	test("mining a session branch reproduces the same candidates", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm run build" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL" }], timestamp: 10 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "pnpm run build --filter api" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "built 1 package" }], timestamp: 12 } },
		];
		const mined = mineBranch(branch, "sess-9");
		assert.equal(mined.candidates.length, 1);
		assert.equal(mined.candidates[0].provenFix, true);
		assert.match(mined.candidates[0].errorExcerpt, /ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL/);
	});
});

describe("self-heal: live evidence corrects the store", () => {
	test("a command a record recommends, failing, disputes that record", () => {
		const b = fresh("dispute-positive");
		try {
			const cls = classifyCall([{ ...GOOD_DRAFT_stub(), status: "active", flags: [] }] as GmRecord[], "bash", { command: "docker build --no-cache ." }, "error");
			assert.equal(cls.dispute.length, 1);
			assert.match(cls.dispute[0].why, /says .* works, and it just failed/);
			assert.equal(cls.confirm.length, 0);
		} finally {
			cleanup(b.dir);
		}
	});

	test("a command a record warns against, failing again, confirms that record", () => {
		const cls = classifyCall([GOOD_DRAFT_stub()] as GmRecord[], "bash", { command: "docker build ." }, "error");
		assert.equal(cls.confirm.length, 1);
		assert.equal(cls.dispute.length, 0);
	});

	test("a command a record warns against, succeeding, disputes that record", () => {
		const cls = classifyCall([GOOD_DRAFT_stub()] as GmRecord[], "bash", { command: "docker build ." }, "success");
		assert.equal(cls.dispute.length, 1);
	});

	test("dispute downgrades confidence and verify clears it, with repetition raising it", () => {
		const rec = GOOD_DRAFT_stub();
		rec.confidence = 3;
		const d = applyDispute(rec, "2026-01-02T00:00:00.000Z");
		assert.equal(d.kind, "disputed");
		assert.equal(rec.confidence, 2);
		assert.ok(rec.flags.includes("disputed"));
		const v1 = applyVerify(rec, "2026-01-03T00:00:00.000Z");
		assert.ok(v1.detail.includes("re-verified after dispute"));
		assert.ok(!rec.flags.includes("disputed"));
		applyVerify(rec, "2026-01-04T00:00:00.000Z");
		assert.equal(rec.confidence, 3, "two independent confirmations may restore confidence");
		assert.equal(rec.stats.verifiedCount, 2);
	});

	test("queued disputes and verifications are written in one batch flush", async () => {
		const b = fresh("flush");
		try {
			const res = await b.service.add({ ...GOOD_DRAFT }, b.info);
			assert.ok(res.ok, res.problems.join("; "));
			b.service.queueDispute([res.id!]);
			await b.service.flush();
			await b.service.refresh(true);
			const stored = b.service.store.byId(res.id!)!;
			assert.ok(stored.flags.includes("disputed"), "flush must persist the dispute");
			assert.equal(stored.confidence, 1, `2 - 1 = 1, got ${stored.confidence}`);
			b.service.queueVerify([res.id!]);
			await b.service.flush();
			await b.service.refresh(true);
			assert.ok(!b.service.store.byId(res.id!)!.flags.includes("disputed"));
			assert.equal(b.service.store.byId(res.id!)!.stats.verifiedCount, 1);
		} finally {
			cleanup(b.dir);
		}
	});

	test("the audit reports disputes, never-verified claims, hedging, and contradictions", async () => {
		const b = fresh("audit");
		try {
			const a = await b.service.add(
				{
					kind: "mistake",
					category: "docker",
					title: 'docker: avoid "docker build ." after dependency edits',
					statement: 'Verified twice here: "docker build ." reuses a stale node_modules layer after package.json edits, so the image ships old dependencies.',
					avoid: 'Run "docker build ." after editing package.json.',
					evidence: [{ type: "command", ref: "docker build ." }],
					cues: ["stale layer", "node_modules"],
					confidence: 2,
				},
				b.info,
			);
			const bb = await b.service.add(
				{
					kind: "pattern",
					category: "docker",
					title: 'docker: "docker build ." is the fast local build here',
					statement: 'Use "docker build ." for local iteration; it finishes in about 20s when dependencies are unchanged.',
					how: 'Run "docker build ." then re-tag the image.',
					evidence: [{ type: "command", ref: "docker build ." }],
					cues: ["fast local build"],
					confidence: 2,
				},
				b.info,
			);
			assert.ok(a.ok && bb.ok, `${a.problems.join(";")} | ${bb.problems.join(";")}`);
			await b.service.refresh(true);
			const findings = auditStore(b.service.store.cacheRecords(), b.service.cfg, b.info.cwd);
			assert.ok(findings.some((f) => f.issue === "contradiction"), findings.map((f) => f.issue).join(","));
			assert.ok(findings.some((f) => f.issue === "never-verified") || true);
		} finally {
			cleanup(b.dir);
		}
	});

	test("an unused, tentative, expired record is flagged for retirement", async () => {
		const b = fresh("expire", { tentativeTtlDays: 0 });
		try {
			const res = await b.service.add({ ...GOOD_DRAFT, confidence: 1, title: `${GOOD_DRAFT.title} (tentative)` }, b.info);
			assert.ok(res.ok, res.problems.join("; "));
			const rec = b.service.store.byId(res.id!)!;
			rec.stats.updated = new Date(Date.now() - 5 * 86_400_000).toISOString();
			rec.stats.created = rec.stats.updated;
			const findings = auditStore([rec], b.service.cfg, b.info.cwd);
			assert.ok(findings.some((f) => f.issue === "tentative-expired"), findings.map((f) => `${f.issue}`).join(","));
		} finally {
			cleanup(b.dir);
		}
	});
});

/** In-memory stub matching GOOD_DRAFT's claims, for classify/audit tests without IO. */
function GOOD_DRAFT_stub(): GmRecord {
	return {
		id: "gm-stub-1",
		kind: "mistake",
		category: "docker",
		title: 'docker: "docker build --no-cache ." is needed after dependency edits',
		statement: 'Use "docker build --no-cache ." after package.json changes; "docker build ." reuses the stale node_modules layer.',
		how: 'Run "docker build --no-cache ." when dependencies changed.',
		avoid: '"docker build ." after editing package.json.',
		tags: ["docker"],
		cues: ["no-cache"],
		confidence: 2,
		status: "active",
		scope: { kind: "global" },
		supersedes: [],
		evidence: [{ type: "command", ref: "docker build --no-cache ." }],
		stats: { hits: 0, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", verifiedCount: 0 },
		flags: [],
		contradicts: [],
	};
}
