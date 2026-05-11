require "json"

# Root-level podspec — modern @react-native-community/cli auto-discovers
# the iOS native module by scanning the package root for `*.podspec`. This
# file simply re-exports the real spec under native/ios/.

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name             = "AllStakRN"
  s.version          = package["version"]
  s.summary          = "AllStak React Native — native iOS crash capture"
  s.description      = "Captures uncaught NSExceptions on iOS, persists them across launches, and exposes drainPendingCrash() to the JS layer."
  s.homepage         = package["homepage"]
  s.license          = "MIT"
  s.authors          = { "AllStak" => "hello@allstak.io" }
  s.platforms        = { :ios => "12.0" }
  s.source           = { :git => package["repository"]["url"], :tag => "v#{s.version}" }

  # Source files live under native/ios/ to keep the package layout clean.
  s.source_files     = "native/ios/*.{h,m,mm}"
  s.requires_arc     = true

  s.dependency "React-Core"
end
