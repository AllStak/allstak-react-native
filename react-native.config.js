/**
 * React Native autolinking config.
 *
 * Tells the RN CLI (>= 0.60) where to find the native iOS / Android crash
 * modules that ship under ./native. With this in place, consumers no
 * longer have to hand-edit Podfile or settings.gradle — `npx pod-install`
 * (iOS) and a Gradle sync (Android) wire AllStakRNModule and
 * AllStakCrashHandler into the host app automatically.
 *
 * iOS: the podspec lives at `native/ios/AllStakRN.podspec` (added in the
 * same change). Android: the project's build.gradle and AndroidManifest.xml
 * under `native/android/` follow the standard RN module layout the CLI
 * expects.
 */
module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: require('node:path').resolve(__dirname, 'native/ios/AllStakRN.podspec'),
      },
      android: {
        sourceDir: './native/android',
        packageImportPath: 'import io.allstak.rn.AllStakRNPackage;',
        packageInstance: 'new AllStakRNPackage()',
      },
    },
  },
};
