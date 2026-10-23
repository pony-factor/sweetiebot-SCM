// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Prefer a user-maintained sibling fork without vendoring CoreML-LLM or its
// conversion scripts into Sweetiebot. Pin upstream when no fork is selected.
let localFork = ProcessInfo.processInfo.environment["SWEETIEBOT_COREML_LLM_FORK"]
let dependency: Package.Dependency = {
    if let path = localFork, !path.isEmpty {
        return .package(path: NSString(string: path).expandingTildeInPath)
    }
    return .package(url: "https://github.com/john-rocky/CoreML-LLM", exact: "1.9.0")
}()

let package = Package(
    name: "SweetiebotANE",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "sweetiebot-ane", targets: ["SweetiebotANE"])],
    dependencies: [dependency],
    targets: [
        .executableTarget(
            name: "SweetiebotANE",
            dependencies: [.product(name: "CoreMLLLM", package: "CoreML-LLM")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
