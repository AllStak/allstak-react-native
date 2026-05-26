/**
 * iOS POSIX signal-crash record format tests.
 *
 * The async-signal-safe native handler (native/ios/AllStakSignalCrashHandler.m)
 * writes a fixed little-endian binary record at crash time and, on the NEXT
 * launch, parses it into the SAME JSON payload shape the NSException path
 * produces ({ exceptionClass, message, stackTrace[], metadata }). That JSON is
 * what `drainPendingCrash` returns and `drainPendingNativeCrashes` ships.
 *
 * The signal handler ITSELF (sigaction, backtrace, write into a crashing
 * process) is DEVICE-VERIFICATION-ONLY — a real SIGSEGV/SIGABRT on a device is
 * the only true end-to-end test. What IS deterministically testable, and is
 * tested here, is the record's wire format and its conversion to the drain
 * payload. This file re-implements the byte layout in JS so a divergence
 * between the documented format and the native encoder/decoder is caught.
 *
 * Layout (must match SignalCrashRecord / AllStakSignalCrashHandler.m):
 *   offset size field
 *   0      4    magic "ASK1"
 *   4      1    version = 1
 *   5      3    padding
 *   8      4    signal number (int32 LE)
 *   12     4    padding
 *   16     8    fault address (uint64 LE)
 *   24     8    timestamp seconds (int64 LE)
 *   32     4    frame count (uint32 LE)
 *   36     4    padding
 *   40     N*8  frame return addresses (uint64 LE each)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MAGIC = [0x41, 0x53, 0x4b, 0x31]; // "ASK1"
const VERSION = 1;
const HEADER_SIZE = 40;
const MAX_FRAMES = 128;

const SIGNALS = {
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGBUS: 10,
  SIGSEGV: 11,
};
const SIGNAL_NAME = Object.fromEntries(
  Object.entries(SIGNALS).map(([name, num]) => [num, name]),
);

/** Mirror of AllStakEncodeRecord: produce the on-disk bytes. */
function encodeRecord({ signal, faultAddress, timestamp, frames }) {
  const count = Math.min(frames.length, MAX_FRAMES);
  const buf = new Uint8Array(HEADER_SIZE + count * 8);
  const dv = new DataView(buf.buffer);
  buf[0] = MAGIC[0];
  buf[1] = MAGIC[1];
  buf[2] = MAGIC[2];
  buf[3] = MAGIC[3];
  buf[4] = VERSION;
  dv.setInt32(8, signal, true);
  dv.setBigUint64(16, BigInt(faultAddress), true);
  dv.setBigInt64(24, BigInt(timestamp), true);
  dv.setUint32(32, count, true);
  for (let i = 0; i < count; i++) {
    dv.setBigUint64(HEADER_SIZE + i * 8, BigInt(frames[i]), true);
  }
  return buf;
}

/** Mirror of AllStakSignalCrashHandler's normal-context parser. */
function parseRecord(buf) {
  if (buf.length < HEADER_SIZE) return null;
  if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] || buf[2] !== MAGIC[2] || buf[3] !== MAGIC[3]) {
    return null;
  }
  if (buf[4] !== VERSION) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const signal = dv.getInt32(8, true);
  const faultAddress = dv.getBigUint64(16, true);
  const timestamp = dv.getBigInt64(24, true);
  const declared = dv.getUint32(32, true);
  const available = Math.floor((buf.length - HEADER_SIZE) / 8);
  const count = Math.min(declared, available, MAX_FRAMES);
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push(dv.getBigUint64(HEADER_SIZE + i * 8, true));
  }
  return { signal, faultAddress, timestamp, frames };
}

/** Mirror of the JSON payload the native drain builds from a parsed record. */
function recordToPayload(parsed, release) {
  const name = SIGNAL_NAME[parsed.signal] ?? `SIG${parsed.signal}`;
  const stackTrace = parsed.frames.map(
    (addr, i) => `${i}  0x${addr.toString(16).padStart(16, '0')}`,
  );
  const payload = {
    exceptionClass: name,
    message: parsed.faultAddress !== 0n
      ? `${name} at 0x${parsed.faultAddress.toString(16)}`
      : name,
    stackTrace,
    level: 'fatal',
    metadata: {
      platform: 'react-native',
      'device.os': 'ios',
      fatal: 'true',
      source: 'ios-POSIXSignalHandler',
      signal: name,
    },
  };
  if (release) payload.release = release;
  return payload;
}

test('record round-trips through encode/parse with exact field values', () => {
  const rec = {
    signal: SIGNALS.SIGSEGV,
    faultAddress: 0xdeadbeef,
    timestamp: 1748275200,
    frames: [0x102abc000, 0x102abc100, 0x7fff20304050],
  };
  const bytes = encodeRecord(rec);
  // header + 3 frames
  assert.equal(bytes.length, HEADER_SIZE + 3 * 8);
  // magic + version
  assert.deepEqual([...bytes.slice(0, 4)], MAGIC);
  assert.equal(bytes[4], VERSION);

  const parsed = parseRecord(bytes);
  assert.ok(parsed);
  assert.equal(parsed.signal, SIGNALS.SIGSEGV);
  assert.equal(parsed.faultAddress, 0xdeadbeefn);
  assert.equal(parsed.timestamp, 1748275200n);
  assert.deepEqual(parsed.frames, [0x102abc000n, 0x102abc100n, 0x7fff20304050n]);
});

test('parse rejects bad magic, bad version, and truncated headers', () => {
  const good = encodeRecord({ signal: SIGNALS.SIGABRT, faultAddress: 0, timestamp: 1, frames: [] });

  const badMagic = good.slice();
  badMagic[0] = 0x00;
  assert.equal(parseRecord(badMagic), null);

  const badVersion = good.slice();
  badVersion[4] = 2;
  assert.equal(parseRecord(badVersion), null);

  assert.equal(parseRecord(good.slice(0, HEADER_SIZE - 1)), null);
});

test('parse clamps a frame count that exceeds the bytes actually present', () => {
  // Encode 2 frames but lie in the header that there are 50.
  const bytes = encodeRecord({
    signal: SIGNALS.SIGTRAP,
    faultAddress: 0,
    timestamp: 1,
    frames: [0x1, 0x2],
  });
  const dv = new DataView(bytes.buffer);
  dv.setUint32(32, 50, true); // declared > available
  const parsed = parseRecord(bytes);
  assert.ok(parsed);
  assert.equal(parsed.frames.length, 2); // clamped to bytes available
});

test('encode honors the MAX_FRAMES cap', () => {
  const frames = Array.from({ length: 300 }, (_, i) => i + 1);
  const bytes = encodeRecord({ signal: SIGNALS.SIGSEGV, faultAddress: 0, timestamp: 1, frames });
  assert.equal(bytes.length, HEADER_SIZE + MAX_FRAMES * 8);
  const parsed = parseRecord(bytes);
  assert.equal(parsed.frames.length, MAX_FRAMES);
});

test('SIGTRAP (force-unwrap / fatalError trap) maps to the expected name', () => {
  const parsed = parseRecord(
    encodeRecord({ signal: SIGNALS.SIGTRAP, faultAddress: 0, timestamp: 1, frames: [0xabc] }),
  );
  const payload = recordToPayload(parsed, 'app@1.0.0');
  assert.equal(payload.exceptionClass, 'SIGTRAP');
  assert.equal(payload.message, 'SIGTRAP'); // no fault address → bare name
  assert.equal(payload.metadata.source, 'ios-POSIXSignalHandler');
});

test('converted payload includes fault address in the message when present', () => {
  const parsed = parseRecord(
    encodeRecord({ signal: SIGNALS.SIGSEGV, faultAddress: 0x10, timestamp: 1, frames: [] }),
  );
  const payload = recordToPayload(parsed, undefined);
  assert.equal(payload.message, 'SIGSEGV at 0x10');
  assert.equal(payload.release, undefined);
});

test('signal-derived payload flows through drainPendingNativeCrashes to /ingest/v1/errors', async () => {
  // Verifies the JS drain pipeline accepts a signal-sourced payload exactly
  // like the NSException one — same wire shape, native.crash tag applied.
  const sent = [];
  const mockFetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: mockFetch, writable: true, configurable: true,
  });

  const { AllStak, drainPendingNativeCrashes, __setNativeModuleForTest } =
    await import('../dist/index.mjs');

  AllStak.init({ apiKey: 'test-key', host: 'https://api.allstak.test', release: 'app@1.0.0' });

  const parsed = parseRecord(
    encodeRecord({
      signal: SIGNALS.SIGSEGV,
      faultAddress: 0xdeadbeef,
      timestamp: 1748275200,
      frames: [0x102abc000, 0x102abc100],
    }),
  );
  const json = JSON.stringify(recordToPayload(parsed, 'app@1.0.0'));

  __setNativeModuleForTest({
    install: async () => {},
    drainPendingCrash: async () => json,
  });

  await drainPendingNativeCrashes('app@1.0.0');
  await new Promise((r) => setTimeout(r, 200));
  __setNativeModuleForTest(null);

  const errReq = sent.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errReq, 'a signal crash must ship to /ingest/v1/errors');
  const body = JSON.parse(errReq.init.body);
  assert.equal(body.exceptionClass, 'SIGSEGV');
  assert.equal(body.metadata['native.crash'], 'true');
  assert.equal(body.metadata.source, 'ios-POSIXSignalHandler');
  assert.equal(body.platform, 'react-native');

  AllStak.destroy();
});
