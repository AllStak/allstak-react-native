import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
const { SDK_VERSION } = await import('../dist/index.mjs');
const pluginModule = await import('../dist/expo-plugin.mjs');

test('SDK_VERSION matches package.json version', () => {
  assert.equal(SDK_VERSION, pkg.version);
});

test('Expo plugin metadata version matches package.json version', () => {
  const config = pluginModule.default({ extra: {} });
  assert.equal(config.extra._allstak.pluginVersion, pkg.version);
});
