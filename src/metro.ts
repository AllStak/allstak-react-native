import { randomUUID } from 'node:crypto';

type MetroConfig = Record<string, any>;
type Bundle = {
  modules?: Array<[number, string]>;
  pre?: string;
  post?: string;
  [key: string]: any;
};

const DEBUG_ID_RE = /\/\/# debugId=[0-9a-f-]{36}\s*$/m;

export interface AllStakMetroOptions {
  annotateReactComponents?: boolean;
  stripUnusedFeatures?: boolean;
}

export function withAllStakConfig<T extends MetroConfig>(config: T, _options: AllStakMetroOptions = {}): T {
  const next: MetroConfig = { ...config };
  const serializer = { ...(config.serializer ?? {}) };
  const originalSerializer = serializer.customSerializer;

  serializer.customSerializer = async (...args: any[]) => {
    const options = args[3] ?? {};
    options.allstakBundleCallback = addDebugIdToBundle;

    if (typeof originalSerializer === 'function') {
      return originalSerializer(args[0], args[1], args[2], options);
    }

    const bundle: Bundle = {
      modules: args[1],
      pre: '',
      post: '',
    };
    const withDebugId = addDebugIdToBundle(bundle);
    return {
      code: [
        withDebugId.pre,
        ...(withDebugId.modules ?? []).map(([, code]) => code),
        withDebugId.post,
      ].filter(Boolean).join('\n'),
      map: [],
    };
  };

  next.serializer = serializer;
  return next as T;
}

export function getAllStakExpoConfig(projectRoot: string, options: AllStakMetroOptions = {}): MetroConfig {
  const expoMetro = require('expo/metro-config') as { getDefaultConfig?: (root: string) => MetroConfig };
  const config = expoMetro.getDefaultConfig?.(projectRoot) ?? {};
  return withAllStakConfig(config, options);
}

export function addDebugIdToBundle<T extends Bundle>(bundle: T): T {
  const next: Bundle = { ...bundle };
  const debugId = findDebugId(next) ?? randomUUID();
  const line = `//# debugId=${debugId}`;

  next.post = `${String(next.post ?? '').replace(DEBUG_ID_RE, '').trimEnd()}\n${line}\n`;
  next.modules = Array.isArray(next.modules)
    ? next.modules.map(([id, code]) => [id, String(code).replace(DEBUG_ID_RE, '').trimEnd()] as [number, string])
    : next.modules;

  return next as T;
}

function findDebugId(bundle: Bundle): string | null {
  const postMatch = String(bundle.post ?? '').match(/debugId=([0-9a-f-]{36})/);
  if (postMatch?.[1]) return postMatch[1];
  for (const [, code] of bundle.modules ?? []) {
    const match = String(code).match(/debugId=([0-9a-f-]{36})/);
    if (match?.[1]) return match[1];
  }
  return null;
}

declare const require: any;
