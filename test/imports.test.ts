import { test } from "node:test";
import * as assert from "node:assert/strict";

/**
 * Cheap syntax/eval smoke: node's type stripping reports a single opaque
 * ERR_INVALID_TYPESCRIPT_SYNTAX for a brace slip, which is otherwise invisible
 * until pi tries to load the extension. Import every module once to catch it.
 */
const MODULES = [
	"../lib/types.ts",
	"../lib/util.ts",
	"../lib/sanitize.ts",
	"../lib/trust.ts",
	"../lib/record.ts",
	"../lib/config.ts",
	"../lib/store.ts",
	"../lib/search.ts",
	"../lib/prompt.ts",
	"../lib/capture.ts",
	"../lib/heal.ts",
	"../lib/service.ts",
	"../lib/schemas.ts",
	"../lib/tools.ts",
	"../lib/commands.ts",
	"../index.ts",
];

for (const rel of MODULES) {
	test(`module loads: ${rel}`, async () => {
		const mod = await import(rel);
		assert.ok(mod !== undefined);
	});
}
