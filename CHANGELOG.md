# Changelog

All notable public changes to `@allstak/react-native` are documented here.

## 0.5.9 - 2026-05-20

- Added performance trace sampling metadata, propagation headers, app-start spans, navigation spans, native frame metrics, HTTP spans, and sampled profile chunks.

## 0.5.8 - 2026-05-20

- Fixed HTTP response body capture metadata so unavailable React Native
  response bodies are reported as unsupported instead of disabled.
- Kept request and response body capture enabled by default with automatic
  sensitive-field redaction.

## 0.5.5 - 2026-05-20

- Moved error screenshots to the SDK native module so apps do not need an
  external screenshot package.

## 0.5.4 - 2026-05-20

- Simplified the public React Native README to match the standard setup flow:
  agent-assisted setup, install, configure, verify, and next steps.
- Removed advanced setup details from the package quickstart docs.

## 0.5.3 - 2026-05-20

- Cleaned the public README.

## 0.5.2 - 2026-05-20

- Updated package documentation and npm package hygiene.

## 0.5.1 - 2026-05-20

- Updated React Native event capture behavior and public package metadata.

## 0.5.0 - 2026-05-18

- Added richer React Native event context.

## 0.4.0 - 2026-05-17

- Added React Native package foundation.
