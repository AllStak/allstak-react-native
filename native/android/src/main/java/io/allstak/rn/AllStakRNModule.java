package io.allstak.rn;

import androidx.annotation.NonNull;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Choreographer;
import android.view.View;

import java.io.ByteArrayOutputStream;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;

/**
 * React Native module bridging {@link AllStakCrashHandler}.
 *
 *  JS side:
 *     NativeModules.AllStakNative.drainPendingCrash().then(json => ...)
 *
 * SCAFFOLDED — compiles against React Native; requires a bare RN app with
 * autolinking to verify end-to-end.
 */
public class AllStakRNModule extends ReactContextBaseJavaModule {
    private static final long PROCESS_START_MS = SystemClock.uptimeMillis();
    private static final double SLOW_FRAME_MS = 50.0d;
    private static final double FROZEN_FRAME_MS = 700.0d;

    private boolean frameMonitorStarted = false;
    private long lastFrameNanos = 0L;
    private int totalFrames = 0;
    private int slowFrames = 0;
    private int frozenFrames = 0;
    private double maxFrameDelayMs = 0.0d;

    public AllStakRNModule(ReactApplicationContext ctx) { super(ctx); }

    @NonNull
    @Override
    public String getName() { return "AllStakNative"; }

    private synchronized void ensureFrameMonitorStarted() {
        if (frameMonitorStarted) return;
        frameMonitorStarted = true;
        UiThreadUtil.runOnUiThread(() -> {
            Choreographer.getInstance().postFrameCallback(new Choreographer.FrameCallback() {
                @Override
                public void doFrame(long frameTimeNanos) {
                    synchronized (AllStakRNModule.this) {
                        if (lastFrameNanos > 0L) {
                            double frameDeltaMs = (frameTimeNanos - lastFrameNanos) / 1_000_000.0d;
                            double delayMs = Math.max(0.0d, frameDeltaMs - 16.7d);
                            totalFrames += 1;
                            if (delayMs > SLOW_FRAME_MS) slowFrames += 1;
                            if (delayMs > FROZEN_FRAME_MS) frozenFrames += 1;
                            if (delayMs > maxFrameDelayMs) maxFrameDelayMs = delayMs;
                        }
                        lastFrameNanos = frameTimeNanos;
                    }
                    Choreographer.getInstance().postFrameCallback(this);
                }
            });
        });
    }

    @ReactMethod
    public void install(String release, Promise promise) {
        try {
            AllStakCrashHandler.install(getReactApplicationContext(), release);
            ensureFrameMonitorStarted();
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("install-failed", t);
        }
    }

    @ReactMethod
    public void getPerformanceSnapshot(Promise promise) {
        try {
            ensureFrameMonitorStarted();
            WritableMap result = Arguments.createMap();
            synchronized (this) {
                result.putDouble("native_app_start_ms", Math.max(0L, SystemClock.uptimeMillis() - PROCESS_START_MS));
                result.putInt("total_frames", totalFrames);
                result.putInt("slow_frames", slowFrames);
                result.putInt("frozen_frames", frozenFrames);
                result.putDouble("max_frame_delay_ms", maxFrameDelayMs);
                totalFrames = 0;
                slowFrames = 0;
                frozenFrames = 0;
                maxFrameDelayMs = 0.0d;
            }
            promise.resolve(result);
        } catch (Throwable t) {
            promise.reject("performance-snapshot-failed", t);
        }
    }

    @ReactMethod
    public void drainPendingCrash(Promise promise) {
        try {
            String json = AllStakCrashHandler.drainPendingCrash(getReactApplicationContext());
            promise.resolve(json);
        } catch (Throwable t) {
            promise.reject("drain-failed", t);
        }
    }

    @ReactMethod
    public void captureScreenshot(ReadableMap options, Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null) {
            promise.reject("screenshot-unavailable", "No current Activity available");
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                View root = activity.getWindow() != null
                    ? activity.getWindow().getDecorView().getRootView()
                    : null;
                if (root == null || root.getWidth() <= 0 || root.getHeight() <= 0) {
                    promise.reject("screenshot-unavailable", "No visible root view available");
                    return;
                }

                Bitmap bitmap = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(bitmap);
                root.draw(canvas);

                String format = options != null && options.hasKey("format")
                    ? options.getString("format")
                    : "jpg";
                double qualityValue = options != null && options.hasKey("quality")
                    ? options.getDouble("quality")
                    : 0.7d;
                int quality = (int) Math.round(Math.max(0d, Math.min(1d, qualityValue)) * 100d);

                Bitmap.CompressFormat compressFormat = Bitmap.CompressFormat.JPEG;
                String contentType = "image/jpeg";
                if ("png".equalsIgnoreCase(format)) {
                    compressFormat = Bitmap.CompressFormat.PNG;
                    contentType = "image/png";
                    quality = 100;
                } else if ("webp".equalsIgnoreCase(format)) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        compressFormat = Bitmap.CompressFormat.WEBP_LOSSY;
                    } else {
                        compressFormat = Bitmap.CompressFormat.WEBP;
                    }
                    contentType = "image/webp";
                }

                ByteArrayOutputStream out = new ByteArrayOutputStream();
                boolean encoded = bitmap.compress(compressFormat, quality, out);
                bitmap.recycle();
                if (!encoded) {
                    promise.reject("screenshot-failed", "Could not encode screenshot");
                    return;
                }

                byte[] bytes = out.toByteArray();
                if (options != null && options.hasKey("maxBytes")) {
                    int maxBytes = options.getInt("maxBytes");
                    if (maxBytes > 0 && bytes.length > maxBytes) {
                        promise.reject("screenshot-too-large", "Screenshot exceeds configured maxBytes");
                        return;
                    }
                }

                WritableMap result = Arguments.createMap();
                result.putString("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                result.putString("contentType", contentType);
                result.putInt("width", root.getWidth());
                result.putInt("height", root.getHeight());
                result.putInt("sizeBytes", bytes.length);
                promise.resolve(result);
            } catch (Throwable t) {
                promise.reject("screenshot-failed", t);
            }
        });
    }

    /**
     * DEV-ONLY: deliberately crash the app from a non-React thread so the
     * Thread.UncaughtExceptionHandler in {@link AllStakCrashHandler} fires.
     * Never call this from production code — it terminates the process.
     * The JS wrapper {@code AllStak.__devCrashAndroid__} is documented as
     * DEV_ONLY and is excluded from the public DX surface.
     */
    @ReactMethod
    public void __devTriggerCrash(Promise promise) {
        promise.resolve(true);
        new Thread(() -> {
            try { Thread.sleep(50); } catch (InterruptedException ignored) {}
            throw new RuntimeException(
                "AllStakDevCrash: Dev-only deliberate native crash to verify capture");
        }, "AllStakDevCrashThread").start();
    }
}
