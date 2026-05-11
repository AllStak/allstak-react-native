/**
 * Source-map upload pipeline for React Native (Metro / Hermes). Build-time only.
 *
 * Metro emits one bundle + one source map per build, so the React Native
 * flow is simpler than the React-web flow (no `dist/` walk needed). The
 * developer hands us the bundle + map paths produced by:
 *
 *   npx react-native bundle \
 *     --platform ios --dev false --entry-file index.js \
 *     --bundle-output ios.bundle \
 *     --sourcemap-output ios.bundle.map
 *
 * If Hermes is enabled, the resulting `.hbc` bytecode replaces the JS
 * bundle on the device, and the user must compose the Metro map with the
 * Hermes map BEFORE uploading. We accept whatever map the user gives us
 * and inject a debug-id into both the map and the bundle.
 *
 * Usage from a build script (`scripts/upload-sourcemaps.js`):
 *
 *   const { uploadReactNativeSourcemap } = require('@allstak/react-native/sourcemaps');
 *
 *   await uploadReactNativeSourcemap({
 *     bundle: 'ios.bundle',
 *     sourcemap: 'ios.bundle.map',
 *     release: 'mobile@1.2.3',
 *     dist: 'ios-hermes',
 *     token: process.env.ALLSTAK_UPLOAD_TOKEN,
 *   });
 *
 * Or `injectOnly: true` to add the debug-id without uploading (useful in
 * CI dry-runs or when you don't have an upload token yet).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';

export const DEFAULT_HOST = 'https://api.allstak.sa';

const DEBUG_ID_LINE_RE = /^\/\/# debugId=([0-9a-f-]{36})\s*$/m;

export interface UploadReactNativeSourcemapOptions {
  /** Path to the JS/Hermes-bytecode bundle (Metro's `--bundle-output`). */
  bundle: string;
  /** Path to the matching `.map` (Metro's `--sourcemap-output`). */
  sourcemap: string;
  /** Release identifier (e.g. `mobile@1.2.3` — match `release` in AllStak.init). */
  release: string;
  /**
   * Distribution tag — recommended values: `ios-hermes`, `android-hermes`,
   * `ios-jsc`, `android-jsc`. Match the `dist` the SDK auto-detects at
   * runtime (see `src/install.ts`). Required for the symbolicator to
   * pick the right map per platform.
   */
  dist?: string;
  /** Project upload token (`aspk_…`). Defaults to `ALLSTAK_UPLOAD_TOKEN`. */
  token?: string;
  /** Override ingest host. Defaults to `ALLSTAK_HOST` or production. */
  host?: string;
  /** Drop `sourcesContent` from the map before upload (smaller payload). */
  stripSources?: boolean;
  /** Also upload the JS/HBC bundle alongside the map. Off by default. */
  uploadBundle?: boolean;
  /** Inject debug-id but skip the upload (CI dry-run). */
  injectOnly?: boolean;
  /** Pre-existing debug-id to use instead of generating one. Optional. */
  debugId?: string;
  /** Suppress per-step console output. Default false. */
  silent?: boolean;
}

export interface UploadReactNativeSourcemapResult {
  /** The debug-id injected into the bundle + map. */
  debugId: string;
  /** True if the bundle already had a debug-id; we reused it. */
  reused: boolean;
  /** True when upload(s) succeeded — undefined when `injectOnly: true`. */
  uploaded?: boolean;
  /** Per-artifact responses, in the order we sent them. */
  steps?: Array<{ type: 'sourcemap' | 'bundle'; status: number; sha8: string; body?: string }>;
}

function sha8(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

/**
 * Inject a debug-id into the bundle + map (idempotent — reuses an
 * existing id if present).
 */
export function injectReactNativeSourcemap(
  opts: Pick<UploadReactNativeSourcemapOptions, 'bundle' | 'sourcemap' | 'debugId'>,
): { debugId: string; reused: boolean } {
  const bundleRaw = readFileSync(opts.bundle, 'utf8');
  const mapRaw = readFileSync(opts.sourcemap, 'utf8');
  const map = JSON.parse(mapRaw) as { debugId?: unknown; [k: string]: unknown };

  let debugId = opts.debugId ?? '';
  if (!debugId && typeof map.debugId === 'string') debugId = map.debugId;
  const existing = DEBUG_ID_LINE_RE.exec(bundleRaw);
  if (!debugId && existing && existing[1]) debugId = existing[1];
  const reused = !!debugId;
  if (!debugId) debugId = randomUUID();

  // Re-stringify map with canonical debugId field.
  map.debugId = debugId;
  writeFileSync(opts.sourcemap, JSON.stringify(map));

  // Append `//# debugId=…` to the bundle (idempotent — strip prior line first).
  let bundleOut = bundleRaw.replace(DEBUG_ID_LINE_RE, '');
  bundleOut = bundleOut.replace(/\s+$/, '');
  bundleOut += `\n//# debugId=${debugId}\n`;
  writeFileSync(opts.bundle, bundleOut);

  return { debugId, reused };
}

async function uploadOne(
  type: 'sourcemap' | 'bundle',
  filePath: string,
  debugId: string,
  release: string,
  host: string,
  token: string,
  dist: string | undefined,
  stripSources: boolean,
): Promise<{ status: number; body: string; ok: boolean }> {
  let buf = readFileSync(filePath);
  if (type === 'sourcemap' && stripSources) {
    const json = JSON.parse(buf.toString('utf8')) as { sourcesContent?: unknown };
    if (Array.isArray(json.sourcesContent)) delete json.sourcesContent;
    buf = Buffer.from(JSON.stringify(json));
  }

  const form = new FormData();
  form.append('debugId', debugId);
  form.append('type', type);
  form.append('release', release);
  if (dist) form.append('dist', dist);
  form.append(
    'file',
    new Blob([buf], {
      type: type === 'sourcemap' ? 'application/json' : 'application/javascript',
    }),
    basename(filePath),
  );

  const res = await fetch(host.replace(/\/$/, '') + '/api/v1/artifacts/upload', {
    method: 'POST',
    headers: { 'X-AllStak-Upload-Token': token },
    body: form,
  });
  return { status: res.status, body: await res.text(), ok: res.ok };
}

/**
 * Inject debug-id into the bundle + map and (optionally) upload.
 *
 * Returns the debug-id (so the caller can stash it for symbolicator
 * lookups), whether it was reused, and per-step upload statuses.
 */
export async function uploadReactNativeSourcemap(
  opts: UploadReactNativeSourcemapOptions,
): Promise<UploadReactNativeSourcemapResult> {
  const log = opts.silent ? () => undefined : (m: string) => console.log(`[allstak/sourcemaps] ${m}`);

  const inject = injectReactNativeSourcemap(opts);
  log(`bundle: ${basename(opts.bundle)}  debugId: ${inject.debugId} ${inject.reused ? '(reused)' : '(new)'}`);

  const token = opts.token ?? process.env.ALLSTAK_UPLOAD_TOKEN;
  if (opts.injectOnly || !token) {
    if (!opts.injectOnly && !token) {
      log('skipping upload — no token (set ALLSTAK_UPLOAD_TOKEN or pass `token`)');
    }
    return inject;
  }

  const host = opts.host ?? process.env.ALLSTAK_HOST ?? DEFAULT_HOST;
  const stripSources = opts.stripSources ?? false;

  const steps: UploadReactNativeSourcemapResult['steps'] = [];
  const mapResult = await uploadOne(
    'sourcemap', opts.sourcemap, inject.debugId, opts.release, host, token, opts.dist, stripSources,
  );
  steps.push({
    type: 'sourcemap',
    status: mapResult.status,
    sha8: sha8(readFileSync(opts.sourcemap)),
    body: mapResult.ok ? undefined : mapResult.body,
  });
  log(`  sourcemap → ${mapResult.status}${mapResult.ok ? '' : ' ' + mapResult.body.slice(0, 120)}`);

  let allOk = mapResult.ok;
  if (opts.uploadBundle) {
    const bundleResult = await uploadOne(
      'bundle', opts.bundle, inject.debugId, opts.release, host, token, opts.dist, false,
    );
    steps.push({
      type: 'bundle',
      status: bundleResult.status,
      sha8: sha8(readFileSync(opts.bundle)),
      body: bundleResult.ok ? undefined : bundleResult.body,
    });
    allOk = allOk && bundleResult.ok;
    log(`  bundle    → ${bundleResult.status}${bundleResult.ok ? '' : ' ' + bundleResult.body.slice(0, 120)}`);
  }

  return { ...inject, uploaded: allOk, steps };
}
