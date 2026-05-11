package io.allstak.rn;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;

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
    public AllStakRNModule(ReactApplicationContext ctx) { super(ctx); }

    @NonNull
    @Override
    public String getName() { return "AllStakNative"; }

    @ReactMethod
    public void install(String release, Promise promise) {
        try {
            AllStakCrashHandler.install(getReactApplicationContext(), release);
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("install-failed", t);
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
