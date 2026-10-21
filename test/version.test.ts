/**
 * Release hygiene: one version, one changelog head, and a published file set that
 * matches what actually runs. This is what keeps an installed extension free of
 * development scaffolding.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const { EXTENSION_VERSION, STORE_FORMAT, CONTAINER_FORMAT } = await import("../lib/version.ts");

/** Collect every file reachable by relative import from an entry point. */
function closure(entry: string, seen = new Set<string>()): Set<string> {
	const abs = path.resolve(ROOT, entry);
	if (seen.has(abs) || !fs.existsSync(abs)) return seen;
	seen.add(abs);
	const text = fs.readFileSync(abs, "utf8");
	const re = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
	for (const m of text.matchAll(re)) {
		const target = path.resolve(path.dirname(abs), m[1]);
		closure(path.relative(ROOT, target), seen);
	}
	return seen;
}

function inAllowlist(rel: string, files: string[]): boolean {
	return files.some((f) => (f.endsWith("/") ? rel === f.slice(0, -1) || rel.startsWith(f) : rel === f));
}

describe("versioning and packaging", () => {
	test("the version constant matches package.json", () => {
		assert.equal(pkg.version, EXTENSION_VERSION, `package.json says ${pkg.version}, lib/version.ts says ${EXTENSION_VERSION}`);
	});

	test("CHANGELOG's newest entry is the current version", () => {
		const head = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").match(/^## (\S+)/m);
		assert.ok(head, "CHANGELOG.md has no version heading");
		assert.equal(head[1], EXTENSION_VERSION, `CHANGELOG top is ${head[1]}, package is ${EXTENSION_VERSION}`);
	});

	test("the pi manifest points at a file that exists", () => {
		const entries = pkg?.pi?.extensions ?? [];
		assert.ok(entries.length > 0, "package.json must declare pi.extensions");
		for (const e of entries) assert.ok(fs.existsSync(path.resolve(ROOT, e)), `declared extension ${e} is missing`);
	});

	test("everything the extension loads at runtime is inside the published files", () => {
		const files: string[] = pkg.files ?? [];
		assert.ok(files.length > 0, "package.json must declare \"files\" so installs are clean");
		const entry = pkg.pi.extensions[0];
		const runtime = [...closure(entry)].map((p) => path.relative(ROOT, p).replace(/\\/g, "/"));
		assert.ok(runtime.length >= 10, `unexpectedly small runtime closure: ${runtime.length} files`);
		for (const rel of runtime) {
			assert.ok(inAllowlist(rel, files), `${rel} is imported at runtime but not published (add it to package.json "files")`);
		}
	});

	test("development scaffolding is never reachable from the entry point", () => {
		const runtime = [...closure(pkg.pi.extensions[0])].map((p) => path.relative(ROOT, p).replace(/\\/g, "/"));
		for (const rel of runtime) {
			assert.ok(!rel.startsWith("test/"), `test file imported by the extension: ${rel}`);
			assert.ok(!rel.startsWith("scripts/"), `dev script imported by the extension: ${rel}`);
			assert.ok(!rel.startsWith("docs/"), `development notes imported by the extension: ${rel}`);
		}
		const devOnly = ["docs", "test", "scripts"];
		for (const d of devOnly) assert.ok(!pkg.files.includes(`${d}/`), `${d}/ must not be published`);
	});

	test("format versions are declared and sane", () => {
		assert.equal(typeof STORE_FORMAT, "number");
		assert.equal(typeof CONTAINER_FORMAT, "number");
		assert.ok(STORE_FORMAT >= 1 && CONTAINER_FORMAT >= 1);
		const container = fs.readFileSync(path.join(ROOT, "lib/container.ts"), "utf8");
		assert.match(container, /CONTAINER_FORMAT/, "the container must stamp its own version");
		const store = fs.readFileSync(path.join(ROOT, "lib/store.ts"), "utf8");
		assert.match(store, /version: STORE_FORMAT/, "index.json must declare the store format");
	});

	test("no local machine paths are baked into the package", () => {
		// The extension must work for any user: absolute home or drive paths are bugs.
		const runtime = [...closure(pkg.pi.extensions[0])].map((p) => path.relative(ROOT, p).replace(/\\/g, "/"));
		const offenders: string[] = [];
		for (const rel of runtime) {
			const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
			if (/[A-Za-z]:[\\/](?:Users|home)[\\/]/.test(text)) offenders.push(`${rel}: absolute user path`);
			if (["C:\\", "D:\\"].some((needle) => text.includes(needle))) offenders.push(`${rel}: drive-letter path`);
		}
		assert.deepEqual(offenders, [], offenders.join("\n"));
	});
});
