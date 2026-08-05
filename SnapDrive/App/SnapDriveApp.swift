import SwiftUI

@main
struct SnapDriveApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var auth = OneDriveAuth()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(settings)
                .environmentObject(auth)
        }
    }
}

// MARK: - Shared formatting

enum Format {
    static func bytes(_ count: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowedUnits = count < 1_000_000 ? [.useKB] : [.useMB]
        return formatter.string(fromByteCount: Int64(count))
    }

    static func relative(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
