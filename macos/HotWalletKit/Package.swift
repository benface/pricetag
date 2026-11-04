// swift-tools-version: 6.4

import PackageDescription

// KeyVault is the only code that touches a key: it holds the two cryptography dependencies, and has no network or UI.
// HotWalletKit decides what to do with the wallet, and can only ask the vault to sign. Both also target iOS (WORK-335).
// Dependencies are pinned exactly, and Package.resolved is committed. See HOT-WALLET-SECURITY.md for why these two.
let package = Package(
    name: "HotWalletKit",
    platforms: [.macOS(.v27), .iOS(.v27)],
    products: [
        .library(name: "KeyVault", targets: ["KeyVault"]),
        .library(name: "HotWalletKit", targets: ["HotWalletKit"]),
    ],
    dependencies: [
        .package(path: "../PricetagKit"),
        .package(url: "https://github.com/21-DOT-DEV/swift-secp256k1", exact: "0.24.0"),
        .package(url: "https://github.com/krzyzanowskim/CryptoSwift", exact: "1.10.0"),
    ],
    targets: [
        .target(
            name: "KeyVault",
            dependencies: [
                .product(name: "libsecp256k1", package: "swift-secp256k1"),
                .product(name: "CryptoSwift", package: "CryptoSwift"),
            ]
        ),
        .target(name: "HotWalletKit", dependencies: ["KeyVault", "PricetagKit"]),
        .testTarget(name: "KeyVaultTests", dependencies: ["KeyVault"]),
        .testTarget(name: "HotWalletKitTests", dependencies: ["HotWalletKit", "PricetagKit"], resources: [.copy("Resources")]),
    ]
)
