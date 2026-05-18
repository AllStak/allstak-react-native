/**
 * Runtime detection for React Native screenshot capture.
 *
 * Determines whether native screenshot APIs (specifically
 * `react-native-view-shot`) are usable in the current host:
 *   - 'expo-go'        — Expo Go sandbox; native modules cannot be added
 *                        at runtime → screenshots silently skipped.
 *   - 'expo-dev-client'— Expo dev/prod build that bundles native deps.
 *   - 'rn-cli'         — bare react-native (CLI) build.
 *   - 'unknown'        — anything we couldn't classify; treat as allowed
 *                        but log a __DEV__ warning.
 */

export type RuntimeMode = 'expo-go' | 'expo-dev-client' | 'rn-cli' | 'unknown';

declare const require: (id: string) => any;
declare const __DEV__: boolean | undefined;

let cached: RuntimeMode | null = null;

/**
 * Best-effort detection of the host runtime. Cached after first call.
 */
export function detectRuntimeMode(): RuntimeMode {
  if (cached) return cached;
  cached = computeRuntimeMode();
  return cached;
}

/** @internal — reset for tests */
export function __resetRuntimeModeForTest(): void {
  cached = null;
}

function computeRuntimeMode(): RuntimeMode {
  // Expo Go advertises `Constants.appOwnership === 'expo'`.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require('expo-constants');
    const appOwnership = Constants?.default?.appOwnership ?? Constants?.appOwnership;
    if (appOwnership === 'expo') return 'expo-go';
    if (appOwnership === 'standalone' || appOwnership === 'guest') return 'expo-dev-client';
    // executionEnvironment is the newer API
    const exec = Constants?.default?.executionEnvironment ?? Constants?.executionEnvironment;
    if (exec === 'storeClient') return 'expo-go';
    if (exec === 'standalone' || exec === 'bare') return 'expo-dev-client';
  } catch { /* expo-constants not installed */ }

  // If expo is present at all (managed/dev-client) but Constants missing, prefer dev-client.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo');
    return 'expo-dev-client';
  } catch { /* not an Expo app */ }

  // Bare react-native CLI app — react-native is installed, no expo wrapper.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react-native');
    return 'rn-cli';
  } catch { /* not RN — JS tests etc. */ }

  return 'unknown';
}

/** Whether a runtime allows attempting a native screenshot via view-shot. */
export function runtimeAllowsScreenshot(mode: RuntimeMode = detectRuntimeMode()): boolean {
  if (mode === 'expo-go') return false;
  return true;
}

/** Try to require a module without throwing. */
export function tryRequire<T = any>(id: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return null;
  }
}
