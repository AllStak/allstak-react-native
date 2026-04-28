/**
 * Verifies the react-native.config.js autolinking manifest is valid and
 * the iOS podspec + Android package class actually exist where the manifest
 * tells the RN CLI to look. Catches cases where the manifest is rewritten
 * to point at non-existent files (which the RN CLI would then fail with a
 * cryptic "no such pod" error days into a customer integration).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const require = createRequire(import.meta.url);

test('react-native.config.js is loadable and exports a dependency block', () => {
  const cfg = require(join(pkgRoot, 'react-native.config.js'));
  assert.ok(cfg.dependency, 'must export a `dependency` field');
  assert.ok(cfg.dependency.platforms.ios, 'must declare ios platform');
  assert.ok(cfg.dependency.platforms.android, 'must declare android platform');
});

test('iOS podspecPath in autolinking config exists on disk', () => {
  const cfg = require(join(pkgRoot, 'react-native.config.js'));
  const podspec = cfg.dependency.platforms.ios.podspecPath;
  assert.ok(existsSync(podspec), `podspec must exist: ${podspec}`);
  // Sanity: podspec mentions our pod name.
  const podsrc = readFileSync(podspec, 'utf8');
  assert.match(podsrc, /AllStakRN/);
});

test('Android sourceDir + AllStakRNPackage exist on disk', () => {
  const cfg = require(join(pkgRoot, 'react-native.config.js'));
  const sourceDir = cfg.dependency.platforms.android.sourceDir;
  const sourceDirAbs = join(pkgRoot, sourceDir);
  assert.ok(existsSync(sourceDirAbs), `android sourceDir must exist: ${sourceDirAbs}`);

  const packageImport = cfg.dependency.platforms.android.packageImportPath;
  assert.match(packageImport, /AllStakRNPackage/, 'must reference AllStakRNPackage');
  const packageInstance = cfg.dependency.platforms.android.packageInstance;
  assert.match(packageInstance, /new AllStakRNPackage\(\)/);

  // The class file referenced by `packageImportPath` must really exist.
  const pkgFile = join(sourceDirAbs, 'src/main/java/io/allstak/rn/AllStakRNPackage.java');
  assert.ok(existsSync(pkgFile), `AllStakRNPackage.java must exist at ${pkgFile}`);
  const pkgSrc = readFileSync(pkgFile, 'utf8');
  assert.match(pkgSrc, /class AllStakRNPackage implements ReactPackage/);
  assert.match(pkgSrc, /new AllStakRNModule\(reactContext\)/);

  // Build script + manifest must also exist for the CLI's gradle layer.
  assert.ok(existsSync(join(sourceDirAbs, 'build.gradle')), 'native android build.gradle missing');
  assert.ok(existsSync(join(sourceDirAbs, 'src/main/AndroidManifest.xml')), 'AndroidManifest.xml missing');
});
