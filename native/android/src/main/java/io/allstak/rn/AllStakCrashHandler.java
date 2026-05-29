package io.allstak.rn;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * Installs a {@link Thread.UncaughtExceptionHandler} that serialises the
 * crash to SharedPreferences so it survives process death. On next app
 * launch, {@link #drainPendingCrash(Context)} returns the stashed payload
 * for the JS layer to ship to AllStak.
 *
 * The crash payload is DTO-compatible with /ingest/v1/errors:
 *   { exceptionClass, message, stackTrace: List<String>,
 *     metadata: { platform, device.os, device.osVersion, device.model,
 *                 fatal, source, release }, ... }
 *
 * This class is platform-level: it does NOT depend on React Native so the
 * handler continues to work even if the RN bridge is already torn down.
 *
 * SCAFFOLDED — requires real device/emulator run to fully verify.
 *
 * NATIVE (NDK) SIGNAL CAPTURE — this handler sees JVM {@link Throwable}s only.
 * The dominant class of native crashes on Android — SIGSEGV/SIGABRT/SIGBUS/
 * SIGILL/SIGFPE/SIGTRAP from JNI, C/C++ libs, the NDK, or the JSI/Hermes engine
 * — deliver a POSIX signal the JVM UncaughtExceptionHandler never observes (the
 * kernel kills the process; debuggerd writes a /data/tombstones/ entry). Those
 * are now captured by {@link AllStakNdk}, an async-signal-safe native sigaction
 * handler (src/main/cpp/allstak_signal_handler.cpp → liballstak_signal.so),
 * mirroring the iOS {@code AllStakSignalCrashHandler}. {@link #install} arms it
 * (gated, fail-open) and {@link #drainPendingCrash} surfaces its record on the
 * next launch through the SAME JSON path the JVM crash uses, so the JS drain
 * pipeline is unchanged. If the NDK library is absent / fails to load, native
 * capture is silently skipped and JVM-only capture continues.
 */
public final class AllStakCrashHandler {
    private static final String TAG = "AllStakCrashHandler";
    private static final String PREFS_NAME = "allstak_crashes";
    private static final String PREFS_KEY = "pending_crash";

    private AllStakCrashHandler() {}

    /** Back-compat overload — native signal capture defaults ON. */
    public static void install(final Context appContext, final String release) {
        install(appContext, release, true);
    }

    /**
     * Install the JVM crash handler and (when {@code captureNativeSignals} is
     * true and the NDK library is available) the async-signal-safe native
     * signal handler. Native capture is fail-open: any failure leaves JVM-only
     * capture intact.
     */
    public static void install(final Context appContext, final String release,
                               final boolean captureNativeSignals) {
        final Context ctx = appContext.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable throwable) {
                try {
                    JSONObject payload = buildPayload(throwable, release);
                    SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    prefs.edit().putString(PREFS_KEY, payload.toString()).commit();
                } catch (Throwable t) {
                    Log.e(TAG, "failed to stash crash", t);
                }
                if (previous != null) {
                    previous.uncaughtException(thread, throwable);
                }
            }
        });

        // Arm the NDK signal handler. Gated + fail-open: never let a native
        // install failure break JVM crash capture.
        if (captureNativeSignals) {
            try {
                AllStakNdk.install(ctx);
            } catch (Throwable t) {
                Log.w(TAG, "native signal handler unavailable", t);
            }
        }
    }

    /**
     * Returns the stashed crash JSON (or null) and clears it. A native signal
     * crash (NDK / C++ / JSI) is preferred when present, since it is the more
     * fatal/representative event for that launch; otherwise the JVM
     * {@link Throwable} record is returned. Both share the same JSON shape so
     * the JS bridge path is identical.
     */
    public static String drainPendingCrash(Context context) {
        return drainPendingCrash(context, null);
    }

    public static String drainPendingCrash(Context context, String release) {
        final Context ctx = context.getApplicationContext();

        // 1. Prefer a native signal-crash record (fail-open).
        String nativeJson = null;
        try {
            nativeJson = AllStakNdk.drainPendingSignalCrash(ctx, release);
        } catch (Throwable t) {
            Log.w(TAG, "failed to drain native crash record", t);
        }

        // 2. Always also drain the JVM record so it never strands.
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String jvmJson = prefs.getString(PREFS_KEY, null);
        prefs.edit().remove(PREFS_KEY).commit();

        return nativeJson != null ? nativeJson : jvmJson;
    }

    private static JSONObject buildPayload(Throwable t, String release) throws Exception {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String full = sw.toString();
        JSONArray stack = new JSONArray();
        for (String line : full.split("\n")) {
            String trimmed = line.trim();
            if (!trimmed.isEmpty()) stack.put(trimmed);
        }

        JSONObject metadata = new JSONObject();
        metadata.put("platform", "react-native");
        metadata.put("device.os", "android");
        metadata.put("device.osVersion", String.valueOf(Build.VERSION.SDK_INT));
        metadata.put("device.model", Build.MODEL == null ? "" : Build.MODEL);
        metadata.put("device.manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        metadata.put("fatal", "true");
        metadata.put("source", "android-UncaughtExceptionHandler");

        JSONObject payload = new JSONObject();
        payload.put("exceptionClass", t.getClass().getSimpleName());
        payload.put("message", t.getMessage() == null ? t.toString() : t.getMessage());
        payload.put("stackTrace", stack);
        payload.put("level", "fatal");
        if (release != null) payload.put("release", release);
        payload.put("metadata", metadata);
        return payload;
    }
}
