/**
 * Version facts in one place, so a release is one edit.
 *
 * test/version.test.ts pins three things that are easy to forget:
 *  - this version equals package.json ("version"),
 *  - CHANGELOG.md's top entry is this version,
 *  - every file reachable by import from index.ts is inside the published `files`
 *    allowlist, so what ships is exactly what runs (and nothing dev-only ships).
 *
 * STORE_FORMAT is the on-disk record/index layout version. Records carry no per-file
 * version today (the layout is self-describing front-matter); index.json declares
 * `version: STORE_FORMAT`, and a future reader can migrate from there.
 * CONTAINER_FORMAT is the export/import container header version, also written into
 * each container so an old file is recognised rather than misread.
 */

export const EXTENSION_VERSION = "0.3.0";

/** Bump when the record front-matter or index layout changes incompatibly. */
export const STORE_FORMAT = 1;

/** Bump when lib/container.ts changes its header or body layout. */
export const CONTAINER_FORMAT = 1;

/** Minimum pi release this extension is verified against (docs cite 1.3.0). */
export const VERIFIED_PI_VERSION = "1.3.0";
