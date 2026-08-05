import Foundation
import os

/// Unified-logging channels.
///
/// Readable from a Mac with the phone connected:
///
///     log collect --device-udid <udid> --last 10m --output snap.logband
///     log show snap.logband --predicate 'subsystem == "com.xiaodijin.snap"' --info
///
/// or live in Console.app by selecting the device and filtering on the subsystem.
///
/// Note that `os.Logger` redacts interpolated values by default. Anything marked
/// `privacy: .public` here is deliberately non-sensitive — sizes, HTTP status codes,
/// stage names — because a log that says `<private>` where the failure is tells you
/// nothing. File names and account details stay redacted.
enum Log {
    private static let subsystem = "com.xiaodijin.snap"

    static let scan = Logger(subsystem: subsystem, category: "scan")
    static let upload = Logger(subsystem: subsystem, category: "upload")
    static let auth = Logger(subsystem: subsystem, category: "auth")
}
