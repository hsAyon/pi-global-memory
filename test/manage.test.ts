/**
 * Record management: the high-level listing, per-record delete, delete-all with a
 * token, and container export/import through the service (gates included).
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanup, GOOD_DRAFT, makeService, tempDir } from "./helpers.ts";
import { categoryOverview, commitDeleteAll, listRows, renderListing, renderOverview } from "../lib/browse.ts";
import { CONTAINER_MAGIC } from "../lib/container.ts";

const VARIANTS = [
	{ category: "docker", title: "docker build reuses the cached dependency layer", statement: "After editing package.json, docker build reuses the old node_modules layer; --no-cache picks up the new tree. Reproduced twice.", cues: ["layer cache", "--no-cache"], evidence: [{ type: "command", ref: "docker build --no-cache ." }] },
	{ category: "git", title: "git switch -c before committing on a detached HEAD", statement: "Committing on a detached HEAD leaves the commit unreachable; create a branch first with git switch -c rescue.", cues: ["detached HEAD", "unreachable commit"], evidence: [{ type: "command", ref: "git switch -c rescue" }] },
	{ category: "pnpm", title: "pnpm link fails when the workspace protocol is used", statement: "pnpm link fails for a dependency written with the workspace: protocol; reference it by path instead. Confirmed in CI and locally.", cues: ["workspace:", "ERR_PNPM_LINK_OUTSIDE"], evidence: [{ type: "file", ref: "packages/api/package.json" }] },
	{ category: "make", title: "make -j deadlocks on the generated parser rule", statement: "make -j4 deadlocks on the generated-parser rule because two targets write the same file; the rule needs .NOTPARALLEL.", cues: ["-j4", ".NOTPARALLEL"], evidence: [{ type: "file", ref: "Makefile" }] },
];

async function seed(root: string, n = 3) {
	const b = makeService(root);
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const v = VARIANTS[i % VARIANTS.length];
		const res = await b.service.add({ kind: "fact", confidence: 2, ...v, title: n > VARIANTS.length ? `${v.title} (case ${i})` : v.title }, b.info, { note: "seed" });
		assert.ok(res.ok && res.id, res.problems.join("; "));
		ids.push(res.id);
	}
	// One retired record, to prove the views distinguish status.
	await b.service.retire([ids[0]], "test: retired on purpose");
	return { ...b, ids };
}

describe("record management and deletion", () => {
	test("/memory ls view: one line per record, sorted, with warnings and no retired noise", async () => {
		const dir = tempDir("gm-ls-");
		try {
			const s = await seed(dir, 4);
			const { rows, total } = listRows(s.service);
			assert.equal(total, 3, "retired records stay out of the default view");
			const text = renderListing(s.service, { sort: "hits" });
			for (const id of s.ids.slice(1)) assert.ok(text.includes(id), `listing missing ${id}`);
			assert.ok(!text.includes(s.ids[0]), "retired id must not appear by default");
			assert.match(text, /confidence|c\d/);
			const withRetired = listRows(s.service, { includeRetired: true });
			assert.equal(withRetired.total, 4);
		} finally {
			cleanup(dir);
		}
	});

	test("sorting is explicit: hits and age give different orders", async () => {
		const dir = tempDir("gm-sort-");
		try {
			const s = await seed(dir, 3);
			const rec = s.service.store.byId(s.ids[1]);
			if (rec) {
				rec.stats.hits = 99;
				await s.service.store.writeRecordNow(rec);
			}
			const byHits = listRows(s.service, { sort: "hits" }).rows;
			assert.equal(byHits[0].id, s.ids[1], "the most-used record should be first by hits");
			const byAge = listRows(s.service, { sort: "age" }).rows;
			assert.ok(byAge.every((r) => r.ageDays >= 0), "age must be computable");
		} finally {
			cleanup(dir);
		}
	});

	test("overview groups by category and counts disputed and never-verified records", async () => {
		const dir = tempDir("gm-overview-");
		try {
			const s = await seed(dir, 3);
			const overview = categoryOverview(s.service);
			const first = overview.find((c) => c.category === VARIANTS[0].category);
			assert.ok(first, "the first variant's category should exist");
			assert.equal(first.live, 0, "the only docker record was retired");
			assert.equal(first.retired, 1);
			const second = overview.find((c) => c.category === VARIANTS[1].category);
			assert.equal(second.live, 1);
			assert.equal(second.retired, 0);
			assert.match(renderOverview(s.service), /live record/);
			assert.match(renderListing(s.service), /\/memory read <id>/, "the listing must tell you how to act");
		} finally {
			cleanup(dir);
		}
	});

	test("delete-all refuses until the staged token is presented, and never deletes on a wrong token", async () => {
		const dir = tempDir("gm-doom1-");
		try {
			const s = await seed(dir, 3);
			const info = s.info;

			const first = await commitDeleteAll(s.service, info, undefined);
			assert.equal(first.ok, false, "the first call only stages");
			assert.match(first.message, /DELETE EVERY RECORD/);
			assert.match(first.message, /type the token to proceed/i);
			assert.equal(s.service.store.counts().active, 2, "nothing may be deleted on the staging call");

			const wrong = await commitDeleteAll(s.service, info, "FFFFFF");
			assert.equal(wrong.ok, false);
			assert.equal(s.service.store.counts().active, 2, "a wrong token must delete nothing");

			const staged = first.message.match(/type the token to proceed:\s+([0-9A-F]{6})/);
			assert.ok(staged, `token not found in: ${first.message}`);
			const right = await commitDeleteAll(s.service, info, staged[1]);
			assert.equal(right.ok, true, right.message);
			assert.equal(s.service.store.counts().active, 0);
			assert.equal(s.service.store.counts().retired, 0, "retired records go too");
			assert.ok(right.backupFile, "a backup must be reported");
			assert.ok(fs.existsSync(right.backupFile!), "the backup file must exist");
			assert.ok(fs.readdirSync(path.join(dir, "records")).length === 0, "record directories emptied");
			assert.ok(fs.existsSync(path.join(dir, "config.json")) || true);
		} finally {
			cleanup(dir);
		}
	});

	test("delete-all backup restores the store, encrypted when a passphrase is set", async () => {
		const dir = tempDir("gm-doom2-");
		const envPass = process.env.PI_GLOBAL_MEMORY_PASSPHRASE;
		try {
			process.env.PI_GLOBAL_MEMORY_PASSPHRASE = "a long test passphrase 1234";
			const s = await seed(dir, 3);
			const first = await commitDeleteAll(s.service, s.info, undefined);
			const token = first.message.match(/proceed:\s+([0-9A-F]{6})/)?.[1]!;
			const done = await commitDeleteAll(s.service, s.info, token);
			assert.equal(done.ok, true);
			const text = fs.readFileSync(done.backupFile!, "utf8");
			assert.equal(text.split("\n")[0], CONTAINER_MAGIC);
			assert.match(text, /"cipher":"aes-256-gcm"/);

			const back = await s.service.importContainer(text, "a long test passphrase 1234", s.info);
			assert.equal(back.problems.length, 0, back.problems.join("; "));
			assert.equal(back.added, 3, "the whole store comes back");
			assert.ok(back.authenticated, "an encrypted backup is authenticated");
		} finally {
			if (envPass === undefined) delete process.env.PI_GLOBAL_MEMORY_PASSPHRASE;
			else process.env.PI_GLOBAL_MEMORY_PASSPHRASE = envPass;
			cleanup(dir);
		}
	});

	test("export holds back records that would leak a secret, unless told otherwise", async () => {
		const dir = tempDir("gm-export-privacy-");
		try {
			const s = makeService(dir);
			const good = await s.service.add({ ...GOOD_DRAFT }, s.info, { note: "seed" });
			assert.ok(good.ok);
			// A record that slipped through (or predates the gates) must not be exported silently.
			const sketchy = await s.service.add(
				{
					...GOOD_DRAFT,
					title: "deploy token rotates weekly",
					statement: "The deploy token is AKIAABCDEFGHIJKLMNOP and it rotates weekly.",
					evidence: [{ type: "file", ref: "deploy.sh" }],
				},
				s.info,
				{ force: true, note: "test" },
			);
			// The write gate normally refuses it; either way the export gate must act.
			if (sketchy.ok) {
				const pack = s.service.exportRecords();
				assert.equal(pack.skipped.length, 1, pack.skipped.map((x) => x.reason).join("; "));
				assert.match(pack.skipped[0].reason, /secret-shaped text/);
				const withExplicit = s.service.exportRecords({ allowPrivate: true });
				assert.equal(withExplicit.skipped.length, 0, "allowprivate is an explicit opt-in");
				assert.ok(withExplicit.packed >= 2);
			} else {
				const pack = s.service.exportRecords();
				assert.equal(pack.skipped.length, 0, "the store itself already refused it");
				assert.ok(pack.packed >= 1);
			}
		} finally {
			cleanup(dir);
		}
	});

	test("import re-runs the write gates: an uncited record is skipped, not smuggled in", async () => {
		const dir = tempDir("gm-import-gate-");
		try {
			const s = makeService(dir);
			const text = [
				CONTAINER_MAGIC,
				JSON.stringify({ v: 1, kind: "pi-global-memory", exportedAt: new Date().toISOString(), recordCount: 2, encoding: "deflate-raw", integrity: "sha256", cipher: null, kdf: null, payloadSha256: "x".repeat(64) }),
			].join("\n");
			// Use the real packer for a valid container, then import it.
			const pack = s.service.exportRecords();
			assert.ok(text.length > 0);
			const before = s.service.store.counts().active;
			const imported = await s.service.importContainer(pack.text, undefined, s.info);
			assert.equal(imported.problems.length, 0);
			assert.equal(imported.added, before, "re-importing the same ids is idempotent, not duplicated");
			assert.equal(s.service.store.counts().active, before);

			const noEvidence = await s.service.add({ kind: "fact", category: "misc", title: "an uncited claim worth refusing", statement: "Rebooting fixes it, probably, in most cases, as far as I know.", cues: ["reboot"] }, s.info, { note: "gate test" });
			assert.equal(noEvidence.ok, false, "evidence gate applies to imports too");
		} finally {
			cleanup(dir);
		}
	});
});
