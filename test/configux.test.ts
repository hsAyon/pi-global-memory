/**
 * Configuration must be understandable by a human who did not write the code.
 * These tests pin the registry (every key documented), the renderers (what the
 * user actually reads), and the parity between docs and settings.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DEFAULTS } from "../lib/types.ts";
import { parseConfigPatch, resolveConfig } from "../lib/config.ts";
import { CONFIG_SPEC, GROUP_ORDER, hintFor, renderConfigList, renderExplain, specFor, undocumentedKeys } from "../lib/configspec.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SENSITIVE_EXPECTED = [
	"enabled",
	"record",
	"privacy",
	"sketchy",
	"redactSecrets",
	"requireEvidence",
	"selfHeal",
	"includeDisputed",
	"respectSessionPrivacy",
	"requireProjectTrustForWrites",
	"restrictProjectPaths",
	"autoCapture",
	"confirmDestructive",
	"gitAutoCommit",
	"minSearchScore",
];

describe("configuration is user-facing", () => {
	test("every setting is documented in the registry", () => {
		assert.deepEqual(undocumentedKeys(), [], "these CONFIG_DEFAULTS keys have no user-facing description");
		assert.equal(CONFIG_SPEC.length, Object.keys(CONFIG_DEFAULTS).length, "the registry and the defaults must be the same size");
	});

	test("every documented key says what it does AND what changing it costs", () => {
		for (const spec of CONFIG_SPEC) {
			assert.ok(spec.description && spec.description.length > 20, `${String(spec.key)}: description too thin`);
			assert.ok(spec.effect && spec.effect.length > 20, `${String(spec.key)}: effect too thin`);
			assert.ok(!/[A-Za-z]:[\\/](Users|home)[\\/]/.test(spec.description + spec.effect), `${String(spec.key)}: description contains a machine path`);
			if (spec.type === "enum") assert.ok((spec.values?.length ?? 0) > 1, `${String(spec.key)}: enum without values`);
			if (spec.type === "int" || spec.type === "float") assert.ok(spec.range, `${String(spec.key)}: numeric without a range`);
		}
	});

	test("privacy and safety switches are flagged so the UI can shout about them", () => {
		const flagged = CONFIG_SPEC.filter((s) => s.sensitive).map((s) => String(s.key));
		for (const key of SENSITIVE_EXPECTED) assert.ok(flagged.includes(key), `${key} should be marked sensitive`);
	});

	test("groups are declared once and every key belongs to one", () => {
		const groups = new Set(CONFIG_SPEC.map((s) => s.group));
		for (const g of groups) assert.ok(GROUP_ORDER.includes(g), `group "${g}" is not in GROUP_ORDER`);
		for (const spec of CONFIG_SPEC) assert.ok(typeof spec.group === "string");
	});

	test("/memory config list output is grouped, marks safety-relevant keys, and names the sources", () => {
		const { config, problems, sources } = resolveConfig({ env: {}, settings: { globalMemory: { privacy: "standard" } } });
		const text = renderConfigList(config, sources, problems);
		for (const g of GROUP_ORDER) assert.match(text, new RegExp(`## ${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|## .+`));
		assert.match(text, /\[!\] record/, "the record switch must be flagged");
		assert.match(text, /\[!\] privacy/, "privacy must be flagged");
		assert.match(text, /privacy = "standard"/, "the current (non-default) value must be shown");
		assert.match(text, /\(default\)/, "defaults must be recognisable");
		assert.match(text, /Sources in precedence order/);
		assert.match(text, /settings\.json:globalMemory/);
		assert.match(text, /pi settings\.json key "globalMemory"/, "it must tell the user where settings live");
	});

	test("/memory config list reports rejected settings instead of hiding them", () => {
		const { config, problems, sources } = resolveConfig({ env: {}, settings: { globalMemory: { privacy: "yes" } } });
		const text = renderConfigList(config, sources, problems);
		assert.match(text, /Rejected settings/);
		assert.match(text, /privacy must be one of/);
		assert.equal(config.privacy, "strict", "a rejected value must not weaken the posture");
	});

	test("/memory config explain answers the questions a user actually asks", () => {
		const text = renderExplain("privacy");
		assert.match(text, /^privacy/m);
		assert.match(text, /default:/);
		assert.match(text, /strict \| standard \| off/);
		assert.match(text, /what:/);
		assert.match(text, /effect:/);
		assert.match(text, /set with: \/memory config set privacy <value>/);
	});

	test("a mistyped key gets a suggestion rather than a shrug", () => {
		const res = parseConfigPatch("recrod", "false");
		assert.deepEqual(res.patch, {});
		assert.match(res.problems.join(" "), /unknown setting "recrod"/);
		assert.match(res.problems.join(" "), /did you mean: record/);
	});

	test("a rejected value explains the expected shape and the escape hatch", () => {
		const enumRes = parseConfigPatch("selfHeal", "always");
		assert.match(enumRes.problems.join(" "), /selfHeal must be one of on \| dispute-only \| off/);

		const numRes = parseConfigPatch("catalogMaxChars", "999999");
		assert.match(numRes.problems.join(" "), /out of range 0\.\.6000/);
		assert.match(numRes.problems.join(" "), /integer 0\.\.6000/);

		const risky = parseConfigPatch("redactSecrets", "off");
		assert.equal(risky.problems.length, 0, "legal values are accepted");
		assert.deepEqual(risky.patch, { redactSecrets: "off" });
	});

	test("hintFor is enough to fix a value without reading source", () => {
		assert.equal(hintFor("use"), "bool (true | false)");
		const inj = hintFor("inject");
		for (const mode of ["off", "catalog", "catalog+hits"]) assert.ok(inj.includes(mode), `inject hint omits ${mode}: ${inj}`);
		assert.match(hintFor("minSearchScore"), /number 0\.\.20/);
		assert.match(hintFor("dir"), /absolute path, or ~\/path/);
	});

	test("README documents every setting exactly once", () => {
		const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
		const missing: string[] = [];
		for (const key of Object.keys(CONFIG_DEFAULTS)) {
			const row = new RegExp(String.raw`\|\s*\`?${key}\`?\s*\|`);
			if (!row.test(readme)) missing.push(key);
		}
		assert.deepEqual(missing, [], `README config table is missing: ${missing.join(", ")}`);
	});
});
