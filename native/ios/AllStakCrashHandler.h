// AllStakCrashHandler — iOS native crash capture for React Native.
//
// SCAFFOLDED: compiles against UIKit; requires an Xcode project + real
// device/simulator to verify end-to-end.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface AllStakCrashHandler : NSObject

/// Install the crash handlers. Idempotent. Arms BOTH:
///   1. the NSUncaughtExceptionHandler (Obj-C NSExceptions), and
///   2. async-signal-safe sigaction handlers for SIGSEGV/SIGABRT/SIGBUS/
///      SIGILL/SIGFPE/SIGTRAP (see AllStakSignalCrashHandler) — the dominant
///      class of real native crashes, which never raise an NSException.
+ (void)installWithRelease:(nullable NSString *)release;

/// Returns the JSON payload stashed by the previous crash (or nil) and clears
/// it. Drains BOTH the NSException store (NSUserDefaults) and the POSIX signal
/// record (converted to the same JSON shape); returns whichever is pending.
+ (nullable NSString *)drainPendingCrash;

@end

NS_ASSUME_NONNULL_END
