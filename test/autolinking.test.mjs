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

test('Android NDK signal-capture build is wired (cpp + CMake + gradle + AllStakNdk)', () => {
  const cfg = require(join(pkgRoot, 'react-native.config.js'));
  const sourceDirAbs = join(pkgRoot, cfg.dependency.platforms.android.sourceDir);

  // Native source + CMake build file the .so is built from.
  const cpp = join(sourceDirAbs, 'src/main/cpp/allstak_signal_handler.cpp');
  const cmake = join(sourceDirAbs, 'src/main/cpp/CMakeLists.txt');
  assert.ok(existsSync(cpp), `native signal handler .cpp must exist: ${cpp}`);
  assert.ok(existsSync(cmake), `CMakeLists.txt must exist: ${cmake}`);

  // The handler must be async-signal-safe-by-construction: it must register
  // sigaction handlers and write the same "ASK1" record the iOS handler uses,
  // and expose JNI via JNI_OnLoad/RegisterNatives.
  const cppSrc = readFileSync(cpp, 'utf8');
  assert.match(cppSrc, /sigaction/);
  assert.match(cppSrc, /SA_SIGINFO\s*\|\s*SA_ONSTACK/);
  assert.match(cppSrc, /_Unwind_Backtrace/, 'must unwind via async-signal-safe libunwind');
  assert.match(cppSrc, /JNI_OnLoad/);
  assert.match(cppSrc, /RegisterNatives/);
  assert.match(cppSrc, /"ASK1"|0x41.*0x53.*0x4B.*0x31/, 'must use the shared ASK1 record magic');

  // CMake must produce the .so AllStakNdk loads.
  const cmakeSrc = readFileSync(cmake, 'utf8');
  assert.match(cmakeSrc, /add_library\(\s*allstak_signal\s+SHARED/);

  // build.gradle must reference the CMake build via externalNativeBuild.
  const gradleSrc = readFileSync(join(sourceDirAbs, 'build.gradle'), 'utf8');
  assert.match(gradleSrc, /externalNativeBuild/);
  assert.match(gradleSrc, /src\/main\/cpp\/CMakeLists\.txt/);

  // AllStakNdk must load the matching library name and degrade gracefully.
  const ndk = join(sourceDirAbs, 'src/main/java/io/allstak/rn/AllStakNdk.java');
  assert.ok(existsSync(ndk), `AllStakNdk.java must exist: ${ndk}`);
  const ndkSrc = readFileSync(ndk, 'utf8');
  assert.match(ndkSrc, /System\.loadLibrary\("allstak_signal"\)/);
  assert.match(ndkSrc, /native boolean nativeInstall/);
  assert.match(ndkSrc, /android-NDKSignalHandler/);
  // Graceful-degrade: loadLibrary failure must be caught, never thrown.
  assert.match(ndkSrc, /catch\s*\(\s*Throwable/);
});
