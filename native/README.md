# @allstak/react-native native modules

Native crash support is included with `@allstak/react-native`.

## iOS crash capture

The iOS native module captures two classes of crash and drains them on the next
launch (`drainPendingCrash` → `/ingest/v1/errors` with `native.crash=true`):

1. **Obj-C `NSException`** via `NSSetUncaughtExceptionHandler`
   (`AllStakCrashHandler`).
2. **POSIX signals** — `SIGSEGV` / `SIGABRT` / `SIGBUS` / `SIGILL` / `SIGFPE` /
   `SIGTRAP` — via async-signal-safe `sigaction` handlers on an alternate
   signal stack (`AllStakSignalCrashHandler`). This covers the dominant class
   of real native crashes (bad memory access, force-unwrap/fatalError traps,
   aborts from native libs) which never raise an `NSException`. The handler
   writes a fixed binary record at crash time and converts it to the same JSON
   payload shape on the next launch. The previous handler is always chained and
   re-raised so the OS crash report and other reporters still run.

Both are gated by the JS `autoNativeCrashHandling` option (the native
`install` is only called when it is enabled).

> The async-signal-safe signal handler is **device-verification-only**: a real
> SIGSEGV/SIGABRT on a device is the only true end-to-end test. The binary
> record format and its parse/convert are unit-tested in JS
> (`test/signal-record.test.mjs`).

## Android crash capture

The Android native module captures two classes of crash and drains them on the
next launch (`drainPendingCrash` → `/ingest/v1/errors` with `native.crash=true`):

1. **JVM `Throwable`** via `Thread.UncaughtExceptionHandler`
   (`AllStakCrashHandler`).
2. **NDK / POSIX signals** — `SIGSEGV` / `SIGABRT` / `SIGBUS` / `SIGILL` /
   `SIGFPE` / `SIGTRAP` — via an async-signal-safe `sigaction` handler on an
   alternate signal stack, compiled into `liballstak_signal.so`
   (`src/main/cpp/allstak_signal_handler.cpp`, JNI-registered via
   `JNI_OnLoad`/`RegisterNatives` against `AllStakNdk`). This covers the
   dominant class of real native Android crashes (bad memory access from JNI,
   C/C++ libs, the NDK, or the JSI/Hermes engine) which never raise a JVM
   `Throwable` (the kernel kills the process; `debuggerd` writes a
   `/data/tombstones/` entry). The handler writes a fixed binary record — the
   SAME `"ASK1"`/v1 little-endian format the iOS handler uses — to a pre-opened
   fd under the app `filesDir`, then restores the previous disposition and
   re-raises so the OS tombstone and other reporters still run. On the next
   launch `AllStakNdk.drainPendingSignalCrash` parses it (in normal context)
   into the same JSON payload the `Throwable` path produces.

Native-signal capture is built with the package via CMake
(`externalNativeBuild`) and is **fail-open**: if the NDK library is absent or
fails to load (no NDK in the consumer build, unsupported ABI), `AllStakNdk`
no-ops and JVM-only capture continues. It is gated by the JS
`autoNativeCrashHandling` option (native `install` is only called when enabled)
plus the `captureNativeSignals` option (default true), which maps to the native
module's `installWithOptions(release, captureNativeSignals)`.

> The async-signal-safe signal handler is **device-verification-only**: a real
> SIGSEGV/SIGABRT on a device/emulator is the only true end-to-end test. The
> binary record format and its parse/convert are unit-tested in JS
> (`test/android-signal-record.test.mjs`), and the C/C++ source is verified to
> compile + link against the NDK sysroot for all four ABIs.

Install the package, add the Expo plugin when using Expo, then rebuild the native app:

```bash
npm install @allstak/react-native
```

```json
{
  "expo": {
    "plugins": ["@allstak/react-native"]
  }
}
```

```bash
npx expo prebuild
npx expo run:ios
npx expo run:android
```

Bare React Native apps should rebuild iOS and Android after package installation so native crash handlers are linked.
