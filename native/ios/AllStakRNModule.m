// RCTBridgeModule bridging AllStakCrashHandler to JS.
//
// SCAFFOLDED: requires React Native iOS project with CocoaPods autolinking
// to verify end-to-end.

#import <React/RCTBridgeModule.h>
#import "AllStakCrashHandler.h"
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>

@interface AllStakRNModule : NSObject <RCTBridgeModule>
@end

@implementation AllStakRNModule

static CFTimeInterval AllStakProcessStartTime = 0;
static BOOL AllStakFrameMonitorStarted = NO;
static CFTimeInterval AllStakLastFrameTimestamp = 0;
static NSInteger AllStakTotalFrames = 0;
static NSInteger AllStakSlowFrames = 0;
static NSInteger AllStakFrozenFrames = 0;
static double AllStakMaxFrameDelayMs = 0;
static CADisplayLink *AllStakDisplayLink = nil;

+ (void)initialize {
    if (self == [AllStakRNModule class]) {
        AllStakProcessStartTime = CACurrentMediaTime();
    }
}

RCT_EXPORT_MODULE(AllStakNative);

- (void)allstakFrameTick:(CADisplayLink *)displayLink {
    if (AllStakLastFrameTimestamp > 0) {
        double expectedFrameMs = displayLink.duration > 0 ? displayLink.duration * 1000.0 : 16.7;
        double frameDeltaMs = (displayLink.timestamp - AllStakLastFrameTimestamp) * 1000.0;
        double delayMs = MAX(0, frameDeltaMs - expectedFrameMs);
        AllStakTotalFrames += 1;
        if (delayMs > 50.0) AllStakSlowFrames += 1;
        if (delayMs > 700.0) AllStakFrozenFrames += 1;
        if (delayMs > AllStakMaxFrameDelayMs) AllStakMaxFrameDelayMs = delayMs;
    }
    AllStakLastFrameTimestamp = displayLink.timestamp;
}

- (void)ensureFrameMonitorStarted {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (AllStakFrameMonitorStarted) return;
        AllStakFrameMonitorStarted = YES;
        AllStakDisplayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(allstakFrameTick:)];
        [AllStakDisplayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
    });
}

RCT_EXPORT_METHOD(install:(NSString *)release
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    [AllStakCrashHandler installWithRelease:release];
    [self ensureFrameMonitorStarted];
    resolve(@YES);
}

RCT_EXPORT_METHOD(getPerformanceSnapshot:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    [self ensureFrameMonitorStarted];
    dispatch_async(dispatch_get_main_queue(), ^{
        NSDictionary *snapshot = @{
            @"native_app_start_ms": @((CACurrentMediaTime() - AllStakProcessStartTime) * 1000.0),
            @"total_frames": @(AllStakTotalFrames),
            @"slow_frames": @(AllStakSlowFrames),
            @"frozen_frames": @(AllStakFrozenFrames),
            @"max_frame_delay_ms": @(AllStakMaxFrameDelayMs)
        };
        AllStakTotalFrames = 0;
        AllStakSlowFrames = 0;
        AllStakFrozenFrames = 0;
        AllStakMaxFrameDelayMs = 0;
        resolve(snapshot);
    });
}

RCT_EXPORT_METHOD(drainPendingCrash:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    NSString *json = [AllStakCrashHandler drainPendingCrash];
    resolve(json ?: [NSNull null]);
}

RCT_EXPORT_METHOD(captureScreenshot:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            UIWindow *window = nil;
            if (@available(iOS 13.0, *)) {
                for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                    if (scene.activationState != UISceneActivationStateForegroundActive ||
                        ![scene isKindOfClass:UIWindowScene.class]) {
                        continue;
                    }
                    UIWindowScene *windowScene = (UIWindowScene *)scene;
                    for (UIWindow *candidate in windowScene.windows) {
                        if (candidate.isKeyWindow) {
                            window = candidate;
                            break;
                        }
                    }
                    if (window != nil) break;
                }
            }
            if (window == nil) {
                window = UIApplication.sharedApplication.keyWindow;
            }
            if (window == nil) {
                reject(@"screenshot-unavailable", @"No active window available", nil);
                return;
            }

            NSString *format = [options[@"format"] isKindOfClass:NSString.class]
                ? [options[@"format"] lowercaseString]
                : @"jpg";
            CGFloat quality = [options[@"quality"] respondsToSelector:@selector(doubleValue)]
                ? [options[@"quality"] doubleValue]
                : 0.7;
            quality = MAX(0.0, MIN(1.0, quality));

            CGSize size = window.bounds.size;
            UIGraphicsImageRendererFormat *rendererFormat = [UIGraphicsImageRendererFormat defaultFormat];
            rendererFormat.scale = window.screen.scale;
            rendererFormat.opaque = NO;
            UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:rendererFormat];
            UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
                BOOL rendered = [window drawViewHierarchyInRect:window.bounds afterScreenUpdates:NO];
                if (!rendered) {
                    [window.layer renderInContext:context.CGContext];
                }
            }];

            NSData *data = nil;
            NSString *contentType = @"image/jpeg";
            if ([format isEqualToString:@"png"]) {
                data = UIImagePNGRepresentation(image);
                contentType = @"image/png";
            } else {
                data = UIImageJPEGRepresentation(image, quality);
            }
            if (data == nil) {
                reject(@"screenshot-failed", @"Could not encode screenshot", nil);
                return;
            }
            NSNumber *maxBytes = options[@"maxBytes"];
            if ([maxBytes respondsToSelector:@selector(unsignedIntegerValue)] &&
                data.length > [maxBytes unsignedIntegerValue]) {
                reject(@"screenshot-too-large", @"Screenshot exceeds configured maxBytes", nil);
                return;
            }

            resolve(@{
                @"dataBase64": [data base64EncodedStringWithOptions:0],
                @"contentType": contentType,
                @"width": @(lrint(size.width)),
                @"height": @(lrint(size.height)),
                @"sizeBytes": @(data.length)
            });
        } @catch (NSException *exception) {
            reject(@"screenshot-failed", exception.reason ?: @"Screenshot capture failed", nil);
        }
    });
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
