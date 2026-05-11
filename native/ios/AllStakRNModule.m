// RCTBridgeModule bridging AllStakCrashHandler to JS.
//
// SCAFFOLDED: requires React Native iOS project with CocoaPods autolinking
// to verify end-to-end.

#import <React/RCTBridgeModule.h>
#import "AllStakCrashHandler.h"

@interface AllStakRNModule : NSObject <RCTBridgeModule>
@end

@implementation AllStakRNModule

RCT_EXPORT_MODULE(AllStakNative);

RCT_EXPORT_METHOD(install:(NSString *)release
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    [AllStakCrashHandler installWithRelease:release];
    resolve(@YES);
}

RCT_EXPORT_METHOD(drainPendingCrash:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    NSString *json = [AllStakCrashHandler drainPendingCrash];
    resolve(json ?: [NSNull null]);
}

// DEV-ONLY: deliberately crash the app to verify the crash-capture flow.
// Throws an NSException synchronously on the next runloop tick. Never
// expose this in user-facing UI of a production app — it kills the
// process. The JS-side wrapper (`AllStak.__devCrashIos__`) is documented
// as DEV_ONLY and is excluded from the public DX surface.
RCT_EXPORT_METHOD(__devTriggerCrash:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @throw [NSException
            exceptionWithName:@"AllStakDevCrash"
            reason:@"Dev-only: deliberate native crash to verify capture"
            userInfo:nil];
    });
    resolve(@YES);
}

@end
