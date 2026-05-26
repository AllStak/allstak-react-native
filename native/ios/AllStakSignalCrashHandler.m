// AllStakSignalCrashHandler.m — async-signal-safe POSIX signal crash capture.
//
// SCAFFOLDED — verify on real device. See the header for why and for which
// parts are unit-testable vs device-verification-only.
//
// Mirrors allstak-apple/Sources/AllStak/SignalCrashHandler.swift: same binary
// record format ("ASK1"/v1), same install-time pre-allocation + pre-open,
// same async-signal-safe handler discipline, same chain-previous + re-raise.
//
// THE HANDLER RUNS INSIDE A CRASHING PROCESS. The only thing it may do is call
// async-signal-safe functions (see `man 2 sigaction`). Concretely the handler
// here:
//   * touches NO Obj-C runtime: no objc_msgSend, no NSString/NSDictionary/
//     NSJSONSerialization/NSUserDefaults, no @try/@catch, no blocks, no malloc;
//   * uses ONLY pre-allocated buffers and a pre-opened file descriptor (set up
//     in +install, in normal context);
//   * captures signal number + faulting address + backtrace return addresses,
//     encodes them into a fixed byte buffer, and emits the whole record with a
//     single write(2);
//   * guards re-entrancy with a sig_atomic_t flag, RESTORES the previously
//     installed disposition for that signal (or SIG_DFL) and re-raises, so the
//     OS crash reporter and any other chained reporter still run.
//
// The record is parsed back on the NEXT launch in normal context (where
// Foundation + allocation are fine) and converted into the SAME JSON payload
// the NSException path produces, so the JS drain pipeline is unchanged.

#import "AllStakSignalCrashHandler.h"

#import <signal.h>
#import <unistd.h>
#import <fcntl.h>
#import <time.h>
#import <string.h>
#import <stdint.h>
#import <execinfo.h>
#import <sys/types.h>
#import <UIKit/UIKit.h>

// ── Binary record format (must match SignalCrashRecord in allstak-apple) ──
//
// All little-endian:
//   offset size field
//   0      4    magic   = "ASK1"  (0x41 0x53 0x4B 0x31)
//   4      1    version = 1
//   5      3    padding (zero)
//   8      4    signal number (int32)
//   12     4    padding (zero)
//   16     8    fault address (uint64; 0 if unknown)
//   24     8    timestamp, whole seconds since epoch (int64)
//   32     4    frame count (uint32)
//   36     4    padding (zero)
//   40     N*8  frame return addresses (uint64 each)

static const uint8_t kAllStakSignalMagic[4] = {0x41, 0x53, 0x4B, 0x31}; // "ASK1"
static const uint8_t kAllStakSignalVersion = 1;
static const int kAllStakSignalHeaderSize = 40;
static const int kAllStakSignalMaxFrames = 128;
static const int kAllStakSignalMaxRecordSize =
    kAllStakSignalHeaderSize + kAllStakSignalMaxFrames * 8;

// Signals we intercept. SIGTRAP is what Swift fatalError / force-unwrap traps
// deliver on Apple platforms; the rest are the classic hard faults that a
// React Native app's native side (TurboModules, JSI, native libs) can hit.
static const int kAllStakSignals[] = {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static const int kAllStakSignalCount =
    (int)(sizeof(kAllStakSignals) / sizeof(kAllStakSignals[0]));

// ── Pre-allocated global state (sigaction handlers are bare C function
//    pointers and cannot capture context, so everything is reached through
//    these globals; all are populated in +install, in normal context). ──

static void *gAllStakAltStack = NULL;            // alternate signal stack
static uint8_t *gAllStakRecordBuffer = NULL;     // handler-filled record bytes
static void **gAllStakFrameBuffer = NULL;        // backtrace() target
static int gAllStakCrashFD = -1;                 // pre-opened record fd
static struct sigaction gAllStakPrevActions[6];  // saved prior dispositions
static int gAllStakPrevSignals[6];               // parallel signal numbers
static int gAllStakInstalledCount = 0;
static volatile sig_atomic_t gAllStakInHandler = 0;
static volatile sig_atomic_t gAllStakInstalled = 0;

// Persisted record path, captured at install time (open() is NOT async-signal-
// safe so the fd is pre-opened; this string is only used on the normal-context
// drain path).
static NSString *gAllStakSignalRecordPath = nil;
static NSString *gAllStakSignalRelease = nil;

// ── Async-signal-safe little-endian writer (no allocation, no bounds growth) ─

static inline void AllStakWriteLE(uint8_t *buf, int offset, uint64_t value, int bytes) {
    for (int i = 0; i < bytes; i++) {
        buf[offset + i] = (uint8_t)(value & 0xFF);
        value >>= 8;
    }
}

// Encode a record into `buf` (must be >= kAllStakSignalMaxRecordSize). Returns
// the number of bytes used. Pure pointer arithmetic — async-signal-safe.
static int AllStakEncodeRecord(uint8_t *buf,
                               int capacity,
                               int32_t signalNumber,
                               uint64_t faultAddress,
                               int64_t timestamp,
                               const uintptr_t *frames,
                               int frameCount) {
    int count = frameCount;
    if (count < 0) count = 0;
    if (count > kAllStakSignalMaxFrames) count = kAllStakSignalMaxFrames;
    int total = kAllStakSignalHeaderSize + count * 8;
    if (capacity < total) return 0;

    // Zero the header so padding bytes are deterministic.
    for (int i = 0; i < kAllStakSignalHeaderSize; i++) buf[i] = 0;

    buf[0] = kAllStakSignalMagic[0];
    buf[1] = kAllStakSignalMagic[1];
    buf[2] = kAllStakSignalMagic[2];
    buf[3] = kAllStakSignalMagic[3];
    buf[4] = kAllStakSignalVersion;
    AllStakWriteLE(buf, 8, (uint64_t)(uint32_t)signalNumber, 4);
    AllStakWriteLE(buf, 16, faultAddress, 8);
    AllStakWriteLE(buf, 24, (uint64_t)timestamp, 8);
    AllStakWriteLE(buf, 32, (uint64_t)count, 4);

    int offset = kAllStakSignalHeaderSize;
    for (int i = 0; i < count; i++) {
        AllStakWriteLE(buf, offset, (uint64_t)frames[i], 8);
        offset += 8;
    }
    return total;
}

// ── chain-previous + re-raise (async-signal-safe) ──

static void AllStakChainPrevious(int signalNumber) {
    int restored = 0;
    for (int i = 0; i < gAllStakInstalledCount; i++) {
        if (gAllStakPrevSignals[i] == signalNumber) {
            sigaction(signalNumber, &gAllStakPrevActions[i], NULL);
            restored = 1;
            break;
        }
    }
    if (!restored) {
        struct sigaction def;
        memset(&def, 0, sizeof(def));
        def.sa_handler = SIG_DFL;
        sigemptyset(&def.sa_mask);
        def.sa_flags = 0;
        sigaction(signalNumber, &def, NULL);
    }
    // Re-raise; the now-restored handler / default disposition takes over so
    // the OS crash report and any other chained reporter still run.
    raise(signalNumber);
}

// ── The handler (async-signal-safe ONLY) ──

static void AllStakSignalHandler(int signalNumber, siginfo_t *info, void *context) {
    (void)context;
    // Re-entrancy / double-fault guard: if we crash again while handling, fall
    // straight through to the previous handler. Not perfectly atomic across
    // threads but allocation-free and matches common practice.
    if (gAllStakInHandler != 0) {
        AllStakChainPrevious(signalNumber);
        return;
    }
    gAllStakInHandler = 1;

    if (gAllStakRecordBuffer != NULL && gAllStakFrameBuffer != NULL && gAllStakCrashFD >= 0) {
        // backtrace() is documented async-signal-safe and writes into our
        // pre-allocated pointer buffer — no allocation.
        int frameCount = backtrace(gAllStakFrameBuffer, kAllStakSignalMaxFrames);

        uint64_t faultAddress = 0;
        if (info != NULL) {
            faultAddress = (uint64_t)(uintptr_t)info->si_addr;
        }

        // time(NULL) is async-signal-safe.
        int64_t now = (int64_t)time(NULL);

        int total = AllStakEncodeRecord(gAllStakRecordBuffer,
                                        kAllStakSignalMaxRecordSize,
                                        (int32_t)signalNumber,
                                        faultAddress,
                                        now,
                                        (const uintptr_t *)gAllStakFrameBuffer,
                                        frameCount);
        if (total > 0) {
            // Single write of the whole record; write()/fsync() are
            // async-signal-safe.
            ssize_t w = write(gAllStakCrashFD, gAllStakRecordBuffer, (size_t)total);
            (void)w;
            fsync(gAllStakCrashFD);
        }
    }

    // Restore the previous disposition for THIS signal and re-raise. Do not loop.
    AllStakChainPrevious(signalNumber);
}

// ── Normal-context helpers (Foundation + allocation allowed) ──

static uint64_t AllStakReadLE(const uint8_t *base, int offset, int bytes) {
    uint64_t v = 0;
    for (int i = 0; i < bytes; i++) {
        v |= ((uint64_t)base[offset + i]) << (8 * i);
    }
    return v;
}

static NSString *AllStakSignalName(int32_t signalNumber) {
    switch (signalNumber) {
        case SIGSEGV: return @"SIGSEGV";
        case SIGABRT: return @"SIGABRT";
        case SIGBUS:  return @"SIGBUS";
        case SIGILL:  return @"SIGILL";
        case SIGFPE:  return @"SIGFPE";
        case SIGTRAP: return @"SIGTRAP";
        default:      return [NSString stringWithFormat:@"SIG%d", signalNumber];
    }
}

static NSString *AllStakSignalMessage(int32_t signalNumber, uint64_t faultAddress) {
    NSString *base;
    switch (signalNumber) {
        case SIGSEGV: base = @"Segmentation fault"; break;
        case SIGABRT: base = @"Abnormal termination (abort)"; break;
        case SIGBUS:  base = @"Bus error"; break;
        case SIGILL:  base = @"Illegal instruction"; break;
        case SIGFPE:  base = @"Floating-point exception"; break;
        case SIGTRAP: base = @"Trace/breakpoint trap (fatal error / force-unwrap)"; break;
        default:      base = [NSString stringWithFormat:@"Fatal signal %d", signalNumber]; break;
    }
    if (faultAddress != 0) {
        return [base stringByAppendingFormat:@" at 0x%llx", (unsigned long long)faultAddress];
    }
    return base;
}

@implementation AllStakSignalCrashHandler

+ (void)installWithRelease:(NSString *)release {
    @synchronized(self) {
        if (release) gAllStakSignalRelease = [release copy];
        if (gAllStakInstalled) return; // idempotent

        // Resolve the record path inside the app's caches dir (survives across
        // launches, not backed up). Pre-open the fd; open() is NOT
        // async-signal-safe so it must happen here, in normal context.
        NSArray<NSString *> *dirs =
            NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
        NSString *cacheDir = dirs.firstObject ?: NSTemporaryDirectory();
        NSString *recordPath = [cacheDir stringByAppendingPathComponent:@"allstak_signal.crash.bin"];
        gAllStakSignalRecordPath = [recordPath copy];

        // 1. Alternate signal stack — a faulting thread's own stack may be
        //    exhausted (e.g. SIGSEGV from a stack overflow), so the handler
        //    must run on its own stack.
        size_t stackSize = (size_t)SIGSTKSZ;
        if (stackSize < 64 * 1024) stackSize = 64 * 1024;
        gAllStakAltStack = malloc(stackSize);
        if (gAllStakAltStack != NULL) {
            stack_t ss;
            memset(&ss, 0, sizeof(ss));
            ss.ss_sp = gAllStakAltStack;
            ss.ss_size = stackSize;
            ss.ss_flags = 0;
            sigaltstack(&ss, NULL);
        }

        // 2. Pre-allocate the buffers the handler fills.
        gAllStakRecordBuffer = (uint8_t *)malloc((size_t)kAllStakSignalMaxRecordSize);
        gAllStakFrameBuffer = (void **)malloc(sizeof(void *) * (size_t)kAllStakSignalMaxFrames);

        // 3. Pre-open the crash record file (O_CREAT|O_WRONLY|O_TRUNC).
        gAllStakCrashFD = open([recordPath fileSystemRepresentation],
                               O_WRONLY | O_CREAT | O_TRUNC, 0600);

        // If any critical pre-allocation failed, bail without arming handlers
        // (so we never run a handler that has no buffer to write into).
        if (gAllStakRecordBuffer == NULL || gAllStakFrameBuffer == NULL || gAllStakCrashFD < 0) {
            return;
        }

        // 4. Install handlers with SA_SIGINFO | SA_ONSTACK, saving the previous
        //    disposition so we can chain/restore + re-raise.
        int installed = 0;
        for (int i = 0; i < kAllStakSignalCount; i++) {
            int sig = kAllStakSignals[i];
            struct sigaction action;
            memset(&action, 0, sizeof(action));
            action.sa_sigaction = AllStakSignalHandler;
            action.sa_flags = SA_SIGINFO | SA_ONSTACK;
            sigemptyset(&action.sa_mask);
            struct sigaction old;
            memset(&old, 0, sizeof(old));
            if (sigaction(sig, &action, &old) == 0) {
                gAllStakPrevActions[installed] = old;
                gAllStakPrevSignals[installed] = sig;
                installed++;
            }
        }
        gAllStakInstalledCount = installed;
        gAllStakInstalled = 1;
    }
}

+ (NSString *)drainPendingSignalCrashJSON {
    NSString *path;
    NSString *release;
    @synchronized(self) {
        path = gAllStakSignalRecordPath;
        release = gAllStakSignalRelease;
    }
    if (path == nil) {
        // Not installed in this process; still attempt a default path so a
        // record from a previous (installed) launch is not stranded.
        NSArray<NSString *> *dirs =
            NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
        NSString *cacheDir = dirs.firstObject ?: NSTemporaryDirectory();
        path = [cacheDir stringByAppendingPathComponent:@"allstak_signal.crash.bin"];
    }

    NSData *data = [NSData dataWithContentsOfFile:path];
    // Always remove the file so a partial/garbage record never loops.
    [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];

    if (data == nil || data.length < (NSUInteger)kAllStakSignalHeaderSize) {
        return nil;
    }

    const uint8_t *base = (const uint8_t *)data.bytes;
    if (base[0] != kAllStakSignalMagic[0] || base[1] != kAllStakSignalMagic[1] ||
        base[2] != kAllStakSignalMagic[2] || base[3] != kAllStakSignalMagic[3]) {
        return nil;
    }
    if (base[4] != kAllStakSignalVersion) return nil;

    int32_t signalNumber = (int32_t)(uint32_t)AllStakReadLE(base, 8, 4);
    uint64_t faultAddress = AllStakReadLE(base, 16, 8);
    int64_t timestamp = (int64_t)AllStakReadLE(base, 24, 8);
    uint32_t frameCount = (uint32_t)AllStakReadLE(base, 32, 4);

    NSUInteger available = (data.length - (NSUInteger)kAllStakSignalHeaderSize) / 8;
    NSUInteger count = frameCount;
    if (count > available) count = available;
    if (count > (NSUInteger)kAllStakSignalMaxFrames) count = (NSUInteger)kAllStakSignalMaxFrames;

    NSMutableArray<NSString *> *stack = [NSMutableArray arrayWithCapacity:count];
    int offset = kAllStakSignalHeaderSize;
    for (NSUInteger i = 0; i < count; i++) {
        uint64_t addr = AllStakReadLE(base, offset, 8);
        offset += 8;
        // Symbolication happens server-side (dSYM); emit raw return addresses
        // as greppable frame lines, mirroring how the NSException path emits
        // callStackSymbols strings.
        [stack addObject:[NSString stringWithFormat:@"%lu  0x%016llx",
                          (unsigned long)i, (unsigned long long)addr]];
    }

    UIDevice *dev = [UIDevice currentDevice];
    NSMutableDictionary *metadata = [@{
        @"platform": @"react-native",
        @"device.os": @"ios",
        @"device.osVersion": dev.systemVersion ?: @"",
        @"device.model": dev.model ?: @"",
        @"device.name": dev.name ?: @"",
        @"fatal": @"true",
        @"source": @"ios-POSIXSignalHandler",
        @"signal": AllStakSignalName(signalNumber),
        @"signal.number": @(signalNumber),
        @"fault.address": [NSString stringWithFormat:@"0x%llx", (unsigned long long)faultAddress],
        @"crash.timestamp": @(timestamp),
    } mutableCopy];

    NSMutableDictionary *payload = [@{
        @"exceptionClass": AllStakSignalName(signalNumber),
        @"message": AllStakSignalMessage(signalNumber, faultAddress),
        @"stackTrace": stack,
        @"level": @"fatal",
        @"metadata": metadata,
    } mutableCopy];
    if (release) payload[@"release"] = release;

    NSError *err = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&err];
    if (json == nil || err != nil) return nil;
    return [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
}

@end
