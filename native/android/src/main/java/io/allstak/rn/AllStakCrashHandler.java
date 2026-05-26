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
 * SCOPE NOTE — NATIVE (NDK) SIGNALS ARE NOT YET CAPTURED ON ANDROID.
 * This handler only sees JVM {@link Throwable}s. The dominant class of native
 * crashes on Android — SIGSEGV/SIGABRT from JNI, C/C++ libs, the NDK, or the
 * JSI/Hermes engine — deliver a POSIX signal that the JVM
 * UncaughtExceptionHandler never observes (the process is killed by the
 * kernel; Android writes a /data/tombstones/ entry instead). Capturing those
 * requires an async-signal-safe native (C/C++) sigaction handler compiled via
 * the NDK + a tombstone/record parser, mirroring what the iOS side now does in
 * AllStakSignalCrashHandler. That is a separate, larger task and is a
 * deliberate FOLLOW-UP — it is intentionally NOT half-implemented here to
 * avoid shipping a broken/partial NDK build. See the iOS implementation for
 * the reference approach to port.
 */
public final class AllStakCrashHandler {
    private static final String TAG = "AllStakCrashHandler";
    private static final String PREFS_NAME = "allstak_crashes";
    private static final String PREFS_KEY = "pending_crash";

    private AllStakCrashHandler() {}

    public static void install(final Context appContext, final String release) {
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
    }

    /** Returns the stashed crash JSON (or null) and clears it. */
    public static String drainPendingCrash(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(PREFS_KEY, null);
        prefs.edit().remove(PREFS_KEY).commit();
        return json;
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
