/**
 * The user-facing command surface. The service layer is covered elsewhere; this file pins the
 * behaviour that only exists in the command wiring, including two claims the documentation makes
 * about safety:
 *
 *  - /memory delete-all cannot delete anything until the staged token is presented, and it always
 *    writes a backup container first;
 *  - /memory inspect reads a container without importing it;
 *  - long listings go to a file under the store instead of into the terminal;
 *  - a rejected config value explains what was allowed.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanup, GOOD_DRAFT, makeService, tempDir } from "./helpers.ts";
import { handleMemoryCommand, type CommandDeps } from "../lib/commands.ts";
import { resolveConfig } from "../lib/config.ts";

interface Harness {
	notices: string[];
	ctx: unknown;
	deps: CommandDeps;
	run(cmd: string): Promise<void>;
}

function harness(root: string, over: Parameters<typeof makeService>[1] = {}): Harness {
	const { service, store, info } = makeService(root, over);
	const notices: string[] = [];
	const problems: string[] = [];
	let fileCfg: Record<string, unknown> = {};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: root,
		ui: {
			notify: (msg: string) => notices.push(String(msg)),
			confirm: async () => true,
			select: async (items: string[]) => items[0],
			input: async () => "",
		},
		sessionManager: { getBranch: () => [] },
	};
	const deps: CommandDeps = {
		service,
		runInfo: () => info,
		configProblems: problems,
		configSources: () => ["test harness"],
		// Mirrors index.ts: the store config file is the durable place, and applying a
		// patch re-resolves every source so the live config matches what a real session gets.
		writeConfig: (patch: Record<string, unknown>) => {
			fileCfg = { ...fileCfg, ...patch };
			const reread = resolveConfig({ env: {}, settings: {}, file: fileCfg });
			service.cfg = reread.config;
			store.updateConfig(reread.config);
			service.ensureStore();
			problems.length = 0;
			problems.push(...reread.problems);
			return { ok: reread.problems.length === 0, message: "wrote store config.json" };
		},
		toggleStatus: () => {},
		version: "test",
	};
	return { notices, ctx, deps, run: (cmd: string) => handleMemoryCommand(cmd, ctx as never, deps) };
}

function tokenIn(text: string): string | undefined {
	return (text.match(/\b[0-9A-F]{6}\b/) || [])[0];
}

test("/memory delete-all stages a token, refuses without it, and backs up before deleting", async () => {
	const dir = tempDir("gm-delete-all");
	const h = harness(dir, { use: true, record: true });
	const FACTS: [string, string][] = [
	["docker", "docker system prune -af clears the build cache on this host"],
	["node", "node --test only picks up files named *.test.ts"],
	["git", "git commit fails without user.name set in the repository config"],
];
for (const [category, statement] of FACTS) {
		const res = await h.deps.service.add({ ...GOOD_DRAFT, category, statement }, h.deps.runInfo(), {
			allowPrivate: true,
		});
		assert.ok(res.ok, JSON.stringify(res.problems));
	}
	await h.deps.service.add({ ...GOOD_DRAFT, category: "apt", statement: "apt-get update needs sudo on this box" }, h.deps.runInfo(), { allowPrivate: true });
	const before = h.deps.service.store.counts();
	assert.ok(before.active >= 3);

	// First call: stages, deletes nothing.
	await h.run("delete-all");
	assert.deepEqual(h.deps.service.store.counts(), before, "the first call must not delete");
	const staged = h.notices.join("\n");
	const token = tokenIn(staged);
	assert.ok(token, `expected a token in the staging message:\n${staged}`);

	// Wrong token: still deletes nothing.
	await h.run("delete-all 000000");
	assert.deepEqual(h.deps.service.store.counts(), before, "a wrong token must not delete");

	// Correct token: backup first, then empty.
	await h.run(`delete-all ${token}`);
	const after = h.deps.service.store.counts();
	assert.equal(after.active, 0, "the store should be empty after a confirmed delete-all");
	const backups = fs.readdirSync(path.join(dir, "backups")).filter((f) => f.startsWith("pre-delete-all-"));
	assert.equal(backups.length, 1, "exactly one backup container must exist");
	const backupText = fs.readFileSync(path.join(dir, "backups", backups[0]), "utf8");
	assert.match(backupText, /^GMEM1/, "the backup must be a container");
	assert.match(h.notices.join("\n"), /backups/, "the message must tell the user where the backup is");

	// The backup really restores.
	const imp = await h.deps.service.importContainer(backupText, undefined, h.deps.runInfo());
	assert.ok(imp.added > 0, `restoring the backup should re-add records: ${JSON.stringify(imp.problems)}`);
	cleanup(dir);
});

test("/memory inspect describes a container without importing it", async () => {
	const dir = tempDir("gm-inspect");
	const h = harness(dir, { use: true, record: true });
	const added = await h.deps.service.add({ ...GOOD_DRAFT, title: "keep", statement: "docker prune caches layers on this host" }, h.deps.runInfo(), { allowPrivate: true });
	assert.ok(added.ok);
	const packed = h.deps.service.exportRecords({ note: "for review before importing" });
	const file = path.join(dir, "look.gmect");
	fs.writeFileSync(file, packed.text, { mode: 0o600 });
	const before = h.deps.service.store.counts();

	await h.run(`inspect ${file}`);
	const shown = h.notices.join("\n");
	assert.match(shown, /for review before importing/);
	assert.match(shown, /not encrypted/);
	assert.deepEqual(h.deps.service.store.counts(), before, "inspecting must not import anything");

	// A damaged file is reported, not half-read.
	fs.writeFileSync(file, "GM1X\n{}\n", { mode: 0o600 });
	await h.run(`inspect ${file}`);
	assert.match(h.notices.join("\n"), /cannot inspect/);
	cleanup(dir);
});

test("long listings are written to a file instead of the terminal", async () => {
	const dir = tempDir("gm-ls-out");
	const h = harness(dir, { use: true, record: true });
	const DISTINCT = [
		"npm ci deletes node_modules before installing, unlike npm install",
		"WSL needs systemd enabled in wsl.conf before systemctl works",
		"ripgrep skips hidden files unless --hidden is passed",
		"bash heredocs swallow backslash escapes unless the delimiter is quoted",
		"the windows firewall rule name must be unique per rule",
		"pnpm stores packages in a content-addressable store under ~/.pnpm-store",
		"docker compose up -d does not rebuild images without --build",
		"git rebase -i needs GIT_SEQUENCE_EDITOR set for scripted rewrites",
		"node fetch requires an https url, not a bare host",
		"tar on windows needs paths without a drive letter prefix",
		"sqlite pragma journal_mode wal must be set before the first write",
		"cargo vendor writes dependencies into a vendor directory, not ~/.cargo",
	];
	for (let i = 0; i < DISTINCT.length; i++) {
		const res = await h.deps.service.add(
			{ ...GOOD_DRAFT, category: `cat${i % 4}`, title: `fact ${i}`, statement: DISTINCT[i] },
			h.deps.runInfo(),
			{ allowPrivate: true },
		);
		assert.ok(res.ok, JSON.stringify(res.problems));
	}
	await h.run("ls");
	const outDir = path.join(dir, "out");
	const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".txt"));
	assert.ok(files.length >= 1, "the listing should land in a file under the store");
	const text = fs.readFileSync(path.join(outDir, files[0]), "utf8");
	assert.ok((text.match(/\n/g) || []).length > 10, "the file should hold the whole listing");
	cleanup(dir);
});

test("a rejected config value says what was allowed", async () => {
	const dir = tempDir("gm-cmd-config");
	const h = harness(dir);
	await h.run("config set privacy sloppiest");
	assert.match(h.notices.join("\n"), /strict|standard|off/, "the error should list the accepted values");
	await h.run("config set privacy standard");
	assert.equal(h.deps.service.cfg.privacy, "standard", "a valid value should apply");
	cleanup(dir);
});
