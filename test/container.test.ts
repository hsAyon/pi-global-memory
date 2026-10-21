/**
 * The export/import container: compression, integrity, encryption, and the
 * refusal paths. A container is the one place the store leaves the machine, so
 * its limits (bomb guard, version, authenticity) are tested, not assumed.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
	CONTAINER_MAGIC,
	ContainerError,
	MAX_INFLATED_BYTES,
	MAX_RECORDS_PER_CONTAINER,
	describeContainer,
	packRecords,
	unpackContainer,
} from "../lib/container.ts";
import { EXTENSION_VERSION } from "../lib/version.ts";

const RECORDS = [
	{
		id: "gm-alpha-one-aaaa1111",
		kind: "fact",
		category: "docker",
		title: "Docker build reuses the old dependency layer",
		statement: "After editing package.json, docker build reuses the cached node_modules layer; --no-cache is needed.",
		tags: ["docker"],
		cues: ["layer cache"],
		confidence: 2,
		status: "active",
		scope: { kind: "global" },
		evidence: [{ type: "command", ref: "docker build --no-cache ." }],
	},
	{
		id: "gm-beta-two-bbbb2222",
		kind: "mistake",
		category: "git",
		title: "git switch after a detached checkout loses the branch",
		statement: "Use git switch -c before committing on a detached HEAD, or the commit is unreachable.",
		tags: ["git"],
		cues: ["detached HEAD"],
		confidence: 3,
		status: "active",
		scope: { kind: "global" },
		evidence: [{ type: "command", ref: "git switch -c rescue" }],
	},
];

function bodyOf(text: string): Buffer {
	return Buffer.from(text.split(/\r?\n/).slice(2).join(""), "base64");
}

function headerOf(text: string): Record<string, unknown> {
	return JSON.parse(text.split(/\r?\n/)[1]);
}

describe("container: export/import format", () => {
	test("a plain container round-trips exactly and is much smaller than JSON", () => {
		const text = packRecords(RECORDS, { note: "unit test" });
		assert.equal(text.split("\n")[0], CONTAINER_MAGIC);
		const out = unpackContainer(text);
		assert.equal(out.records.length, 2);
		assert.equal(out.records[0].id, "gm-alpha-one-aaaa1111");
		assert.equal(out.authenticated, false, "a plain container is checksum-authenticated only");
		// Compression is measured on the payload, not on the base64 wrapper.
		const payloadSize = Buffer.byteLength(JSON.stringify({ records: RECORDS }), "utf8");
		assert.ok(bodyOf(text).length < payloadSize, `compressed body ${bodyOf(text).length} should beat payload ${payloadSize}`);
		assert.match(describeContainer(text), /2 record\(s\)/);
		assert.match(describeContainer(text), /not encrypted/);
	});

	test("the payload digest ignores key insertion order (canonical JSON), so the same store hashes the same", () => {
		const reordered = RECORDS.map((r) => Object.fromEntries(Object.entries(r).reverse()));
		const a = packRecords(RECORDS, { exportedAt: "2026-01-01T00:00:00.000Z" });
		const b = packRecords(reordered, { exportedAt: "2026-01-01T00:00:00.000Z" });
		assert.equal(headerOf(a).payloadSha256, headerOf(b).payloadSha256, "key order must not change the digest");
	});

	test("encrypted containers round-trip with a passphrase and say they are authenticated", () => {
		const text = packRecords(RECORDS, { passphrase: "correct horse battery staple" });
		assert.match(describeContainer(text), /ENCRYPTED \(passphrase needed to read\)/);
		const out = unpackContainer(text, "correct horse battery staple");
		assert.equal(out.records.length, 2);
		assert.equal(out.authenticated, true);
		// The plaintext must not be present in the file in any recoverable form.
		assert.ok(!text.includes("Docker build reuses"), "plaintext leaked into an encrypted container");
		assert.ok(!text.includes("gm-alpha-one-aaaa1111"));
	});

	test("the wrong passphrase fails closed, and never partially decrypts", () => {
		const text = packRecords(RECORDS, { passphrase: "correct horse battery staple" });
		assert.throws(() => unpackContainer(text, "wrong passphrase here"), (err: unknown) => err instanceof ContainerError && (err as ContainerError).code === "passphrase");
		assert.throws(() => unpackContainer(text, undefined), (err: unknown) => (err as ContainerError).code === "passphrase");
	});

	test("two containers of the same records differ (fresh salt and IV every time)", () => {
		const a = packRecords(RECORDS, { passphrase: "a passphrase that is long" });
		const b = packRecords(RECORDS, { passphrase: "a passphrase that is long" });
		assert.notEqual(bodyOf(a).toString("base64"), bodyOf(b).toString("base64"), "reusing salt or IV would weaken GCM");
	});

	test("editing the header of an encrypted container breaks authentication", () => {
		const text = packRecords(RECORDS, { passphrase: "a passphrase that is long" });
		const lines = text.split(/\r?\n/);
		const header = JSON.parse(lines[1]);
		header.recordCount = 999;
		lines[1] = JSON.stringify(header);
		const tampered = lines.join("\n");
		assert.throws(() => unpackContainer(tampered, "a passphrase that is long"), (err: unknown) => err instanceof ContainerError);
	});

	test("a header digest that disagrees with the payload is reported as tampering", () => {
		const text = packRecords(RECORDS);
		// the digest lives in the header; changing one hex digit makes it disagree with the payload
		const fixed = text.replace(/"payloadSha256":\s*"([0-9a-f])([0-9a-f])/, (_m, a, b) => `"payloadSha256": "${a === "0" ? "1" : "0"}${b}`);
		assert.notEqual(fixed, text, "the header must carry a payloadSha256 field");
		assert.throws(() => unpackContainer(fixed), (err: unknown) => (err as ContainerError).code === "tamper");
	});

	test("a flipped payload byte never imports silently", () => {
		const text = packRecords(RECORDS);
		const body = bodyOf(text);
		body[Math.floor(body.length / 3)] ^= 0xff; // inside the compressed payload
		const lines = text.split(/\r?\n/);
		const b64 = body.toString("base64").match(/.{1,76}/g) ?? [];
		const fixed = [lines[0], lines[1], ...b64].join("\n");
		assert.throws(
			() => {
				const out = unpackContainer(fixed);
				return out.records.length;
			},
			(err: unknown) => ["tamper", "damaged", "format"].includes((err as ContainerError).code),
		);
	});

	test("a truncated file is reported as damaged, not imported short", () => {
		const text = packRecords(RECORDS);
		const cut = text.slice(0, text.length - 60);
		assert.throws(() => unpackContainer(cut), (err: unknown) => err instanceof ContainerError);
	});

	test("a foreign or missing magic line is refused", () => {
		assert.throws(() => unpackContainer("hello\n{}\n"), (err: unknown) => (err as ContainerError).code === "format");
		const text = packRecords(RECORDS);
		const wrong = text.replace(CONTAINER_MAGIC, "OTHER1");
		assert.throws(() => unpackContainer(wrong), (err: unknown) => (err as ContainerError).code === "format");
	});

	test("a container from a format this build cannot read is refused with a version message", () => {
		const text = packRecords(RECORDS);
		const lines = text.split(/\r?\n/);
		const header = JSON.parse(lines[1]);
		header.v = 99;
		assert.throws(() => unpackContainer([lines[0], JSON.stringify(header), ...lines.slice(2)].join("\n")), (err: unknown) => (err as ContainerError).code === "version");
		assert.equal(headerOf(text).v, EXTENSION_VERSION ? 1 : 1, "the writer stamps the current format version");
	});

	test("a decompression bomb is refused before it is expanded", () => {
		// Build one by hand: no exporter would create it, but a downloaded file might.
		const payload = Buffer.from(JSON.stringify({ records: [], pad: "a".repeat(MAX_INFLATED_BYTES + 4096) }), "utf8");
		const compressed = deflateRawSync(payload, { level: 9 });
		const header = {
			v: 1,
			kind: "pi-global-memory",
			exportedAt: new Date().toISOString(),
			recordCount: 0,
			encoding: "deflate-raw",
			integrity: "sha256",
			cipher: null,
			kdf: null,
			payloadSha256: createHash("sha256").update(payload).digest("hex"),
		};
		const body = Buffer.concat([Buffer.from("GM1", "utf8"), Buffer.from([0]), compressed]);
		const text = [CONTAINER_MAGIC, JSON.stringify(header), ...(body.toString("base64").match(/.{1,76}/g) ?? [])].join("\n");
		assert.throws(() => unpackContainer(text), (err: unknown) => (err as ContainerError).code === "too-large");
	});

	test("absurd record counts are refused rather than allocated", () => {
		assert.throws(() => packRecords(new Array(MAX_RECORDS_PER_CONTAINER + 1).fill({ id: "x" })), (err: unknown) => (err as ContainerError).code === "too-large");
		const text = packRecords(RECORDS);
		const lines = text.split(/\r?\n/);
		const header = JSON.parse(lines[1]);
		header.recordCount = 5_000_000;
		assert.throws(() => unpackContainer([lines[0], JSON.stringify(header), ...lines.slice(2)].join("\n")), (err: unknown) => (err as ContainerError).code === "too-large");
	});

	test("a short passphrase is refused instead of protecting the file weakly", () => {
		assert.throws(() => packRecords(RECORDS, { passphrase: "abc" }), (err: unknown) => (err as ContainerError).code === "passphrase");
	});
});
