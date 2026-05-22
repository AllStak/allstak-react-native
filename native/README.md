# @allstak/react-native native modules

Native crash support is included with `@allstak/react-native`.

Install the package, add the Expo plugin when using Expo, then rebuild the native app:

```bash
npm install @allstak/react-native
```

```json
{
  "expo": {
    "plugins": ["@allstak/react-native"]
  }
}
```

```bash
npx expo prebuild
npx expo run:ios
npx expo run:android
```

Bare React Native apps should rebuild iOS and Android after package installation so native crash handlers are linked.
