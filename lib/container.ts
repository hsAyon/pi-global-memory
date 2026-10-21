/**
 * The export/import container: compressed, integrity-checked, optionally
 * encrypted, and copy-pasteable.
 *
 * Why this shape
 * --------------
 * - deflate, not "none": a store of a few hundred records is ~10x smaller, which
 *   matters because these files get committed, mailed, and pasted.
 * - SHA-256 of the payload, always: detects truncation and accidental edits.
 *   Unencrypted containers are authenticated only against corruption - an attacker
 *   who can rewrite the file can rewrite the digest too. Say so in docs.
 * - optional AES-256-GCM with a scrypt-derived key: this is the only mode with real
 *   authenticity, because the GCM tag covers the header as additional authenticated
 *   data. Use a passphrase for anything that leaves the machine.
 * - inflate has a hard output cap: a compressed file is the classic way to turn a
 *   4 KB download into 4 GB of RAM.
 *
 * Format (text, so it survives email, git, and chat):
 *
 *   GMEM1
 *   {"v":1,...header...}
 *   <base64 body, 76-char wrapped>
 *
 * Body layout: "GM1" + flags byte + [salt(16) + iv(12) if encrypted] + payload or
 * ciphertext + [16-byte GCM tag if encrypted].
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { CONTAINER_FORMAT } from "./version.ts";

export const CONTAINER_MAGIC = "GMEM1";
export const CONTAINER_EXT = ".gmect";

export const MAX_CONTAINER_CHARS = 32 * 1024 * 1024; // file text on disk
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024; // decompression bomb guard
export const MAX_RECORDS_PER_CONTAINER = 20_000;

const BODY_MAGIC = "GM1";
const FLAG_ENCRYPTED = 1;
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 1 << 26 };

export interface ContainerHeader {
	v: typeof CONTAINER_FORMAT;
	kind: "pi-global-memory";
	exportedAt: string;
	recordCount: number;
	encoding: "deflate-raw";
	integrity: "sha256";
	cipher: null | "aes-256-gcm";
	kdf: null | "scrypt";
	note?: string;
	payloadSha256: string;
}

export class ContainerError extends Error {
	code: "format" | "truncated" | "tamper" | "passphrase" | "too-large" | "unsupported" | "version";
	constructor(code: ContainerError["code"], message: string) {
		super(message);
		this.code = code;
		this.name = "ContainerError";
	}
}

/** Deterministic JSON: sorted keys, so the same store always hashes the same. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function sha256(buf: Buffer | string): string {
	return createHash("sha256").update(buf as never).digest("hex");
}

function wrapBase64(b64: string): string {
	const lines: string[] = [];
	for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
	return lines.join("\n");
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
	// scrypt rather than a bare hash: it makes an offline crack on a stolen export
	// cost memory as well as time. Parameters are modest on purpose - this protects
	// a personal notes file, not a data centre.
	return scryptSync(String(passphrase), salt, 32, SCRYPT);
}

export interface PackOptions {
	passphrase?: string;
	note?: string;
	exportedAt?: string;
}

/** Serialize records into the container text. Payload is the canonical JSON envelope. */
export function packRecords(records: Record<string, unknown>[], opts: PackOptions = {}): string {
	const list = Array.isArray(records) ? records : [];
	if (list.length > MAX_RECORDS_PER_CONTAINER) throw new ContainerError("too-large", `refusing to pack ${list.length} records (max ${MAX_RECORDS_PER_CONTAINER})`);

	const envelope = canonical({ v: 1, kind: "pi-global-memory", exportedAt: opts.exportedAt ?? new Date().toISOString(), records: list });
	const payload = Buffer.from(envelope, "utf8");
	const compressed = deflateRawSync(payload, { level: 9 });
	const payloadSha256 = sha256(payload);

	const header: ContainerHeader = {
		v: CONTAINER_FORMAT,
		kind: "pi-global-memory",
		exportedAt: opts.exportedAt ?? new Date().toISOString(),
		recordCount: list.length,
		encoding: "deflate-raw",
		integrity: "sha256",
		cipher: opts.passphrase ? "aes-256-gcm" : null,
		kdf: opts.passphrase ? "scrypt" : null,
		note: opts.note ? String(opts.note).slice(0, 200) : undefined,
		payloadSha256,
	};
	const headerText = canonical(header);

	let body: Buffer;
	if (opts.passphrase) {
		if (String(opts.passphrase).length < 8) throw new ContainerError("passphrase", "a container passphrase should be at least 8 characters");
		// Fresh salt and fresh IV every time: reusing either under the same key would
		// leak information and, for GCM nonces, can break confidentiality outright.
		const salt = randomBytes(16);
		const iv = randomBytes(12);
		const key = deriveKey(String(opts.passphrase), salt);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from(headerText, "utf8"));
		const ct = Buffer.concat([cipher.update(compressed), cipher.final()]);
		body = Buffer.concat([Buffer.from(BODY_MAGIC, "utf8"), Buffer.from([FLAG_ENCRYPTED]), salt, iv, ct, cipher.getAuthTag()]);
	} else {
		body = Buffer.concat([Buffer.from(BODY_MAGIC, "utf8"), Buffer.from([0]), compressed]);
	}

	return `${CONTAINER_MAGIC}\n${headerText}\n${wrapBase64(body.toString("base64"))}\n`;
}

export interface ContainerInfo {
	header: ContainerHeader;
	encrypted: boolean;
	compressedBytes: number;
}

/** Read the header without decrypting: used to ask for a passphrase before parsing. */
export function inspectContainer(text: string): ContainerInfo {
	const raw = String(text ?? "");
	if (raw.length > MAX_CONTAINER_CHARS) throw new ContainerError("too-large", `container text is ${raw.length} chars (max ${MAX_CONTAINER_CHARS})`);
	const lines = raw.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== CONTAINER_MAGIC) throw new ContainerError("format", "not a pi-global-memory container: missing the GMEM1 line");
	const headerLine = lines[1] ?? "";
	let header: ContainerHeader;
	try {
		header = JSON.parse(headerLine) as ContainerHeader;
	} catch {
		throw new ContainerError("format", "the container header line is not valid JSON - the file is damaged");
	}
	if (header?.v !== CONTAINER_FORMAT) throw new ContainerError("version", `unsupported container version ${String(header?.v)} (this build reads container format v${CONTAINER_FORMAT})`);
	if (header.kind !== "pi-global-memory") throw new ContainerError("format", "this file is not a pi-global-memory export");
	if (header.encoding !== "deflate-raw" || header.integrity !== "sha256") throw new ContainerError("unsupported", `unsupported container encoding ${String(header.encoding)}/${String(header.integrity)}`);
	if (header.cipher !== null && header.cipher !== "aes-256-gcm") throw new ContainerError("unsupported", `unsupported cipher ${String(header.cipher)}`);
	const body = lines.slice(2).join("");
	const compressedBytes = Math.floor((body.length * 3) / 4);
	if (header.cipher !== null && !header.payloadSha256) throw new ContainerError("format", "encrypted container is missing its payload digest");
	return { header, encrypted: header.cipher === "aes-256-gcm", compressedBytes };
}

export interface UnpackResult {
	records: Record<string, unknown>[];
	header: ContainerHeader;
	/** Plain-text containers detect corruption, not forgery; encrypted ones are authenticated. */
	authenticated: boolean;
}

export function unpackContainer(text: string, passphrase?: string): UnpackResult {
	const { header, encrypted, compressedBytes } = inspectContainer(text);
	if (header.recordCount > MAX_RECORDS_PER_CONTAINER) throw new ContainerError("too-large", `container claims ${header.recordCount} records (max ${MAX_RECORDS_PER_CONTAINER})`);

	const bodyB64 = text.split(/\r?\n/).slice(2).join("");
	let body: Buffer;
	try {
		body = Buffer.from(bodyB64, "base64");
	} catch {
		throw new ContainerError("format", "the container body is not valid base64");
	}
	if (body.length < 4) throw new ContainerError("truncated", "container body is empty or truncated");
	if (body.subarray(0, BODY_MAGIC.length).toString("utf8") !== BODY_MAGIC) throw new ContainerError("format", "container body marker is wrong - the file is damaged");
	const flags = body[BODY_MAGIC.length];
	const actuallyEncrypted = (flags & FLAG_ENCRYPTED) !== 0;
	if (actuallyEncrypted !== encrypted) throw new ContainerError("tamper", "container header disagrees with the body about encryption - do not use this file");

	let compressed: Buffer;
	let authenticated = false;
	if (actuallyEncrypted) {
		if (!passphrase) throw new ContainerError("passphrase", "this container is encrypted: supply a passphrase (/memory import <file> <passphrase>, or PI_GLOBAL_MEMORY_PASSPHRASE)");
		const salt = body.subarray(BODY_MAGIC.length + 1, BODY_MAGIC.length + 17);
		const iv = body.subarray(BODY_MAGIC.length + 17, BODY_MAGIC.length + 29);
		const tag = body.subarray(body.length - 16);
		const ct = body.subarray(BODY_MAGIC.length + 29, body.length - 16);
		if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new ContainerError("truncated", "encrypted container is missing its salt/iv/tag - the file is damaged");
		const headerText = text.split(/\r?\n/)[1] ?? "";
		let plain: Buffer;
		try {
			const decipher = createDecipheriv("aes-256-gcm", deriveKey(String(passphrase), salt), iv);
			decipher.setAAD(Buffer.from(headerText, "utf8"));
			decipher.setAuthTag(tag);
			plain = Buffer.concat([decipher.update(ct), decipher.final()]);
		} catch {
			// GCM authentication failure means either the wrong passphrase or a modified
			// file. The library cannot tell them apart, and we must not guess: report both.
			throw new ContainerError("passphrase", "decryption failed: wrong passphrase, or the file was modified (GCM authentication did not verify)");
		}
		compressed = plain;
		authenticated = true;
	} else {
		compressed = body.subarray(BODY_MAGIC.length + 1);
	}

	if (compressedBytes > MAX_INFLATED_BYTES) throw new ContainerError("too-large", `container body is ${compressedBytes} bytes (max ${MAX_INFLATED_BYTES})`);

	let payload: Buffer;
	try {
		payload = inflateRawSync(compressed, { maxOutputLength: MAX_INFLATED_BYTES });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ERR_BUFFER_TOO_LARGE") throw new ContainerError("too-large", `container would decompress past ${MAX_INFLATED_BYTES} bytes - refusing to expand it`);
		throw new ContainerError("format", "container body could not be decompressed - the file is damaged");
	}

	const digest = sha256(payload);
	if (digest !== header.payloadSha256) {
		throw new ContainerError(authenticated ? "tamper" : "tamper", `payload digest mismatch: the records changed since export (expected ${header.payloadSha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`);
	}

	let parsed: { records?: unknown };
	try {
		parsed = JSON.parse(payload.toString("utf8"));
	} catch {
		throw new ContainerError("format", "container payload is not valid JSON");
	}
	const records = Array.isArray(parsed?.records) ? (parsed.records as Record<string, unknown>[]) : [];
	if (records.length !== header.recordCount) throw new ContainerError("tamper", `header claims ${header.recordCount} records, payload holds ${records.length}`);
	return { records, header, authenticated };
}

/** Human summary for /memory export and import confirmations. */
export function describeContainer(text: string, passphrase?: string): string {
	const info = inspectContainer(text);
	const records = info.header.recordCount;
	const sizeKb = Math.max(1, Math.round((text.length / 1024) * 10) / 10);
	const bits = [`${records} record(s)`, `${sizeKb} KB`, `exported ${info.header.exportedAt}`];
	if (info.encrypted) {
		bits.push(passphrase ? "encrypted AES-256-GCM, authenticated" : "ENCRYPTED (passphrase needed to read)");
	} else {
		bits.push("not encrypted - readable by anyone holding the file; integrity-checked only");
	}
	if (info.header.note) bits.push(`note: ${info.header.note}`);
	return bits.join(" · ");
}
