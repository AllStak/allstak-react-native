/**
 * @allstak/react-native — standalone React Native SDK.
 *
 * Self-contained: depends only on `react-native` (peer) and the global
 * `fetch`/`AbortController` that RN guarantees. Contains no `window`,
 * `document`, `localStorage`, `sessionStorage`, or browser DOM event
 * listeners.
 *
 * Recommended usage (one-liner):
 *
 *   import { AllStakProvider } from '@allstak/react-native';
 *
 *   export default function App() {
 *     return (
 *       <AllStakProvider apiKey="YOUR_API_KEY" environment="production">
 *         <AppRoot />
 *       </AllStakProvider>
 *     );
 *   }
 *
 * Advanced / manual usage:
 *
 *   import { AllStak, installReactNative } from '@allstak/react-native';
 *   AllStak.init({ apiKey, environment, release });
 *   installReactNative();
 *
 * Native crash capture (Java/Kotlin on Android, Obj-C/Swift on iOS) lives
 * under the `native/` directory in this package. See README.
 */

import { AllStak } from './client';
import { wrap } from './provider';

(AllStak as typeof AllStak & { wrap?: typeof wrap }).wrap = wrap;

// ── Primary API: init + wrap, plus Provider compatibility ──
export {
  AllStakProvider,
  useAllStak,
  wrap,
  __resetProviderInstanceForTest,
} from './provider';
export type { AllStakProviderProps } from './provider';

// ── Core client + manual setup ──────────────────────────────────
export { AllStak } from './client';
export type {
  AllStakConfig,
  Breadcrumb,
  EventId,
  ErrorEventProcessor,
  LogLevel,
  LogEnvelope,
  ScreenshotArtifact,
  ScreenshotCaptureOptions,
  SeverityLevel,
} from './client';
export type { TransportStats } from './transport';
export { HttpTransport } from './transport';
export { AllStakClient, INGEST_HOST, SDK_NAME, SDK_VERSION, Scope } from './client';
export {
  parseGitRelease,
  resolveRelease,
  releaseFromEnv,
  isNodeRuntime,
  __resetGitReleaseCacheForTest,
} from './release-detect';
export type { GitRunner } from './release-detect';

export const init = AllStak.init;
export const captureException = AllStak.captureException;
export const captureMessage = AllStak.captureMessage;
export const log = AllStak.log;
export const logger = AllStak.logger;
export const addBreadcrumb = AllStak.addBreadcrumb;
export const setUser = AllStak.setUser;
export const setTag = AllStak.setTag;
export const setTags = AllStak.setTags;
export const addEventProcessor = AllStak.addEventProcessor;
export const setContext = AllStak.setContext;
export const withScope = AllStak.withScope;
export const getCurrentScope = AllStak.getCurrentScope;
export const configureScope = AllStak.configureScope;
export const startSpan = AllStak.startSpan;
export const flush = AllStak.flush;

// ── Flat screenshot API + masking primitives (0.4.0+) ───────────
export {
  AllStakMaskedView,
  AllStakPrivacyView,
  AllStakTextInput,
  AllStakSensitiveText,
  useAllStakPrivacy,
  registerSensitiveRef,
  isCapturingScreenshot,
  __resetPrivacyStateForTest,
} from './privacy';
export type {
  AllStakMaskedViewProps,
  AllStakTextInputProps,
  AllStakSensitiveTextProps,
  PrivacyLevel,
} from './privacy';
export {
  resolveScreenshotConfig,
  pickScreenshotConfig,
  maybeCaptureScreenshot,
  captureViaNativeModule,
  isNativeScreenshotAvailable,
  DEFAULT_SCREENSHOT_CONFIG,
} from './screenshot';
export type {
  ScreenshotConfig,
  ScreenshotContext,
  ScreenshotMetadata,
  ScreenshotUpload,
  ScreenshotRedactionMode,
  ScreenshotMaskStyle,
  ScreenshotFormat,
  ScreenshotNativeMode,
  ScreenshotFailPolicy,
} from './screenshot';
export { detectRuntimeMode, runtimeAllowsScreenshot, __resetRuntimeModeForTest } from './runtime';
export type { RuntimeMode } from './runtime';

// ── React Native integrations (used internally by AllStakProvider) ──
export { installReactNative } from './install';
export type { ReactNativeInstallOptions } from './install';

// ── Navigation helpers ──────────────────────────────────────────
export {
  instrumentReactNavigation,
  instrumentNavigationFromLinking,
  tryAutoInstrumentNavigation,
  __resetAutoNavigationFlagForTest,
} from './navigation';

// ── Console capture types ───────────────────────────────────────
export type { ConsoleCaptureOptions } from './auto-breadcrumbs';
export { __resetConsoleInstrumentationFlagForTest } from './auto-breadcrumbs';

// ── Rich event enrichment (0.5.0+) ──────────────────────────────
export { collectAutoContexts, buildAutoRelease, resolveAutoRelease, buildUserContext } from './contexts';
export type { AllStakContexts, CollectContextOptions } from './contexts';
export {
  buildExceptionChain,
  extractAxiosRequest,
  classifyHttpError,
  maybeExtractHttpRequest,
  sanitizeUrl,
} from './mechanism';
export type { MechanismType, ExceptionValue, SanitizedHttpRequest } from './mechanism';

// ── Advanced modules ────────────────────────────────────────────
export { ReplaySurrogate } from './replay-surrogate';
export type { ReplaySurrogateOptions } from './replay-surrogate';
export { detectArchitecture, applyArchitectureTags } from './architecture';
export type { ArchitectureInfo } from './architecture';
export type { HttpTrackingOptions } from './http-redact';
export {
  ALWAYS_REDACT_HEADERS,
  ALWAYS_REDACT_QUERY,
  DEFAULT_REDACT_BODY_FIELDS,
  REDACTED,
  redactUrl,
  sanitizeHeaders,
  captureBodyResult,
} from './http-redact';
export { HttpRequestModule } from './http-requests';
export type { HttpRequestEvent } from './http-requests';

// ── Value-pattern PII scrubbing (CC/SSN/email/IPv4) ─────────────
export { scrubString, scrubValueTree, MAX_SCAN_LENGTH, MAX_DEPTH } from './value-scrub';
export type { ValueScrubOptions } from './value-scrub';

// ── Release-health session tracking (0.5.12+) ───────────────────
export { Session, SessionTracker } from './session';
export type {
  SessionStatus,
  SessionStartFields,
  SessionTrackerOptions,
} from './session';

// ── Offline / persistent event queue (0.5.12+) ──────────────────
export {
  setPersistence,
  detectDefaultStorage,
  PersistentEventStore,
  __getPersistenceOverrideForTest,
} from './persistence';
export type {
  PersistenceStorage,
  PersistenceOptions,
  PersistedEntry,
} from './persistence';

// ── Native crash drain ──────────────────────────────────────────

declare const require: (id: string) => any;

/**
 * Test seam — set a fake native module to be returned by
 * `drainPendingNativeCrashes` instead of `require('react-native').NativeModules.AllStakNative`.
 * Pass `null` to clear. Production callers must NOT use this.
 *
 * @internal
 */
let __testNativeModule: any = null;
export function __setNativeModuleForTest(mod: any): void {
  __testNativeModule = mod;
}

/**
 * DEV-ONLY: deliberately trigger a native iOS or Android crash via the
 * linked AllStak native module. This is intended for verifying the
 * native-crash → drain → ingest pipeline during SDK development. It
 * **terminates the app process** — never expose this in production UI.
 *
 *   import { __devTriggerNativeCrash } from '@allstak/react-native';
 *   if (__DEV__) __devTriggerNativeCrash();  // app dies; relaunch drains
 *
 * No-op when the native module is not linked.
 */
export async function __devTriggerNativeCrash(): Promise<void> {
  try {
    let native: any = __testNativeModule;
    if (!native) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      native = rn?.NativeModules?.AllStakNative;
    }
    if (!native || typeof native.__devTriggerCrash !== 'function') return;
    await native.__devTriggerCrash();
  } catch {
    // Native module not present — silently no-op.
  }
}

/**
 * Drain any native crash stashed by AllStakCrashHandler on the previous
 * launch and ship it to /ingest/v1/errors. No-op when the native module
 * is not linked (Expo Go, JS-only test runners, etc).
 */
export async function drainPendingNativeCrashes(release?: string): Promise<void> {
  try {
    let native: any = __testNativeModule;
    if (!native) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      native = rn?.NativeModules?.AllStakNative;
    }
    if (!native) return;
    // Prefer the options-aware install (native-signal capture on by default);
    // fall back to the legacy single-arg install for older native modules.
    if (typeof native.installWithOptions === 'function') {
      try { await native.installWithOptions(release ?? '', true); } catch { /* ignore */ }
    } else if (typeof native.install === 'function') {
      try { await native.install(release ?? ''); } catch { /* ignore */ }
    }
    if (typeof native.drainPendingCrash === 'function') {
      const json: string | null = await native.drainPendingCrash();
      if (json && json !== '') {
        try {
          const payload = JSON.parse(json);
          const err = new Error(payload?.message ?? 'Native crash');
          err.name = payload?.exceptionClass ?? 'NativeCrash';
          (err as any).stack = Array.isArray(payload?.stackTrace)
            ? payload.stackTrace.join('\n')
            : String(payload?.stackTrace ?? '');
          AllStak.captureException(err, {
            ...(payload?.metadata || {}),
            'native.crash': 'true',
          }, { mechanism: 'native_crash', handled: false });
        } catch { /* swallow */ }
      }
    }
  } catch {
    // react-native not available in this runtime
  }
}
