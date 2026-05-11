#!/usr/bin/env node
/**
 * One-line source-map upload hook for React Native (Metro / Hermes).
 *
 * Drop this file into your repo at `scripts/upload-sourcemaps.js` (or
 * any path you like). It auto-detects the bundle + map written by
 * `npx react-native bundle` for both platforms, calls the SDK's
 * uploader, and exits non-zero if any platform's upload fails.
 *
 * Usage in CI / Xcode build phase / Gradle task:
 *
 *   ALLSTAK_RELEASE='mobile@1.2.3+5' \
 *   ALLSTAK_UPLOAD_TOKEN='aspk_…' \
 *     node scripts/upload-sourcemaps.js [path/to/build-output-dir]
 *
 * Env vars consulted:
 *   ALLSTAK_RELEASE       — required, your release identifier
 *   ALLSTAK_UPLOAD_TOKEN  — required, project-scoped upload token
 *   ALLSTAK_HOST          — optional, defaults to https://api.allstak.sa
 *   ALLSTAK_DIST_OVERRIDE — optional, override auto-detected dist
 *
 * Bundle/map paths it looks for, in order:
 *   1. CLI arg: explicit `--bundle` / `--sourcemap` / `--platform` / `--dist`
 *   2. Build dir from CLI positional arg (default: cwd)
 *   3. Conventional names: <platform>.bundle / <platform>.bundle.map
 *
 * Exits:
 *   0  — at least one platform uploaded OK (or injectOnly with no token)
 *   1  — required env missing or all platforms failed
 *
 * No deps beyond Node 18+ and the SDK itself.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = parseArgs(process.argv.slice(2));

const RELEASE = process.env.ALLSTAK_RELEASE;
const TOKEN = process.env.ALLSTAK_UPLOAD_TOKEN;
const HOST = process.env.ALLSTAK_HOST;
const DIST_OVERRIDE = process.env.ALLSTAK_DIST_OVERRIDE;
const INJECT_ONLY = !TOKEN;  // gracefully fall back to inject-only if no token

if (!RELEASE) {
  console.error('[allstak] ALLSTAK_RELEASE env var is required (e.g. "mobile@1.2.3+5")');
  process.exit(1);
}

if (INJECT_ONLY && !args.injectOnly) {
  console.warn('[allstak] no ALLSTAK_UPLOAD_TOKEN — running in inject-only mode (debug-ids written, no upload)');
}

(async () => {
  let uploader;
  try {
    uploader = require('@allstak/react-native/sourcemaps').uploadReactNativeSourcemap;
  } catch (e) {
    console.error('[allstak] could not require @allstak/react-native/sourcemaps — is the package installed?');
    console.error(e?.message ?? e);
    process.exit(1);
  }

  const baseDir = path.resolve(args.dir || process.cwd());

  // Targets to try. If --bundle/--sourcemap are supplied, treat that as
  // a single explicit target; otherwise probe both ios + android in the
  // build dir.
  const targets = [];
  if (args.bundle && args.sourcemap) {
    targets.push({
      platform: args.platform || guessPlatform(args.bundle),
      bundle: path.resolve(args.bundle),
      sourcemap: path.resolve(args.sourcemap),
      dist: args.dist || guessDist(args.platform || guessPlatform(args.bundle)),
    });
  } else {
    for (const platform of ['ios', 'android']) {
      const probe = pickBundle(baseDir, platform);
      if (probe) targets.push({
        platform,
        bundle: probe.bundle,
        sourcemap: probe.sourcemap,
        dist: args.dist || (DIST_OVERRIDE || guessDist(platform)),
      });
    }
  }

  if (targets.length === 0) {
    console.error(`[allstak] no bundle+sourcemap pair found under ${baseDir}.`);
    console.error('         Expected: <platform>.bundle + <platform>.bundle.map');
    console.error('         Or pass --bundle <path> --sourcemap <path>.');
    process.exit(1);
  }

  let okCount = 0;
  for (const t of targets) {
    try {
      console.log(`[allstak] ${t.platform}: ${path.relative(baseDir, t.bundle)} + .map  (dist=${t.dist})`);
      const result = await uploader({
        bundle: t.bundle,
        sourcemap: t.sourcemap,
        release: RELEASE,
        dist: t.dist,
        token: TOKEN,
        host: HOST,
        injectOnly: INJECT_ONLY || args.injectOnly,
        stripSources: args.stripSources,
        uploadBundle: args.uploadBundle,
      });
      if (INJECT_ONLY || args.injectOnly) {
        console.log(`[allstak] ${t.platform}: debug-id ${result.debugId} ${result.reused ? '(reused)' : '(new)'} — inject-only`);
        okCount += 1;
      } else if (result.uploaded) {
        console.log(`[allstak] ${t.platform}: uploaded debug-id ${result.debugId}`);
        okCount += 1;
      } else {
        const last = result.steps?.[result.steps.length - 1];
        console.error(`[allstak] ${t.platform}: FAIL status=${last?.status ?? '?'} body=${(last?.body ?? '').slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[allstak] ${t.platform}: error — ${e?.message ?? e}`);
    }
  }

  process.exit(okCount > 0 ? 0 : 1);
})();

// ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle')        out.bundle = argv[++i];
    else if (a === '--sourcemap') out.sourcemap = argv[++i];
    else if (a === '--platform')  out.platform = argv[++i];
    else if (a === '--dist')      out.dist = argv[++i];
    else if (a === '--inject-only') out.injectOnly = true;
    else if (a === '--strip-sources') out.stripSources = true;
    else if (a === '--upload-bundle') out.uploadBundle = true;
    else if (a.startsWith('--')) console.warn(`[allstak] unknown flag: ${a}`);
    else out._.push(a);
  }
  if (out._.length > 0 && !out.dir) out.dir = out._[0];
  return out;
}

function pickBundle(dir, platform) {
  const candidates = [
    [path.join(dir, `${platform}.bundle`), path.join(dir, `${platform}.bundle.map`)],
    [path.join(dir, `main.jsbundle`), path.join(dir, `main.jsbundle.map`)],     // iOS Xcode default
    [path.join(dir, `index.${platform}.bundle`), path.join(dir, `index.${platform}.bundle.map`)],
  ];
  for (const [b, m] of candidates) {
    if (fs.existsSync(b) && fs.existsSync(m)) return { bundle: b, sourcemap: m };
  }
  return null;
}

function guessPlatform(bundlePath) {
  const f = path.basename(bundlePath).toLowerCase();
  if (f.includes('ios')) return 'ios';
  if (f.includes('android')) return 'android';
  return 'unknown';
}

function guessDist(platform) {
  // Match the SDK's runtime dist auto-detection (`<os>-<engine>`).
  if (platform === 'ios') return 'ios-hermes';
  if (platform === 'android') return 'android-hermes';
  return platform;
}
