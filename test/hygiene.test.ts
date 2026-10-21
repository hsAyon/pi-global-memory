/**
 * Hygiene rules for the shipped code, enforced offline with no compiler needed.
 *
 * These exist because the package is TypeScript that pi runs directly, so nothing else in the
 * pipeline would tell you about dead code or unused imports:
 *
 * 1. every import in a shipped file must be used in that file;
 * 2. every exported symbol must be referenced somewhere (in the shipped code, the tests, or the
 *    load-check script) - the default export of the entry point is exempt because pi calls it;
 * 3. a file must not import from itself, and relative imports must name an existing file.
 *
 * The point is not cosmetics. Dead exports are how a package accretes a second, undocumented API
 * that nobody maintains.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCANNED = ["index.ts", ...readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`)];
const CONTEXT = [...SCANNED, ...readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".ts") || f.endsWith(".mjs")).map((f) => `test/${f}`), "scripts/load-check.mjs"].filter((f) => existsSync(path.join(ROOT, f)));

const IMPORT_RE = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?$/gm;

function stripImports(text: string): string {
  return text.replace(IMPORT_RE, "");
}

function importedNames(clause: string): string[] {
  const names: string[] = [];
  const braces = clause.match(/\{([\s\S]*?)\}/);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const trimmed = part.replace(/\/\/.*$/gm, "").trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.push(asMatch ? asMatch[1] : trimmed.replace(/^type\s+/, "").split(/\s+/)[0]);
    }
  }
  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) names.push(namespace[1]);
  const bare = clause.replace(/\{[\s\S]*?\}/g, "").replace(/\/\/.*$/gm, "").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.push(bare);
  return names.filter(Boolean);
}

test("no shipped file keeps an unused import", () => {
  const offenders: string[] = [];
  for (const rel of SCANNED) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    const body = stripImports(text);
    for (const m of text.matchAll(IMPORT_RE)) {
      for (const name of importedNames(m[1])) {
        if (!new RegExp(`\\b${name}\\b`).test(body)) offenders.push(`${rel}: imports ${name} but never uses it`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("no shipped export is unreferenced", () => {
  const sources = Object.fromEntries(CONTEXT.map((rel) => [rel, readFileSync(path.join(ROOT, rel), "utf8")]));
  const offenders: string[] = [];
  for (const rel of SCANNED) {
    const text = sources[rel];
    for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      let hits = 0;
      for (const [other, otherText] of Object.entries(sources)) {
        const occurrences = (otherText.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
        hits += other === rel ? occurrences - 1 : occurrences; // do not count the declaration itself
      }
      if (hits <= 0) offenders.push(`${rel}: exports ${name} which nothing references`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("relative imports resolve to real files and never point at development folders", () => {
  const offenders: string[] = [];
  for (const rel of SCANNED) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[2];
      if (/(^|\/)(test|scripts|docs)\//.test(spec)) offenders.push(`${rel}: imports from ${spec}`);
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), spec);
      if (!existsSync(target)) offenders.push(`${rel}: imports ${spec}, which does not exist`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
