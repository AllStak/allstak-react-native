# @allstak/react-native

AllStak React Native SDK for JavaScript errors, native crashes, logs, breadcrumbs, HTTP telemetry, navigation breadcrumbs, and source maps.

## Install

```bash
npm install @allstak/react-native
```

Peer requirements:

| Peer | Version |
| --- | --- |
| `react` | `>=16.8.0` |
| `react-native` | `>=0.70` |

## Setup

Initialize the SDK as early as possible in your app entry file:

```tsx
import * as AllStak from '@allstak/react-native';
import App from './App';

AllStak.init({
  apiKey: process.env.EXPO_PUBLIC_ALLSTAK_API_KEY,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.EXPO_PUBLIC_RELEASE,
  tracesSampleRate: 1.0,
  enableLogs: true,
});

export default AllStak.wrap(App);
```

## Provider setup

```tsx
import { AllStakProvider } from '@allstak/react-native';

export default function Root() {
  return (
    <AllStakProvider
      apiKey={process.env.EXPO_PUBLIC_ALLSTAK_API_KEY}
      environment="production"
      release={process.env.EXPO_PUBLIC_RELEASE}
    >
      <App />
    </AllStakProvider>
  );
}
```

## Metro source maps

```js
const { withAllStakConfig } = require('@allstak/react-native/metro');

module.exports = withAllStakConfig({
  resolver: {},
  transformer: {},
});
```

## Expo plugin

```json
{
  "expo": {
    "plugins": ["@allstak/react-native"]
  }
}
```

## Useful API

```tsx
AllStak.captureException(new Error('checkout failed'));
AllStak.captureMessage('cart opened', 'info');
AllStak.logger.warn('payment retry');
AllStak.setUser({ id: 'user_123', email: 'user@example.com' });
await AllStak.flush();
```

## Privacy

Use privacy components around sensitive UI so screenshots and replay metadata stay safe:

```tsx
import { AllStakPrivacyView } from '@allstak/react-native';

<AllStakPrivacyView>
  <CreditCardForm />
</AllStakPrivacyView>
```

## Troubleshooting

- No events: confirm the API key is available in the mobile runtime.
- Native crashes missing: rebuild the native app after adding the package or Expo plugin.
- Source maps missing: keep runtime `release` aligned with the uploaded build release.

## License

MIT
