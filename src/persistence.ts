/**
 * Offline / persistent event queue for the React Native SDK.
 *
 * Goal: buffered telemetry should survive a process/app restart AND a network
 * outage. When an event cannot be delivered (network error, retries exhausted,
 * offline, or the app shutting down with events still buffered) the SDK writes
 * the (already PII-scrubbed) payload to a persistent store instead of dropping
 * it, then replays it on the next init. This is an offline store /
 * envelope cache, adapted to RN.
 *
 * RN ships no bundled native filesystem, so persistence is a PLUGGABLE adapter
 * (a tiny async key/value `Storage` interface, the same shape as
 * `AsyncStorage`). The default adapter detects a global `AsyncStorage` if the
 * host app installed `@react-native-async-storage/async-storage` and otherwise
 * degrades to an in-memory map — never adding a heavy native dependency here.
 * (This SDK is browser-API-free by design — no `localStorage`/`document`/
 * `window` references — so the only auto-detected adapter is AsyncStorage.)
 *
 * Hard invariants (must never regress):
 *   - Fail-open everywhere: a broken / read-only / sandboxed store must never
 *     throw, never block init, and never block capture. On any failure the
 *     transport silently keeps its existing in-memory ring-buffer behavior.
 *   - Only already-scrubbed payloads reach this layer (the transport is the
 *     last hop after the SDK's PII pipeline), so nothing unredacted is written.
 *   - Bounded: capped by count AND bytes AND max age; when full the OLDEST
 *     entries are dropped first. The store can never grow unbounded.
 *   - Session lifecycle calls (/sessions/start, /sessions/end) are excluded by
 *     the caller — a replayed stale session would skew release-health durations.
 */

/**
 * Minimal async key/value store. Compatible with the `AsyncStorage` API (and
 * with any sync key/value store — sync methods are awaited fine). Only these
 * three methods are used; anything matching this shape works.
 */
export interface PersistenceStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** A single persisted telemetry entry. */
export interface PersistedEntry {
  /** Unique id for de-dup / removal after delivery. */
  id: string;
  /** Ingest path the payload was destined for (never a /sessions/* path). */
  path: string;
  /** Already-PII-scrubbed payload, exactly as it would have been POSTed. */
  payload: unknown;
  /** Epoch ms when the entry was persisted (used for max-age eviction). */
  ts: number;
}

export interface PersistenceOptions {
  /** Master switch. When false the store is a no-op. Default true. */
  enabled?: boolean;
  /** Explicit storage adapter. When omitted a default is auto-detected. */
  storage?: PersistenceStorage;
  /** Storage key (namespace). Default `allstak:offline-queue`. */
  storageKey?: string;
  /** Max number of entries kept. Default 50. Oldest dropped when exceeded. */
  maxEntries?: number;
  /** Max total serialized bytes. Default ~2 MB. Oldest dropped when exceeded. */
  maxBytes?: number;
  /** Max entry age in ms. Default 48h. Older entries are evicted on load/save. */
  maxAgeMs?: number;
}

const DEFAULT_KEY = 'allstak:offline-queue';
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // ~2 MB
const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Process-global persistence override, installed via {@link setPersistence}.
 * Lets a host app provide its own AsyncStorage instance (or any compatible
 * store) without re-initializing the SDK. Read lazily when a transport builds
 * its store so the call order (setPersistence before/after init) doesn't matter.
 */
let globalStorageOverride: PersistenceStorage | null = null;

/**
 * Install a process-wide persistence adapter for the offline event queue.
 *
 * Idiomatic on RN, where no filesystem is bundled:
 *
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   import { setPersistence } from '@allstak/react-native';
 *   setPersistence(AsyncStorage);
 *
 * Pass `null` to clear the override (the SDK falls back to a global
 * AsyncStorage if present, then in-memory). Fully optional — the SDK works
 * without it.
 */
export function setPersistence(storage: PersistenceStorage | null): void {
  globalStorageOverride = storage && isStorageLike(storage) ? storage : null;
}

/** @internal — test seam. */
export function __getPersistenceOverrideForTest(): PersistenceStorage | null {
  return globalStorageOverride;
}

function isStorageLike(value: unknown): value is PersistenceStorage {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.getItem === 'function' &&
    typeof s.setItem === 'function' &&
    typeof s.removeItem === 'function'
  );
}

/**
 * In-memory fallback store. Used when nothing else is available so the rest of
 * the pipeline is identical regardless of platform; it just won't survive a
 * process restart (no worse than the prior in-memory-only behavior).
 */
class MemoryStorage implements PersistenceStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * Detect a usable persistence adapter without adding a dependency:
 *   1. explicit override from {@link setPersistence}
 *   2. a global `AsyncStorage` (some RN apps expose it globally)
 *   3. in-memory fallback
 *
 * This SDK is intentionally browser-API-free, so no `localStorage`/`window`
 * is ever touched. Never throws — any detection error falls through to memory.
 */
export function detectDefaultStorage(): PersistenceStorage {
  if (globalStorageOverride) return globalStorageOverride;
  try {
    const g: any = typeof globalThis !== 'undefined' ? globalThis : undefined;
    if (g && isStorageLike(g.AsyncStorage)) return g.AsyncStorage as PersistenceStorage;
  } catch {
    /* fall through to memory */
  }
  return new MemoryStorage();
}

function safeByteLength(value: string): number {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  } catch {
    /* ignore */
  }
  return value.length;
}

let entrySeq = 0;
function nextEntryId(): string {
  entrySeq = (entrySeq + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${entrySeq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Bounded, persistent FIFO store for already-scrubbed telemetry payloads.
 *
 * Persistence model: a single JSON-array value under one key. This is the most
 * portable shape across AsyncStorage / localStorage / a custom adapter and
 * keeps the implementation dependency-free. Reads/writes are debounced behind a
 * single in-flight serialize promise so concurrent appends can't interleave a
 * torn write. Every public method is fail-open: on any error the store behaves
 * as empty / no-op and the caller keeps its in-memory behavior.
 */
export class PersistentEventStore {
  private readonly enabled: boolean;
  private readonly storage: PersistenceStorage;
  private readonly key: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  /** Serialize all mutations so concurrent writes don't clobber each other. */
  private writeChain: Promise<void> = Promise.resolve();
  private degraded = false;

  constructor(options: PersistenceOptions = {}) {
    this.enabled = options.enabled !== false;
    this.storage = options.storage ?? detectDefaultStorage();
    this.key = options.storageKey ?? DEFAULT_KEY;
    this.maxEntries = positiveOr(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = positiveOr(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxAgeMs = positiveOr(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
  }

  isEnabled(): boolean {
    return this.enabled && !this.degraded;
  }

  /**
   * Append one already-scrubbed entry, applying age + count + byte caps with
   * oldest-first eviction. Fail-open: a write error degrades the store to a
   * silent no-op for the rest of the process. Resolves with the new entry id
   * (or null when disabled/degraded) once the write settles, so the caller can
   * remove it after an eventual successful in-memory delivery.
   */
  async persist(path: string, payload: unknown): Promise<string | null> {
    if (!this.isEnabled()) return null;
    const id = nextEntryId();
    await this.enqueue(async (entries) => {
      entries.push({ id, path, payload, ts: Date.now() });
      return this.applyCaps(entries);
    });
    return this.degraded ? null : id;
  }

  /**
   * Load all persisted entries (oldest first), pruning expired ones. Returns an
   * empty list on any error. Does NOT remove entries — the caller removes each
   * via {@link remove} only after the entry is accepted or permanently dead.
   */
  async load(): Promise<PersistedEntry[]> {
    if (!this.isEnabled()) return [];
    try {
      const entries = await this.read();
      const live = this.pruneExpired(entries);
      if (live.length !== entries.length) {
        // Persist the pruned set so expired entries don't linger on disk.
        await this.write(live);
      }
      return live;
    } catch {
      this.degraded = true;
      return [];
    }
  }

  /** Remove one entry by id after it was accepted (2xx) or is permanently dead. */
  async remove(id: string): Promise<void> {
    if (!this.isEnabled()) return;
    return this.enqueue(async (entries) => entries.filter((e) => e.id !== id));
  }

  /** Remove several entries by id in one write. */
  async removeMany(ids: string[]): Promise<void> {
    if (!this.isEnabled() || ids.length === 0) return;
    const dead = new Set(ids);
    return this.enqueue(async (entries) => entries.filter((e) => !dead.has(e.id)));
  }

  /** Drop everything. Best-effort. */
  async clear(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await this.storage.removeItem(this.key);
    } catch {
      this.degraded = true;
    }
  }

  /** Current entry count (best-effort; 0 on error). */
  async size(): Promise<number> {
    if (!this.isEnabled()) return 0;
    try {
      return (await this.read()).length;
    } catch {
      return 0;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Run a mutation against the current entries under the serialize chain so two
   * concurrent persists can't read-modify-write over each other.
   */
  private enqueue(mutate: (entries: PersistedEntry[]) => Promise<PersistedEntry[]>): Promise<void> {
    const run = this.writeChain.then(async () => {
      try {
        const current = await this.read();
        const next = await mutate(current);
        await this.write(next);
      } catch {
        this.degraded = true;
      }
    });
    // Keep the chain unbroken even if a step rejects.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<PersistedEntry[]> {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Tolerate partially-malformed entries — keep only well-formed ones.
      return parsed.filter(
        (e): e is PersistedEntry =>
          !!e && typeof e.id === 'string' && typeof e.path === 'string' && typeof e.ts === 'number',
      );
    } catch {
      return [];
    }
  }

  private async write(entries: PersistedEntry[]): Promise<void> {
    if (entries.length === 0) {
      await this.storage.removeItem(this.key);
      return;
    }
    await this.storage.setItem(this.key, JSON.stringify(entries));
  }

  private pruneExpired(entries: PersistedEntry[]): PersistedEntry[] {
    const cutoff = Date.now() - this.maxAgeMs;
    return entries.filter((e) => e.ts >= cutoff);
  }

  /** Apply age → count → byte caps, dropping OLDEST entries first. */
  private applyCaps(entries: PersistedEntry[]): PersistedEntry[] {
    let live = this.pruneExpired(entries);
    if (live.length > this.maxEntries) {
      live = live.slice(live.length - this.maxEntries);
    }
    // Byte cap: drop oldest until the serialized array fits (always keep >=1).
    while (live.length > 1 && safeByteLength(JSON.stringify(live)) > this.maxBytes) {
      live.shift();
    }
    return live;
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
