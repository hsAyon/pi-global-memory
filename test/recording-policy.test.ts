/**
 * Recording policy: what is allowed to become a record.
 *
 * The store is for knowledge - research findings, verified fixes, environment facts learned by
 * correcting a mistake. It must never fill up with the agent's own failures: a rejected tool call,
 * an abort, a compaction error, a model-runner fault, a context overflow. Those are not facts
 * about the user's environment, nobody can re-verify them, and the next session would read them as
 * guidance to route around a transient fault.
 *
 * Two layers are asserted here:
 *  1. capture: noise never becomes a candidate or a signal, and the exclusion is counted;
 *  2. the write gate: an agent cannot save such a thing on purpose either.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { cleanup, GOOD_DRAFT, makeService, tempDir } from "./helpers.ts";
import { RunLedger, candidateToDraft, failureNoise, type ToolObservation } from "../lib/capture.ts";
import { assessRuntimeNoise } from "../lib/trust.ts";

function obs(o: Partial<ToolObservation>): ToolObservation {
	return { toolName: "bash", input: { command: "npm run build" }, isError: true, text: "", atMs: Date.now(), ...o };
}

function ledger(): RunLedger {
	return new RunLedger({ maxCandidates: 20, sessionId: "policy-session" });
}

describe("capture ignores agent and runtime failures", () => {
	test("harness phrasing never becomes a candidate, and the exclusion is counted", () => {
		const cases: [string, string][] = [
			['Tool "bash" failed', "harness"],
			["Invalid arguments for tool \"bash\": must have required property 'command'", "model-call"],
			["Request was aborted", "aborted"],
			["Compaction cancelled", "runtime"],
			["Compaction produced no summary; keeping the conversation as it is.", "runtime"],
			["prompt is too long; exceeded max context length", "runtime"],
			["rate limit reached; retry in 30s", "runtime"],
			["Traceback (most recent call last): segfault", "harness"],
		];
		for (const [text, cls] of cases) {
			const l = ledger();
			l.observe(obs({ text }));
			// A later, slightly different success must not resurrect a meaningless pair.
			l.observe(obs({ text: "ok", isError: false, input: { command: "npm run build --no-lint" } }));
			assert.equal(l.candidates().length, 0, `${text} must not produce a candidate`);
			assert.equal(l.signals().length, 0, `${text} must not produce a signal`);
			assert.ok(l.dropCounts()[cls], `${text} should count as ${cls}: ${JSON.stringify(l.dropCounts())}`);
			assert.match(l.dropSummary(), /never recorded/);
		}
	});

	test("an edit that simply did not match is a model slip, not a project fact", () => {
		const l = ledger();
		l.observe(obs({ toolName: "edit", input: { path: "src/app.ts", edits: [] }, text: "oldText not found in the file" }));
		assert.equal(l.candidates().length, 0);
		assert.ok(l.dropCounts()["model-call"]);
	});

	test("a call with no usable argument is dropped rather than stored as a mystery", () => {
		const l = ledger();
		l.observe(obs({ input: {}, text: "usage: bash: no command given" }));
		assert.equal(l.candidates().length, 0);
		assert.ok(l.dropCounts()["empty-argument"]);
	});

	test("a real environment failure with a real fix is still captured and still writable", async () => {
		const l = ledger();
		l.observe(obs({ input: { command: "npm ci" }, text: "npm ERR! cannot reach the internal registry, needs --registry" }));
		l.observe(obs({ input: { command: "npm ci --registry https://registry.internal" }, text: "added 402 packages", isError: false }));
		const c = l.candidates();
		assert.equal(c.length, 1, `expected one candidate, drops were ${JSON.stringify(l.dropCounts())}`);
		assert.equal(c[0].provenFix, true);
		assert.equal(l.signals()[0].resolved, true);

		const dir = tempDir("gm-capture-write");
		const { service, info } = makeService(dir, { record: true, use: true });
		try {
			const res = await service.add(candidateToDraft(c[0], "/tmp/project", "policy-session"), info, { autoFlags: ["auto"] });
			assert.ok(res.id, `a captured fix must pass the write gate: ${JSON.stringify(res.problems)}`);
		} finally {
			cleanup(dir);
		}
	});

	test("failureNoise says which failures are real environment facts", () => {
		assert.equal(failureNoise(obs({ text: "Request was aborted" })).cls, "aborted");
		assert.equal(failureNoise(obs({ text: "Makefile:12: *** missing separator. Stop." })).cls, null);
		assert.equal(failureNoise(obs({ text: "unknown flag: --query" })).cls, null);
	});
});

describe("the write gate refuses fault reports about the agent and its runtime", () => {
	test("an agent cannot save a model, pi, or runner failure", async () => {
		const dir = tempDir("gm-noise-gate");
		const { service, info } = makeService(dir, { record: true, use: true, minQuality: 0 });
		const attempts: [string, string][] = [
			["pi-model", "pi crashed while writing the report; restart the session and try again"],
			["runner", "the model runner returned stop reason length, so output was truncated"],
			["compaction", "compaction error lost earlier tool results, so re-read the files"],
			["system", "a system error terminated the call; retry it"],
			["validation", "the tool call was rejected by argument validation, so use a different shape"],
		];
		try {
			for (const [category, statement] of attempts) {
				const res = await service.add(
					{ ...GOOD_DRAFT, category, title: statement.slice(0, 48), statement, evidence: [{ type: "session", ref: "session:policy", note: "seen once" }] },
					info,
					{ force: true },
				);
				assert.ok(!res.ok, `${statement} should have been refused`);
				assert.match(res.problems.join(" "), /agent\/runtime fault report/, "the refusal must name the policy");
			}
			assert.equal(service.store.counts().active, 0, "nothing should have been written");
		} finally {
			cleanup(dir);
		}
	});

	test("knowledge about pi as a tool is welcome", async () => {
		const dir = tempDir("gm-pi-facts");
		const { service, info } = makeService(dir, { record: true, use: true });
		try {
			const good: [string, string][] = [
				["pi-flags", "pi keeps sessions in memory under --no-session, so nothing persists to disk"],
				["pi-settings", "pi settings.json allows unknown keys, so a globalMemory section is not rejected"],
				["docker", "docker system prune -af also removes stopped containers, not just the build cache"],
			];
			for (const [category, statement] of good) {
				const res = await service.add({ ...GOOD_DRAFT, category, title: statement.slice(0, 48), statement }, info, { allowPrivate: true });
				assert.ok(res.id, `${statement} should be writable: ${JSON.stringify(res.problems)}`);
			}
			assert.equal(service.store.counts().active, 3);
		} finally {
			cleanup(dir);
		}
	});

	test("updating an existing record into a fault report is refused too", async () => {
		const dir = tempDir("gm-noise-update");
		const { service, info } = makeService(dir, { record: true, use: true, minQuality: 0 });
		try {
			const first = await service.add({ ...GOOD_DRAFT, category: "keep", statement: "keep: this record is fine exactly as it is" }, info, { allowPrivate: true });
			assert.ok(first.id);
			const upd = await service.update(first.id!, { statement: "the pi coding agent failed here and needs a retry" }, info);
			assert.ok(!upd.ok, "an update must not smuggle a fault report into a good record");
			const after = service.store.byId(first.id!);
			assert.match(after!.statement, /fine exactly as it is/, "the stored record must be untouched");
		} finally {
			cleanup(dir);
		}
	});

	test("the gate is not a posture toggle", async () => {
		const dir = tempDir("gm-noise-posture");
		const { service, info } = makeService(dir, { record: true, use: true, privacy: "off", sketchy: "off", minQuality: 0 });
		try {
			const res = await service.add({ ...GOOD_DRAFT, category: "noise", statement: "pi coding agent failed and had to be restarted" }, info, { force: true });
			assert.ok(!res.ok, "relaxing privacy and sketchy must not re-admit fault reports");
		} finally {
			cleanup(dir);
		}
	});

	test("assessRuntimeNoise distinguishes a fault report from a fact that mentions pi", () => {
		const rejects = [
			"pi coding agent failed during compaction",
			"the harness threw an exception",
			"the tool call was rejected by validation",
			"a runtime error killed the run",
		];
		const accepts = [
			"the ssh session times out after five minutes; set ServerAliveInterval 60",
			"the systemd service fails to start after a reboot unless it is enabled first",
			"npm ci fails when package-lock.json is stale",
			"pi stores sessions under the agent directory unless --no-session is used",
			"the build agent on ci.internal drops jobs when the disk fills up",
		];
		for (const t of rejects) assert.ok(assessRuntimeNoise([t]).noise, `should reject: ${t}`);
		for (const t of accepts) assert.ok(!assessRuntimeNoise([t]).noise, `should accept: ${t}`);
	});
});
