// swift-tools-version: 6.4

import PackageDescription

// Everything that isn't Mac-specific: the API models, the client, the live feed, formatting and shared views.
// It also targets iOS, because an iOS app is coming (WORK-335). No dependencies, on purpose.
let package = Package(
    name: "PricetagKit",
    platforms: [.macOS(.v27), .iOS(.v27)],
    products: [.library(name: "PricetagKit", targets: ["PricetagKit"])],
    targets: [
        .target(name: "PricetagKit"),
        .testTarget(name: "PricetagKitTests", dependencies: ["PricetagKit"], resources: [.copy("Resources")]),
    ]
)
