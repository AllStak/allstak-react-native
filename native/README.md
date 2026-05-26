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

Android currently captures **JVM `Throwable`s** only
(`Thread.UncaughtExceptionHandler`). Native (NDK / C++ / JSI) `SIGSEGV`/`SIGABRT`
signal + tombstone capture is a deliberate **follow-up** — it requires an
async-signal-safe NDK handler and is intentionally not partially implemented.
See `AllStakSignalCrashHandler.m` for the iOS reference approach to port.

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
