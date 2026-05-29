// allstak_signal_handler.cpp — async-signal-safe NDK / native-signal crash
// capture for the AllStak React Native Android module.
//
// SCAFFOLDED — verify on a real device/emulator. The async-signal-safe handler
// cannot be exercised by host unit tests; a real SIGSEGV/SIGABRT on a device is
// the only true end-to-end verification. The binary record format and its
// on-launch parse/convert ARE unit-tested from JS (test/android-signal-record.test.mjs)
// and the Java parser mirrors this exact byte layout.
//
// WHY THIS EXISTS — the Java Thread.UncaughtExceptionHandler in
// AllStakCrashHandler only sees JVM Throwables. The dominant class of native
// crashes on Android — SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE/SIGTRAP from JNI,
// C/C++ libs, the NDK, or the JSI/Hermes engine — deliver a POSIX signal the
// JVM handler never observes (the kernel kills the process; Android writes a
// /data/tombstones/ entry). Capturing those requires this async-signal-safe
// sigaction handler, mirroring native/ios/AllStakSignalCrashHandler.m.
//
// THE HANDLER RUNS INSIDE A CRASHING PROCESS. The only thing it may do is call
// async-signal-safe functions (see `man 7 signal-safety`). Concretely the
// handler here:
//   * touches NO JNI (no JNIEnv, no FindClass, no NewStringUTF), no malloc, no
//     C++ exceptions, no libc++ allocation, no Android log (which mallocs);
//   * uses ONLY pre-allocated buffers and a pre-opened file descriptor (set up
//     in allstak_install, in normal context);
//   * captures signal number + faulting address + a backtrace of return
//     addresses (via libunwind's _Unwind_Backtrace, which only walks frames and
//     writes into our pre-allocated buffer — no allocation), encodes them into a
//     fixed byte buffer, and emits the whole record with a single write(2);
//   * guards re-entrancy with a sig_atomic_t flag, RESTORES the previously
//     installed disposition for that signal (or SIG_DFL) and re-raises, so the
//     OS crash reporter (debuggerd / tombstone) and any other chained reporter
//     still run.
//
// The record is parsed back on the NEXT launch in normal context (Java side,
// AllStakNdk.drainPendingNativeSignalCrash) and converted into the SAME JSON
// payload the Throwable path produces, so the JS drain pipeline is unchanged.

#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unwind.h>

#if defined(__ANDROID__)
#include <jni.h>
#endif

// ── Binary record format (must match SignalCrashRecord in the iOS handler and
//    the Java parser in AllStakNdk; identical "ASK1"/v1 layout) ──
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

// Signals we intercept. SIGTRAP is delivered by some __builtin_trap() / abort
// paths (e.g. Hermes / JSI fatal errors); the rest are the classic hard faults
// a React Native app's native side (TurboModules, JSI, native libs) can hit.
static const int kAllStakSignals[] = {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static const int kAllStakSignalCount =
    (int)(sizeof(kAllStakSignals) / sizeof(kAllStakSignals[0]));

// ── Pre-allocated global state (sigaction handlers are bare C function
//    pointers and cannot capture context, so everything is reached through
//    these globals; all are populated in allstak_install, in normal context). ──

static uint8_t *gAllStakAltStack = nullptr;          // alternate signal stack
static uint8_t *gAllStakRecordBuffer = nullptr;      // handler-filled record bytes
static uintptr_t *gAllStakFrameBuffer = nullptr;     // backtrace target
static int gAllStakCrashFD = -1;                     // pre-opened record fd
static struct sigaction gAllStakPrevActions[6];      // saved prior dispositions
static int gAllStakPrevSignals[6];                   // parallel signal numbers
static int gAllStakInstalledCount = 0;
static volatile sig_atomic_t gAllStakInHandler = 0;
static volatile sig_atomic_t gAllStakInstalled = 0;

// ── Async-signal-safe libunwind backtrace ──
//
// _Unwind_Backtrace only walks the stack and calls our callback per frame — it
// performs no allocation and is safe to run from a signal handler on Android
// (this is exactly how Breakpad / Crashpad-style minimal collectors unwind).

struct AllStakUnwindState {
    uintptr_t *frames;
    int max;
    int count;
};

static _Unwind_Reason_Code AllStakUnwindCallback(struct _Unwind_Context *ctx, void *arg) {
    AllStakUnwindState *state = (AllStakUnwindState *)arg;
    if (state->count >= state->max) {
        return _URC_END_OF_STACK;
    }
    uintptr_t ip = (uintptr_t)_Unwind_GetIP(ctx);
    if (ip != 0) {
        state->frames[state->count++] = ip;
    }
    return _URC_NO_REASON;
}

static int AllStakCaptureBacktrace(uintptr_t *frames, int max) {
    AllStakUnwindState state;
    state.frames = frames;
    state.max = max;
    state.count = 0;
    _Unwind_Backtrace(AllStakUnwindCallback, &state);
    return state.count;
}

// ── Async-signal-safe little-endian writer (no allocation, no bounds growth) ──

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
            sigaction(signalNumber, &gAllStakPrevActions[i], nullptr);
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
        sigaction(signalNumber, &def, nullptr);
    }
    // Re-raise; the now-restored handler / default disposition takes over so
    // debuggerd's tombstone and any other chained reporter still run.
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

    if (gAllStakRecordBuffer != nullptr && gAllStakFrameBuffer != nullptr && gAllStakCrashFD >= 0) {
        int frameCount = AllStakCaptureBacktrace(gAllStakFrameBuffer, kAllStakSignalMaxFrames);

        uint64_t faultAddress = 0;
        if (info != nullptr) {
            faultAddress = (uint64_t)(uintptr_t)info->si_addr;
        }

        // time(NULL) is async-signal-safe.
        int64_t now = (int64_t)time(nullptr);

        int total = AllStakEncodeRecord(gAllStakRecordBuffer,
                                        kAllStakSignalMaxRecordSize,
                                        (int32_t)signalNumber,
                                        faultAddress,
                                        now,
                                        gAllStakFrameBuffer,
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

// ── Normal-context install (allocation + open() allowed here) ──
//
// Returns 1 on success (handlers armed), 0 on graceful failure (nothing armed,
// caller degrades to JVM-only capture). Idempotent.
static int allstak_install(const char *recordPath) {
    if (gAllStakInstalled) return 1; // idempotent
    if (recordPath == nullptr) return 0;

    // 1. Alternate signal stack — a faulting thread's own stack may be
    //    exhausted (e.g. SIGSEGV from a stack overflow), so the handler must
    //    run on its own stack.
    size_t stackSize = (size_t)SIGSTKSZ;
    if (stackSize < 64 * 1024) stackSize = 64 * 1024;
    gAllStakAltStack = (uint8_t *)malloc(stackSize);
    if (gAllStakAltStack != nullptr) {
        stack_t ss;
        memset(&ss, 0, sizeof(ss));
        ss.ss_sp = gAllStakAltStack;
        ss.ss_size = stackSize;
        ss.ss_flags = 0;
        sigaltstack(&ss, nullptr);
    }

    // 2. Pre-allocate the buffers the handler fills.
    gAllStakRecordBuffer = (uint8_t *)malloc((size_t)kAllStakSignalMaxRecordSize);
    gAllStakFrameBuffer = (uintptr_t *)malloc(sizeof(uintptr_t) * (size_t)kAllStakSignalMaxFrames);

    // 3. Pre-open the crash record file (O_CREAT|O_WRONLY|O_TRUNC). open() is
    //    NOT async-signal-safe so it must happen here, in normal context.
    gAllStakCrashFD = open(recordPath, O_WRONLY | O_CREAT | O_TRUNC, 0600);

    // If any critical pre-allocation failed, bail without arming handlers (so
    // we never run a handler that has no buffer to write into). The caller
    // degrades to JVM-only capture.
    if (gAllStakRecordBuffer == nullptr || gAllStakFrameBuffer == nullptr || gAllStakCrashFD < 0) {
        return 0;
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
    return installed > 0 ? 1 : 0;
}

#if defined(__ANDROID__)

// ── JNI bridge ──
//
// Registered via JNI_OnLoad with RegisterNatives so no header generation /
// name-mangling fragility. The Java class io.allstak.rn.AllStakNdk declares:
//     private static native boolean nativeInstall(String recordPath);

extern "C" jboolean AllStakNdk_nativeInstall(JNIEnv *env, jclass clazz, jstring jpath) {
    (void)clazz;
    if (jpath == nullptr) return JNI_FALSE;
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (path == nullptr) return JNI_FALSE;
    int ok = allstak_install(path);
    env->ReleaseStringUTFChars(jpath, path);
    return ok ? JNI_TRUE : JNI_FALSE;
}

static const JNINativeMethod kAllStakNativeMethods[] = {
    {"nativeInstall", "(Ljava/lang/String;)Z", (void *)AllStakNdk_nativeInstall},
};

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    JNIEnv *env = nullptr;
    if (vm->GetEnv((void **)&env, JNI_VERSION_1_6) != JNI_OK || env == nullptr) {
        return JNI_ERR;
    }
    jclass clazz = env->FindClass("io/allstak/rn/AllStakNdk");
    if (clazz == nullptr) {
        return JNI_ERR;
    }
    if (env->RegisterNatives(clazz, kAllStakNativeMethods,
                             (jint)(sizeof(kAllStakNativeMethods) /
                                    sizeof(kAllStakNativeMethods[0]))) != 0) {
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}

#endif // __ANDROID__
