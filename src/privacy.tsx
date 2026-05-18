/**
 * Privacy / masking primitives for AllStak React Native screenshots.
 *
 * Three concerns:
 *   1. A registry of refs / views the capture path should mask when it
 *      takes a snapshot.
 *   2. An "isCapturing" flag that masking components subscribe to so they
 *      can swap their children for a redacted placeholder during a capture.
 *   3. Light wrappers (`AllStakMaskedView`, `AllStakPrivacyView`,
 *      `AllStakTextInput`, `AllStakSensitiveText`) that opt-in to the
 *      isCapturing swap.
 *
 * All wrappers are no-ops when react-native is not installed (e.g. JS
 * test environment) — they just render their children.
 */

import * as React from 'react';
import { tryRequire } from './runtime';

// Lazy-require react-native so JS-only test runners don't crash.
const RN: any = tryRequire('react-native');

export type PrivacyLevel = 'mask' | 'hide' | 'show';

interface PrivacyState {
  isCapturing: boolean;
  sensitiveRefs: Set<unknown>;
}

const state: PrivacyState = {
  isCapturing: false,
  sensitiveRefs: new Set(),
};

const listeners = new Set<(isCapturing: boolean) => void>();

/** @internal — capture path calls this around captureRef(). */
export function __setCapturing(value: boolean): void {
  if (state.isCapturing === value) return;
  state.isCapturing = value;
  for (const fn of listeners) {
    try { fn(value); } catch { /* listener must not break capture */ }
  }
}

/** @internal — for tests. */
export function __resetPrivacyStateForTest(): void {
  state.isCapturing = false;
  state.sensitiveRefs.clear();
  listeners.clear();
}

/** Whether a capture is currently in progress. */
export function isCapturingScreenshot(): boolean {
  return state.isCapturing;
}

/** How many sensitive refs are registered (used by capture metadata). */
export function sensitiveRefCount(): number {
  return state.sensitiveRefs.size;
}

/** Register a sensitive ref. Returns an unregister function. */
export function registerSensitiveRef(ref: unknown): () => void {
  state.sensitiveRefs.add(ref);
  return () => { state.sensitiveRefs.delete(ref); };
}

function useIsCapturing(): boolean {
  const [val, setVal] = React.useState<boolean>(state.isCapturing);
  React.useEffect(() => {
    const fn = (v: boolean) => setVal(v);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return val;
}

/**
 * Hook returning the privacy state — host apps can build their own
 * masking UI on top of this.
 */
export function useAllStakPrivacy(): {
  isCapturing: boolean;
  registerSensitiveRef: typeof registerSensitiveRef;
} {
  const isCapturing = useIsCapturing();
  return { isCapturing, registerSensitiveRef };
}

// ── Component wrappers ──────────────────────────────────────────────

const View: any = RN?.View ?? (((props: any) => React.createElement('View', props)) as any);
const Text: any = RN?.Text ?? (((props: any) => React.createElement('Text', props)) as any);
const TextInput: any = RN?.TextInput ?? (((props: any) => React.createElement('TextInput', props)) as any);

const DEFAULT_MASK_COLOR = '#d8dde7';
const DEFAULT_MASK_LABEL = '••••••';

export interface AllStakMaskedViewProps {
  children?: React.ReactNode;
  maskLabel?: string;
  maskColor?: string;
  hideScreenshot?: boolean;
  privacy?: PrivacyLevel;
  style?: any;
  // Allow any other RN view prop to pass through.
  [key: string]: unknown;
}

/**
 * Masks its children during a screenshot capture. While the SDK is
 * capturing, this component renders a solid placeholder instead of its
 * children; the rest of the time it's a transparent passthrough.
 */
export function AllStakMaskedView({
  children,
  maskLabel = DEFAULT_MASK_LABEL,
  maskColor = DEFAULT_MASK_COLOR,
  hideScreenshot = false,
  privacy = 'mask',
  style,
  ...rest
}: AllStakMaskedViewProps): React.ReactElement {
  const isCapturing = useIsCapturing();
  // 'show' always passes through; 'hide' renders nothing during capture;
  // 'mask' (default) renders the placeholder during capture.
  if (!isCapturing || privacy === 'show') {
    return React.createElement(View, { style, ...rest }, children);
  }
  if (privacy === 'hide' || hideScreenshot) {
    return React.createElement(View, { style: [{ backgroundColor: maskColor }, style], ...rest });
  }
  return React.createElement(
    View,
    { style: [{ backgroundColor: maskColor, alignItems: 'center', justifyContent: 'center' }, style], ...rest },
    React.createElement(Text, { style: { color: '#3f4652', fontSize: 12 } }, maskLabel),
  );
}

/**
 * Stricter variant — defaults to hiding the contents from screenshots
 * entirely. Use for credit-card fields, IBANs, passwords, etc.
 */
export function AllStakPrivacyView(props: AllStakMaskedViewProps): React.ReactElement {
  return React.createElement(AllStakMaskedView, { hideScreenshot: true, ...props });
}

export interface AllStakTextInputProps {
  privacy?: PrivacyLevel;
  style?: any;
  maskColor?: string;
  [key: string]: unknown;
}

/**
 * `TextInput` wrapper that swaps to a solid masked box during capture.
 * Always treated as sensitive unless `privacy="show"`.
 */
export function AllStakTextInput({
  privacy = 'mask',
  style,
  maskColor = DEFAULT_MASK_COLOR,
  ...rest
}: AllStakTextInputProps): React.ReactElement {
  const isCapturing = useIsCapturing();
  if (isCapturing && privacy !== 'show') {
    return React.createElement(View, {
      style: [{ minHeight: 40, backgroundColor: maskColor, borderRadius: 4 }, style],
    });
  }
  return React.createElement(TextInput, { style, ...rest });
}

export interface AllStakSensitiveTextProps {
  children?: React.ReactNode;
  privacy?: PrivacyLevel;
  style?: any;
  maskLabel?: string;
  [key: string]: unknown;
}

/**
 * Wraps a Text element so it renders the mask label during capture
 * instead of its actual children. Default privacy is `'mask'`.
 */
export function AllStakSensitiveText({
  children,
  privacy = 'mask',
  style,
  maskLabel = DEFAULT_MASK_LABEL,
  ...rest
}: AllStakSensitiveTextProps): React.ReactElement {
  const isCapturing = useIsCapturing();
  if (isCapturing && privacy !== 'show') {
    return React.createElement(Text, { style, ...rest }, maskLabel);
  }
  return React.createElement(Text, { style, ...rest }, children);
}
