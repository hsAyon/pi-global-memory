/**
 * Configuration resolution.
 *
 * Precedence, highest wins:
 *   1. environment variables (PI_GLOBAL_MEMORY_*)
 *   2. the `globalMemory` object in pi's settings.json (via pi.getSettings())
 *   3. `<store>/config.json` (written by `/memory config set`)
 *   4. CONFIG_DEFAULTS in lib/types.ts
 *
 * No pi imports here so the resolution logic is unit-testable on its own.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { GmAutoCapture, GmConfig, GmInjectMode, GmPrivacyMode, GmRedactMode, GmSelfHeal, GmSketchyMode } from "./types.ts";
import { AUTOCAPTURE_MODES, CONFIG_DEFAULTS, INJECT_MODES, PRIVACY_MODES, REDACT_MODES, SELFHEAL_MODES, SKETCHY_MODES } from "./types.ts";
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

const NUM_RANGES: Partial<Record<keyof GmConfig, [number, number]>> = {
	catalogMaxChars: [0, 6000],
	hitsMaxChars: [0, 4000],
	maxIndexEntries: [0, 300],
	maxHits: [0, 12],
	searchMaxChars: [500, 20000],
	readMaxChars: [500, 20000],
	minSearchScore: [0, 20],
	maxWritesPerSession: [0, 500],
	maxRecordChars: [200, 8000],
	dedupThreshold: [0, 1],
	maxSignals: [10, 5000],
	tentativeTtlDays: [0, 3650],
	staleDays: [1, 3650],
	maxActiveRecords: [10, 20000],
	reloadTtlMs: [0, 600000],
	minQuality: [0, 10],
};

const ENUM_KEYS: Partial<Record<keyof GmConfig, readonly string[]>> = {
	inject: INJECT_MODES,
	redactSecrets: REDACT_MODES,
	autoCapture: AUTOCAPTURE_MODES,
	privacy: PRIVACY_MODES,
	sketchy: SKETCHY_MODES,
	selfHeal: SELFHEAL_MODES,
};

const STRING_KEYS: (keyof GmConfig)[] = ["toggleShortcut"];

const BOOL_KEYS: (keyof GmConfig)[] = [
	"enabled",
	"use",
	"record",
	"readOnly",
	"requireEvidence",
	"signals",
	"confirmDestructive",
	"statusLine",
	"gitAutoCommit",
	"restrictProjectPaths",
	"includeTentative",
	"respectSessionPrivacy",
	"requireProjectTrustForWrites",
	"autoVerify",
	"includeDisputed",
];

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
			problems.push(`${label}: unknown setting "${rawKey}" (ignored)`);
			continue;
		}
		if (value === undefined || value === null) continue;
		if (key === "dir") {
			if (typeof value !== "string" || !value.trim()) {
				problems.push(`${label}: dir must be a non-empty path`);
				continue;
			}
			target.dir = path.resolve(expandHome(value));
			continue;
		}
		if (BOOL_KEYS.includes(key)) {
			const b = coerceBool(value);
			if (b === undefined) {
				problems.push(`${label}: ${rawKey} must be true/false`);
				continue;
			}
			target[key] = b as never;
			continue;
		}
		if (key === "inject") {
			if (typeof value !== "string" || !(INJECT_MODES as readonly string[]).includes(value)) {
				problems.push(`${label}: inject must be one of ${INJECT_MODES.join(", ")}`);
				continue;
			}
			target.inject = value as GmInjectMode;
			continue;
		}
		if (key === "redactSecrets") {
			if (typeof value !== "string" || !(REDACT_MODES as readonly string[]).includes(value)) {
				problems.push(`${label}: redactSecrets must be one of ${REDACT_MODES.join(", ")}`);
			} else target.redactSecrets = value as GmRedactMode;
			continue;
		}
		if (key === "autoCapture") {
			if (typeof value !== "string" || !(AUTOCAPTURE_MODES as readonly string[]).includes(value)) {
				problems.push(`${label}: autoCapture must be one of ${AUTOCAPTURE_MODES.join(", ")}`);
			} else target.autoCapture = value as GmAutoCapture;
			continue;
		}
		if (ENUM_KEYS[key]) {
			const allowed = ENUM_KEYS[key] as readonly string[];
			if (typeof value !== "string" || !allowed.includes(value)) {
				problems.push(`${label}: ${rawKey} must be one of ${allowed.join(", ")}`);
				continue;
			}
			(target as Record<string, unknown>)[rawKey] = value;
			continue;
		}
		if (STRING_KEYS.includes(key)) {
			if (typeof value !== "string" || value.length > 64) {
				problems.push(`${label}: ${rawKey} must be a short string (<= 64 chars)`);
				continue;
			}
			(target as Record<string, unknown>)[rawKey] = value;
			continue;
		}
		const range = NUM_RANGES[key];
		if (range) {
			const n = coerceNumber(value);
			if (n === undefined) {
				problems.push(`${label}: ${rawKey} must be a number`);
				continue;
			}
			if (n < range[0] || n > range[1]) {
				problems.push(`${label}: ${rawKey}=${n} out of range ${range[0]}..${range[1]}`);
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
	const envMap: [string, keyof GmConfig][] = [
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
	];
	for (const [suffix, key] of envMap) {
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

/** Parse `key value` text from `/memory config set`. */
export function parseConfigPatch(key: string, value: string): { patch: Record<string, unknown>; problems: string[] } {
	const problems: string[] = [];
	if (!key || !(key in CONFIG_DEFAULTS)) {
		return { patch: {}, problems: [`unknown setting "${key}"; valid: ${Object.keys(CONFIG_DEFAULTS).sort().join(", ")}`] };
	}
	const probe: GmConfig = { ...CONFIG_DEFAULTS };
	applySource(probe, { [key]: value }, "input", problems);
	if (problems.length > 0) return { patch: {}, problems };
	return { patch: { [key]: (probe as Record<string, unknown>)[key] }, problems };
}

export function configKeys(): string[] {
	return Object.keys(CONFIG_DEFAULTS).sort();
}

export function configAsPlainObject(c: GmConfig): Record<string, unknown> {
	return { ...c };
}
