/**
 * Configuration: precedence, validation, and the private-by-default posture.
 * These tests pin the contract the README documents, because a silently
 * ignored setting is indistinguishable from a working one at runtime.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { CONFIG_DEFAULTS } from "../lib/types.ts";
import { agentDir, configKeys, defaultStoreDir, parseConfigPatch, resolveConfig, SETTINGS_KEY } from "../lib/config.ts";

describe("config resolution", () => {
	test("the shipped defaults are private-first and accuracy-first", () => {
		const { config, problems } = resolveConfig({ env: {} });
		assert.deepEqual(problems, [], "defaults must resolve cleanly");
		assert.equal(config.privacy, "strict", "personal identifiers and confidential-sounding text must be refused by default");
		assert.equal(config.sketchy, "block", "low-reliability content must be refused by default");
		assert.equal(config.selfHeal, "on", "contradictions must be corrected by default");
		assert.equal(config.autoVerify, true);
		assert.equal(config.includeDisputed, false, "disputed records must not reach the prompt by default");
		assert.equal(config.respectSessionPrivacy, true, "--no-session must suppress recording");
		assert.equal(config.requireProjectTrustForWrites, true);
		assert.equal(config.requireEvidence, true, "no evidence, no record");
		assert.equal(config.redactSecrets, "block");
		assert.ok(config.minQuality >= 3, `minQuality=${config.minQuality}`);
		assert.equal(config.use, true);
		assert.equal(config.record, true);
		assert.equal(config.enabled, true);
	});

	test("context budgets are small enough to be worth it", () => {
		const { config } = resolveConfig({ env: {} });
		assert.ok(config.catalogMaxChars <= 2000, `catalog budget ${config.catalogMaxChars}`);
		assert.ok(config.hitsMaxChars <= 1000, `hits budget ${config.hitsMaxChars}`);
		assert.ok(config.maxHits <= 3, `max hits ${config.maxHits}`);
		assert.ok(config.maxIndexEntries <= 60, `catalog entries ${config.maxIndexEntries}`);
		assert.ok(config.catalogMaxChars + config.hitsMaxChars < 3000, "the two sections together must stay under ~3k chars");
	});

	test("store directory follows PI_CODING_AGENT_DIR, then ~/.pi/agent", () => {
		const withEnv = defaultStoreDir({ PI_CODING_AGENT_DIR: "/tmp/agent-x" });
		assert.equal(withEnv, path.join("/tmp/agent-x", "global-memory"));
		assert.equal(defaultStoreDir({}), path.join(agentDir({}), "global-memory"));
		assert.match(defaultStoreDir({}), /global-memory$/);
	});

	test("precedence: config.json < settings.json < environment", () => {
		const { config, problems, sources } = resolveConfig({
			env: { PI_GLOBAL_MEMORY_HITS_MAX_CHARS: "400" },
			settings: { [SETTINGS_KEY]: { hitsMaxChars: 600, inject: "off" } },
			file: { hitsMaxChars: 999, catalogMaxChars: 1234 },
		});
		assert.deepEqual(problems, []);
		assert.equal(config.hitsMaxChars, 400, "environment must win so an operator can force a safe state");
		assert.equal(config.inject, "off", "settings.json must beat config.json");
		assert.equal(config.catalogMaxChars, 1234, "config.json still applies for keys nothing else sets");
		assert.ok(sources.includes("env PI_GLOBAL_MEMORY_HITS_MAX_CHARS"));
		assert.ok(sources.includes("settings.json:globalMemory"));
		assert.ok(sources.includes("config.json"));
	});

	test("PI_GLOBAL_MEMORY_DISABLE turns everything off; PI_GLOBAL_MEMORY_DIR relocates the store", () => {
		const off = resolveConfig({ env: { PI_GLOBAL_MEMORY_DISABLE: "1" } });
		assert.equal(off.config.enabled, false);
		const moved = resolveConfig({ env: { PI_GLOBAL_MEMORY_DIR: "/tmp/somewhere-else" } });
		assert.equal(moved.config.dir, path.resolve("/tmp/somewhere-else"));
	});

	test("a bad setting is reported and ignored, never guessed at", () => {
		const { config, problems } = resolveConfig({
			env: {},
			settings: {
				[SETTINGS_KEY]: {
					catalogMaxChars: 900000, // out of range
					privacy: "yolo", // not an enum member
					record: "maybe", // not a bool
					nonsenseKey: true, // typo in the user's settings
				},
			},
		});
		assert.equal(config.catalogMaxChars, CONFIG_DEFAULTS.catalogMaxChars, "out-of-range value must not apply");
		assert.equal(config.privacy, "strict", "unknown privacy mode must not loosen the posture");
		assert.equal(config.record, true, "unparseable bool must not flip recording");
		assert.equal(problems.length, 4, problems.join(" | "));
		assert.match(problems.join("\n"), /unknown setting "nonsenseKey"/);
		assert.match(problems.join("\n"), /privacy must be one of/);
		assert.match(problems.join("\n"), /out of range/);
	});

	test("/memory config set validates before writing", () => {
		const good = parseConfigPatch("inject", "catalog");
		assert.deepEqual(good.problems, []);
		assert.deepEqual(good.patch, { inject: "catalog" });

		const toggle = parseConfigPatch("record", "false");
		assert.deepEqual(toggle.patch, { record: false }, "string booleans from the command line must coerce");

		const short = parseConfigPatch("hitsMaxChars", "0");
		assert.deepEqual(short.patch, { hitsMaxChars: 0 }, "0 is legal: it disables the hits section");

		const bad = parseConfigPatch("selfHeal", "sometimes");
		assert.deepEqual(bad.patch, {});
		assert.match(bad.problems.join(" "), /selfHeal must be one of/);

		const typo = parseConfigPatch("recrod", "false");
		assert.deepEqual(typo.patch, {});
		assert.match(typo.problems.join(" "), /unknown setting "recrod"/);

		const range = parseConfigPatch("minQuality", "11");
		assert.deepEqual(range.patch, {});
		assert.match(range.problems.join(" "), /out of range/);
	});

	test("every documented key is settable and every key is known to config", () => {
		const keys = configKeys();
		for (const k of ["dir", "enabled", "use", "record", "inject", "privacy", "sketchy", "selfHeal", "minQuality", "redactSecrets", "requireEvidence", "respectSessionPrivacy", "requireProjectTrustForWrites", "toggleShortcut", "gitAutoCommit", "autoCapture"]) {
			assert.ok(keys.includes(k), `missing config key "${k}"`);
		}
		assert.deepEqual(keys, Object.keys(CONFIG_DEFAULTS).sort(), "configKeys must list every default");
	});
});
