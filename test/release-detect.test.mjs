/**
 * Release auto-detection for allstak-react-native.
 *
 * RN has no child_process, so RUNTIME local-git is a no-op — the realistic RN
 * release comes from explicit/env/native-app-config/version. These tests seam
 * the git runner so they never spawn git or need a real repo.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseGitRelease,
  resolveRelease,
  releaseFromEnv,
  __resetGitReleaseCacheForTest,
  SDK_VERSION,
} = await import('../dist/index.mjs');

beforeEach(() => __resetGitReleaseCacheForTest());

const DESCRIBE = 'describe --tags --always --dirty';
const REVPARSE = 'rev-parse --short HEAD';
const STATUS = 'status --porcelain';

function fakeRunner(map) {
  return (args) => (args.join(' ') in map ? map[args.join(' ')] : '');
}

function withCleanEnv(fn) {
  const keys = ['ALLSTAK_RELEASE', 'npm_package_version', 'VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT'];
  const stash = {};
  for (const k of keys) { stash[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(stash)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('parseGitRelease: prefers describe (tag form)', () => {
  assert.equal(parseGitRelease('v1.2.3', 'abc1234', ''), 'v1.2.3');
});

test('parseGitRelease: describe distance + dirty kept verbatim', () => {
  assert.equal(parseGitRelease('v1.2.3-4-gabc1234-dirty'), 'v1.2.3-4-gabc1234-dirty');
});

test('parseGitRelease: sha fallback', () => {
  assert.equal(parseGitRelease('', 'abc1234', ''), 'abc1234');
});

test('parseGitRelease: sha + -dirty when porcelain non-empty', () => {
  assert.equal(parseGitRelease(undefined, 'abc1234', ' M a.ts'), 'abc1234-dirty');
});

test('parseGitRelease: undefined when nothing usable', () => {
  assert.equal(parseGitRelease('', '', ''), undefined);
});

test('resolveRelease: 1. explicit always wins', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'env-x';
    assert.equal(
      resolveRelease('explicit', 'app@1.0.0', SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v9' })),
      'explicit',
    );
  }));

test('resolveRelease: 2. native app-config beats env + git + version (pre-existing RN behavior)', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'env-release';
    assert.equal(
      resolveRelease(undefined, 'com.acme@1.2.0+44', SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v9' })),
      'com.acme@1.2.0+44',
    );
  }));

test('resolveRelease: 3. env beats git + version when no app-config', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'env-release';
    assert.equal(
      resolveRelease(undefined, undefined, SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v9' })),
      'env-release',
    );
  }));

test('resolveRelease: 4. git used only when no app-config (seamed runner)', () =>
  withCleanEnv(() => {
    assert.equal(
      resolveRelease(undefined, undefined, SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v7.7.7' })),
      'v7.7.7',
    );
  }));

test('resolveRelease: 4. git sha+dirty fallback', () =>
  withCleanEnv(() => {
    assert.equal(
      resolveRelease(undefined, undefined, SDK_VERSION, true, fakeRunner({ [DESCRIBE]: '', [REVPARSE]: 'deadbee', [STATUS]: ' M x' })),
      'deadbee-dirty',
    );
  }));

test('resolveRelease: 5. SDK version fallback when nothing else', () =>
  withCleanEnv(() => {
    assert.equal(resolveRelease(undefined, undefined, SDK_VERSION, true, fakeRunner({})), SDK_VERSION);
  }));

test('resolveRelease: graceful when git runner throws', () =>
  withCleanEnv(() => {
    const throwing = () => { throw new Error('no git'); };
    assert.equal(resolveRelease(undefined, undefined, SDK_VERSION, true, throwing), SDK_VERSION);
  }));

test('resolveRelease: RN/browser guard — null runner falls through to version', () =>
  withCleanEnv(() => {
    assert.equal(resolveRelease(undefined, undefined, SDK_VERSION, true, null), SDK_VERSION);
  }));

test('resolveRelease: opt-out disables git + version fallback', () =>
  withCleanEnv(() => {
    assert.equal(
      resolveRelease(undefined, undefined, SDK_VERSION, false, fakeRunner({ [DESCRIBE]: 'v7' })),
      undefined,
    );
  }));

test('resolveRelease: opt-out still honors explicit/env/app-config', () =>
  withCleanEnv(() => {
    // app-config still resolves under opt-out (it is step 3, above the gate)
    assert.equal(
      resolveRelease(undefined, 'app@2.0.0', SDK_VERSION, false, fakeRunner({ [DESCRIBE]: 'v7' })),
      'app@2.0.0',
    );
    process.env.ALLSTAK_RELEASE = 'env-only';
    assert.equal(
      resolveRelease(undefined, undefined, SDK_VERSION, false, fakeRunner({ [DESCRIBE]: 'v7' })),
      'env-only',
    );
  }));

test('releaseFromEnv: reads ALLSTAK_RELEASE', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'r1';
    assert.equal(releaseFromEnv(), 'r1');
  }));
