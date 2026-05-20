/**
 * Flat screenshot API for `@allstak/react-native`.
 *
 * Mirrors the props the wizard emits (`captureScreenshotOnError`,
 * `screenshotRedaction`, etc.) and orchestrates native capture via the
 * the SDK-owned native module.
 *
 * Fail-open contract: the event MUST always send even when capture is
 * unavailable, throws, times out, or the upload fails. The capture
 * subsystem is allowed to log in __DEV__ but must never reject into the
 * host app's promise chain.
 */

import { tryRequire, detectRuntimeMode, runtimeAllowsScreenshot, RuntimeMode } from './runtime';
import { __setCapturing, sensitiveRefCount } from './privacy';

declare const __DEV__: boolean | undefined;

export type ScreenshotRedactionMode = 'strict' | 'balanced' | 'custom';
export type ScreenshotMaskStyle = 'solid' | 'blur';
export type ScreenshotFormat = 'png' | 'jpg' | 'webp';
export type ScreenshotNativeMode = 'auto' | 'native' | 'disabled';
export type ScreenshotFailPolicy = 'disable-screenshot' | 'send-event-only';

export interface ScreenshotConfig {
  captureScreenshotOnError: boolean;
  screenshotRedaction: ScreenshotRedactionMode;
  screenshotMaskStyle: ScreenshotMaskStyle;
  screenshotMaxBytes: number;
  screenshotQuality: number;
  screenshotFormat: ScreenshotFormat;
  screenshotSampleRate: number;
  screenshotOnUnhandledOnly: boolean;
  screenshotUploadTimeoutMs: number;
  screenshotCaptureTimeoutMs: number;
  screenshotNativeMode: ScreenshotNativeMode;
  screenshotFailPolicy: ScreenshotFailPolicy;
  beforeScreenshotCapture?: (ctx: ScreenshotContext) => boolean | Promise<boolean>;
  beforeScreenshotUpload?:
    | ((payload: ScreenshotUpload, meta: ScreenshotMetadata) =>
        ScreenshotUpload | null | Promise<ScreenshotUpload | null>);
  isScreenshotAllowed?: (ctx: ScreenshotContext) => boolean | Promise<boolean>;
}

export interface ScreenshotContext {
  error?: Error;
  unhandled?: boolean;
  runtimeMode: RuntimeMode;
}

export interface ScreenshotUpload {
  /** Base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
  contentType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ScreenshotMetadata {
  captureMethod: string;
  redactionMode: ScreenshotRedactionMode;
  maskStyle: ScreenshotMaskStyle;
  format: ScreenshotFormat;
  width: number;
  height: number;
  sizeBytes: number;
  maskedElements?: number;
  privacyComponentsDetected?: number;
  runtimeMode: RuntimeMode;
}

export const DEFAULT_SCREENSHOT_CONFIG: ScreenshotConfig = {
  captureScreenshotOnError: true,
  screenshotRedaction: 'strict',
  screenshotMaskStyle: 'solid',
  screenshotMaxBytes: 500_000,
  screenshotQuality: 0.6,
  screenshotFormat: 'jpg',
  screenshotSampleRate: 1,
  screenshotOnUnhandledOnly: false,
  screenshotUploadTimeoutMs: 8000,
  screenshotCaptureTimeoutMs: 2000,
  screenshotNativeMode: 'native',
  screenshotFailPolicy: 'send-event-only',
};

/**
 * Merge partial config from `init()` / provider props with sensible
 * defaults. Any `undefined` field falls back to the default. Numeric
 * fields are clamped to safe ranges.
 */
export function resolveScreenshotConfig(
  partial: Partial<ScreenshotConfig> | undefined,
): ScreenshotConfig {
  const c = { ...DEFAULT_SCREENSHOT_CONFIG, ...(partial ?? {}) };
  c.screenshotMaxBytes = clamp(c.screenshotMaxBytes, 1024, 5_000_000);
  c.screenshotQuality = clamp(c.screenshotQuality, 0, 1);
  c.screenshotSampleRate = clamp(c.screenshotSampleRate, 0, 1);
  c.screenshotUploadTimeoutMs = clamp(c.screenshotUploadTimeoutMs, 500, 60_000);
  c.screenshotCaptureTimeoutMs = clamp(c.screenshotCaptureTimeoutMs, 100, 30_000);
  return c;
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Module-level ref the provider keeps to the root view. The capture
// path reads from here.
let rootViewRef: { current: unknown } | null = null;

/** @internal — set by AllStakProvider. */
export function __setRootViewRef(ref: { current: unknown } | null): void {
  rootViewRef = ref;
}

/** @internal — read by tests / verify script. */
export function __getRootViewRef(): { current: unknown } | null {
  return rootViewRef;
}

// One-time deprecation log when both APIs are present.
let warnedAboutBothApis = false;
export function warnIfBothApisPresent(callbackPresent: boolean, flatPresent: boolean): void {
  if (!callbackPresent || !flatPresent || warnedAboutBothApis) return;
  warnedAboutBothApis = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[AllStak] Both `screenshot.provider` (deprecated) and the flat `captureScreenshotOnError` API are configured. ' +
    'The flat API takes precedence. Remove `screenshot.provider` to silence this warning.',
  );
}

function getAllStakNative(): any | null {
  try {
    const RN: any = tryRequire('react-native');
    return RN?.NativeModules?.AllStakNative ?? null;
  } catch {
    return null;
  }
}

export function isNativeScreenshotAvailable(): boolean {
  const native = getAllStakNative();
  return typeof native?.captureScreenshot === 'function';
}

/**
 * Attempt a native screenshot via the SDK-owned native module. Returns
 * `null` if anything goes wrong (timeout, missing module, unsupported host).
 * Never throws. Toggles `__setCapturing(true)` for the duration of the
 * capture so masking primitives swap to their placeholder render.
 */
export async function captureViaNativeModule(
  config: ScreenshotConfig,
): Promise<ScreenshotUpload | null> {
  if (config.screenshotNativeMode === 'disabled') return null;
  const native = getAllStakNative();
  if (typeof native?.captureScreenshot !== 'function') return null;

  const format = config.screenshotFormat === 'jpg' ? 'jpg' : config.screenshotFormat;

  __setCapturing(true);
  // Yield one tick so masking primitives can re-render with isCapturing=true.
  await new Promise((r) => setTimeout(r, 16));

  try {
    const captured = await Promise.race([
      Promise.resolve(native.captureScreenshot({
        format,
        quality: config.screenshotQuality,
        maxBytes: config.screenshotMaxBytes,
      })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), config.screenshotCaptureTimeoutMs)),
    ]);
    if (!captured || typeof captured.dataBase64 !== 'string') return null;
    const sizeBytes = typeof captured.sizeBytes === 'number'
      ? captured.sizeBytes
      : estimateBase64Size(captured.dataBase64);
    if (sizeBytes > config.screenshotMaxBytes) {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.warn(`[AllStak] Screenshot ${sizeBytes}B exceeds limit ${config.screenshotMaxBytes}B; dropping.`);
      }
      return null;
    }
    const dimensions = readDimensions();
    const contentType = typeof captured.contentType === 'string'
      ? captured.contentType
      : format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
    return {
      dataBase64: captured.dataBase64,
      contentType,
      width: typeof captured.width === 'number' ? captured.width : dimensions.width,
      height: typeof captured.height === 'number' ? captured.height : dimensions.height,
      sizeBytes,
    };
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[AllStak] native screenshot capture failed:', (err as Error)?.message);
    }
    return null;
  } finally {
    __setCapturing(false);
  }
}

function estimateBase64Size(base64: string): number {
  // 4 base64 chars encode 3 bytes; strip padding.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function readDimensions(): { width: number; height: number } {
  try {
    const RN: any = tryRequire('react-native');
    const dims = RN?.Dimensions?.get?.('window');
    if (dims && typeof dims.width === 'number' && typeof dims.height === 'number') {
      return { width: Math.round(dims.width), height: Math.round(dims.height) };
    }
  } catch { /* ignore */ }
  return { width: 0, height: 0 };
}

/**
 * Top-level orchestrator. Returns an upload + metadata if a screenshot
 * is captured, or `null` if anything (sampling, gates, capture, etc.)
 * skipped it. Never throws.
 */
export async function maybeCaptureScreenshot(
  config: ScreenshotConfig,
  ctx: ScreenshotContext,
): Promise<{ upload: ScreenshotUpload; metadata: ScreenshotMetadata } | null> {
  try {
    if (!config.captureScreenshotOnError) return null;
    if (config.screenshotOnUnhandledOnly && ctx.unhandled === false) return null;
    if (config.screenshotSampleRate < 1 && Math.random() >= config.screenshotSampleRate) return null;
    if (!runtimeAllowsScreenshot(ctx.runtimeMode)) return null;
    if (config.isScreenshotAllowed) {
      try {
        const allowed = await config.isScreenshotAllowed(ctx);
        if (!allowed) return null;
      } catch { /* hook errors → skip capture, do not break */ return null; }
    }
    if (config.beforeScreenshotCapture) {
      try {
        const cont = await config.beforeScreenshotCapture(ctx);
        if (!cont) return null;
      } catch { return null; }
    }

    const upload = await captureViaNativeModule(config);
    if (!upload) return null;

    const metadata: ScreenshotMetadata = {
      captureMethod: 'allstak-native',
      redactionMode: config.screenshotRedaction,
      maskStyle: config.screenshotMaskStyle,
      format: config.screenshotFormat,
      width: upload.width,
      height: upload.height,
      sizeBytes: upload.sizeBytes,
      privacyComponentsDetected: sensitiveRefCount(),
      runtimeMode: ctx.runtimeMode,
    };

    if (config.beforeScreenshotUpload) {
      try {
        const filtered = await config.beforeScreenshotUpload(upload, metadata);
        if (!filtered) return null;
        return { upload: filtered, metadata };
      } catch { return null; }
    }

    return { upload, metadata };
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[AllStak] maybeCaptureScreenshot fail-open:', (err as Error)?.message);
    }
    return null;
  }
}

export function pickScreenshotConfig(source: Record<string, unknown>): Partial<ScreenshotConfig> {
  const out: Partial<ScreenshotConfig> = {};
  const pick = <K extends keyof ScreenshotConfig>(key: K) => {
    if (source[key] !== undefined) (out as any)[key] = source[key];
  };
  pick('captureScreenshotOnError');
  pick('screenshotRedaction');
  pick('screenshotMaskStyle');
  pick('screenshotMaxBytes');
  pick('screenshotQuality');
  pick('screenshotFormat');
  pick('screenshotSampleRate');
  pick('screenshotOnUnhandledOnly');
  pick('screenshotUploadTimeoutMs');
  pick('screenshotCaptureTimeoutMs');
  pick('screenshotNativeMode');
  pick('screenshotFailPolicy');
  pick('beforeScreenshotCapture');
  pick('beforeScreenshotUpload');
  pick('isScreenshotAllowed');
  return out;
}
