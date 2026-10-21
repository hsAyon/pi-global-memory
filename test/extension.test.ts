/**
 * Wiring test for the real entry point: index.ts loaded against a mock
 * ExtensionAPI. This is what catches "the extension never actually registers"
 * bugs that unit tests on the core cannot see.
 *
 * The mock implements only the pi surface index.ts uses, recorded from pi 1.3.0
 * (docs/extensions.md and dist/core/extensions/types.d.ts).
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { cleanup, GOOD_DRAFT, tempDir } from "./helpers.ts";
import * as fs from "node:fs";
import * as path from "node:path";

type Handler = (event: any, ctx: any) => Promise<any> | any;

interface Tool {
	name: string;
	description: string;
	label?: string;
	promptSnippet?: string;
	parameters: any;
	annotations?: Record<string, boolean>;
	execute: Handler;
}

function makePi() {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, any>();
	const flags = new Map<string, any>();
	const events = new Map<string, Handler[]>();
	const shortcuts: any[] = [];
	let active = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const api = {
		registerTool(t: Tool) {
			tools.set(t.name, t);
		},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
		registerFlag(name: string, opts: any) {
			flags.set(name, opts);
		},
		getFlag(name: string) {
			return flags.get(name)?.defaultValue;
		},
		getSettings() {
			return {};
		},
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
		registerShortcut(id: string, opts: any) {
			shortcuts.push({ id, ...opts });
		},
		on(event: string, handler: Handler) {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
			return () => {};
		},
	};
	return {
		api: api as never,
		tools,
		commands,
		flags,
		shortcuts,
		active: () => active,
		async fire(event: string, ev: unknown, ctx: unknown) {
			const out: unknown[] = [];
			for (const h of events.get(event) ?? []) out.push(await h(ev, ctx));
			return out;
		},
		has: (event: string) => (events.get(event) ?? []).length > 0,
	};
}

function makeCtx(storeDir: string, over: Record<string, unknown> = {}) {
	const notices: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		cwd: storeDir,
		mode: "test",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "sess-mock",
			getSessionFile: () => over["__inMemory"] === true ? undefined : path.join(storeDir, "session.jsonl"),
			getBranch: () => [],
		},
		ui: {
			notify: (msg: string) => notices.push(msg),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
		signal: undefined,
		notices,
		statuses,
		...over,
	};
	return ctx as any;
}

describe("extension wiring (index.ts)", () => {
	test("registers exactly two tools, one command, and the CLI escape hatches", async () => {
		const mock = makePi();
		const mod = await import("../index.ts");
const { globalMemoryExtension } = mod;
		mod.default(mock.api);
		assert.deepEqual([...mock.tools.keys()].sort(), ["memory_lookup", "memory_save"]);
		assert.ok(mock.commands.has("memory"), "/memory command must be registered");
		for (const flag of ["no-global-memory", "global-memory-record", "global-memory-use"]) {
			assert.ok(mock.flags.has(flag), `missing --${flag}`);
		}
		for (const name of ["memory_lookup", "memory_save"]) {
			const t = mock.tools.get(name)!;
			assert.ok(t.description.length > 60, `${name} needs a description the model can act on`);
			assert.ok(t.promptSnippet, `${name} should declare a system-prompt snippet`);
			assert.ok(t.parameters?.properties, `${name} needs an object schema`);
			assert.ok(t.parameters?.properties?.action, `${name} is action-dispatched`);
		}
		assert.equal(mock.tools.get("memory_lookup")!.annotations?.readOnlyHint, true, "lookup must declare itself read-only");
		for (const ev of ["session_start", "session_shutdown", "before_agent_start", "tool_result", "agent_start", "agent_end", "session_tree"]) {
			assert.ok(mock.has(ev), `no handler for ${ev}`);
		}
	});

	test("session_start opens the store, sets status, and announces posture", async () => {
		const dir = tempDir("gm-wire-start-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir);
			await mock.fire("session_start", { type: "session_start" }, ctx);
			assert.ok(fs.existsSync(path.join(dir, "records")), "store tree should exist after session_start");
			assert.ok(fs.existsSync(path.join(dir, ".gitignore")), "store should be untracked by default");
			const status = ctx.statuses.get("global-memory");
			assert.ok(status && /GM use\+record/.test(status), `status text was: ${status}`);
			assert.ok(ctx.notices.some((n) => /global memory:/.test(n)), ctx.notices.join(" | "));
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("before_agent_start injects two budgeted sections and nothing else", async () => {
		const dir = tempDir("gm-wire-inject-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir);
			await mock.fire("session_start", { type: "session_start" }, ctx);

			// Seed through the tool itself, which is how the model writes.
			const save = mock.tools.get("memory_save")!;
			const res = await save.execute(
				"call-1",
				{
					action: "add",
					...GOOD_DRAFT,
				},
				undefined,
				undefined,
				ctx,
			);
			assert.ok(res.details?.ok === true, JSON.stringify(res.details ?? res.content[0]?.text).slice(0, 400));

			const options = { sections: { project_context: "keep me" }, promptGuidelines: [] as string[] };
			const [result] = await mock.fire(
				"before_agent_start",
				{ type: "before_agent_start", messageType: "user", prompt: "why does docker build reuse the old layer cache after I edit package.json?", systemPrompt: "base", systemPromptOptions: options },
				ctx,
			);
			assert.equal(result, undefined, "sections are mutated in place; no full-prompt replacement");
			const sections = options.sections;
			assert.equal(sections.project_context, "keep me", "other prompt sections must survive");
			assert.ok(sections.global_memory, "catalog section missing");
			assert.ok(sections.global_memory_hits, "hits section missing");
			assert.ok(sections.global_memory.length <= 1800, `catalog ${sections.global_memory.length} chars`);
			assert.ok(sections.global_memory_hits.length <= 900, `hits ${sections.global_memory_hits.length} chars`);
			assert.match(sections.global_memory_hits, /gm-/, "the relevant record should be surfaced");
			assert.ok(mock.active().includes("memory_lookup"), "tools stay active while use is on");
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("memory_lookup and memory_save obey the user's toggles and report why", async () => {
		const dir = tempDir("gm-wire-toggle-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir);
			await mock.fire("session_start", { type: "session_start" }, ctx);
			const command = mock.commands.get("memory")!;

			await command.handler("record off", ctx);
			const save = mock.tools.get("memory_save")!;
			const refused = await save.execute("c2", { action: "add", ...GOOD_DRAFT }, undefined, undefined, ctx);
			assert.equal(refused.isError, true, "writing while recording is off must fail, not silently drop");
			assert.match(refused.content[0].text, /recording is OFF/);
			assert.match(refused.content[0].text, /\/memory record on/, "the refusal must name the switch");

			await command.handler("use off", ctx);
			const lookup = mock.tools.get("memory_lookup")!;
			const readRefused = await lookup.execute("c3", { action: "search", query: "docker cache" }, undefined, undefined, ctx);
			assert.equal(readRefused.isError, true);
			assert.match(readRefused.content[0].text, /usage is OFF/);
			assert.ok(!mock.active().includes("memory_lookup"), "tools are withdrawn while use is off");

			await command.handler("on", ctx);
			const back = await lookup.execute("c4", { action: "search", query: "docker cache" }, undefined, undefined, ctx);
			assert.equal(back.isError, false);
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("an in-memory session (--no-session) records nothing but still reads", async () => {
		const dir = tempDir("gm-wire-ephemeral-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir, {
				__inMemory: true,
				sessionManager: {
					getSessionId: () => "sess-ephemeral",
					getSessionFile: () => undefined,
					getBranch: () => [{ type: "message", message: { role: "user" } }],
				},
			});
			await mock.fire("session_start", { type: "session_start" }, ctx);
			const save = mock.tools.get("memory_save")!;
			const refused = await save.execute("c5", { action: "add", ...GOOD_DRAFT }, undefined, undefined, ctx);
			assert.equal(refused.isError, true);
			assert.match(refused.content[0].text, /ephemeral session/);
			const lookup = mock.tools.get("memory_lookup")!;
			const ok = await lookup.execute("c6", { action: "stats" }, undefined, undefined, ctx);
			assert.equal(ok.isError, false, "reading stays available in ephemeral sessions");
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("an untrusted project cannot write through the tool", async () => {
		const dir = tempDir("gm-wire-trust-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir, { isProjectTrusted: () => false });
			await mock.fire("session_start", { type: "session_start" }, ctx);
			const save = mock.tools.get("memory_save")!;
			const refused = await save.execute("c7", { action: "add", ...GOOD_DRAFT }, undefined, undefined, ctx);
			assert.equal(refused.isError, true);
			assert.match(refused.content[0].text, /project trust is denied/);
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("a failing call that contradicts a stored record disputes it on disk", async () => {
		const dir = tempDir("gm-wire-heal-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir);
			await mock.fire("session_start", { type: "session_start" }, ctx);
			const save = mock.tools.get("memory_save")!;
			const res = await save.execute("c8", { action: "add", ...GOOD_DRAFT }, undefined, undefined, ctx);
			const id = res.details?.id as string;
			assert.ok(id, JSON.stringify(res.details));

			await mock.fire("agent_start", { type: "agent_start" }, ctx);
			await mock.fire(
				"tool_result",
				{
					type: "tool_result",
					toolCallId: "t1",
					toolName: "bash",
					input: { command: "docker build --no-cache ." },
					content: [{ type: "text", text: "ERROR: Cannot connect to the Docker daemon" }],
					isError: true,
				},
				ctx,
			);
			await mock.fire("agent_end", { type: "agent_end", messages: [] }, ctx);

			// The record file should now carry the dispute marker and a lower confidence.
			const files = fs.readdirSync(path.join(dir, "records", "docker"));
			const text = fs.readFileSync(path.join(dir, "records", "docker", files[0]), "utf8");
			assert.match(text, /disputed/, "the store must record the contradiction");
			assert.match(text, /confidence: 1/, "confidence must drop one rung");
			assert.ok(ctx.notices.some((n) => /DISPUTING/.test(n)), ctx.notices.join(" | "));
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("a proven fix is captured automatically and lands in the store", async () => {
		const dir = tempDir("gm-wire-capture-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			const ctx = makeCtx(dir);
			await mock.fire("session_start", { type: "session_start" }, ctx);
			await mock.fire("agent_start", { type: "agent_start" }, ctx);
			await mock.fire(
				"tool_result",
				{ type: "tool_result", toolCallId: "a", toolName: "bash", input: { command: "pnpm run build" }, content: [{ type: "text", text: "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL" }], isError: true },
				ctx,
			);
			await mock.fire(
				"tool_result",
				{ type: "tool_result", toolCallId: "b", toolName: "bash", input: { command: "pnpm run build --filter api" }, content: [{ type: "text", text: "build finished" }], isError: false },
				ctx,
			);
			await mock.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
			const all = fs.readdirSync(path.join(dir, "records")).length;
			assert.ok(all > 0, "expected an auto-captured record");
			const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
			assert.ok(index.count >= 1, "auto-captured record must be indexed");
			assert.ok(ctx.notices.some((n) => /captured 1 learning/.test(n)), ctx.notices.join(" | "));
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});

	test("--no-global-memory disables everything, including injection", async () => {
		const dir = tempDir("gm-wire-off-");
		try {
			process.env.PI_GLOBAL_MEMORY_DIR = dir;
			const mock = makePi();
			const mod = await import("../index.ts");
			mod.default(mock.api);
			mock.flags.set("no-global-memory", { defaultValue: true });
			const ctx = makeCtx(dir);
			await mock.fire("session_start", { type: "session_start" }, ctx);
			const options = { sections: {}, promptGuidelines: [] as string[] };
			await mock.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "docker layer cache", systemPrompt: "base", systemPromptOptions: options }, ctx);
			assert.deepEqual(options.sections, {}, "no sections may be injected when disabled");
			assert.ok(!mock.active().includes("memory_lookup"), "tools withdrawn when disabled");
			assert.equal(fs.existsSync(path.join(dir, "index.json")), false, "a disabled extension should not build an index");
		} finally {
			delete process.env.PI_GLOBAL_MEMORY_DIR;
			cleanup(dir);
		}
	});
});
