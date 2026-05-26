// AllStakSignalCrashHandler — async-signal-safe POSIX signal crash capture
// for the AllStak React Native iOS native module.
//
// SCAFFOLDED — verify on real device. The async-signal-safe handler cannot be
// exercised by unit tests or the iOS Simulator's normal test harness; a real
// SIGSEGV/SIGABRT on a device is the only true end-to-end verification. The
// binary record format and its on-launch parse/convert are pure data and ARE
// unit-tested from JS via a fixture (see test/signal-record.test.mjs) which
// mirrors this exact byte layout.
//
// The Obj-C `NSUncaughtExceptionHandler` in AllStakCrashHandler only sees
// Obj-C `NSException`s. The dominant class of native crashes — bad memory
// access, force-unwrap traps, aborts from native libs — deliver a POSIX signal
// instead, which never reaches that handler. This installs `sigaction`
// handlers for those signals.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface AllStakSignalCrashHandler : NSObject

/// Arm the async-signal-safe sigaction handlers (SIGSEGV/SIGABRT/SIGBUS/
/// SIGILL/SIGFPE/SIGTRAP) on an alternate signal stack. Pre-allocates all
/// buffers and pre-opens the crash record file — none of which is safe to do
/// inside a handler — so the handler itself only makes async-signal-safe
/// calls. Idempotent. Called from normal context at install time.
+ (void)installWithRelease:(nullable NSString *)release;

/// Read + delete a persisted signal-crash record from the previous launch and
/// convert it to the SAME JSON payload shape the NSException path produces
/// (exceptionClass / message / stackTrace[] / metadata). Returns nil when
/// there is no record (or it is unparseable; the file is removed regardless).
/// Runs in normal context — Foundation + allocation are fine here.
+ (nullable NSString *)drainPendingSignalCrashJSON;

@end

NS_ASSUME_NONNULL_END
