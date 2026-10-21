/**
 * Small filesystem, path, and text helpers.
 * Only node builtins are used; the extension adds no runtime dependencies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * A short, human-typeable token for destructive-action confirmation. Cryptographically
 * random on purpose: a guessed token must not be reachable by counting timestamps.
 */
export function randomToken(bytes = 3): string {
	return randomBytes(bytes).toString("hex").toUpperCase();
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic 32-bit hash, hex encoded. Used for ids and signal fingerprints. */
export function hash32(input: string): string {
	let h = 0x811c9dc5 >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i) & 0xff;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJsonSafe<T>(text: string, fallback: T): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

/** Windows-aware display path with forward slashes. Never used for fs calls. */
export function displayPath(p: string): string {
	return p.replace(/\\/g, "/");
}

export function normalizePathForMatch(p: string): string {
	let out = displayPath(String(p ?? "").trim());
	if (!out) return "";
	out = out.replace(/[\\/]+$/, "");
	if (process.platform === "win32") out = out.toLowerCase();
	return out;
}

export function pathContains(parent: string, child: string): boolean {
	const a = normalizePathForMatch(parent);
	const b = normalizePathForMatch(child);
	if (!a || !b) return false;
	return a === b || b.startsWith(`${a}/`);
}

export function expandHome(p: string): string {
	const s = String(p ?? "").trim();
	if (!s) return s;
	if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
		return path.join(os.homedir(), s.slice(1).replace(/^[\\/]/, ""));
	}
	return s;
}

export function isAbsoluteish(p: string): boolean {
	const s = expandHome(p);
	return path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s);
}

export function exists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Best-effort tightening of file mode. No-op on platforms without POSIX modes. */
export function tightenMode(file: string, mode = 0o600): void {
	try {
		if (process.platform !== "win32") fs.chmodSync(file, mode);
	} catch {
		/* best effort only */
	}
}

/**
 * Atomic write: unique temp file in the same directory, then rename.
 * Rename is atomic on POSIX and replaces on Windows, so a crash leaves either
 * the old file or the new one, never a half-written record.
 */
export function writeFileAtomic(file: string, content: string): void {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	tightenMode(tmp);
	try {
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw err;
	}
}

export function readTextLimited(file: string, maxBytes: number): string | undefined {
	try {
		const st = fs.statSync(file);
		if (!st.isFile() || st.size > maxBytes) return undefined;
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Depth-first file listing with a hard cap so a bad store path cannot hang us. */
export function listFiles(root: string, ext: string, cap = 5000): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (out.length >= cap) return out;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === ".git" || e.name === "node_modules") continue;
				stack.push(full);
			} else if (e.isFile() && e.name.endsWith(ext)) {
				out.push(full);
			}
		}
	}
	return out;
}

export function relPath(root: string, file: string): string {
	return displayPath(path.relative(root, file));
}

export function truncate(text: string, max: number): string {
	const s = String(text ?? "");
	if (s.length <= max) return s;
	if (max <= 1) return s.slice(0, Math.max(0, max));
	return `${s.slice(0, max - 1)}\u2026`;
}

/** Collapse whitespace runs and trim. Used before length checks and hashing. */
export function normWs(text: string): string {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

export function slugify(text: string, max = 40): string {
	const s = normWs(String(text ?? ""))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	// ids must stay filesystem-safe, so this slice never appends an ellipsis
	return s.slice(0, max).replace(/-+$/g, "");
}

export function uniqueStrings(values: unknown, cap: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of Array.isArray(values) ? values : []) {
		const s = normWs(String(v ?? ""));
		if (!s) continue;
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s);
		if (out.length >= cap) break;
	}
	return out;
}

/** Jaccard similarity over the token sets of two strings. */
/**
 * Jaccard similarity over tokens.
 *
 * The token sets are memoised because the duplicate scan compares one new record against every
 * stored record, which otherwise re-tokenises the whole store on every write (measured: ~73 ms per
 * write at 400 records, ~20 ms after caching). The cache is bounded and the sets are never mutated
 * by anyone who reads them, so this is a pure-function cache, not shared mutable state.
 */
const TOKEN_SETS = new Map<string, Set<string>>();
const TOKEN_SETS_MAX = 4000;

function tokenSet(text: string): Set<string> {
	const key = String(text ?? "");
	const hit = TOKEN_SETS.get(key);
	if (hit) return hit;
	const set = new Set(tokenize(key));
	if (TOKEN_SETS.size >= TOKEN_SETS_MAX) TOKEN_SETS.clear();
	TOKEN_SETS.set(key, set);
	return set;
}

export function tokenSimilarity(a: string, b: string): number {
	const ta = tokenSet(a);
	const tb = tokenSet(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
	let inter = 0;
	for (const t of small) if (large.has(t)) inter++;
	return inter / (ta.size + tb.size - inter);
}

const STOPWORDS = new Set(
	("a an and are as at be been before being but by can did for from had has have how i if in into is it its of on or " +
		"the their them then there these they this to too was were when where which while with you your not should would " +
		"could do does doing that these those so than then them him his her its our we us me my").split(" "),
);

export function tokenize(text: string): string[] {
	const raw = String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9_]+/g);
	const out: string[] = [];
	for (const t of raw) {
		if (t.length < 2 || t.length > 40) continue;
		if (STOPWORDS.has(t)) continue;
		out.push(t);
	}
	return out;
}

export function escapeRegExp(text: string): string {
	return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Local process spawn used only for the optional git bookkeeping. No shell, so
 * a path or message can never be reinterpreted. Networked git subcommands are
 * refused at the protocol layer by GIT_ALLOW_PROTOCOL=none.
 */
export async function run(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = 8000,
	env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const { spawn } = await import("node:child_process");
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (code: number) => {
			if (done) return;
			done = true;
			resolve({ code, stdout, stderr });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd,
				windowsHide: true,
				env: env ? { ...process.env, ...env } : undefined,
			});
		} catch {
			finish(127);
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(124);
		}, timeoutMs);
		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < 64_000) stdout += String(d);
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < 64_000) stderr += String(d);
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish(127);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code ?? 0);
		});
	});
}
