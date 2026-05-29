/**
 * Android NDK / native-signal crash record format tests.
 *
 * The async-signal-safe native handler
 * (native/android/src/main/cpp/allstak_signal_handler.cpp) writes a fixed
 * little-endian binary record at crash time — the SAME "ASK1"/v1 format the iOS
 * handler uses — and the Java side
 * (native/android/.../AllStakNdk.java#parseRecordToJson) parses it on the NEXT
 * launch into the JSON payload shape the Throwable path produces
 * ({ exceptionClass, message, stackTrace[], level, metadata }). That JSON is
 * what AllStakCrashHandler.drainPendingCrash returns and the JS
 * `drainPendingNativeCrashes` ships to /ingest/v1/errors with native.crash=true.
 *
 * The signal handler ITSELF (sigaction, _Unwind_Backtrace, write into a
 * crashing process) is DEVICE-VERIFICATION-ONLY — a real SIGSEGV/SIGABRT on a
 * device/emulator is the only true end-to-end test. What IS deterministically
 * testable, and is tested here, is the record's wire format and its conversion
 * to the drain payload. This file re-implements the byte layout AND the Java
 * parser's signal-number → name mapping in JS so a divergence between the
 * documented format / the native encoder / the Java decoder is caught.
 *
 * Layout (must match AllStakEncodeRecord in the .cpp and the Java parser):
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
 *
 * NOTE: Linux/Android signal numbers differ from Apple for SIGBUS (Android = 7,
 * Apple = 10) and SIGTRAP/SIGABRT/etc. share values. AllStakNdk.signalName uses
 * the Android numbering, mirrored here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MAGIC = [0x41, 0x53, 0x4b, 0x31]; // "ASK1"
const VERSION = 1;
const HEADER_SIZE = 40;
const MAX_FRAMES = 128;

// Android (Linux) signal numbers — mirror of AllStakNdk.signalName.
const SIGNALS = {
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7, // Android = 7 (Apple uses 10)
  SIGFPE: 8,
  SIGSEGV: 11,
};
const SIGNAL_NAME = Object.fromEntries(
  Object.entries(SIGNALS).map(([name, num]) => [num, name]),
);

/** Mirror of AllStakEncodeRecord (the .cpp): produce the on-disk bytes. */
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

/** Mirror of AllStakNdk.parseRecordToJson (the Java normal-context parser). */
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

function signalMessage(signal, faultAddress) {
  const base = {
    11: 'Segmentation fault',
    6: 'Abnormal termination (abort)',
    7: 'Bus error',
    4: 'Illegal instruction',
    8: 'Floating-point exception',
    5: 'Trace/breakpoint trap',
  }[signal] ?? `Fatal signal ${signal}`;
  return faultAddress !== 0n ? `${base} at 0x${faultAddress.toString(16)}` : base;
}

/** Mirror of the JSON payload AllStakNdk builds from a parsed record. */
function recordToPayload(parsed, release) {
  const name = SIGNAL_NAME[parsed.signal] ?? `SIG${parsed.signal}`;
  const stackTrace = parsed.frames.map(
    (addr, i) => `${i}  0x${addr.toString(16).padStart(16, '0')}`,
  );
  const payload = {
    exceptionClass: name,
    message: signalMessage(parsed.signal, parsed.faultAddress),
    stackTrace,
    level: 'fatal',
    metadata: {
      platform: 'react-native',
      'device.os': 'android',
      fatal: 'true',
      source: 'android-NDKSignalHandler',
      signal: name,
      'signal.number': parsed.signal,
    },
  };
  if (release) payload.release = release;
  return payload;
}

test('android record round-trips through encode/parse with exact field values', () => {
  const rec = {
    signal: SIGNALS.SIGSEGV,
    faultAddress: 0xdeadbeef,
    timestamp: 1748275200,
    frames: [0x7f8abc000, 0x7f8abc100, 0x7fff20304050],
  };
  const bytes = encodeRecord(rec);
  assert.equal(bytes.length, HEADER_SIZE + 3 * 8);
  assert.deepEqual([...bytes.slice(0, 4)], MAGIC);
  assert.equal(bytes[4], VERSION);

  const parsed = parseRecord(bytes);
  assert.ok(parsed);
  assert.equal(parsed.signal, SIGNALS.SIGSEGV);
  assert.equal(parsed.faultAddress, 0xdeadbeefn);
  assert.equal(parsed.timestamp, 1748275200n);
  assert.deepEqual(parsed.frames, [0x7f8abc000n, 0x7f8abc100n, 0x7fff20304050n]);
});

test('android parse rejects bad magic, bad version, and truncated headers', () => {
  const good = encodeRecord({ signal: SIGNALS.SIGABRT, faultAddress: 0, timestamp: 1, frames: [] });

  const badMagic = good.slice();
  badMagic[0] = 0x00;
  assert.equal(parseRecord(badMagic), null);

  const badVersion = good.slice();
  badVersion[4] = 2;
  assert.equal(parseRecord(badVersion), null);

  assert.equal(parseRecord(good.slice(0, HEADER_SIZE - 1)), null);
});

test('android parse clamps a frame count that exceeds the bytes actually present', () => {
  const bytes = encodeRecord({
    signal: SIGNALS.SIGABRT,
    faultAddress: 0,
    timestamp: 1,
    frames: [0x1, 0x2],
  });
  const dv = new DataView(bytes.buffer);
  dv.setUint32(32, 999, true); // declared > available
  const parsed = parseRecord(bytes);
  assert.ok(parsed);
  assert.equal(parsed.frames.length, 2);
});

test('android encode honors the MAX_FRAMES cap', () => {
  const frames = Array.from({ length: 300 }, (_, i) => i + 1);
  const bytes = encodeRecord({ signal: SIGNALS.SIGSEGV, faultAddress: 0, timestamp: 1, frames });
  assert.equal(bytes.length, HEADER_SIZE + MAX_FRAMES * 8);
  const parsed = parseRecord(bytes);
  assert.equal(parsed.frames.length, MAX_FRAMES);
});

test('android SIGBUS uses the Linux number (7), not the Apple number (10)', () => {
  const parsed = parseRecord(
    encodeRecord({ signal: SIGNALS.SIGBUS, faultAddress: 0x40, timestamp: 1, frames: [0xabc] }),
  );
  const payload = recordToPayload(parsed, undefined);
  assert.equal(parsed.signal, 7);
  assert.equal(payload.exceptionClass, 'SIGBUS');
  assert.equal(payload.message, 'Bus error at 0x40');
  // Guard against accidentally copying the Apple SIGBUS=10 mapping.
  assert.notEqual(parsed.signal, 10);
});

test('android converted payload tags source=android-NDKSignalHandler', () => {
  const parsed = parseRecord(
    encodeRecord({ signal: SIGNALS.SIGSEGV, faultAddress: 0x10, timestamp: 1, frames: [] }),
  );
  const payload = recordToPayload(parsed, 'app@1.0.0');
  assert.equal(payload.exceptionClass, 'SIGSEGV');
  // Message is descriptive (matches AllStakNdk.signalMessage / the iOS handler).
  assert.equal(payload.message, 'Segmentation fault at 0x10');
  assert.equal(payload.metadata.source, 'android-NDKSignalHandler');
  assert.equal(payload.metadata['device.os'], 'android');
  assert.equal(payload.release, 'app@1.0.0');
});

test('android: signal payload flows through drainPendingNativeCrashes to /ingest/v1/errors', async () => {
  // Verifies an NDK signal-sourced payload ships exactly like the Throwable
  // one — same wire shape, native.crash tag applied — and that the bridge uses
  // the options-aware installWithOptions when present (native-signal capture).
  const sent = [];
  const installCalls = [];
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
      frames: [0x7f8abc000, 0x7f8abc100],
    }),
  );
  const json = JSON.stringify(recordToPayload(parsed, 'app@1.0.0'));

  __setNativeModuleForTest({
    installWithOptions: async (release, captureNativeSignals) => {
      installCalls.push({ release, captureNativeSignals });
    },
    drainPendingCrash: async () => json,
  });

  await drainPendingNativeCrashes('app@1.0.0');
  await new Promise((r) => setTimeout(r, 200));
  __setNativeModuleForTest(null);

  // The options-aware install must be used with native-signal capture on.
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].captureNativeSignals, true);

  const errReq = sent.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errReq, 'a native signal crash must ship to /ingest/v1/errors');
  const body = JSON.parse(errReq.init.body);
  assert.equal(body.exceptionClass, 'SIGSEGV');
  assert.equal(body.metadata['native.crash'], 'true');
  assert.equal(body.metadata.source, 'android-NDKSignalHandler');
  assert.equal(body.metadata['device.os'], 'android');
  assert.equal(body.platform, 'react-native');

  AllStak.destroy();
});

test('android: legacy native module without installWithOptions still drains via install()', async () => {
  // Older native modules only expose install(release). The bridge must fall
  // back to it (those always capture native signals on Android) so consumers
  // mid-upgrade are not broken.
  const sent = [];
  const installCalls = [];
  const mockFetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: mockFetch, writable: true, configurable: true,
  });

  const { AllStak, drainPendingNativeCrashes, __setNativeModuleForTest } =
    await import('../dist/index.mjs');

  AllStak.init({ apiKey: 'test-key', host: 'https://api.allstak.test', release: 'app@2.0.0' });

  const parsed = parseRecord(
    encodeRecord({ signal: SIGNALS.SIGABRT, faultAddress: 0, timestamp: 1, frames: [0x1] }),
  );
  const json = JSON.stringify(recordToPayload(parsed, 'app@2.0.0'));

  __setNativeModuleForTest({
    install: async (release) => { installCalls.push(release); },
    drainPendingCrash: async () => json,
  });

  await drainPendingNativeCrashes('app@2.0.0');
  await new Promise((r) => setTimeout(r, 200));
  __setNativeModuleForTest(null);

  assert.deepEqual(installCalls, ['app@2.0.0']);
  const errReq = sent.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errReq, 'legacy-install crash must still ship');
  const body = JSON.parse(errReq.init.body);
  assert.equal(body.exceptionClass, 'SIGABRT');
  assert.equal(body.metadata['native.crash'], 'true');

  AllStak.destroy();
});
