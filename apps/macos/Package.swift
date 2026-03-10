// swift-tools-version: 6.0
// Package manifest for the Verso macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "Verso",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "VersoIPC", targets: ["VersoIPC"]),
        .library(name: "VersoDiscovery", targets: ["VersoDiscovery"]),
        .executable(name: "Verso", targets: ["Verso"]),
        .executable(name: "openclaw-mac", targets: ["VersoMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(path: "../shared/VersoKit"),
        .package(path: "../shared/OpenClawKit"),
    ],
    targets: [
        .target(
            name: "VersoIPC",
            dependencies: [],
            path: "Sources/OpenClawIPC",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "VersoDiscovery",
            dependencies: [
                .product(name: "VersoKit", package: "VersoKit"),
            ],
            path: "Sources/OpenClawDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Verso",
            dependencies: [
                "VersoIPC",
                "VersoDiscovery",
                .product(name: "VersoKit", package: "VersoKit"),
                .product(name: "VersoChatUI", package: "VersoKit"),
                .product(name: "VersoProtocol", package: "VersoKit"),
                .product(name: "OpenClawKit", package: "OpenClawKit"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/OpenClaw",
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/Verso.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "VersoMacCLI",
            dependencies: [
                "VersoDiscovery",
                .product(name: "VersoKit", package: "VersoKit"),
                .product(name: "VersoProtocol", package: "VersoKit"),
            ],
            path: "Sources/OpenClawMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "VersoIPCTests",
            dependencies: [
                "VersoIPC",
                "Verso",
                "VersoDiscovery",
                .product(name: "VersoProtocol", package: "VersoKit"),
                .product(name: "OpenClawKit", package: "OpenClawKit"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
