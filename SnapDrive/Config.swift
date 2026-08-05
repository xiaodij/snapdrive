import Foundation

/// OneDrive / Microsoft Graph configuration.
///
/// Nothing here is hardcoded to a particular fork. The bundle identifier comes from the
/// running bundle, and the client ID and tenant are read from Info.plist, where the build
/// substitutes them from `Config.xcconfig`. So the OAuth redirect URI is always derived
/// from the actual bundle identifier and cannot drift out of sync with it — the classic
/// way these setups break is three copies of the same string quietly disagreeing.
///
/// To point this at your own Azure app registration, edit `Config.xcconfig`.
enum Config {

    // MARK: - Fork configuration (Config.xcconfig -> Info.plist -> here)

    /// Compiled-in client ID. A value saved in Settings takes precedence over it.
    static let defaultClientID = infoValue("SnapClientID")

    /// Which Microsoft accounts may sign in — must match the registration's audience.
    ///
    /// `consumers` = personal accounts, `organizations` = work/school, `common` = both,
    /// or a specific tenant id.
    static var tenant: String {
        let value = infoValue("SnapTenant")
        return value.isEmpty ? "consumers" : value
    }

    static var bundleID: String { Bundle.main.bundleIdentifier ?? "" }

    // MARK: - Client ID

    static var clientID: String {
        let stored = UserDefaults.standard.string(forKey: "onedrive.clientID") ?? ""
        return stored.isEmpty ? defaultClientID : stored
    }

    static func setClientID(_ value: String) {
        UserDefaults.standard.set(value.trimmingCharacters(in: .whitespacesAndNewlines),
                                  forKey: "onedrive.clientID")
    }

    static var isConfigured: Bool { !clientID.isEmpty }

    // MARK: - OAuth

    /// Azure's sanctioned redirect shape for iOS public clients. This exact string has to
    /// be registered on the app under "Mobile and desktop applications".
    static var redirectScheme: String { "msauth.\(bundleID)" }
    static var redirectURI: String { "\(redirectScheme)://auth" }

    /// `offline_access` is what yields a refresh token — without it the app would need a
    /// full interactive sign-in roughly every hour.
    static let scopes = ["Files.ReadWrite", "User.Read", "offline_access"]

    static var authorizeURL: URL {
        URL(string: "https://login.microsoftonline.com/\(tenant)/oauth2/v2.0/authorize")!
    }
    static var tokenURL: URL {
        URL(string: "https://login.microsoftonline.com/\(tenant)/oauth2/v2.0/token")!
    }
    static let graphBase = "https://graph.microsoft.com/v1.0"

    /// Graph accepts a plain PUT below 4 MB; anything larger needs a chunked upload session.
    static let simpleUploadLimit = 4 * 1024 * 1024

    // MARK: - Helpers

    private static func infoValue(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return "" }
        // A literal "$(SNAP_CLIENT_ID)" means the xcconfig wasn't applied. Treat it as
        // unset so the UI asks for a client ID rather than sending nonsense to Azure.
        return value.hasPrefix("$(") ? "" : value
    }
}
