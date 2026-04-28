require "json"

# Read package.json so the podspec version always matches the npm version.
package = JSON.parse(File.read(File.join(__dir__, "..", "..", "package.json")))

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

  s.source_files     = "*.{h,m,mm}"
  s.requires_arc     = true

  s.dependency "React-Core"
end
