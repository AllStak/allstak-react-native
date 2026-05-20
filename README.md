# @allstak/react-native

React Native SDK for AllStak error monitoring.

[![npm version](https://img.shields.io/npm/v/@allstak/react-native.svg)](https://www.npmjs.com/package/@allstak/react-native)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Agent-Assisted Setup

Run the wizard:

```bash
npx @allstak/wizard@latest -i reactNative
```

The wizard patches your React Native project automatically. You only need to run
it once, then commit the patched project files.

## Install

If you prefer manual setup:

```bash
npm install @allstak/react-native
```

Peer requirements:

| Peer | Version |
| --- | --- |
| React | `>=16.8.0` |
| React Native | `>=0.70` |

## Configure

Initialize the SDK as early as possible in your app entry file.

```tsx
import * as AllStak from "@allstak/react-native";

AllStak.init({
  apiKey: "ask_live_...",
  sendDefaultPii: true,
});

export default AllStak.wrap(App);
```

## Features

Error monitoring is enabled by default after initialization. You can also turn
on additional features when your project needs them:

```tsx
AllStak.init({
  apiKey: "ask_live_...",
  sendDefaultPii: true,
  // Capture 100% of tracing spans. Adjust this value in production.
  tracesSampleRate: 1.0,
  // Send logs created with AllStak.log(...) or AllStak.logger.*(...).
  enableLogs: true,
});
```

## Verify

Add an intentional error while testing your setup. You should see it in AllStak
within a few minutes.

```tsx
throw new Error("My first AllStak error!");
```

## Next Steps

- Add readable stack traces with source maps.
- Review data collection and privacy settings.
- Capture custom errors and messages where needed.

## Links

- Dashboard: https://app.allstak.sa
- Documentation: https://docs.allstak.sa
- Package: https://www.npmjs.com/package/@allstak/react-native

## License

MIT (c) AllStak
