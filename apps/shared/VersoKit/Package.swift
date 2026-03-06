// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "VersoKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "VersoProtocol", targets: ["VersoProtocol"]),
        .library(name: "VersoKit", targets: ["VersoKit"]),
        .library(name: "VersoChatUI", targets: ["VersoChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "VersoProtocol",
            path: "Sources/VersoProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "VersoKit",
            dependencies: [
                "VersoProtocol",
            ],
            path: "Sources/VersoKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "VersoChatUI",
            dependencies: [
                "VersoKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/VersoChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "VersoKitTests",
            dependencies: ["VersoKit", "VersoChatUI"],
            path: "Tests/VersoKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
