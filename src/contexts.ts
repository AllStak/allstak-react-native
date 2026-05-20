/**
 * Auto-collected AllStak context bags for React Native events.
 *
 * Lazily requires optional metadata packages and never throws when they
 * are absent. Output is intentionally product-owned so public payloads and
 * tags do not expose vendor-specific naming:
 *
 *   contexts.device     — model, manufacturer, family, arch, simulator, …
 *   contexts.os         — name, version, build
 *   contexts.app        — app_name, app_identifier, app_build, app_version, …
 *   contexts.react_native — react_native_version, expo, hermes, fabric, …
 *   contexts.runtime    — name, version (e.g. hermes 0.74.x)
 *
 * All collectors fail-open: a missing optional dep means the corresponding
 * context bag is shallow (only what we can read from globals + react-native
 * Platform) rather than failing the whole event.
 */

declare const require: (id: string) => any;
declare const __DEV__: boolean | undefined;

export interface AllStakContexts {
  device?: Record<string, unknown>;
  os?: Record<string, unknown>;
  app?: Record<string, unknown>;
  react_native?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  user?: Record<string, unknown>;
}

export interface AutoTags {
  [key: string]: string;
}

export interface CollectContextOptions {
  /** Include free/total memory + battery when collectors permit. Default true. */
  captureDeviceContext?: boolean;
  /** Include battery_level + charging. Default false (privacy). */
  captureBattery?: boolean;
  /** Include screen orientation + dimensions. Default true. */
  captureScreenContext?: boolean;
  /** Include user.email if config.user.email present. Default false. */
  sendDefaultPii?: boolean;
}

function tryReq<T = any>(id: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch { return null; }
}

function defaultExport<T = any>(mod: any): T | null {
  if (!mod) return null;
  return (mod.default ?? mod) as T;
}

function strOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > 0 ? s : undefined;
}

function trimString(v: unknown): string | undefined {
  const s = strOrUndef(v)?.trim();
  return s && s.length > 0 ? s : undefined;
}

export function buildAutoRelease(app: Record<string, unknown> | undefined): string | undefined {
  const version = trimString(app?.app_version);
  if (!version) return undefined;
  const id = trimString(app?.app_identifier) ?? trimString(app?.app_name) ?? 'mobile';
  const build = trimString(app?.app_build);
  return build ? `${id}@${version}+${build}` : `${id}@${version}`;
}

export function resolveAutoRelease(): string | undefined {
  const { contexts } = collectAutoContexts({
    captureDeviceContext: false,
    captureBattery: false,
    captureScreenContext: false,
  });
  return buildAutoRelease(contexts.app);
}

/**
 * Collect all context bags + a flat tag dictionary in one
 * pass. Safe to call once during init, then re-used by every event via
 * client.config.contexts.
 *
 * Returns null for any context bag whose source data is entirely missing
 * (rather than emitting empty {}); the dashboard renderer can then hide
 * the panel cleanly.
 */
export function collectAutoContexts(opts: CollectContextOptions = {}): {
  contexts: AllStakContexts;
  tags: AutoTags;
} {
  const captureDev = opts.captureDeviceContext !== false;
  const captureScreen = opts.captureScreenContext !== false;

  const contexts: AllStakContexts = {};
  const tags: AutoTags = {};

  // ── react-native Platform ─────────────────────────────────────
  const RN = tryReq('react-native');
  const Platform = RN?.Platform;
  const Dimensions = RN?.Dimensions;
  const NativeModules = RN?.NativeModules;

  const osName = strOrUndef(Platform?.OS); // 'ios' | 'android'
  const osVersion = strOrUndef(Platform?.Version);
  const osConstants: any = Platform?.constants ?? {};

  if (osName) {
    contexts.os = {
      name: osName === 'ios' ? 'iOS' : osName === 'android' ? 'Android' : osName,
      version: osVersion,
      build: strOrUndef(osConstants?.osBuildId ?? osConstants?.Release),
    };
    tags.os = osName;
    if (osVersion) tags.os_version = osVersion;
  }

  // ── Architecture / engine ──────────────────────────────────────
  const g: any = globalThis as any;
  const hermes = typeof g.HermesInternal !== 'undefined';
  const fabric = typeof g.__turboModuleProxy !== 'undefined';
  const turboModules = fabric; // these usually go together
  const bridgeless = typeof g.RN$Bridgeless !== 'undefined' && !!g.RN$Bridgeless;
  const jsEngine = hermes ? 'hermes' : 'jsc';

  tags['js_engine'] = jsEngine;
  tags['fabric'] = String(fabric);
  tags['turbo_modules'] = String(turboModules);

  // ── runtime context ────────────────────────────────────────────
  const hermesVersion = (() => {
    try { return g.HermesInternal?.getRuntimeProperties?.()?.['OSS Release Version']; }
    catch { return undefined; }
  })();
  contexts.runtime = {
    name: jsEngine,
    version: strOrUndef(hermesVersion) ?? 'unknown',
    bridgeless,
  };

  // ── device context ─────────────────────────────────────────────
  if (captureDev) {
    const device: Record<string, unknown> = {};

    // Platform.constants on iOS exposes systemName, interfaceIdiom; on
    // Android exposes Model/Brand/Manufacturer/Release/Fingerprint.
    if (osConstants?.Model) device.model = String(osConstants.Model);
    if (osConstants?.Brand) device.brand = String(osConstants.Brand);
    if (osConstants?.Manufacturer) device.manufacturer = String(osConstants.Manufacturer);
    if (osConstants?.systemName) device.systemName = String(osConstants.systemName);
    if (osConstants?.interfaceIdiom) device.family = String(osConstants.interfaceIdiom);

    // Simulator/emulator heuristic
    const isSim = Boolean(osConstants?.isTesting) ||
                  (typeof osConstants?.reactNativeVersion === 'object' &&
                   String(osConstants?.systemName ?? '').toLowerCase().includes('simulator'));
    if (isSim) {
      device.simulator = true;
      tags.device_simulator = 'true';
    }

    // expo-device — preferred source on Expo
    const expoDevice = tryReq('expo-device');
    if (expoDevice) {
      const ed = defaultExport(expoDevice) ?? expoDevice;
      if (ed.modelName) device.model = String(ed.modelName);
      if (ed.brand) device.brand = String(ed.brand);
      if (ed.manufacturer) device.manufacturer = String(ed.manufacturer);
      if (ed.deviceYearClass != null) device.yearClass = ed.deviceYearClass;
      if (ed.totalMemory != null) device.memory_size = ed.totalMemory;
      if (typeof ed.supportedCpuArchitectures !== 'undefined') {
        const arr = ed.supportedCpuArchitectures;
        if (Array.isArray(arr) && arr.length > 0) device.arch = String(arr[0]);
      }
      if (typeof ed.isDevice === 'boolean' && !ed.isDevice) {
        device.simulator = true;
        tags.device_simulator = 'true';
      }
    } else {
      // react-native-device-info — used on bare RN CLI
      const dinfo = tryReq('react-native-device-info');
      if (dinfo) {
        const d = defaultExport(dinfo) ?? dinfo;
        try { device.model = device.model ?? d.getModel?.(); } catch { /* ignore */ }
        try { device.manufacturer = device.manufacturer ?? d.getManufacturerSync?.(); } catch { /* ignore */ }
        try { device.memory_size = device.memory_size ?? d.getTotalMemorySync?.(); } catch { /* ignore */ }
        try { const isEm = d.isEmulatorSync?.(); if (isEm) { device.simulator = true; tags.device_simulator = 'true'; } }
        catch { /* ignore */ }
      }
    }

    // Screen + orientation
    if (captureScreen && Dimensions && typeof Dimensions.get === 'function') {
      try {
        const screen = Dimensions.get('screen');
        if (screen?.width && screen?.height) {
          device.screen_width_pixels = Math.round(screen.width * (screen.scale ?? 1));
          device.screen_height_pixels = Math.round(screen.height * (screen.scale ?? 1));
          device.screen_density = screen.scale;
          device.orientation = screen.width >= screen.height ? 'landscape' : 'portrait';
          tags.device_orientation = device.orientation as string;
        }
      } catch { /* ignore */ }
    }

    // Battery (opt-in)
    if (opts.captureBattery) {
      const expoBattery = tryReq('expo-battery');
      if (expoBattery) {
        try {
          const eb = defaultExport(expoBattery) ?? expoBattery;
          // These are async on Expo Battery — best we can do here is
          // signal the dep is present; actual values land via setContext
          // callbacks the host can wire if they want live readings.
          device.battery_available = true;
          // Try the sync getter on older versions
          if (typeof eb.getBatteryLevelAsync === 'function') {
            // Promise — store nothing now; caller can refresh via setContext
          }
        } catch { /* ignore */ }
      }
    }

    if (Object.keys(device).length > 0) {
      contexts.device = device;
      if (device.model) tags.device_model = String(device.model);
    }
  }

  // ── app context ────────────────────────────────────────────────
  const app: Record<string, unknown> = {};
  app.app_start_time = new Date().toISOString();

  const expoApp = tryReq('expo-application');
  if (expoApp) {
    const ea = defaultExport(expoApp) ?? expoApp;
    if (ea.applicationName) app.app_name = String(ea.applicationName);
    if (ea.applicationId) app.app_identifier = String(ea.applicationId);
    if (ea.nativeBuildVersion) app.app_build = String(ea.nativeBuildVersion);
    if (ea.nativeApplicationVersion) app.app_version = String(ea.nativeApplicationVersion);
  } else {
    const dinfo = tryReq('react-native-device-info');
    if (dinfo) {
      const d = defaultExport(dinfo) ?? dinfo;
      try { app.app_name = d.getApplicationName?.(); } catch { /* ignore */ }
      try { app.app_identifier = d.getBundleId?.(); } catch { /* ignore */ }
      try { app.app_build = d.getBuildNumber?.(); } catch { /* ignore */ }
      try { app.app_version = d.getVersion?.(); } catch { /* ignore */ }
    }
  }

  const expoConstants = tryReq('expo-constants');
  if (expoConstants) {
    const ec = defaultExport(expoConstants) ?? expoConstants;
    const extra = ec.expoConfig?.extra ?? ec.manifest?.extra ?? {};
    const allstak = extra?._allstak ?? {};
    if (!app.app_name && ec.expoConfig?.name) app.app_name = String(ec.expoConfig.name);
    if (!app.app_identifier && (ec.expoConfig?.ios?.bundleIdentifier || ec.expoConfig?.android?.package)) {
      app.app_identifier = String(ec.expoConfig.ios?.bundleIdentifier ?? ec.expoConfig.android?.package);
    }
    if (!app.app_version && (ec.expoConfig?.version || allstak.version)) {
      app.app_version = String(ec.expoConfig.version ?? allstak.version);
    }
    if (!app.app_build && (ec.expoConfig?.ios?.buildNumber || ec.expoConfig?.android?.versionCode || allstak.build)) {
      app.app_build = String(ec.expoConfig.ios?.buildNumber ?? ec.expoConfig.android?.versionCode ?? allstak.build);
    }
  }

  if (Object.keys(app).length > 0) {
    contexts.app = app;
    if (app.app_version) tags.app_version = String(app.app_version);
    if (app.app_build) tags.app_build = String(app.app_build);
  }

  // ── react_native context ───────────────────────────────────────
  const rn: Record<string, unknown> = {
    hermes,
    fabric,
    turbo_modules: turboModules,
    bridgeless,
    js_engine: jsEngine,
  };

  // react-native version: try osConstants.reactNativeVersion = {major, minor, patch}
  if (osConstants?.reactNativeVersion) {
    const v = osConstants.reactNativeVersion;
    if (typeof v === 'object' && v.major != null) {
      rn.react_native_version = `${v.major}.${v.minor ?? 0}.${v.patch ?? 0}`;
    } else if (typeof v === 'string') {
      rn.react_native_version = v;
    }
  }

  // Expo SDK version
  if (expoConstants) {
    const ec = defaultExport(expoConstants) ?? expoConstants;
    if (ec.expoVersion) rn.expo = ec.expoVersion;
    else if (ec.expoConfig?.sdkVersion) rn.expo = ec.expoConfig.sdkVersion;
    if (ec.appOwnership) rn.expo_application_ownership = String(ec.appOwnership);
    if (ec.executionEnvironment) rn.expo_execution_environment = String(ec.executionEnvironment);
  } else {
    // expo plugin not present — mark explicitly
    rn.expo = false;
  }

  contexts.react_native = rn;
  if (rn.expo && rn.expo !== false) tags['expo'] = 'true';
  if (rn.react_native_version) tags.react_native_version = String(rn.react_native_version);

  return { contexts, tags };
}

/**
 * Convert a user object to a `contexts.user` bag,
 * respecting `sendDefaultPii`.
 */
export function buildUserContext(
  user: { id?: string; email?: string; username?: string; ip_address?: string } | undefined,
  opts: { sendDefaultPii?: boolean } = {},
): Record<string, unknown> | undefined {
  if (!user) return undefined;
  const out: Record<string, unknown> = {};
  if (user.id) out.id = user.id;
  if (user.username) out.username = user.username;
  if (opts.sendDefaultPii) {
    if (user.email) out.email = user.email;
    if (user.ip_address) out.ip_address = user.ip_address;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
