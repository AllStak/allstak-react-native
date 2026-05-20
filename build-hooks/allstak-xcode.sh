#!/usr/bin/env bash
# AllStak React Native Xcode wrapper.
#
# Replace the standard "Bundle React Native code and images" script with this
# wrapper. It runs the normal React Native bundling script first, then runs the
# AllStak source-map upload phase against the generated bundle and map.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WITH_ENVIRONMENT="${WITH_ENVIRONMENT:-${SRCROOT}/../node_modules/react-native/scripts/xcode/with-environment.sh}"
REACT_NATIVE_XCODE="${REACT_NATIVE_XCODE:-${SRCROOT}/../node_modules/react-native/scripts/react-native-xcode.sh}"

if [[ -f "${WITH_ENVIRONMENT}" ]]; then
  /bin/sh -c "\"${WITH_ENVIRONMENT}\" \"${REACT_NATIVE_XCODE}\""
else
  /bin/sh "${REACT_NATIVE_XCODE}"
fi

/bin/bash "${SCRIPT_DIR}/xcode-build-phase.sh"
