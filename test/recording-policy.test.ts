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
import { RunLedger, candidateToDraft, failureNoise, normalizeCall, type ToolObservation } from "../lib/capture.ts";
import { assessExplorationDiary, assessRuntimeNoise } from "../lib/trust.ts";

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

	test("the agent's own slips are noise: malformed command strings and throwaway scripts", () => {
		const malformed = failureNoise(obs({ toolName: "bash", input: { command: "cd /srv/app && cat >> lib/a.ts <<'TS' * broken *" }, text: "/usr/bin/bash: -c: line 173: syntax error near unexpected token `('" }));
		assert.equal(malformed.cls, "model-call");
		assert.match(malformed.why, /malformed/);
		const scratch = failureNoise(obs({ toolName: "bash", input: { command: "cd /srv/app && node - <<'NODE' const t = require('fs').readFileSync('lib/a.ts'); t.matchAll(X); NODE" }, text: "TypeError: String.prototype.matchAll called with a non-regexp argument" }));
		assert.equal(scratch.cls, "model-call");
		assert.match(scratch.why, /throwaway script/);
		const realApp = failureNoise(obs({ toolName: "bash", input: { command: "node dist/server.js" }, text: "TypeError: Cannot read properties of undefined (reading 'port')" }));
		assert.equal(realApp.cls, null, "a TypeError in the user's own program is a fact about the program");
		const realScript = failureNoise(obs({ toolName: "bash", input: { command: "bash scripts/deploy.sh" }, text: "scripts/deploy.sh: line 12: unbound variable" }));
		assert.equal(realScript.cls, null, "a checked-in script failing is knowledge, not a slip");
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

describe("exploration misfires and unrenderable arguments never reach the store", () => {
	test("a search that missed a guessed path is a misfire, not an environment fact", () => {
		const cases: [string, Record<string, unknown>, string, string][] = [
			["bash", { command: "cd /srv/app && head -40 src/missing.ts" }, "head: cannot open 'src/missing.ts' for reading: No such file or directory", "model-call"],
			["bash", { command: "grep -rln 'no such symbol' src/" }, "grep: src/: No such file or directory", "model-call"],
			["bash", { command: "ls build/out/" }, "ls: cannot access 'build/out/': No such file or directory", "model-call"],
		];
		for (const [toolName, input, text, cls] of cases) {
			const v = failureNoise(obs({ toolName, input, text }));
			assert.equal(v.cls, cls, `expected ${cls} for: ${text}`);
			assert.match(v.why, /misfire|guessed path/);
		}
	});

	test("a real missing file in the user's build is still reportable", () => {
		const v = failureNoise(obs({ toolName: "bash", input: { command: "make" }, text: "make: *** No rule to make target 'generated/parser.c'.  Stop." }));
		assert.equal(v.cls, null, "a build genuinely missing a generated file is knowledge, not a misfire");
	});

	test("an edit that failed to match is a retry, under every wording the harness uses", () => {
		for (const text of ["Could not find edits[0] in SECURITY.md. The oldText must match exactly including all whitespace and newlines.", "Could not find the exact text in lib/trust.ts", "No match found for oldText in the file"] as const) {
			const v = failureNoise(obs({ toolName: "edit", input: { path: "lib/trust.ts", edits: [{ oldText: "x", newText: "y" }] }, text }));
			assert.equal(v.cls, "model-call", `expected a retry classification for: ${text}`);
		}
	});

	test("edit arguments are rendered structurally, so records quote the change rather than a type name", () => {
		const call = normalizeCall("edit", { path: "lib/trust.ts", edits: [{ oldText: "score += cost;", newText: "score += cost;\n\tif (transcript) {" }] });
		assert.match(call, /score \+= cost/);
		assert.ok(!call.includes("[object Object]"), `unrenderable argument leaked into the call signature: ${call}`);
		assert.match(call, /lib\/trust\.ts/);
	});

	test("a call whose arguments logged as [object Object] cannot become a record", () => {
		const v = failureNoise(obs({ toolName: "edit", input: { path: "SECURITY.md", oldText: "[object Object],[object Object]" }, text: "Could not find edits[0] in SECURITY.md" }));
		assert.equal(v.cls, "no-detail");
		assert.match(v.why, /unrenderably|\[object Object\]/);
	});

	test("the ledger keeps a genuine build failure and drops the misfires in the same run", () => {
		const l = ledger();
		l.observe(obs({ toolName: "bash", input: { command: "cd /app && head -40 src/nope.ts" }, text: "head: cannot open 'src/nope.ts' for reading: No such file or directory" }));
		l.observe(obs({ toolName: "bash", input: { command: "cd /app && head -40 src/ok.ts" }, text: "contents of ok.ts", isError: false }));
		l.observe(obs({ toolName: "bash", input: { command: "make" }, text: "make: *** No rule to make target 'generated/parser.c'.  Stop." }));
		l.observe(obs({ toolName: "bash", input: { command: "make generate && make" }, text: "generated/parser.c written", isError: false }));
		const cands = l.candidates();
		assert.equal(cands.length, 1, `expected exactly one candidate, got ${JSON.stringify(cands.map((c) => c.failing))}`);
		assert.match(cands[0].failing, /make$/);
		assert.equal(l.dropCounts()["model-call"] ?? 0, 1, "the search misfire must be counted, not silently ignored");
	});

	test("the write gate refuses an exploration diary but keeps a miss with a real cause", async () => {
		const diaries = [
			{
				title: "grep worked after head failed",
				statement: 'bash call "cd /srv/app && head -40 src/x.ts" failed 1x; a later bash call "cd /srv/app && grep -rln thing src/" succeeded',
				avoid: "head: cannot open 'src/x.ts' for reading: No such file or directory",
				how: "cd /srv/app && grep -rln thing src/",
				why: "",
			},
			{
				title: "use ls instead of cat",
				statement: "cat of the build directory failed; ls listed it",
				avoid: "cat: build/out: No such file or directory",
				how: "ls build/",
				why: "",
			},
			{
				title: "cd: wc worked after grep (auto-capture wording)",
				statement: 'Observed in /srv/app: bash call "cd /srv/app && head -40 src/x.ts" failed 1x; a later bash call "cd /srv/app && grep -rln thing src/" succeeded. Re-check before generalizing beyond this environment.',
				avoid: `"cd /srv/app && head -40 src/x.ts" failed: head: cannot open 'src/x.ts' for reading: No su…`,
				how: `Use "cd /srv/app && grep -rln thing src/" instead, then confirm the result.`,
				why: "",
			},
		];
		const genuine = [
			{ title: "parser.c is generated", statement: "make failed: No rule to make target 'generated/parser.c'", avoid: "make -> No rule to make target", how: "run make generate first; the parser is generated, not checked in", why: "" },
			{ title: "module must be installed", statement: "node cannot find module 'dotenv' at startup", avoid: "node index.js -> Cannot find module 'dotenv'", how: "npm install dotenv before running", why: "" },
			{ title: "the entry point moved", statement: "reading src/x.ts fails because the file was moved", avoid: "read src/x.ts -> No such file or directory", how: "read src/x/index.ts instead", why: "" },
		];
		for (const d of diaries) {
			const v = assessExplorationDiary(d);
			assert.ok(v.diary, `should be a diary: ${d.title} (${v.why})`);
		}
		for (const d of genuine) {
			const v = assessExplorationDiary(d);
			assert.ok(!v.diary, `should not be a diary: ${d.title}`);
		}

		const dir = tempDir("gm-diary-gate");
		const { service, info } = makeService(dir, { record: true, use: true });
		try {
			const res = await service.add({ ...diaries[0], kind: "mistake", category: "cd", evidence: [{ type: "command", ref: "cd /srv/app && grep -rln thing src/" }] }, info, { allowPrivate: true });
			assert.ok(!res.ok, "a diary entry must be refused at the write gate");
			assert.match(res.problems.join(" "), /exploration diary/);
			assert.match(res.problems.join(" "), /name that change in how/, "the refusal has to say what would make it recordable");
			const keep = await service.add({ ...genuine[0], kind: "mistake", category: "make", evidence: [{ type: "command", ref: "make generate && make" }] }, info, { allowPrivate: true });
			assert.ok(keep.ok, `a real generated-file lesson must be writable: ${keep.problems.join("; ")}`);
		} finally {
			cleanup(dir);
		}
	});

	test("a draft whose content logged as [object Object] is refused, not filed", async () => {
		const dir = tempDir("gm-artifact-gate");
		const { service, info } = makeService(dir, { record: true, use: true });
		try {
			const res = await service.add(
				{
					kind: "mistake",
					category: "md",
					title: 'SECURITY.md|[object Object] worked after "SECURITY.md|[object Object],[object Object]"',
					statement: "edit call SECURITY.md|[object Object],[object Object] failed 2x; a later edit call SECURITY.md|[object Object] succeeded",
					evidence: [{ type: "command", ref: "SECURITY.md|[object Object]" }],
				},
				info,
				{ allowPrivate: true },
			);
			assert.ok(!res.ok, "an unrenderable draft must never be stored");
			assert.match(res.problems.join(" "), /unrenderable value/);
			assert.match(service.statusSummary(info), /unrenderable draft x1/, "the refusal has to be counted");
		} finally {
			cleanup(dir);
		}
	});
});
