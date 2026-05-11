/**
 * @allstak/react-native/sourcemaps build-pipeline tests.
 *
 * Verifies:
 *   - subpath module imports cleanly
 *   - injectReactNativeSourcemap is idempotent
 *   - debugId is written to BOTH the bundle (`//# debugId=`) and the
 *     map (top-level `debugId` field) and they match
 *   - uploadReactNativeSourcemap posts to /api/v1/artifacts/upload
 *     with the right multipart fields (debugId, type, release, dist)
 *   - injectOnly:true skips the upload
 *   - missing token skips the upload silently
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sm = await import('../dist/build/sourcemaps.mjs');

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'allstak-rn-sm-'));
}

function writeBundlePair(dir) {
  const bundle = join(dir, 'ios.bundle');
  const sourcemap = join(dir, 'ios.bundle.map');
  writeFileSync(bundle, 'var __BUNDLE_START_TIME__=Date.now();\nconsole.log("rn");\n');
  writeFileSync(sourcemap, JSON.stringify({
    version: 3,
    sources: ['index.ts'],
    mappings: 'AAAA',
    names: [],
    sourcesContent: ['console.log("rn");'],
  }));
  return { bundle, sourcemap };
}

// ── Surface ──────────────────────────────────────────────────

test('@allstak/react-native/sourcemaps exports the documented surface', () => {
  for (const name of ['injectReactNativeSourcemap', 'uploadReactNativeSourcemap', 'DEFAULT_HOST']) {
    assert.ok(name in sm, `expected export: ${name}`);
  }
});

// ── inject ────────────────────────────────────────────────────

test('injectReactNativeSourcemap writes a debugId into both bundle and map', () => {
  const dir = freshDir();
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    const result = sm.injectReactNativeSourcemap({ bundle, sourcemap });
    assert.ok(/^[0-9a-f-]{36}$/.test(result.debugId));
    assert.equal(result.reused, false);

    const bundleText = readFileSync(bundle, 'utf8');
    const debugIdLine = bundleText.match(/\/\/# debugId=([0-9a-f-]{36})/);
    assert.ok(debugIdLine);
    assert.equal(debugIdLine[1], result.debugId);

    const map = JSON.parse(readFileSync(sourcemap, 'utf8'));
    assert.equal(map.debugId, result.debugId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectReactNativeSourcemap is idempotent — second run reuses the same debugId', () => {
  const dir = freshDir();
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    const a = sm.injectReactNativeSourcemap({ bundle, sourcemap });
    const b = sm.injectReactNativeSourcemap({ bundle, sourcemap });
    assert.equal(b.debugId, a.debugId);
    assert.equal(b.reused, true);
    const bundleText = readFileSync(bundle, 'utf8');
    const matches = bundleText.match(/\/\/# debugId=/g) ?? [];
    assert.equal(matches.length, 1, 'exactly one debug-id comment');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectReactNativeSourcemap honors a caller-supplied debugId', () => {
  const dir = freshDir();
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    const fixed = '11111111-2222-4333-8444-555555555555';
    const result = sm.injectReactNativeSourcemap({ bundle, sourcemap, debugId: fixed });
    assert.equal(result.debugId, fixed);
    const map = JSON.parse(readFileSync(sourcemap, 'utf8'));
    assert.equal(map.debugId, fixed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── upload ────────────────────────────────────────────────────

test('uploadReactNativeSourcemap posts a multipart payload to /api/v1/artifacts/upload', async () => {
  const dir = freshDir();
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    recorded.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      bodyType: init?.body?.constructor?.name,
    });
    return new Response(JSON.stringify({ success: true }), { status: 201 });
  };
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    const result = await sm.uploadReactNativeSourcemap({
      bundle,
      sourcemap,
      release: 'mobile@1.2.3',
      dist: 'ios-hermes',
      token: 'aspk_fake',
      host: 'http://localhost:8080',
      silent: true,
    });
    assert.equal(result.uploaded, true);
    assert.equal(recorded.length, 1);  // map only by default
    assert.equal(recorded[0].url, 'http://localhost:8080/api/v1/artifacts/upload');
    assert.equal(recorded[0].method, 'POST');
    assert.equal(recorded[0].headers['X-AllStak-Upload-Token'], 'aspk_fake');
    assert.equal(recorded[0].bodyType, 'FormData');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadReactNativeSourcemap with uploadBundle:true sends both map AND bundle', async () => {
  const dir = freshDir();
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    recorded.push({ url: String(url) });
    return new Response('{}', { status: 201 });
  };
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    await sm.uploadReactNativeSourcemap({
      bundle, sourcemap,
      release: 'mobile@1.2.3', dist: 'ios-hermes',
      token: 'aspk_fake', host: 'http://localhost:8080',
      uploadBundle: true, silent: true,
    });
    assert.equal(recorded.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadReactNativeSourcemap with injectOnly:true skips upload', async () => {
  const dir = freshDir();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 201 }); };
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    const result = await sm.uploadReactNativeSourcemap({
      bundle, sourcemap, release: 'mobile@1.2.3',
      token: 'aspk_fake', host: 'http://localhost:8080',
      injectOnly: true, silent: true,
    });
    assert.equal(result.uploaded, undefined);
    assert.equal(calls, 0);
    assert.ok(/^[0-9a-f-]{36}$/.test(result.debugId));
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadReactNativeSourcemap silently skips when no token is provided', async () => {
  const dir = freshDir();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 201 }); };
  delete process.env.ALLSTAK_UPLOAD_TOKEN;
  try {
    const { bundle, sourcemap } = writeBundlePair(dir);
    const result = await sm.uploadReactNativeSourcemap({
      bundle, sourcemap, release: 'mobile@1.2.3',
      host: 'http://localhost:8080', silent: true,
    });
    assert.equal(result.uploaded, undefined);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
