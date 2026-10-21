import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanup, GOOD_DRAFT, makeService, tempDir, type ServiceBundle } from "./helpers.ts";

/** Fresh store per test: no cross-test coupling, and the duplicate guard stays meaningful. */
function fresh(name: string): ServiceBundle & { dir: string } {
	const dir = tempDir(`gm-${name}-`);
	const bundle = makeService(dir);
	return { ...bundle, dir };
}

describe("store: confinement, atomicity, lifecycle", () => {
	test("refuses paths outside the store root", () => {
		const { store, dir } = fresh("confine");
		try {
			assert.throws(() => store.safeJoin("../escape"), /outside-store|refused/);
			assert.throws(() => store.safeJoin("a/../../b"), /refused unsafe path segment/);
			assert.throws(() => store.safeJoin("/absolute"), /refused unsafe relative path/);
			assert.throws(() => store.safeJoin("C:\\Windows\\x"), /refused unsafe relative path/);
			assert.throws(() => store.safeJoin("a/./b"), /refused unsafe path segment/);
			assert.ok(store.safeJoin(path.join("records", "ok", "gm-x-1.md")).startsWith(store.root));
		} finally {
			cleanup(dir);
		}
	});

	test("add writes the record plus both indexes", async () => {
		const { service, store, info, dir } = fresh("add");
		try {
			const res = await service.add({ ...GOOD_DRAFT }, info);
			assert.ok(res.ok, res.problems.join("; "));
			assert.match(res.id ?? "", /^gm-[a-z0-9-]+$/);
			const file = path.join(store.root, "records", "docker", `${res.id}.md`);
			assert.ok(fs.existsSync(file), "record file missing");
			const index = JSON.parse(fs.readFileSync(path.join(store.root, "index.json"), "utf8"));
			assert.equal(index.count, 1);
			assert.equal(index.records[0].id, res.id);
			const md = fs.readFileSync(path.join(store.root, "INDEX.md"), "utf8");
			assert.match(md, /## docker/);
			const body = fs.readFileSync(file, "utf8");
			assert.match(body, /^## Statement/m);
			assert.match(body, /kind: research/);
			assert.match(body, /verifiedCount: 0/);
		} finally {
			cleanup(dir);
		}
	});

	test("id generation stays filesystem-safe for long titles", async () => {
		const { service, info, dir } = fresh("id");
		try {
			const res = await service.add(
				{
					kind: "fact",
					category: "long",
					title: `long: ${"a very long descriptive title about docker build caching behaviour on windows ".repeat(2)}ends here`,
					statement: "Record created to prove id generation stays inside the filesystem-safe alphabet and length budget for awkward titles.",
					evidence: [{ type: "command", ref: "docker build ." }],
					cues: ["long title", "id generation"],
					confidence: 2,
				},
				info,
			);
			assert.ok(res.ok, res.problems.join("; "));
			assert.match(res.id ?? "", /^gm-[a-z0-9-]+$/);
			assert.ok((res.id ?? "").length <= 64, `id too long: ${res.id}`);
		} finally {
			cleanup(dir);
		}
	});

	test("a store directory is private and untracked by default", () => {
		const { service, store, dir } = fresh("gitignore");
		try {
			service.ensureStore();
			const ignore = fs.readFileSync(path.join(store.root, ".gitignore"), "utf8");
			assert.match(ignore, /pi-global-memory/);
			assert.match(ignore, /^\*$/m);
		} finally {
			cleanup(dir);
		}
	});

	test("retire moves the file to archive/, restore moves it back", async () => {
		const { service, store, info, dir } = fresh("retire");
		try {
			const res = await service.add(
				{
					...GOOD_DRAFT,
					category: "git",
					title: 'git: "git switch -c name" is the branch creation form here',
					statement: "Verified in this repo: git switch -c name creates the branch, and the older checkout -b form prints a deprecation warning.",
					evidence: [{ type: "command", ref: "git switch -c trial" }],
					cues: ["git switch", "checkout -b"],
				},
				info,
			);
			assert.ok(res.ok, res.problems.join("; "));
			const active = path.join(store.root, "records", "git", `${res.id}.md`);
			assert.ok(fs.existsSync(active));
			const ret = await service.retire([res.id!], "test");
			assert.deepEqual(ret.changed, [res.id]);
			assert.ok(!fs.existsSync(active), "retire must remove the file from records/");
			const archived = path.join(store.root, "archive", "git", `${res.id}.md`);
			assert.ok(fs.existsSync(archived), "archived copy missing");
			const idx = JSON.parse(fs.readFileSync(path.join(store.root, "index.json"), "utf8"));
			assert.equal(idx.count, 0, "retired records must leave the machine index");
			const search = await service.lookup({ text: "git switch branch", limit: 5, includeRetired: true }, info);
			assert.ok(search.ids.includes(res.id!), "explicit includeRetired search should still find it");
			const live = await service.lookup({ text: "git switch branch", limit: 5 }, info);
			assert.ok(!live.ids.includes(res.id!), "retired records must not surface in normal search");
			await service.restore([res.id!]);
			assert.ok(fs.existsSync(active), "restore must move the record back");
		} finally {
			cleanup(dir);
		}
	});

	test("parallel writers do not corrupt the store (lock plus atomic rename)", async () => {
		const { service, store, info, dir } = fresh("parallel");
		try {
			const topics: [string, string, string][] = [
				["git", "git: use switch -c instead of checkout -b for new branches", "Verified here: git switch -c name creates the branch cleanly, while git checkout -b name prints a deprecation warning in this git version."],
				["node", "node: unset NODE_OPTIONS before jest watch starts", "Unsetting NODE_OPTIONS before jest watch removes the openssl-legacy-provider crash that happened in this environment."],
				["make", "make: use -j4 to avoid the codegen race", "Running make -j4 finishes codegen without the interleaved writes that corrupted generated files in this repo."],
				["curl", "curl: add retry connrefused for a booting dev server", "Adding curl --retry 3 --retry-connrefused removed the false failures while the dev server was still starting."],
				["pnpm", "pnpm: frozen-lockfile install is the CI default here", "pnpm install --frozen-lockfile matches CI behaviour and avoids lockfile drift in this repository."],
			];
			const results = await Promise.all(
				topics.map(([category, title, statement]) =>
					service.add({ kind: "fact", category, title, statement, evidence: [{ type: "command", ref: title }], cues: [category, title.slice(0, 30)], confidence: 2 }, info),
				),
			);
			const problems = results.flatMap((r) => r.problems);
			assert.equal(results.filter((r) => r.ok).length, topics.length, `all distinct writes should succeed: ${problems.join(" | ")}`);
			await service.refresh(true);
			const counts = store.counts();
			assert.equal(counts.invalid, 0, "no file may be left unparsable");
			assert.ok(!fs.existsSync(path.join(store.root, ".lock")), "lock must be released");
		} finally {
			cleanup(dir);
		}
	});

	test("hard delete removes the file for good", async () => {
		const { service, store, info, dir } = fresh("delete");
		try {
			const res = await service.add(
				{
					kind: "fact",
					category: "todelete",
					title: "todelete: this record exists only to be deleted permanently",
					statement: "Created by the store test to prove hardDelete removes the file and clears it from the cache afterwards.",
					evidence: [{ type: "command", ref: "/memory delete" }],
					cues: ["delete me", "hard delete"],
					confidence: 2,
				},
				info,
			);
			assert.ok(res.ok, res.problems.join("; "));
			const del = await store.hardDelete([res.id!], "test");
			assert.deepEqual(del.deleted, [res.id]);
			await service.refresh(true);
			assert.ok(!service.store.byId(res.id!));
		} finally {
			cleanup(dir);
		}
	});

	test("a corrupt record is reported, never injected", async () => {
		const { service, store, dir } = fresh("corrupt");
		try {
			fs.mkdirSync(path.join(store.root, "records", "broken"), { recursive: true });
			fs.writeFileSync(path.join(store.root, "records", "broken", "gm-bad-1.md"), "---\nnot frontmatter at all\n", "utf8");
			await service.refresh(true);
			assert.ok(store.counts().invalid >= 1, "corrupt file should be counted as invalid");
			const rep = await store.doctor();
			assert.ok(rep.problems.some((p) => p.includes("gm-bad-1") || p.includes("broken")), rep.problems.join("; "));
			const cat = store.indexPayload(store.cacheRecords()).md;
			assert.match(cat, /Unreadable files/);
		} finally {
			cleanup(dir);
		}
	});

	test("derived indexes match a full rescan after incremental writes", async () => {
		const { service, store, info, dir } = fresh("index-parity");
		const readIndex = () => fs.readFileSync(path.join(dir, "index.json"), "utf8").replace(/"generatedAt": "[^"]+",?/, "");
		const readMd = () => fs.readFileSync(path.join(dir, "INDEX.md"), "utf8").replace(/^Generated .*$/m, "");
		try {
			for (const [category, statement] of [
				["docker", "docker system prune clears the layer cache on this host"],
				["node", "node --test only matches files named .test.ts"],
				["git", "git rebase -i needs GIT_SEQUENCE_EDITOR set"],
			] as [string, string][]) {
				const res = await service.add({ ...GOOD_DRAFT, category, statement, title: statement.slice(0, 40) }, info, { allowPrivate: true });
				assert.ok(res.ok, res.problems.join("; "));
			}
			// A retire moves the file between directories, which is where an incremental cache is
			// most likely to lie about the path, so do it before comparing.
			const list = store.cacheRecords();
			assert.equal(list.length, 3);
			await store.setStatus([list[1].id], "retired", "test retire");
			const incrementalJson = readIndex();
			const incrementalMd = readMd();
			const rebuilt = await store.rebuildIndex();
			assert.equal(rebuilt.records, 3, "a rescan still sees all three files, one of them archived");
			assert.equal(readIndex(), incrementalJson, "index.json from the cache must equal index.json from a rescan");
			assert.equal(readMd(), incrementalMd, "INDEX.md from the cache must equal INDEX.md from a rescan");
			const entries = JSON.parse(readIndex()).records as { id: string; file: string; status: string }[];
			assert.equal(entries.length, 2, "the retired record must be out of the live index either way");
			for (const e of entries) assert.match(e.file, /records[\\/].*\.md$/, "every indexed record must point at a real path");
		} finally {
			cleanup(dir);
		}
	});

	test("hit counters batch instead of rewriting on every lookup", async () => {
		const { service, store, info, dir } = fresh("hits");
		try {
			const res = await service.add({ ...GOOD_DRAFT }, info);
			assert.ok(res.ok, res.problems.join("; "));
			const file = path.join(store.root, "records", "docker", `${res.id}.md`);
			const before = fs.readFileSync(file, "utf8");
			await service.lookup({ text: "docker cache package.json", limit: 3 }, info);
			await service.lookup({ text: "docker cache package.json", limit: 3 }, info);
			const mid = fs.readFileSync(file, "utf8");
			assert.equal(mid, before, "lookups must not rewrite files immediately");
			await service.flush();
			const after = fs.readFileSync(file, "utf8");
			assert.match(after, /hits: [1-9]/);
		} finally {
			cleanup(dir);
		}
	});
});
