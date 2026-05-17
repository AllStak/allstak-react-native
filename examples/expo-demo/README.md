# AllStak Expo Demo

Minimal Expo app demonstrating the `@allstak/react-native` SDK for error capture, breadcrumbs, and HTTP instrumentation.

## Setup

```bash
# Install dependencies (links the local SDK via file:../../)
npx expo install

# Copy and fill in your API key
cp .env.example .env

# Start the Expo dev server
npx expo start
```

Scan the QR code with Expo Go (iOS/Android) or press `i`/`a` to open in a simulator.

## Features Demonstrated

| Button | SDK Feature |
|---|---|
| **Trigger JS Error** | `throw` inside render — caught by `AllStakProvider`'s built-in `ErrorBoundary` |
| **Trigger Promise Rejection** | Unhandled `Promise.reject` — caught by AllStak's rejection tracking hook |
| **Manual Capture** | `AllStak.captureException()` with custom metadata |
| **Add Breadcrumb** | `AllStak.addBreadcrumb()` — attaches context to the next error |
| **Test Network Request** | `fetch()` call — auto-instrumented when `enableHttpTracking` is on |

## Configuration

The app wraps everything in `<AllStakProvider>` which handles:

- SDK initialization
- Error boundary (renders fallback UI on crash)
- React Native install hooks (ErrorUtils, promise rejection tracking)
- HTTP instrumentation (when `enableHttpTracking` is set)
