/**
 * Expo config plugin tests.
 *
 * Validates that:
 *   - app.plugin.js entrypoint resolves to the built dist
 *   - the plugin is a function returning a mutated config (Expo's contract)
 *   - it stamps `extra._allstak.{release, environment, dist, pluginVersion}`
 *   - it preserves untouched fields (name, plugins[], other extras)
 *   - second invocation is idempotent on the same config
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const require = createRequire(import.meta.url);

test('app.plugin.js exists at the package root', () => {
  assert.ok(existsSync(join(pkgRoot, 'app.plugin.js')),
    'Expo expects app.plugin.js at the package root for plugin resolution');
});

test('app.plugin.js loads and re-exports a function', () => {
  const plugin = require(join(pkgRoot, 'app.plugin.js'));
  assert.equal(typeof plugin, 'function', 'plugin must be a function');
});

test('plugin stamps extra._allstak with release/environment/dist/pluginVersion', () => {
  const plugin = require(join(pkgRoot, 'app.plugin.js'));
  const baseConfig = {
    name: 'MyApp',
    extra: { existingThing: true },
    plugins: ['existing-plugin'],
  };
  const next = plugin(baseConfig, {
    release: 'mobile@2.0.0',
    environment: 'production',
    dist: 'ios-hermes',
  });

  assert.equal(next.name, 'MyApp', 'untouched fields must remain');
  assert.equal(next.extra.existingThing, true, 'other extras must remain');
  assert.deepEqual(next.plugins, ['existing-plugin'], 'plugins[] must remain');

  assert.deepEqual(next.extra._allstak, {
    release: 'mobile@2.0.0',
    environment: 'production',
    dist: 'ios-hermes',
    pluginVersion: '0.3.0',
  });
});

test('plugin is pure — does not mutate the input config', () => {
  const plugin = require(join(pkgRoot, 'app.plugin.js'));
  const input = { name: 'A', extra: { x: 1 } };
  plugin(input, { release: 'r' });
  assert.deepEqual(input, { name: 'A', extra: { x: 1 } },
    'input config must not be mutated');
});

test('plugin merges with previous _allstak block on second invocation (idempotent)', () => {
  const plugin = require(join(pkgRoot, 'app.plugin.js'));
  const first = plugin({ name: 'A' }, { release: 'r1', environment: 'staging' });
  const second = plugin(first, { release: 'r2' });
  // release overrides; environment from first survives.
  assert.equal(second.extra._allstak.release, 'r2');
  assert.equal(second.extra._allstak.environment, 'staging');
});
