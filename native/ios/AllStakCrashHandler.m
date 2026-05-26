// AllStakCrashHandler.m — iOS uncaught exception capture.
//
// SCAFFOLDED: requires Xcode compile + real iOS simulator/device for
// end-to-end verification. Obj-C / UIKit imports are standard; no
// third-party dependencies.

#import "AllStakCrashHandler.h"
#import "AllStakSignalCrashHandler.h"
#import <UIKit/UIKit.h>

static NSString * const kAllStakPendingCrashKey = @"io.allstak.rn.pending_crash";
static NSString *gAllStakRelease = nil;
static NSUncaughtExceptionHandler *gAllStakPreviousHandler = NULL;

static void AllStakHandleUncaughtException(NSException *exception) {
    @try {
        NSMutableArray<NSString *> *stack = [NSMutableArray array];
        for (NSString *line in [exception callStackSymbols]) {
            NSString *trimmed = [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
            if (trimmed.length > 0) [stack addObject:trimmed];
        }

        UIDevice *dev = [UIDevice currentDevice];
        NSDictionary *metadata = @{
            @"platform": @"react-native",
            @"device.os": @"ios",
            @"device.osVersion": dev.systemVersion ?: @"",
            @"device.model": dev.model ?: @"",
            @"device.name": dev.name ?: @"",
            @"fatal": @"true",
            @"source": @"ios-NSUncaughtExceptionHandler"
        };

        NSMutableDictionary *payload = [@{
            @"exceptionClass": exception.name ?: @"NSException",
            @"message": exception.reason ?: @"(no reason)",
            @"stackTrace": stack,
            @"level": @"fatal",
            @"metadata": metadata,
        } mutableCopy];
        if (gAllStakRelease) payload[@"release"] = gAllStakRelease;

        NSError *err = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&err];
        if (json && !err) {
            NSString *str = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
            [[NSUserDefaults standardUserDefaults] setObject:str forKey:kAllStakPendingCrashKey];
            [[NSUserDefaults standardUserDefaults] synchronize];
        }
    } @catch (NSException *ignored) {
        // never re-raise from within the crash handler
    }

    if (gAllStakPreviousHandler) {
        gAllStakPreviousHandler(exception);
    }
}

@implementation AllStakCrashHandler

+ (void)installWithRelease:(NSString *)release {
    @synchronized(self) {
        if (release) gAllStakRelease = [release copy];
        gAllStakPreviousHandler = NSGetUncaughtExceptionHandler();
        NSSetUncaughtExceptionHandler(&AllStakHandleUncaughtException);
    }
    // Also arm the async-signal-safe POSIX signal handlers (SIGSEGV/SIGABRT/
    // ...). NSUncaughtExceptionHandler only catches Obj-C NSExceptions; the
    // dominant class of native crashes deliver a signal instead. Gated by the
    // same enable flag — this method is only called when JS opts into native
    // crash handling (autoNativeCrashHandling).
    [AllStakSignalCrashHandler installWithRelease:release];
}

+ (NSString *)drainPendingCrash {
    // 1. NSException JSON stashed in NSUserDefaults (the managed-runtime path).
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *exceptionJSON = [defaults stringForKey:kAllStakPendingCrashKey];
    [defaults removeObjectForKey:kAllStakPendingCrashKey];
    [defaults synchronize];

    // 2. POSIX signal record persisted by the async-signal-safe handler,
    //    converted on this (normal) launch to the SAME JSON payload shape.
    //    Always drain it so a record never leaks, even if we return the
    //    NSException one below.
    NSString *signalJSON = [AllStakSignalCrashHandler drainPendingSignalCrashJSON];

    // A process delivers at most one fatal crash before it dies, so in
    // practice only one source is populated per launch. If both happen to be
    // present, prefer the NSException JSON (richer Obj-C symbolated frames);
    // the signal record was still drained above so it won't replay.
    if (exceptionJSON != nil && exceptionJSON.length > 0) {
        return exceptionJSON;
    }
    return signalJSON;
}

@end
