package io.allstak.rn;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * NDK / native-signal crash capture for Android, the counterpart to the iOS
 * {@code AllStakSignalCrashHandler}. Arms async-signal-safe {@code sigaction}
 * handlers (implemented in {@code src/main/cpp/allstak_signal_handler.cpp},
 * compiled into {@code liballstak_signal.so}) for the fatal signals
 * SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE/SIGTRAP that JNI, C/C++ libs, the NDK, or
 * the JSI/Hermes engine can raise — the dominant class of native Android crashes
 * that the JVM {@link Thread.UncaughtExceptionHandler} in
 * {@link AllStakCrashHandler} never observes.
 *
 * <p>FAIL-OPEN / GRACEFUL DEGRADE: if the native library is absent or fails to
 * load (e.g. a consumer built without the NDK, or an unsupported ABI), every
 * method here no-ops and the SDK continues with JVM-only crash capture. Nothing
 * here throws to the caller.
 *
 * <p>The native handler writes a fixed little-endian binary record at crash time
 * (the same "ASK1"/v1 format the iOS handler uses) to a pre-opened fd under the
 * app filesDir. On the NEXT launch {@link #drainPendingSignalCrash(Context)}
 * reads + deletes that record (in normal context, where allocation is fine) and
 * converts it into the SAME JSON payload shape the Throwable path produces, so
 * the JS drain pipeline ({@code drainPendingNativeCrashes}) is unchanged.
 *
 * <p>SCAFFOLDED — the async-signal-safe handler is device-verification-only. The
 * binary record format + parse/convert are unit-tested in JS
 * (test/android-signal-record.test.mjs).
 */
public final class AllStakNdk {
    private static final String TAG = "AllStakNdk";
    private static final String RECORD_FILENAME = "allstak_signal.crash.bin";

    // ── Binary record format (must match allstak_signal_handler.cpp and the iOS
    //    AllStakSignalCrashHandler; identical "ASK1"/v1 layout) ──
    private static final byte[] MAGIC = {0x41, 0x53, 0x4B, 0x31}; // "ASK1"
    private static final int VERSION = 1;
    private static final int HEADER_SIZE = 40;
    private static final int MAX_FRAMES = 128;

    /** True once the native library loaded successfully. */
    private static final boolean NATIVE_AVAILABLE;

    static {
        boolean ok = false;
        try {
            System.loadLibrary("allstak_signal");
            ok = true;
        } catch (Throwable t) {
            // No NDK lib in this build / unsupported ABI — degrade gracefully.
            Log.i(TAG, "native signal handler unavailable; JVM-only crash capture");
        }
        NATIVE_AVAILABLE = ok;
    }

    private AllStakNdk() {}

    /** Implemented in allstak_signal_handler.cpp, registered via JNI_OnLoad. */
    private static native boolean nativeInstall(String recordPath);

    /** Whether the native .so loaded (used for diagnostics / tests). */
    public static boolean isNativeAvailable() {
        return NATIVE_AVAILABLE;
    }

    /**
     * Resolve the crash-record path inside the app filesDir. Public so the
     * drain path and install path agree on the location.
     */
    public static String recordPath(Context context) {
        File dir = context.getFilesDir();
        return new File(dir, RECORD_FILENAME).getAbsolutePath();
    }

    /**
     * Arm the native sigaction handlers with a pre-opened record fd under the
     * app filesDir. Idempotent; no-op + returns false when the native library
     * is unavailable or install fails. Never throws.
     */
    public static boolean install(Context appContext) {
        if (!NATIVE_AVAILABLE) return false;
        try {
            String path = recordPath(appContext.getApplicationContext());
            return nativeInstall(path);
        } catch (Throwable t) {
            Log.w(TAG, "native signal handler install failed", t);
            return false;
        }
    }

    /**
     * Read + delete any native signal-crash record from a previous launch and
     * convert it to the same JSON payload shape the Throwable path produces
     * ({@code exceptionClass / message / stackTrace[] / level / metadata}).
     * Returns the JSON string, or {@code null} when there is no (parseable)
     * record. The record file is always removed so a partial/garbage record
     * never loops. Never throws.
     */
    public static String drainPendingSignalCrash(Context context, String release) {
        File file = new File(recordPath(context.getApplicationContext()));
        if (!file.exists()) return null;

        byte[] bytes = null;
        try {
            long len = file.length();
            if (len > 0 && len <= (HEADER_SIZE + MAX_FRAMES * 8L)) {
                bytes = new byte[(int) len];
                try (FileInputStream in = new FileInputStream(file)) {
                    int read = 0;
                    while (read < bytes.length) {
                        int n = in.read(bytes, read, bytes.length - read);
                        if (n < 0) break;
                        read += n;
                    }
                    if (read != bytes.length) bytes = java.util.Arrays.copyOf(bytes, read);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to read native crash record", t);
            bytes = null;
        } finally {
            // Always remove so a partial/garbage record never loops.
            try { file.delete(); } catch (Throwable ignored) {}
        }

        if (bytes == null) return null;
        try {
            return parseRecordToJson(bytes, release);
        } catch (Throwable t) {
            Log.w(TAG, "failed to parse native crash record", t);
            return null;
        }
    }

    // ── Normal-context parser (mirrors the iOS drainPendingSignalCrashJSON) ──

    private static long readLE(byte[] b, int offset, int count) {
        long v = 0L;
        for (int i = 0; i < count; i++) {
            v |= ((long) (b[offset + i] & 0xFF)) << (8 * i);
        }
        return v;
    }

    static String parseRecordToJson(byte[] b, String release) throws Exception {
        if (b == null || b.length < HEADER_SIZE) return null;
        if (b[0] != MAGIC[0] || b[1] != MAGIC[1] || b[2] != MAGIC[2] || b[3] != MAGIC[3]) {
            return null;
        }
        if ((b[4] & 0xFF) != VERSION) return null;

        int signalNumber = (int) readLE(b, 8, 4);
        long faultAddress = readLE(b, 16, 8);
        long timestamp = readLE(b, 24, 8);
        long declared = readLE(b, 32, 4) & 0xFFFFFFFFL;

        long available = (b.length - HEADER_SIZE) / 8;
        long count = Math.min(declared, available);
        if (count > MAX_FRAMES) count = MAX_FRAMES;
        if (count < 0) count = 0;

        JSONArray stack = new JSONArray();
        int offset = HEADER_SIZE;
        for (int i = 0; i < count; i++) {
            long addr = readLE(b, offset, 8);
            offset += 8;
            // Symbolication is server-side; emit raw return addresses as
            // greppable frame lines, mirroring the iOS POSIX-signal path.
            stack.put(String.format("%d  0x%016x", i, addr));
        }

        String name = signalName(signalNumber);
        String message = signalMessage(signalNumber, faultAddress);

        JSONObject metadata = new JSONObject();
        metadata.put("platform", "react-native");
        metadata.put("device.os", "android");
        metadata.put("device.osVersion", String.valueOf(Build.VERSION.SDK_INT));
        metadata.put("device.model", Build.MODEL == null ? "" : Build.MODEL);
        metadata.put("device.manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        metadata.put("fatal", "true");
        metadata.put("source", "android-NDKSignalHandler");
        metadata.put("signal", name);
        metadata.put("signal.number", signalNumber);
        metadata.put("fault.address", String.format("0x%x", faultAddress));
        metadata.put("crash.timestamp", timestamp);

        JSONObject payload = new JSONObject();
        payload.put("exceptionClass", name);
        payload.put("message", message);
        payload.put("stackTrace", stack);
        payload.put("level", "fatal");
        if (release != null && !release.isEmpty()) payload.put("release", release);
        payload.put("metadata", metadata);
        return payload.toString();
    }

    static String signalName(int signalNumber) {
        switch (signalNumber) {
            case 11: return "SIGSEGV";
            case 6:  return "SIGABRT";
            case 7:  return "SIGBUS";   // Linux/Android SIGBUS = 7 (not 10 as on Apple)
            case 4:  return "SIGILL";
            case 8:  return "SIGFPE";
            case 5:  return "SIGTRAP";
            default: return "SIG" + signalNumber;
        }
    }

    static String signalMessage(int signalNumber, long faultAddress) {
        String base;
        switch (signalNumber) {
            case 11: base = "Segmentation fault"; break;
            case 6:  base = "Abnormal termination (abort)"; break;
            case 7:  base = "Bus error"; break;
            case 4:  base = "Illegal instruction"; break;
            case 8:  base = "Floating-point exception"; break;
            case 5:  base = "Trace/breakpoint trap"; break;
            default: base = "Fatal signal " + signalNumber; break;
        }
        if (faultAddress != 0L) {
            return base + String.format(" at 0x%x", faultAddress);
        }
        return base;
    }
}
