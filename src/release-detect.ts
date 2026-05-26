/**
 * Release auto-detection for allstak-react-native.
 *
 * A React Native JS runtime has **no `child_process`**, so RUNTIME local-git
 * detection is impossible — step 3 below is intentionally a documented
 * **no-op** at RN runtime. The realistic RN release is a *build-time* value:
 * the app version / build / bundle id, which this SDK already derives from the
 * native app config via `buildAutoRelease` in `contexts.ts`, plus optional
 * env vars baked in at bundle time. This module adds:
 *
 *   - a guarded git step (no-op on RN; only engages if a runner is injected or
 *     the code happens to run under Node, e.g. SSR/test tooling), and
 *   - a never-empty SDK-version fallback, and
 *   - the shared, pure, testable `parseGitRelease` seam.
 *
 * Resolution order for `release` (highest priority first):
 *   1. Explicit `config.release`            — always wins (client.ts).
 *   2. Native app-config auto-release (`buildAutoRelease`) — RN build-time;
 *      this is the SDK's PRE-EXISTING primary auto-detect and stays authoritative.
 *   3. Env vars (ALLSTAK_RELEASE, VERCEL_GIT_*, …) baked at bundle time.
 *   4. Local git at init                    — RN/browser NO-OP (guarded).
 *   5. SDK version constant                 — never-empty fallback.
 *
 * Steps 4 + 5 are gated by `autoDetectRelease` (default true). On RN, the
 * practical chain is explicit → app-config → env → SDK version (git never
 * engages at runtime). App-config is kept above env so the pre-existing RN
 * behavior (native app version/build as release) is preserved exactly.
 */

/** A function that runs a git command and returns its trimmed stdout. */
export type GitRunner = (args: string[]) => string;

/**
 * Parse raw git output into a release string. PURE — no I/O, no spawning.
 * Shared shape with the other AllStak SDKs.
 */
export function parseGitRelease(
  describeOut: string | undefined,
  revParseOut?: string | undefined,
  porcelainOut?: string | undefined,
): string | undefined {
  const describe = normalizeLine(describeOut);
  if (describe) return describe;

  const sha = normalizeLine(revParseOut);
  if (!sha) return undefined;
  const dirty = typeof porcelainOut === 'string' && porcelainOut.trim().length > 0;
  return dirty ? `${sha}-dirty` : sha;
}

function normalizeLine(out: string | undefined): string | undefined {
  if (!out) return undefined;
  const first = out.split('\n')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/** Read an env var safely; undefined when `process` is absent or unset. */
export function envVar(name: string): string | undefined {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env[name];
      if (v && v.length > 0) return v;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Conventional CI/runtime env vars (bundle-time inlined for RN). */
export function releaseFromEnv(): string | undefined {
  return (
    envVar('ALLSTAK_RELEASE') ??
    envVar('npm_package_version') ??
    envVar('VERCEL_GIT_COMMIT_SHA')?.slice(0, 12) ??
    envVar('RAILWAY_GIT_COMMIT_SHA')?.slice(0, 12) ??
    envVar('RENDER_GIT_COMMIT')?.slice(0, 12)
  );
}

/**
 * Is the current runtime a Node-like environment that *could* spawn git?
 * False on React Native (navigator.product === 'ReactNative'), in browsers,
 * and anywhere `process.versions.node` is absent.
 */
export function isNodeRuntime(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      !!process.versions &&
      typeof process.versions.node === 'string' &&
      typeof (globalThis as any).window === 'undefined' &&
      !(typeof navigator !== 'undefined' && (navigator as any).product === 'ReactNative')
    );
  } catch {
    return false;
  }
}

let cachedRelease: string | undefined | null = null;

/** @internal — reset memoized git release for tests. */
export function __resetGitReleaseCacheForTest(): void {
  cachedRelease = null;
}

/**
 * Detect a release from local git. On RN/browser this is a **no-op** and
 * returns `undefined`. A `GitRunner` may be injected (test seam, or a Node
 * host like Metro tooling / SSR); when omitted, the probe only engages under a
 * genuine Node runtime. Result is cached.
 */
export function detectGitRelease(runner?: GitRunner | null): string | undefined {
  if (cachedRelease !== null) return cachedRelease ?? undefined;

  const run = runner === undefined ? (isNodeRuntime() ? createNodeGitRunner() : null) : runner;
  if (!run) {
    cachedRelease = undefined;
    return undefined;
  }

  try {
    const describe = run(['describe', '--tags', '--always', '--dirty']);
    let release = parseGitRelease(describe);
    if (!release) {
      const sha = run(['rev-parse', '--short', 'HEAD']);
      const porcelain = run(['status', '--porcelain']);
      release = parseGitRelease(undefined, sha, porcelain);
    }
    cachedRelease = release;
    return release;
  } catch {
    cachedRelease = undefined;
    return undefined;
  }
}

/**
 * Guarded dynamic require of child_process — never statically imported so the
 * RN/browser bundle is unaffected. Returns null off-Node or when unavailable.
 */
function createNodeGitRunner(timeoutMs = 1500): GitRunner | null {
  if (!isNodeRuntime()) return null;
  let cp: any;
  try {
    const req: ((id: string) => any) | undefined =
      typeof require === 'function'
        ? require
        : (typeof module !== 'undefined' && (module as any).require) || undefined;
    if (!req) return null;
    cp = req('child_process');
  } catch {
    return null;
  }
  if (!cp || typeof cp.execFileSync !== 'function') return null;
  return (args: string[]): string => {
    try {
      const out = cp.execFileSync('git', args, {
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true,
      });
      return typeof out === 'string' ? out : '';
    } catch {
      return '';
    }
  };
}

/**
 * Resolve the effective `release` applying the full order. The RN build-time
 * app-config release is supplied by the caller (`appConfigRelease`) since it
 * comes from native modules collected in client.ts.
 *
 * @param explicit          `config.release` if set by the user (step 1).
 * @param appConfigRelease  RN native app-config release (`buildAutoRelease`, step 2).
 * @param sdkVersion        never-empty fallback (the package's SDK_VERSION, step 5).
 * @param autoDetect        when false, disables steps 4 + 5 (git + version fallback).
 * @param gitRunner         test seam / Node host (step 4).
 */
export function resolveRelease(
  explicit: string | undefined,
  appConfigRelease: string | undefined,
  sdkVersion: string,
  autoDetect: boolean,
  gitRunner?: GitRunner | null,
): string | undefined {
  if (explicit) return explicit; // 1. explicit always wins

  // 2. RN native app-config release — the SDK's pre-existing primary signal.
  if (appConfigRelease) return appConfigRelease;

  const fromEnv = releaseFromEnv(); // 3. env vars (bundle-time)
  if (fromEnv) return fromEnv;

  if (!autoDetect) return undefined;

  const fromGit = detectGitRelease(gitRunner); // 4. local git (RN/browser → no-op)
  if (fromGit) return fromGit;

  return sdkVersion; // 5. never-empty SDK-version fallback
}
