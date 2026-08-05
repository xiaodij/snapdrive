// swift-tools-version: 5.9
//
// This package exists ONLY to run the image/PDF pipeline on macOS for testing.
// The shipping app is the Xcode project generated from project.yml.
//
// Everything under Snap/Core is deliberately free of UIKit/VisionKit so it can be
// compiled and exercised here as well as on the phone.
//
//   swift run PipelineTest
//
import PackageDescription

let package = Package(
    name: "SnapTools",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "PipelineTest",
            path: ".",
            sources: ["Snap/Core", "Tools/PipelineTest"]
        )
    ]
)
