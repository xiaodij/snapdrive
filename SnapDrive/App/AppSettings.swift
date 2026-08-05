import Foundation
import SwiftUI

/// A file that has been uploaded, kept for the home screen's recent list.
struct UploadRecord: Codable, Identifiable, Hashable {
    var id = UUID()
    var filename: String
    var folderPath: String
    var date: Date
    var byteCount: Int
    var pageCount: Int
    var webURL: String?
}

@MainActor
final class AppSettings: ObservableObject {

    @Published var quality: QualityTier { didSet { save(quality.rawValue, "quality") } }
    @Published var ocrEnabled: Bool { didSet { save(ocrEnabled, "ocrEnabled") } }
    @Published var languages: [String] { didSet { saveJSON(languages, "languages") } }
    @Published var defaultFolder: FolderRef { didSet { saveJSON(defaultFolder, "defaultFolder") } }
    @Published var useOCRTitle: Bool { didSet { save(useOCRTitle, "useOCRTitle") } }
    @Published var defaultColorMode: String { didSet { save(defaultColorMode, "defaultColorMode") } }
    @Published private(set) var recents: [UploadRecord] { didSet { saveJSON(recents, "recents") } }

    private let store = UserDefaults.standard

    init() {
        let store = UserDefaults.standard
        quality = QualityTier(rawValue: store.string(forKey: "quality") ?? "") ?? .balanced
        ocrEnabled = store.object(forKey: "ocrEnabled") as? Bool ?? true
        useOCRTitle = store.object(forKey: "useOCRTitle") as? Bool ?? true
        defaultColorMode = store.string(forKey: "defaultColorMode") ?? "auto"
        languages = Self.loadJSON([String].self, "languages", from: store) ?? ["en-US"]
        defaultFolder = Self.loadJSON(FolderRef.self, "defaultFolder", from: store) ?? .root
        recents = Self.loadJSON([UploadRecord].self, "recents", from: store) ?? []
    }

    /// `.auto` unless the user has pinned a specific mode for every scan.
    var colorSelection: ColorModeSelection {
        guard let mode = ColorMode(rawValue: defaultColorMode) else { return .auto }
        return .forced(mode)
    }

    func record(_ entry: UploadRecord) {
        recents.insert(entry, at: 0)
        if recents.count > 20 { recents.removeLast(recents.count - 20) }
    }

    func clearRecents() { recents = [] }

    // MARK: - Persistence

    private func save(_ value: Any, _ key: String) { store.set(value, forKey: key) }

    private func saveJSON<T: Encodable>(_ value: T, _ key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        store.set(data, forKey: key)
    }

    private static func loadJSON<T: Decodable>(_ type: T.Type, _ key: String, from store: UserDefaults) -> T? {
        guard let data = store.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
