import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DEFAULTS, type GmConfig } from "../lib/types.ts";
import { MemoryStore } from "../lib/store.ts";
import { MemoryService, type RunInfo } from "../lib/service.ts";

export function tempDir(prefix = "gm-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* tmp on some systems is already private */
	}
	return dir;
}

export function cleanup(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* windows occasional EBUSY; temp dir gets collected anyway */
	}
}

export function testConfig(root: string, over: Partial<GmConfig> = {}): GmConfig {
	return { ...CONFIG_DEFAULTS, dir: root, ...over };
}

export function makeService(root: string, over: Partial<GmConfig> = {}): ServiceBundle {
	const cfg = testConfig(root, over);
	const store = new MemoryStore(root, cfg);
	const service = new MemoryService(cfg, store);
	store.ensure();
	const info: RunInfo = {
		cwd: root,
		sessionId: "test-session",
		projectTrusted: true,
		ephemeral: false,
		hasUI: false,
		mode: "test",
	};
	return { service, store, info };
}

export interface ServiceBundle {
	service: MemoryService;
	store: MemoryStore;
	info: RunInfo;
}

export const GOOD_DRAFT = {
	kind: "research",
	category: "docker",
	title: 'docker: "npm run build" busts the cache after package.json edits',
	statement: 'In this repo, "docker build ." reuses the old node_modules layer after package.json changes; "docker build --no-cache ." picks up the new dependency tree, verified twice.',
	why: "The COPY layer hash for package.json changed but the cache key for node_modules was reused.",
	how: 'Run "docker build --no-cache ." when dependencies changed.',
	avoid: '"docker build ." after editing package.json.',
	tags: ["docker", "build"],
	cues: ["docker build --no-cache", "layer cache", "package.json"],
	confidence: 2,
	evidence: [
		{ type: "command", ref: "docker build --no-cache ." },
		{ type: "file", ref: "Dockerfile", note: "COPY package.json layer" },
	],
};
