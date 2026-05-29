/**
 * Value-pattern PII scrubbing for free-text telemetry values.
 *
 * Companion to the key-name redaction in `http-redact.ts`
 * (`password`/`token`/`cookie`/…). Key-name redaction catches structured
 * fields; this module catches PII that leaks into *free-text values*
 * (an exception message, a log line, breadcrumb text, etc).
 *
 * Layering (Sentry data-scrubbing parity):
 *
 *   A) ALWAYS scrub — regardless of `sendDefaultPii`. High-risk
 *      financial / identity data that is never legitimately wanted in
 *      telemetry:
 *        - Credit-card numbers: 13–19 digit runs (spaces / hyphens allowed
 *          as separators) that PASS the Luhn checksum. Runs that FAIL Luhn
 *          are left intact (so order ids / timestamps / long counters are
 *          not nuked).
 *        - US SSN: `\d{3}-\d{2}-\d{4}` — the hyphens are REQUIRED. Bare
 *          nine-digit numbers are deliberately NOT matched.
 *
 *   B) Scrub UNLESS `sendDefaultPii === true` (default false = Sentry
 *      parity). When the host opts into PII these are left intact:
 *        - Email addresses.
 *        - IPv4 addresses (octets validated 0–255).
 *
 *   C) Caller-supplied `scrubPatterns` are ALWAYS applied (the host asked
 *      for them explicitly).
 *
 * Hard rules:
 *   - Fail-open. A scrubber must NEVER throw on the wire path; on any
 *     error the original (key-redacted) value is returned unchanged.
 *   - Performance. Regexes are compiled once at module load. Strings
 *     longer than {@link MAX_SCAN_LENGTH} are skipped (returned as-is).
 *     Recursion is depth-capped via {@link MAX_DEPTH}.
 *   - Conservative. Over-redaction that corrupts legitimate data is a
 *     real failure mode; the CC matcher is Luhn-gated and SSN requires
 *     hyphens precisely to avoid that.
 */

import { REDACTED } from './http-redact';

/** Strings longer than this are not scanned (returned unchanged). */
export const MAX_SCAN_LENGTH = 16_384;

/** Maximum object/array nesting walked by {@link scrubValueTree}. */
export const MAX_DEPTH = 8;

export interface ValueScrubOptions {
  /**
   * When true the host has opted into PII: the (B) value scrubbers
   * (email + IPv4) are DISABLED. The (A) scrubbers (CC + SSN) always run.
   * Default false (Sentry parity).
   */
  sendDefaultPii?: boolean;
  /** Caller-supplied patterns, always applied. */
  scrubPatterns?: RegExp[];
}

// ── Compiled-once regexes ───────────────────────────────────────────

/**
 * Candidate credit-card run: 13–19 digits with optional single space /
 * hyphen separators between them. Bounded by non-digit / start / end so we
 * don't slice the middle of a longer digit run. Luhn-validated before
 * redaction — a candidate that fails Luhn is preserved.
 *
 * The leading/trailing assertions use a digit lookbehind/lookahead so a
 * 20+ digit blob is not partially matched as a 19-digit "card".
 */
const CC_CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

/** US SSN — hyphens REQUIRED. Bare 9-digit numbers are intentionally skipped. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Standard email. Conservative: a local part, `@`, a dotted domain. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** IPv4 with each octet validated 0–255. */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`\\b${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}\\b`, 'g');

/**
 * Luhn checksum over the digits of `s` (separators already stripped by the
 * caller). Returns true only for a valid checksum AND a 13–19 digit length,
 * matching real PAN lengths.
 */
function luhnValid(digits: string): boolean {
  const len = digits.length;
  if (len < 13 || len > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = len - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Scrub PII patterns from a single string. Fail-open: returns the input
 * unchanged on any error or when the string is too large to scan.
 */
export function scrubString(input: string, opts: ValueScrubOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (input.length > MAX_SCAN_LENGTH) return input;
  try {
    let out = input;

    // (A) ALWAYS — credit cards (Luhn-gated). Replace only the runs whose
    // digits pass Luhn; preserve everything else (order ids, timestamps).
    out = out.replace(CC_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      return luhnValid(digits) ? REDACTED : match;
    });

    // (A) ALWAYS — US SSN (hyphens required).
    out = out.replace(SSN, REDACTED);

    // (B) Unless the host opted into PII.
    if (opts.sendDefaultPii !== true) {
      out = out.replace(EMAIL, REDACTED);
      out = out.replace(IPV4, REDACTED);
    }

    // (C) Caller-supplied patterns — always applied.
    const patterns = opts.scrubPatterns;
    if (patterns && patterns.length > 0) {
      for (const re of patterns) {
        if (!(re instanceof RegExp)) continue;
        try {
          // Avoid mutating a shared lastIndex on a stateful /g regex.
          const safe = re.global ? new RegExp(re.source, re.flags) : re;
          out = out.replace(safe, REDACTED);
        } catch { /* skip a pathological pattern, keep going */ }
      }
    }

    return out;
  } catch {
    return input; // fail-open
  }
}

/**
 * Recursively scrub string values inside a plain object / array. Returns a
 * NEW value; never mutates the input. Non-string leaves pass through.
 * Depth-capped and fail-open: on any error the original node is returned.
 *
 * NOTE: callers decide WHICH bags to pass through here. This walker does
 * not know about allowlisted fields (stack frames, urls, sessionId, the
 * explicit user object) — those are excluded by the caller before walking.
 */
export function scrubValueTree<T>(value: T, opts: ValueScrubOptions = {}, depth = 0): T {
  try {
    if (typeof value === 'string') return scrubString(value, opts) as unknown as T;
    if (value == null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return value;

    if (Array.isArray(value)) {
      return value.map((item) => scrubValueTree(item, opts, depth + 1)) as unknown as T;
    }

    // Only walk plain objects — Dates, RegExps, Maps, typed arrays, etc.
    // pass through untouched.
    const tag = Object.prototype.toString.call(value);
    if (tag !== '[object Object]') return value;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValueTree(v, opts, depth + 1);
    }
    return out as unknown as T;
  } catch {
    return value; // fail-open
  }
}
