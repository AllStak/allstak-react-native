/**
 * RN architecture detection tests.
 *
 * Verifies the JS-level New Architecture / Bridgeless / Hermes flag
 * reading. End-to-end Fabric/TurboModules verification on a real device
 * build is documented as a known gap in the README.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'fetch', {
  value: async () => new Response('{}', { status: 200 }),
  writable: true, configurable: true,
});

const { detectArchitecture, applyArchitectureTags } = await import('../dist/index.mjs');

const cleanup = () => {
  delete globalThis.__turboModuleProxy;
  delete globalThis.RN$Bridgeless;
  delete globalThis.HermesInternal;
  delete globalThis.nativeFlushQueueImmediate;
};

test('detectArchitecture returns new-arch when __turboModuleProxy is present', () => {
  cleanup();
  globalThis.__turboModuleProxy = () => null;
  const info = detectArchitecture();
  assert.equal(info.newArchitecture, true);
  assert.equal(info.tag, 'new-arch');
});

test('detectArchitecture returns old-arch when only nativeFlushQueueImmediate is present', () => {
  cleanup();
  globalThis.nativeFlushQueueImmediate = () => {};
  const info = detectArchitecture();
  assert.equal(info.newArchitecture, false);
  assert.equal(info.tag, 'old-arch');
});

test('detectArchitecture detects Hermes via HermesInternal', () => {
  cleanup();
  globalThis.HermesInternal = {};
  const info = detectArchitecture();
  assert.equal(info.hermes, true);
});

test('detectArchitecture detects Bridgeless when RN$Bridgeless is truthy', () => {
  cleanup();
  globalThis.RN$Bridgeless = true;
  const info = detectArchitecture();
  assert.equal(info.bridgeless, true);
});

test('applyArchitectureTags writes rn.architecture / rn.bridgeless / rn.hermes', () => {
  cleanup();
  globalThis.__turboModuleProxy = () => null;
  globalThis.HermesInternal = {};
  const tags = {};
  applyArchitectureTags((k, v) => { tags[k] = v; });
  assert.equal(tags['rn.architecture'], 'new-arch');
  assert.equal(tags['rn.hermes'], 'true');
  assert.equal(tags['rn.bridgeless'], 'false');
  cleanup();
});
