import Foundation

/// OneDrive / Microsoft Graph configuration.
///
/// The client ID comes from an Azure app registration — see README.md. It can be pasted
/// into Settings at runtime so a rebuild isn't needed to change it, and that value wins
/// over the compiled-in default.
enum Config {

    /// Azure "Application (client) ID" for the `Snap` app registration
    /// (audience: personal Microsoft accounts).
    ///
    /// Not a secret. A public client can't keep one, which is why the flow uses PKCE
    /// instead — the client ID alone is useless without the one-time code verifier, and
    /// it grants no access to anything until a user signs in and consents to their own
    /// OneDrive.
    ///
    /// If you forked this, register your own (see README) rather than reusing this ID.
    static let defaultClientID = "de30792a-98aa-4d0a-90e5-0f86eda12646"

    static var clientID: String {
        let stored = UserDefaults.standard.string(forKey: "onedrive.clientID") ?? ""
        return stored.isEmpty ? defaultClientID : stored
    }

    static func setClientID(_ value: String) {
        UserDefaults.standard.set(value.trimmingCharacters(in: .whitespacesAndNewlines),
                                  forKey: "onedrive.clientID")
    }

    static var isConfigured: Bool { !clientID.isEmpty }

    static let bundleID = "com.xiaodijin.snap"

    /// Azure's sanctioned redirect shape for iOS public clients. Must match the redirect
    /// URI registered under the app's "Mobile and desktop applications" platform, and the
    /// scheme must also appear in Info.plist's CFBundleURLTypes.
    static var redirectScheme: String { "msauth.\(bundleID)" }
    static var redirectURI: String { "\(redirectScheme)://auth" }

    /// `consumers` = personal Microsoft accounts (outlook/hotmail/live).
    /// Switch to `common` to also allow work/school accounts.
    static let tenant = "consumers"

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
}
