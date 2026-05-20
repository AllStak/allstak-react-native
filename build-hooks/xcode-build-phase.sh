#!/usr/bin/env bash
# AllStak source-map upload — iOS Xcode build phase.
#
# Add a new "Run Script" build phase to your iOS app target in Xcode,
# AFTER the React Native "Bundle React Native code and images" phase,
# with this exact body:
#
#   "$SRCROOT/../node_modules/@allstak/react-native/build-hooks/xcode-build-phase.sh"
#
# Optional env vars:
#
#   ALLSTAK_RELEASE        = com.company.app@1.2.3+5  (optional override)
#   ALLSTAK_UPLOAD_TOKEN   = build-only source-map upload credential
#   ALLSTAK_HOST           = https://api.allstak.sa  (optional)
#   ALLSTAK_DIST_OVERRIDE  = ios-hermes              (optional override)
#
# This script auto-detects the bundle + sourcemap that the React Native
# Xcode build phase wrote and runs the SDK's uploader on them. It only
# runs in Release builds — Debug builds are no-ops.
#
# Exits 0 even on upload failure so a flaky CI step doesn't fail your
# archive. The hook script logs everything to the build log.

set -e

if [[ "${CONFIGURATION}" != "Release" ]]; then
  echo "[allstak] CONFIGURATION=${CONFIGURATION} — skipping sourcemap upload (Release-only)"
  exit 0
fi

if [[ -z "${ALLSTAK_RELEASE}" ]]; then
  APP_ID="${PRODUCT_BUNDLE_IDENTIFIER:-}"
  APP_VERSION="${MARKETING_VERSION:-}"
  APP_BUILD="${CURRENT_PROJECT_VERSION:-}"
  if [[ -n "${APP_ID}" && -n "${APP_VERSION}" ]]; then
    ALLSTAK_RELEASE="${APP_ID}@${APP_VERSION}"
    if [[ -n "${APP_BUILD}" ]]; then
      ALLSTAK_RELEASE="${ALLSTAK_RELEASE}+${APP_BUILD}"
    fi
    echo "[allstak] derived release=${ALLSTAK_RELEASE}"
  else
    echo "[allstak] could not derive release from PRODUCT_BUNDLE_IDENTIFIER/MARKETING_VERSION and ALLSTAK_RELEASE is not set — skipping sourcemap upload"
    exit 0
  fi
fi

# Locate the bundle + map relative to standard React Native output paths.
# The RN Xcode build phase writes:
#   ${CONFIGURATION_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/main.jsbundle
#   ${CONFIGURATION_BUILD_DIR}/main.jsbundle.map
BUNDLE="${CONFIGURATION_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/main.jsbundle"
MAP="${CONFIGURATION_BUILD_DIR}/main.jsbundle.map"

if [[ ! -f "${BUNDLE}" ]]; then
  echo "[allstak] bundle not found at ${BUNDLE} — skipping"
  exit 0
fi
if [[ ! -f "${MAP}" ]]; then
  echo "[allstak] sourcemap not found at ${MAP} — skipping (set SOURCEMAP_FILE in your bundle build phase)"
  exit 0
fi

# Resolve the hook script. Default location: node_modules in the JS root
# above the iOS project. Override via ALLSTAK_HOOK_SCRIPT.
HOOK_SCRIPT="${ALLSTAK_HOOK_SCRIPT:-${SRCROOT}/../node_modules/@allstak/react-native/build-hooks/upload-sourcemaps.js}"
if [[ ! -f "${HOOK_SCRIPT}" ]]; then
  echo "[allstak] hook script not found at ${HOOK_SCRIPT} — is @allstak/react-native installed?"
  exit 0
fi

# Find a usable Node binary. Xcode build phases don't inherit the user's
# PATH, so check the common locations.
if [[ -z "${NODE_BINARY}" ]]; then
  for candidate in \
    "$(command -v node 2>/dev/null)" \
    "/usr/local/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/bin/node" ; do
    if [[ -x "${candidate}" ]]; then
      NODE_BINARY="${candidate}"
      break
    fi
  done
fi
if [[ -z "${NODE_BINARY}" || ! -x "${NODE_BINARY}" ]]; then
  echo "[allstak] could not locate a Node binary — set NODE_BINARY in your build phase"
  exit 0
fi

DIST="${ALLSTAK_DIST_OVERRIDE:-ios-hermes}"
if [[ -z "${ALLSTAK_UPLOAD_TOKEN:-}" ]]; then
  PROP_FILE="${SRCROOT}/allstak.properties"
  if [[ -f "${PROP_FILE}" ]]; then
    ALLSTAK_UPLOAD_TOKEN="$(awk -F= '/^auth\.token=/{print substr($0, index($0,$2)); exit}' "${PROP_FILE}")"
    export ALLSTAK_UPLOAD_TOKEN
  fi
fi

echo "[allstak] uploading sourcemap for ${BUNDLE} (release=${ALLSTAK_RELEASE} dist=${DIST})"

# Don't fail the archive if the upload errors. Log and continue.
"${NODE_BINARY}" "${HOOK_SCRIPT}" \
  --bundle "${BUNDLE}" \
  --sourcemap "${MAP}" \
  --platform ios \
  --dist "${DIST}" \
  || echo "[allstak] sourcemap upload reported non-zero — see log above"
