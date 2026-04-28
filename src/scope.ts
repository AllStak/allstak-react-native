/**
 * Per-call scoped context isolation.
 *
 * A `Scope` carries the same shape as the top-level config (user, tags,
 * extras, contexts, fingerprint, level) but only applies inside the
 * `withScope` callback that owns it. The client merges the active scope
 * stack on top of the base config when building each event payload, so:
 *
 *   - context set inside `withScope` does NOT leak out
 *   - nested scopes layer additively (later wins on key conflicts)
 *   - throwing or async work in the callback still pops the scope
 *
 * Use this on the server (SSR / RSC / API route handlers) to attach
 * per-request user/tags without leaking that data into another request
 * being processed concurrently.
 */

export type Severity = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export class Scope {
  user?: { id?: string; email?: string };
  tags: Record<string, string> = {};
  extras: Record<string, unknown> = {};
  contexts: Record<string, Record<string, unknown>> = {};
  fingerprint?: string[];
  level?: Severity;

  setUser(user: { id?: string; email?: string }): this { this.user = user; return this; }
  setTag(key: string, value: string): this { this.tags[key] = value; return this; }
  setTags(tags: Record<string, string>): this { Object.assign(this.tags, tags); return this; }
  setExtra(key: string, value: unknown): this { this.extras[key] = value; return this; }
  setExtras(extras: Record<string, unknown>): this { Object.assign(this.extras, extras); return this; }
  setContext(name: string, ctx: Record<string, unknown> | null): this {
    if (ctx === null) delete this.contexts[name]; else this.contexts[name] = ctx;
    return this;
  }
  setLevel(level: Severity): this { this.level = level; return this; }
  setFingerprint(fingerprint: string[] | null): this {
    this.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : undefined;
    return this;
  }
  clear(): this {
    this.user = undefined;
    this.tags = {};
    this.extras = {};
    this.contexts = {};
    this.fingerprint = undefined;
    this.level = undefined;
    return this;
  }
}

/**
 * Merge a base config with the active scope stack. Later scopes overwrite
 * earlier ones on key conflicts; tag/extra/context dictionaries are merged
 * key-by-key. Returns a NEW object — does not mutate inputs.
 */
export function mergeScopes<T extends {
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
  fingerprint?: string[];
  level?: Severity;
}>(base: T, stack: Scope[]): T {
  const out: T = { ...base };
  out.tags = { ...(base.tags ?? {}) };
  out.extras = { ...(base.extras ?? {}) };
  out.contexts = { ...(base.contexts ?? {}) };
  for (const scope of stack) {
    if (scope.user) out.user = scope.user;
    Object.assign(out.tags, scope.tags);
    Object.assign(out.extras, scope.extras);
    Object.assign(out.contexts, scope.contexts);
    if (scope.fingerprint) out.fingerprint = scope.fingerprint;
    if (scope.level) out.level = scope.level;
  }
  return out;
}
