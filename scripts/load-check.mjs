/**
 * Real-pi load check (not a unit test).
 *
 * Drives pi's own extension loader - jiti/TypeScript compilation, pi's module
 * resolution, and pi's registration bookkeeping - against this folder, then
 * compiles the TypeBox parameter schemas. This is what catches "pi rejected the
 * extension at startup" problems that a mock-API unit test cannot see.
 *
 *   node scripts/load-check.mjs [extension-dir]
 *
 * No network I/O, no model call, no agent loop.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Compile } from "typebox/compile";

function findPiInstall() {
	const candidates = [];
	if (process.env.PI_CODING_AGENT_INSTALL) candidates.push(process.env.PI_CODING_AGENT_INSTALL);
	const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	if (fs.existsSync(releases)) {
		for (const v of fs.readdirSync(releases).sort().reverse()) {
			candidates.push(path.join(releases, v, "node_modules", "@earendil-works", "pi-coding-agent"));
		}
	}
	// Also honour a plain node_modules walk upwards from here (dev checkouts).
	let dir = path.resolve(".");
	for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
		candidates.push(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"));
		dir = path.dirname(dir);
	}
	for (const c of candidates) if (c && fs.existsSync(c)) return c;
	throw new Error(`could not find an installed @earendil-works/pi-coding-agent; tried:\n  ${candidates.join("\n  ")}`);
}

const pkg = findPiInstall();
const pi = await import(pathToFileURL(path.join(pkg, "dist", "index.js")).href);

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.resolve(process.argv[2] ?? here);

const store = fs.mkdtempSync(path.join(os.tmpdir(), "gm-load-check-"));
process.env.PI_GLOBAL_MEMORY_DIR = path.join(store, "memory");

const result = await pi.discoverAndLoadExtensions([extensionDir], extensionDir);
const ext = result.extensions[0];

const tools = ext ? [...ext.tools.values()].map((t) => t.definition.name).sort() : [];
const commands = ext ? [...ext.commands.keys()].sort() : [];
const flags = ext ? [...ext.flags.keys()].sort() : [];
const handlers = ext ? [...ext.handlers.keys()].sort() : [];

// Compile the schemas the way pi will: a malformed TypeBox schema fails here.
const compiled = {};
if (ext) {
	for (const [name, reg] of ext.tools) {
		const c = Compile(reg.definition.parameters);
		compiled[name] = {
			ok: true,
			props: Object.keys(reg.definition.parameters?.properties ?? {}),
			validateSearch: c.Check({ action: "search", query: "docker cache" }),
			rejectBogus: c.Check({ action: "nope" }) === false,
			rejectMissing: c.Check({ action: "read" }) === false,
		};
	}
}

const report = {
	piPackage: pkg,
	extensionDir,
	loaded: result.extensions.length,
	loadErrors: result.errors,
	tools,
	commands,
	flags,
	handlers,
	schemaChecks: compiled,
};
console.log(JSON.stringify(report, null, 2));

const ok =
	result.errors.length === 0 &&
	result.extensions.length === 1 &&
	JSON.stringify(tools) === JSON.stringify(["memory_lookup", "memory_save"]) &&
	commands.includes("memory") &&
	compiled.memory_lookup?.validateSearch === true &&
	compiled.memory_lookup?.rejectBogus === true &&
	compiled.memory_save?.rejectMissing === true &&
	handlers.includes("before_agent_start") &&
	handlers.includes("tool_result");

fs.rmSync(store, { recursive: true, force: true });
console.log(ok ? "LOAD CHECK PASSED" : "LOAD CHECK FAILED");
process.exit(ok ? 0 : 1);
