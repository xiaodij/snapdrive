import Foundation
import Security

/// Minimal keychain wrapper for the OAuth tokens.
///
/// Tokens are the one genuinely sensitive thing the app holds, so they live here rather
/// than in UserDefaults. `ThisDeviceOnly` keeps them out of iCloud Keychain backups —
/// a refresh token restored onto another device would be a credential leak, and
/// re-authenticating after a restore costs one tap.
enum Keychain {

    private static let service = "com.xiaodijin.snap.onedrive"

    static func set(_ data: Data, for account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)

        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(insert as CFDictionary, nil)
    }

    static func get(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func delete(_ account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }

    static func setObject<T: Encodable>(_ value: T, for account: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        set(data, for: account)
    }

    static func object<T: Decodable>(_ type: T.Type, for account: String) -> T? {
        guard let data = get(account) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
