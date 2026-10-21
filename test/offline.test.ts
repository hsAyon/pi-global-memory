/**
 * Offline invariant. This test is the enforcement behind the "fully local,
 * offline, no internet" promise: it fails the build if any source file imports
 * or references a network capability.
 */

import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
/** Every shipped module is scanned; adding a file cannot dodge the invariant. */
const SHIPPED = ["index.ts", ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`)].sort();
const SOURCES = SHIPPED;


const FORBIDDEN: { name: string; re: RegExp }[] = [
	{ name: "node:http", re: /\bnode:http\b|\bfrom\s+["']http["']|\brequire\(["']http["']\)/ },
	{ name: "node:https", re: /\bnode:https\b|\bfrom\s+["']https["']|\brequire\(["']https["']\)/ },
	{ name: "node:net", re: /\bnode:net\b|\bfrom\s+["']net["']|\brequire\(["']net["']\)/ },
	{ name: "node:tls", re: /\bnode:tls\b|\brequire\(["']tls["']\)/ },
	{ name: "node:dns", re: /\bnode:dns\b/ },
	{ name: "node:dgram", re: /\bnode:dgram\b/ },
	{ name: "node:worker_threads", re: /\bnode:worker_threads\b/ },
	{ name: "fetch", re: /(^|[^.\w])fetch\s*\(/ },
	{ name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
	{ name: "WebSocket", re: /\bWebSocket\b/ },
	{ name: "EventSource", re: /\bEventSource\b/ },
	{ name: "navigator.sendBeacon", re: /\bsendBeacon\b/ },
	{ name: "pi model streaming", re: /streamSimple|ctx\.modelRegistry|pi\.registerProvider|sendUserMessage|sendMessage\s*\(/ },
	{ name: "shell string execution", re: /\bexecSync\b|\bspawnSync\b|\bchild_process\b|(?<![.\w$])exec\s*\(/ },
];

/** Only this one file may spawn a process at all, and only for contained git. */
const PROCESS_USERS = new Set(["lib/util.ts"]);
/** The confinement rules are asserted here so a removed control fails a test. */
const GIT_CONTAINMENT = [
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
	"--git-dir",
	"--work-tree",
	"GIT_ALLOWED",
];

test("every source file listed for the offline scan exists", () => {
	const missing = SOURCES.filter((s) => !fs.existsSync(path.join(ROOT, s)));
	if (missing.length > 0) throw new Error(`update the offline scan list, missing: ${missing.join(", ")}`);
});

test("no network APIs are referenced anywhere in the extension", () => {
	const findings: string[] = [];
	for (const rel of SOURCES) {
		const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
		const code = stripComments(text);
		for (const rule of FORBIDDEN) {
			// util.ts and store.ts may spawn a local process; the third test pins how.
			if (PROCESS_USERS.has(rel) && rule.name === "shell string execution") continue;
			if (rule.re.test(code)) findings.push(`${rel}: ${rule.name}`);
		}
	}
	if (findings.length > 0) throw new Error(`offline invariant violated:\n  ${findings.join("\n  ")}`);
});

test("child_process is only used for git, with argv form and no shell", () => {
	const offenders: string[] = [];
	for (const rel of SOURCES) {
		const text = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
		if (!/\bchild_process\b|\bspawn\b/.test(text)) continue;
		if (!PROCESS_USERS.has(rel)) offenders.push(`${rel}: uses child_process but is not allow-listed`);
		if (/shell\s*:\s*true/.test(text)) offenders.push(`${rel}: spawn with shell:true`);
	}
	if (offenders.length > 0) throw new Error(offenders.join("\n"));

	const store = stripComments(fs.readFileSync(path.join(ROOT, "lib/store.ts"), "utf8"));
	const util = stripComments(fs.readFileSync(path.join(ROOT, "lib/util.ts"), "utf8"));
	if (!/spawn\(/.test(util)) throw new Error("util.ts no longer spawns through a shared helper");
	if (/shell\s*:\s*true/.test(util)) throw new Error("util.ts spawns with a shell");
	if (/\bspawn\(/.test(store)) throw new Error("store.ts must spawn only through the run() helper");
	for (const required of ["GIT_ALLOW_PROTOCOL", "protocol.ext.allow=never", '"add"', '"commit"']) {
		if (!store.includes(required)) throw new Error(`store.ts lost a git hardening control: ${required}`);
	}
	for (const control of GIT_CONTAINMENT) {
		if (!store.includes(control)) throw new Error(`store.ts lost a git containment control: ${control}`);
	}
	for (const networked of ['"push"', '"fetch"', '"pull"', '"clone"', '"ls-remote"', '"submodule"']) {
		if (store.includes(networked)) throw new Error(`store.ts may run a networked git subcommand: ${networked}`);
	}
});

test("the store is written with atomic rename and an exclusive lock", () => {
	const util = stripComments(fs.readFileSync(path.join(ROOT, "lib/util.ts"), "utf8"));
	const store = stripComments(fs.readFileSync(path.join(ROOT, "lib/store.ts"), "utf8"));
	if (!/renameSync/.test(util)) throw new Error("util.ts lost its atomic rename");
	if (!/"wx"/.test(store)) throw new Error("store.ts no longer takes an exclusive lock file");
	if (!/0o700/.test(util)) throw new Error("util.ts no longer creates private directories");
});

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
