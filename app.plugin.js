// Expo entrypoint — re-exports the actual plugin from `dist/expo-plugin.js`
// so consumers can write `"plugins": ["@allstak/react-native"]` in their
// app.json and Expo's `withPlugins` resolver finds it without an extra
// import path. Expo looks for `app.plugin.js` at the package root by
// convention.
module.exports = require('./dist/expo-plugin.js');
