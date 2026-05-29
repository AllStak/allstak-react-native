# CMake build for the AllStak NDK / native-signal crash handler.
#
# Referenced from native/android/build.gradle via android.externalNativeBuild.
# Produces liballstak_signal.so, packaged into the host APK by the standard RN
# Gradle pipeline. AllStakNdk.java loads it with System.loadLibrary and degrades
# gracefully (JVM-only crash capture) if the library is absent or fails to load.

cmake_minimum_required(VERSION 3.18.1)

project(allstak_signal LANGUAGES CXX)

add_library(allstak_signal SHARED
    allstak_signal_handler.cpp)

target_compile_features(allstak_signal PRIVATE cxx_std_14)

# -fexceptions/-frtti are NOT needed: the handler uses no C++ exceptions or RTTI.
# Keep the .so small and dependency-light.
target_compile_options(allstak_signal PRIVATE
    -fno-exceptions
    -fno-rtti
    -fvisibility=hidden
    -Wall)

# Android system libs: log is optional (the handler does not log from the
# signal path), but linking it keeps parity with typical NDK modules and is
# harmless. The C++ runtime + libunwind (for _Unwind_Backtrace) come from the
# NDK toolchain automatically.
find_library(log-lib log)
target_link_libraries(allstak_signal ${log-lib})
