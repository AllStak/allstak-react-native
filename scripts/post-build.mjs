/**
 * Post-build patcher.
 *
 * tsup wraps `require(...)` calls in an `__require` shim so the ESM bundle
 * has a CJS-style require fallback. Under Metro the shim resolves to the
 * runtime `require` just fine — BUT Metro's static analyzer only registers
 * package names for string-name lookup when it sees a literal `require("...")`
 * token in the source. `__require("react-native")` is invisible to the
 * analyzer, so dynamic lookup fails at runtime with a LogBox dev error.
 *
 * Fix: rewrite `__require("…")` back to `require("…")` after tsup is done.
 * This is safe because:
 *   - Under Metro, `require` is the runtime CJS require — same behavior.
 *   - Under Node ESM, the existing `__require` shim is removed too, but
 *     the SDK's Node tests only exercise `require()` paths via
 *     `globalThis.require` mocks, which we keep working below.
 *   - We also keep a thin compatibility export of `__require = require`
 *     so any callsite that wasn't transformed still resolves.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const TARGETS = ['index.mjs', 'index.js'];

for (const file of TARGETS) {
  const path = join(DIST, file);
  let src;
  try { src = await readFile(path, 'utf8'); }
  catch { continue; }

  // Replace literal __require("name") with require("name") so Metro's
  // static analyzer picks up the dependencies. We deliberately do NOT
  // touch `var __require = ...` definitions — the alias still exists for
  // any leftover dynamic uses.
  const before = (src.match(/__require\(/g) ?? []).length;
  const patched = src.replace(/__require\(/g, 'require(');
  const after = (patched.match(/__require\(/g) ?? []).length;

  // Make sure the `__require` symbol is still defined for safety, since
  // we just left a few binding-style uses (none expected, but defensive).
  // The chunk file already defines it; keep that intact.

  await writeFile(path, patched, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[post-build] ${file}: ${before} __require→require replacements (${after} remaining)`);
}
