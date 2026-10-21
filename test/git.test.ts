/**
 * The extension keeps history for its own records, and nothing else. These tests
 * prove the containment rather than asserting good intentions: a store nested
 * inside somebody's real repository must never be committed to by that repository.
 *
 * Skipped automatically when git is not installed.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanup, GOOD_DRAFT, makeService, tempDir } from "./helpers.ts";

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("internal versioning is contained", { skip: gitAvailable ? false : "git not installed" }, () => {
	test("gitAutoCommit creates the store's own repository and never touches a parent one", async () => {
		const parent = tempDir("gm-git-parent-");
		try {
			// A real repository, with one commit, that the store sits inside of.
			git(["init", "-q"], parent);
			fs.writeFileSync(path.join(parent, "work.txt"), "user work\n");
			git(["-c", "user.name=t", "-c", "user.email=t@x", "add", "work.txt"], parent);
			const commit = git(["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "user commit"], parent);
			assert.equal(commit.code, 0, commit.stderr);
			const before = git(["rev-list", "--count", "HEAD"], parent).stdout.trim();

			const storeDir = path.join(parent, "global-memory");
			const b = makeService(storeDir, { gitAutoCommit: true });
			const res = await b.service.add({ ...GOOD_DRAFT }, b.info, { note: "test write" });
			assert.ok(res.ok && res.id, res.problems.join("; "));
			await b.service.refresh(true);

			// 1. the store has its own repository
			assert.ok(fs.existsSync(path.join(storeDir, ".git")), "the store did not create its own .git");

			// 2. the parent repository gained nothing: no new commit, nothing staged
			const after = git(["rev-list", "--count", "HEAD"], parent).stdout.trim();
			assert.equal(after, before, "the extension committed to the PARENT repository - containment failed");
			const parentStatus = git(["status", "--porcelain"], parent).stdout.trim().split("\n").filter(Boolean);
			assert.ok(
				parentStatus.every((line) => line.includes("global-memory") || line === ""),
				`the parent repository was left dirty by the extension: ${parentStatus.join(" | ")}`,
			);

			// 3. the store repository recorded the record file
			const storeGit = ["--git-dir", path.join(storeDir, ".git"), "--work-tree", storeDir];
			const log = git([...storeGit, "log", "--oneline"], storeDir);
			assert.equal(log.code, 0, log.stderr);
			assert.match(log.stdout, /global-memory: test write/);
			const tracked = git([...storeGit, "ls-files"], storeDir).stdout.trim().split("\n");
			assert.ok(tracked.some((f) => f.startsWith("records/")), `records are not versioned: ${tracked.join(", ")}`);
			assert.ok(tracked.some((f) => f === "index.json" || f === "INDEX.md"), "indexes should be versioned");
		} finally {
			cleanup(parent);
		}
	});

	test("versioned records stay separate from exports, backups, and the ledger", async () => {
		const dir = tempDir("gm-git-scope-");
		try {
			const b = makeService(dir, { gitAutoCommit: true });
			const res = await b.service.add({ ...GOOD_DRAFT }, b.info, { note: "seed" });
			assert.ok(res.ok);
			const pack = b.service.exportRecords({ note: "portable copy" });
			const outDir = b.service.outDir();
			fs.mkdirSync(outDir, { recursive: true });
			const exported = path.join(outDir, "sample.gmect");
			fs.writeFileSync(exported, pack.text, { mode: 0o600 });
			fs.mkdirSync(path.join(dir, "pending"), { recursive: true });
			fs.writeFileSync(path.join(dir, "pending", "signals.jsonl"), '{"a":1}\n', { mode: 0o600 });
			await b.service.add({ ...GOOD_DRAFT, title: "second, genuinely different record", statement: "Different subject entirely: the make target deadlocks under -j4; add .NOTPARALLEL.", cues: ["make -j4", ".NOTPARALLEL"], category: "make", evidence: [{ type: "file", ref: "Makefile" }] }, b.info, { note: "second" });

			const storeGit = ["--git-dir", path.join(dir, ".git"), "--work-tree", dir];
			const tracked = git([...storeGit, "ls-files"], dir).stdout.trim().split("\n");
			for (const f of tracked) {
				assert.ok(!f.startsWith("out/"), `export landed in version control: ${f}`);
				assert.ok(!f.endsWith(".gmect"), `a container landed in version control: ${f}`);
				assert.ok(!f.startsWith("pending/"), `the failed-call ledger is versioned: ${f}`);
				assert.ok(!f.startsWith("backups/"), `a backup landed in version control: ${f}`);
				assert.ok(!f.startsWith(".git-empty-config"), "the isolation config must not be versioned");
			}
			assert.ok(tracked.some((f) => f.startsWith("records/make/")), "records should be versioned");
		} finally {
			cleanup(dir);
		}
	});

	test("with versioning off, no repository is created anywhere", async () => {
		const parent = tempDir("gm-git-off-");
		try {
			git(["init", "-q"], parent);
			const storeDir = path.join(parent, "global-memory");
			const b = makeService(storeDir, { gitAutoCommit: false });
			const res = await b.service.add({ ...GOOD_DRAFT }, b.info, { note: "seed" });
			assert.ok(res.ok);
			assert.equal(fs.existsSync(path.join(storeDir, ".git")), false, "versioning is opt-in");
			const status = git(["status", "--porcelain"], parent).stdout.trim().split("\n").filter(Boolean);
			assert.ok(status.every((l) => l.includes("global-memory")), "the store must stay untracked by default");
			assert.match(fs.readFileSync(path.join(storeDir, ".gitignore"), "utf8"), /\*/);
		} finally {
			cleanup(parent);
		}
	});

	test("the store's git calls ignore global config, hooks, and any remote transport", () => {
		const source = fs.readFileSync(path.join(path.resolve(import.meta.dirname, ".."), "lib", "store.ts"), "utf8");
		for (const needle of [
			"GIT_ALLOW_PROTOCOL",
			"protocol.ext.allow=never",
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_SYSTEM",
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_TERMINAL_PROMPT",
			"GIT_ASKPASS",
			"GIT_SSH_COMMAND",
			"core.hooksPath",
			"core.fsmonitor=false",
			"commit.gpgsign=false",
			"--git-dir",
			"--work-tree",
			"GIT_ALLOWED",
		]) {
			assert.ok(source.includes(needle), `store.ts lost a containment control: ${needle}`);
		}
		// No networked or destructive-repository subcommand can be reached.
		for (const banned of ['"push"', '"fetch"', '"pull"', '"clone"', '"remote"', '"ls-remote"', '"reset"', '"clean"', '"filter-branch"', '"submodule"', '"gc"', '"config", "--global"']) {
			assert.ok(!source.includes(banned), `store.ts may run a repository-dangerous git subcommand: ${banned}`);
		}
	});
});
