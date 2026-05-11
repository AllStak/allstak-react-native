/**
 * Runtime debug-ID resolver for React Native.
 *
 * The build-time source map injector (`build/sourcemaps.ts`) appends
 * `//# debugId=<uuid>` to every JS bundle and writes the same UUID
 * into the matching `.map` file. At runtime, the symbolicator needs
 * that UUID per stack frame to pick the right source map.
 *
 * In React Native the primary lookup path is the global registry:
 *   `globalThis._allstakDebugIds`  —  a `{ [bundleUrl]: uuid }` map
 * populated by the injected code at bundle evaluation time.
 *
 * This is a best-effort resolver: it returns `undefined` when no
 * debug ID can be found. The symbolicator handles missing IDs
 * gracefully (falls back to release-based lookup).
 */

const REGISTRY_KEY = '_allstakDebugIds';

const cache = new Map<string, string | null>();

export function resolveDebugId(filename: string | undefined): string | undefined {
  if (!filename) return undefined;

  if (cache.has(filename)) return cache.get(filename) ?? undefined;

  // Global registry — set by the build-time injector. Indexed by the
  // bundle URL that the runtime loaded.
  const registry = (globalThis as { [REGISTRY_KEY]?: Record<string, string> })[REGISTRY_KEY];
  if (registry && typeof registry === 'object') {
    const hit = registry[filename];
    if (typeof hit === 'string' && hit.length > 0) {
      cache.set(filename, hit);
      return hit;
    }
  }

  cache.set(filename, null);
  return undefined;
}

/** Test-only: reset the per-process cache. */
export function _resetDebugIdCache(): void {
  cache.clear();
}
