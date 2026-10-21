/**
 * Configuration resolution.
 *
 * Precedence, highest wins:
 *   1. environment variables (PI_GLOBAL_MEMORY_*)
 *   2. the `globalMemory` object in pi's settings.json (via pi.getSettings())
 *   3. `<store>/config.json` (written by `/memory config set`)
 *   4. CONFIG_DEFAULTS in lib/types.ts
 *
 * Validation rules come from lib/configspec.ts, so the text that describes a
 * setting and the rule that accepts it can never disagree. A rejected value is
 * reported and ignored - never guessed at - because a silently coerced privacy
 * setting is a security bug.
 *
 * No pi imports here so the resolution logic is unit-testable on its own.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { GmConfig } from "./types.ts";
import { CONFIG_DEFAULTS } from "./types.ts";
import { boolSpecKeys, enumSpecKeys, explainProblem, hintFor, numericSpecKeys, specFor, stringSpecKeys } from "./configspec.ts";
import { expandHome, isPlainObject } from "./util.ts";

export const SETTINGS_KEY = "globalMemory";
export const ENV_PREFIX = "PI_GLOBAL_MEMORY_";

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	// Documented in pi docs/configuration.md: PI_CODING_AGENT_DIR, else ~/.pi/agent.
	const fromEnv = env.PI_CODING_AGENT_DIR;
	if (fromEnv && String(fromEnv).trim()) return expandHome(String(fromEnv).trim());
	return path.join(os.homedir(), ".pi", "agent");
}

export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentDir(env), "global-memory");
}

const NUM_RANGES = numericSpecKeys();
const ENUM_KEYS = enumSpecKeys();
const STRING_KEYS = stringSpecKeys();
const BOOL_KEYS = boolSpecKeys();
const ALL_KEYS = Object.keys(CONFIG_DEFAULTS);

function coerceBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(s)) return true;
		if (["0", "false", "no", "off"].includes(s)) return false;
	}
	return undefined;
}

function coerceNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function applySource(target: GmConfig, src: unknown, label: string, problems: string[]): void {
	if (src === undefined || src === null) return;
	if (!isPlainObject(src)) {
		problems.push(`${label}: expected an object`);
		return;
	}
	for (const [rawKey, value] of Object.entries(src)) {
		const key = rawKey as keyof GmConfig;
		if (!(rawKey in CONFIG_DEFAULTS)) {
			const near = ALL_KEYS.filter((k) => k.startsWith(rawKey.slice(0, 3)));
			problems.push(`${label}: unknown setting "${rawKey}" (ignored)${near.length ? ` - did you mean: ${near.join(", ")}?` : ""}`);
			continue;
		}
		if (value === undefined || value === null) continue;
		if (key === "dir") {
			if (typeof value !== "string" || !value.trim()) {
				problems.push(`${label}: ${explainProblem("dir", "dir must be a non-empty path")}`);
				continue;
			}
			target.dir = path.resolve(expandHome(value));
			continue;
		}
		if (BOOL_KEYS.includes(key)) {
			const b = coerceBool(value);
			if (b === undefined) {
				problems.push(`${label}: ${explainProblem(rawKey, `${rawKey} must be true or false`)}`);
				continue;
			}
			target[key] = b as never;
			continue;
		}
		const allowed = ENUM_KEYS[key];
		if (allowed) {
			const list = allowed as readonly string[];
			if (typeof value !== "string" || !list.includes(value)) {
				problems.push(`${label}: ${rawKey} must be one of ${list.join(" | ")}  (${hintFor(rawKey)})`);
				continue;
			}
			(target as Record<string, unknown>)[rawKey] = value;
			continue;
		}
		if (STRING_KEYS.includes(key)) {
			if (typeof value !== "string" || value.length > 64) {
				problems.push(`${label}: ${explainProblem(rawKey, `${rawKey} must be a short string (<= 64 chars)`)}`);
				continue;
			}
			(target as Record<string, unknown>)[rawKey] = value;
			continue;
		}
		const range = NUM_RANGES[key];
		if (range) {
			const n = coerceNumber(value);
			if (n === undefined) {
				problems.push(`${label}: ${explainProblem(rawKey, `${rawKey} must be a number`)}`);
				continue;
			}
			if (n < range[0] || n > range[1]) {
				problems.push(`${label}: ${rawKey}=${n} out of range ${range[0]}..${range[1]}  (${hintFor(rawKey)})`);
				continue;
			}
			target[key] = n as never;
			continue;
		}
		problems.push(`${label}: ${rawKey} has no coercion rule`);
	}
}

export interface ResolveInput {
	env?: NodeJS.ProcessEnv;
	settings?: unknown;
	file?: unknown;
	/** Used when nothing sets dir. */
	cwd?: string;
}

export interface ResolvedConfig {
	config: GmConfig;
	problems: string[];
	sources: string[];
}

/** Env var name -> config key. Only the switches an operator may need to force. */
const ENV_MAP: [string, keyof GmConfig][] = [
	["DIR", "dir"],
	["INJECT", "inject"],
	["REDACT", "redactSecrets"],
	["AUTOCAPTURE", "autoCapture"],
	["READONLY", "readOnly"],
	["GIT_AUTOCOMMIT", "gitAutoCommit"],
	["STATUSLINE", "statusLine"],
	["MAX_INDEX_ENTRIES", "maxIndexEntries"],
	["CATALOG_MAX_CHARS", "catalogMaxChars"],
	["HITS_MAX_CHARS", "hitsMaxChars"],
	["USE", "use"],
	["RECORD", "record"],
	["PRIVACY", "privacy"],
	["SKETCHY", "sketchy"],
	["SELFHEAL", "selfHeal"],
	["MIN_QUALITY", "minQuality"],
	["TOGGLE_SHORTCUT", "toggleShortcut"],
];

export function resolveConfig(input: ResolveInput): ResolvedConfig {
	const env = input.env ?? process.env;
	const problems: string[] = [];
	const sources: string[] = [];
	const config: GmConfig = { ...CONFIG_DEFAULTS, dir: defaultStoreDir(env) };
	sources.push("defaults");

	applySource(config, input.file, "config.json", problems);
	if (input.file && isPlainObject(input.file) && Object.keys(input.file).length > 0) sources.push("config.json");

	applySource(config, input.settings ? (input.settings as Record<string, unknown>)[SETTINGS_KEY] : undefined, `settings.json:${SETTINGS_KEY}`, problems);
	const settingsObj = input.settings as Record<string, unknown> | undefined;
	if (settingsObj && isPlainObject(settingsObj[SETTINGS_KEY])) sources.push(`settings.json:${SETTINGS_KEY}`);

	// Environment last so an operator can always force a safe state.
	for (const [suffix, key] of ENV_MAP) {
		const v = env[`${ENV_PREFIX}${suffix}`];
		if (v === undefined) continue;
		applySource(config, { [key]: v }, `env ${ENV_PREFIX}${suffix}`, problems);
		sources.push(`env ${ENV_PREFIX}${suffix}`);
	}
	if (coerceBool(env[`${ENV_PREFIX}DISABLE`]) === true) {
		config.enabled = false;
		sources.push("env PI_GLOBAL_MEMORY_DISABLE");
	}
	if (coerceBool(env[`${ENV_PREFIX}ENABLE`]) === true) config.enabled = true;

	if (!config.dir) config.dir = defaultStoreDir(env);
	return { config, problems, sources: [...new Set(sources)] };
}

/** Parse `key value` text from `/memory config set`. Never applies a partial value. */
export function parseConfigPatch(key: string, value: string): { patch: Record<string, unknown>; problems: string[] } {
	if (!key || !(key in CONFIG_DEFAULTS)) {
		const near = key ? ALL_KEYS.filter((k) => k.startsWith(key.slice(0, 3))) : [];
		return {
			patch: {},
			problems: [
				`unknown setting "${key}"${near.length ? ` - did you mean: ${near.join(", ")}?` : ""}\nlist every key with: /memory config list\nexplain one with:  /memory config explain <key>`,
			],
		};
	}
	const probe: GmConfig = { ...CONFIG_DEFAULTS };
	const problems: string[] = [];
	applySource(probe, { [key]: value }, `"${key}"`, problems);
	if (problems.length > 0) {
		const spec = specFor(key);
		if (spec?.sensitive) problems.push(`"${key}" affects privacy or safety - read /memory config explain ${key} before relaxing it.`);
		return { patch: {}, problems };
	}
	return { patch: { [key]: (probe as Record<string, unknown>)[key] }, problems };
}

export function configKeys(): string[] {
	return [...ALL_KEYS].sort();
}

