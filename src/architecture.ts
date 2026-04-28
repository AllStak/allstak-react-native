/**
 * React Native architecture / runtime detection.
 *
 * **Status:** the JS-level check is implemented and tested. The native
 * AllStak modules (Java + Obj-C) are written in legacy module style and
 * are known to interoperate with the New Architecture (Fabric +
 * TurboModules) via the RN interop layer. End-to-end integration on a
 * real Fabric build has not yet been verified — see README §"New
 * Architecture support" for current status.
 *
 * The two booleans returned here are read off well-known global flags
 * that RN exposes to JS:
 *
 *   - `globalThis.__turboModuleProxy` — present when TurboModules is
 *     enabled (New Architecture).
 *   - `globalThis.RN$Bridgeless` — present when bridgeless mode is on.
 *
 * If the host app surfaces this through `AllStak.setTag('rn.newArch', '1')`
 * we can correlate New-Arch crashes specifically and prioritize a fix.
 */

export interface ArchitectureInfo {
  /** True when TurboModules / New Architecture is detected at runtime. */
  newArchitecture: boolean;
  /** True when bridgeless mode is detected. */
  bridgeless: boolean;
  /** True when the JS engine is Hermes. */
  hermes: boolean;
  /** Free-form tag suitable for `AllStak.setTag('rn.architecture', ...)`. */
  tag: 'new-arch' | 'old-arch' | 'unknown';
}

export function detectArchitecture(): ArchitectureInfo {
  const g = globalThis as any;
  const newArchitecture = typeof g.__turboModuleProxy !== 'undefined';
  const bridgeless = typeof g.RN$Bridgeless !== 'undefined' && !!g.RN$Bridgeless;
  const hermes = typeof g.HermesInternal !== 'undefined';

  let tag: ArchitectureInfo['tag'] = 'unknown';
  // Heuristic: if `__turboModuleProxy` is defined we're on New Arch.
  // Without it we conservatively return 'unknown' rather than guessing,
  // since some legacy debug builds also lack it.
  if (newArchitecture) tag = 'new-arch';
  else if (typeof g.nativeFlushQueueImmediate === 'function') tag = 'old-arch';

  return { newArchitecture, bridgeless, hermes, tag };
}

/**
 * Convenience: stamp `rn.architecture`, `rn.bridgeless`, and `rn.hermes`
 * tags on the active AllStak singleton based on detection. Safe to call
 * any time after `AllStak.init()` and before the first capture.
 */
export function applyArchitectureTags(setTag: (key: string, value: string) => void): ArchitectureInfo {
  const info = detectArchitecture();
  try {
    setTag('rn.architecture', info.tag);
    setTag('rn.bridgeless', String(info.bridgeless));
    setTag('rn.hermes', String(info.hermes));
  } catch { /* never break host */ }
  return info;
}
