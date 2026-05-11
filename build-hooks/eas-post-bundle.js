#!/usr/bin/env node
/**
 * AllStak source-map upload — Expo / EAS Build hook.
 *
 * EAS Build calls per-build hooks defined in `eas.json` under
 * `build.<profile>.hooks` (e.g. `eas-build-on-success`) or via package.json
 * scripts (`eas-build-pre-install`, `eas-build-on-success`, …).
 *
 * Drop-in setup:
 *   1. Add a script in package.json:
 *
 *        "scripts": {
 *          "eas-build-on-success":
 *            "node node_modules/@allstak/react-native/build-hooks/eas-post-bundle.js"
 *        }
 *
 *   2. Set these in eas.json secrets (or as EAS env vars):
 *
 *        ALLSTAK_RELEASE        — required (e.g. "mobile@1.2.3+5")
 *        ALLSTAK_UPLOAD_TOKEN   — required for actual upload
 *        ALLSTAK_HOST           — optional override
 *
 * What this hook does:
 *   • Probes EAS's standard output paths for both iOS and Android Hermes
 *     bundles + composed source maps.
 *   • Calls the SDK's uploader for each platform that produced artifacts.
 *   • Falls back to inject-only mode when no token is set.
 *   • Always exits 0 — never fails an EAS build over a sourcemap glitch.
 *
 * If you build outside of EAS (bare RN, custom CI), use
 * `upload-sourcemaps.js` directly instead.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RELEASE = process.env.ALLSTAK_RELEASE;
const TOKEN = process.env.ALLSTAK_UPLOAD_TOKEN;

if (!RELEASE) {
  console.warn('[allstak] ALLSTAK_RELEASE not set — skipping sourcemap upload');
  process.exit(0);
}

if (!TOKEN) {
  console.warn('[allstak] ALLSTAK_UPLOAD_TOKEN not set — running in inject-only mode');
}

// EAS sets EAS_BUILD_WORKINGDIR to the per-build working directory.
// Outside of EAS it falls back to cwd.
const root = process.env.EAS_BUILD_WORKINGDIR || process.cwd();

// Probe locations for each platform. EAS runs the standard
// `npx react-native bundle` in a temp dir under android/ios — these
// are the conventional output names.
const probes = [
  // iOS
  { platform: 'ios', dist: 'ios-hermes',
    bundle: path.join(root, 'ios', 'main.jsbundle'),
    sourcemap: path.join(root, 'ios', 'main.jsbundle.map') },
  { platform: 'ios', dist: 'ios-hermes',
    bundle: path.join(root, 'ios.bundle'),
    sourcemap: path.join(root, 'ios.bundle.map') },
  // Android
  { platform: 'android', dist: 'android-hermes',
    bundle: path.join(root, 'android', 'app', 'build', 'generated', 'assets',
                      'createBundleReleaseJsAndAssets', 'index.android.bundle'),
    sourcemap: path.join(root, 'android', 'app', 'build', 'generated', 'sourcemaps',
                         'react', 'release', 'index.android.bundle.map') },
  { platform: 'android', dist: 'android-hermes',
    bundle: path.join(root, 'android.bundle'),
    sourcemap: path.join(root, 'android.bundle.map') },
];

const targets = [];
const seen = new Set();
for (const p of probes) {
  if (fs.existsSync(p.bundle) && fs.existsSync(p.sourcemap)) {
    const key = p.platform;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(p);
  }
}

if (targets.length === 0) {
  console.warn('[allstak] no bundle+sourcemap pairs found under', root);
  console.warn('         Searched standard EAS / RN paths for both iOS and Android.');
  console.warn('         If your build writes to a different location, run');
  console.warn('         `node node_modules/@allstak/react-native/build-hooks/upload-sourcemaps.js`');
  console.warn('         with explicit --bundle and --sourcemap flags.');
  process.exit(0);  // not a failure
}

const hookScript = path.join(__dirname, 'upload-sourcemaps.js');

(async () => {
  for (const t of targets) {
    console.log(`[allstak] EAS hook: ${t.platform} bundle ${t.bundle}`);
    await new Promise((resolve) => {
      const child = spawn('node', [
        hookScript,
        '--bundle', t.bundle,
        '--sourcemap', t.sourcemap,
        '--platform', t.platform,
        '--dist', t.dist,
      ], {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('close', (code) => {
        if (code !== 0) {
          console.warn(`[allstak] EAS hook: ${t.platform} returned exit ${code} — continuing`);
        }
        resolve();
      });
      child.on('error', (e) => {
        console.warn(`[allstak] EAS hook: ${t.platform} error — ${e.message}`);
        resolve();
      });
    });
  }
  process.exit(0);
})();
