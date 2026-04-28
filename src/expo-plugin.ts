/**
 * Expo config plugin.
 *
 * Apply via `app.json`:
 *
 *   {
 *     "expo": {
 *       "plugins": [
 *         ["@allstak/react-native", { "release": "mobile@1.2.3", "environment": "production" }]
 *       ]
 *     }
 *   }
 *
 * The plugin runs at `expo prebuild` / EAS build time and:
 *
 *   1. Adds the AllStak iOS pod (declared in `react-native.config.js`).
 *      Expo's autolinking already picks this up — we just record metadata
 *      so `expo doctor` can verify the install is wired.
 *   2. Stamps the chosen `release` into `expo-constants` extras so the JS
 *      layer can read it at runtime via `Constants.expoConfig.extra._allstak`
 *      without the host app needing to plumb it through env vars.
 *   3. Records that `@allstak/react-native` was loaded as an Expo plugin
 *      for diagnostics.
 *
 * Pure config mutation — no native code is patched here. The native iOS
 * + Android modules under ./native are linked by Expo's existing
 * autolinking flow (which honors the `react-native.config.js` manifest).
 */

export interface AllStakExpoOptions {
  /** Release identifier (e.g. `mobile@1.2.3`). Stamped into `Constants.expoConfig.extra._allstak.release`. */
  release?: string;
  /** Environment label — `production`, `staging`, etc. */
  environment?: string;
  /** Optional dist tag (e.g. `ios-hermes`). Auto-detected at runtime if unset. */
  dist?: string;
}

interface ExpoConfig {
  name?: string;
  extra?: Record<string, unknown>;
  plugins?: any[];
  [key: string]: any;
}

interface ExpoConfigContext {
  modResults?: any;
  modRawConfig?: ExpoConfig;
  [key: string]: any;
}

/**
 * The plugin function itself. Expo's plugin runner calls it as
 * `(config, options) => modifiedConfig`. We avoid importing
 * `@expo/config-plugins` so the package has zero hard dependencies on the
 * Expo toolchain — the type checking happens at usage site instead.
 */
function withAllStak(config: ExpoConfig & ExpoConfigContext, options: AllStakExpoOptions = {}): ExpoConfig {
  const next: ExpoConfig = { ...config };
  next.extra = { ...(config.extra ?? {}) };

  // Embed runtime-readable metadata under a namespaced key so we never
  // collide with the host app's other extras.
  const existing = (next.extra as any)._allstak ?? {};
  (next.extra as any)._allstak = {
    ...existing,
    release: options.release ?? existing.release,
    environment: options.environment ?? existing.environment,
    dist: options.dist ?? existing.dist,
    pluginVersion: '0.2.0',
  };

  return next;
}

export default withAllStak;

// Expose as a CommonJS function so `app.plugin.js`'s `require('./dist/expo-plugin.js')`
// returns the plugin directly. The `declare const module` keeps the TS
// type-checker happy without dragging in @types/node.
declare const module: { exports: any };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = withAllStak;
  module.exports.default = withAllStak;
}
