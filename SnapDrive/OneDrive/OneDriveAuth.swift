import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

enum OneDriveError: LocalizedError {
    case notConfigured
    case notSignedIn
    case authCancelled
    case authFailed(String)
    case requestFailed(Int, String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No Azure client ID has been set. Add one in Settings."
        case .notSignedIn:
            return "Not signed in to OneDrive."
        case .authCancelled:
            return "Sign-in was cancelled."
        case .authFailed(let detail):
            return "Sign-in failed: \(detail)"
        case .requestFailed(let code, let detail):
            return "OneDrive returned \(code): \(detail)"
        case .badResponse:
            return "Unexpected response from OneDrive."
        }
    }
}

/// OAuth 2.0 authorisation-code flow with PKCE, straight against the Microsoft identity
/// platform — no MSAL dependency.
///
/// PKCE is what makes it safe to ship a public client with no secret: the app sends a
/// hash of a one-time random verifier up front, then the real verifier when redeeming the
/// code, so a stolen redirect is useless on its own.
@MainActor
final class OneDriveAuth: NSObject, ObservableObject {

    struct Account: Codable, Equatable {
        var displayName: String
        var email: String
    }

    private struct Tokens: Codable {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Date
    }

    @Published private(set) var account: Account?
    @Published private(set) var isWorking = false

    private var tokens: Tokens?
    private var session: ASWebAuthenticationSession?

    private static let tokenKey = "tokens"
    private static let accountKey = "account.info"

    var isSignedIn: Bool { tokens != nil }

    override init() {
        super.init()
        tokens = Keychain.object(Tokens.self, for: Self.tokenKey)
        account = Keychain.object(Account.self, for: Self.accountKey)
    }

    // MARK: - Sign in / out

    func signIn() async throws {
        guard Config.isConfigured else { throw OneDriveError.notConfigured }
        isWorking = true
        defer { isWorking = false }

        let verifier = Self.randomCodeVerifier()
        let challenge = Self.codeChallenge(for: verifier)

        var components = URLComponents(url: Config.authorizeURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: Config.clientID),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: Config.redirectURI),
            URLQueryItem(name: "response_mode", value: "query"),
            URLQueryItem(name: "scope", value: Config.scopes.joined(separator: " ")),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "prompt", value: "select_account")
        ]

        let callback = try await presentAuthSession(url: components.url!)
        guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value
        else {
            let error = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "error_description" })?.value
            throw OneDriveError.authFailed(error ?? "no authorisation code returned")
        }

        try await redeem(parameters: [
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": Config.redirectURI,
            "code_verifier": verifier
        ])
        await loadAccountInfo()
    }

    func signOut() {
        tokens = nil
        account = nil
        Keychain.delete(Self.tokenKey)
        Keychain.delete(Self.accountKey)
    }

    /// A valid access token, refreshed transparently when it's close to expiring.
    func accessToken() async throws -> String {
        guard let current = tokens else { throw OneDriveError.notSignedIn }
        // 60s of slack so a token can't expire mid-upload.
        if current.expiresAt.timeIntervalSinceNow > 60 { return current.accessToken }

        try await redeem(parameters: [
            "grant_type": "refresh_token",
            "refresh_token": current.refreshToken,
            "redirect_uri": Config.redirectURI
        ])
        guard let refreshed = tokens else { throw OneDriveError.notSignedIn }
        return refreshed.accessToken
    }

    // MARK: - Token endpoint

    private func redeem(parameters: [String: String]) async throws {
        var body = parameters
        body["client_id"] = Config.clientID
        body["scope"] = Config.scopes.joined(separator: " ")

        var request = URLRequest(url: Config.tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
            .map { "\($0.key)=\(Self.formEncode($0.value))" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw OneDriveError.badResponse }

        guard http.statusCode == 200 else {
            let detail = (try? JSONDecoder().decode(TokenErrorResponse.self, from: data))?.errorDescription
                ?? String(data: data, encoding: .utf8)
                ?? "unknown"
            // A dead refresh token can never recover on its own — drop it so the UI falls
            // back to offering a fresh sign-in rather than looping on a doomed refresh.
            if parameters["grant_type"] == "refresh_token" { signOut() }
            throw OneDriveError.authFailed(detail)
        }

        let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
        let new = Tokens(
            accessToken: decoded.accessToken,
            // Microsoft may omit a rotated refresh token; keep the existing one if so.
            refreshToken: decoded.refreshToken ?? tokens?.refreshToken ?? "",
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expiresIn))
        )
        tokens = new
        Keychain.setObject(new, for: Self.tokenKey)
    }

    private func loadAccountInfo() async {
        guard let token = try? await accessToken() else { return }
        var request = URLRequest(url: URL(string: "\(Config.graphBase)/me")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let me = try? JSONDecoder().decode(GraphUser.self, from: data)
        else { return }

        let info = Account(
            displayName: me.displayName ?? "OneDrive",
            email: me.userPrincipalName ?? me.mail ?? ""
        )
        account = info
        Keychain.setObject(info, for: Self.accountKey)
    }

    // MARK: - Web session

    private func presentAuthSession(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: Config.redirectScheme
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else if let error = error as? ASWebAuthenticationSessionError,
                          error.code == .canceledLogin {
                    continuation.resume(throwing: OneDriveError.authCancelled)
                } else {
                    continuation.resume(throwing: OneDriveError.authFailed(
                        error?.localizedDescription ?? "unknown"))
                }
            }
            session.presentationContextProvider = self
            // Reuse any existing Microsoft session cookies so signing in is usually just
            // picking the account rather than retyping a password.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            session.start()
        }
    }

    // MARK: - PKCE

    private static func randomCodeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 64)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64URL(Data(bytes))
    }

    private static func codeChallenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func formEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

extension OneDriveAuth: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}

// MARK: - Wire types

private struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

private struct TokenErrorResponse: Decodable {
    let errorDescription: String?
    enum CodingKeys: String, CodingKey { case errorDescription = "error_description" }
}

private struct GraphUser: Decodable {
    let displayName: String?
    let userPrincipalName: String?
    let mail: String?
}
