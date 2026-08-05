import Foundation

struct DriveItem: Identifiable, Hashable, Codable {
    let id: String
    let name: String
    let isFolder: Bool
    let childCount: Int?
    let webURL: String?

    enum CodingKeys: String, CodingKey {
        case id, name, folder, webUrl
    }

    init(id: String, name: String, isFolder: Bool, childCount: Int? = nil, webURL: String? = nil) {
        self.id = id
        self.name = name
        self.isFolder = isFolder
        self.childCount = childCount
        self.webURL = webURL
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        webURL = try c.decodeIfPresent(String.self, forKey: .webUrl)
        let folder = try c.decodeIfPresent(FolderFacet.self, forKey: .folder)
        isFolder = folder != nil
        childCount = folder?.childCount
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(webURL, forKey: .webUrl)
    }

    private struct FolderFacet: Codable {
        let childCount: Int?
    }
}

/// A destination folder. `nil` id means the drive root.
struct FolderRef: Codable, Hashable {
    var id: String?
    var displayPath: String

    static let root = FolderRef(id: nil, displayPath: "OneDrive")
}

/// Microsoft Graph calls for listing folders and uploading files.
@MainActor
final class OneDriveClient {

    private let auth: OneDriveAuth

    init(auth: OneDriveAuth) {
        self.auth = auth
    }

    // MARK: - Browsing

    func children(of folder: FolderRef) async throws -> [DriveItem] {
        let path = folder.id.map { "/me/drive/items/\($0)/children" } ?? "/me/drive/root/children"
        var items: [DriveItem] = []
        // Graph pages at 200 items; follow @odata.nextLink so large folders list fully.
        var next: URL? = URL(string: Config.graphBase + path + "?$top=200&$select=id,name,folder,webUrl")

        while let url = next {
            let (data, _) = try await send(request(url: url, method: "GET"))
            let page = try JSONDecoder().decode(ChildrenResponse.self, from: data)
            items.append(contentsOf: page.value)
            next = page.nextLink.flatMap(URL.init(string:))
        }
        return items
    }

    func folders(in folder: FolderRef) async throws -> [DriveItem] {
        try await children(of: folder)
            .filter(\.isFolder)
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func createFolder(named name: String, in parent: FolderRef) async throws -> DriveItem {
        let path = parent.id.map { "/me/drive/items/\($0)/children" } ?? "/me/drive/root/children"
        var req = request(url: URL(string: Config.graphBase + path)!, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "name": name,
            "folder": [:] as [String: Any],
            "@microsoft.graph.conflictBehavior": "rename"
        ])
        let (data, _) = try await send(req)
        return try JSONDecoder().decode(DriveItem.self, from: data)
    }

    // MARK: - Upload

    /// - Parameter progress: Called on the main actor, synchronously. It must NOT hop
    ///   through a `Task`: an update enqueued before the terminal state is assigned can
    ///   run after it and knock the UI back onto the progress screen for good.
    func upload(
        _ data: Data,
        as filename: String,
        to folder: FolderRef,
        contentType: String = "application/pdf",
        progress: @escaping @MainActor (Double) -> Void = { _ in }
    ) async throws -> DriveItem {
        let mode = data.count <= Config.simpleUploadLimit ? "simple" : "session"
        Log.upload.info("upload start: \(data.count, privacy: .public) bytes via \(mode, privacy: .public), folder=\(folder.id ?? "root", privacy: .public)")
        do {
            let item: DriveItem
            if data.count <= Config.simpleUploadLimit {
                item = try await simpleUpload(data, as: filename, to: folder, contentType: contentType, progress: progress)
            } else {
                item = try await sessionUpload(data, as: filename, to: folder, progress: progress)
            }
            Log.upload.info("upload ok: id=\(item.id, privacy: .public)")
            return item
        } catch {
            Log.upload.error("upload failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    private func simpleUpload(
        _ data: Data, as filename: String, to folder: FolderRef,
        contentType: String, progress: @escaping @MainActor (Double) -> Void
    ) async throws -> DriveItem {
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? filename
        let base = folder.id.map { "/me/drive/items/\($0):/\(encoded):/content" }
            ?? "/me/drive/root:/\(encoded):/content"
        // `rename` rather than `replace`: a scan should never silently destroy a file that
        // happens to share its name.
        let url = URL(string: Config.graphBase + base + "?@microsoft.graph.conflictBehavior=rename")!

        var req = request(url: url, method: "PUT")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")

        // Real byte-level progress from the session, rather than a fake 10% that sits
        // still for the whole transfer and reads as a hang.
        let (response, _) = try await send(req, body: data, progress: progress)
        progress(1.0)
        return try JSONDecoder().decode(DriveItem.self, from: response)
    }

    /// Chunked resumable upload, required above 4 MB.
    private func sessionUpload(
        _ data: Data, as filename: String, to folder: FolderRef,
        progress: @escaping @MainActor (Double) -> Void
    ) async throws -> DriveItem {
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? filename
        let base = folder.id.map { "/me/drive/items/\($0):/\(encoded):/createUploadSession" }
            ?? "/me/drive/root:/\(encoded):/createUploadSession"

        var create = request(url: URL(string: Config.graphBase + base)!, method: "POST")
        create.setValue("application/json", forHTTPHeaderField: "Content-Type")
        create.httpBody = try JSONSerialization.data(withJSONObject: [
            "item": ["@microsoft.graph.conflictBehavior": "rename"]
        ])
        let (created, _) = try await send(create)
        guard let uploadURL = try JSONDecoder()
            .decode(UploadSessionResponse.self, from: created).uploadUrl
            .flatMap(URL.init(string:))
        else { throw OneDriveError.badResponse }

        // Graph requires chunks to be a multiple of 320 KiB.
        let chunkSize = 320 * 1024 * 10
        var offset = 0

        while offset < data.count {
            let end = min(offset + chunkSize, data.count)
            let chunk = data[offset..<end]

            // The upload URL carries its own credentials; no Authorization header.
            var req = URLRequest(url: uploadURL)
            req.httpMethod = "PUT"
            req.setValue("bytes \(offset)-\(end - 1)/\(data.count)", forHTTPHeaderField: "Content-Range")
            req.setValue("\(chunk.count)", forHTTPHeaderField: "Content-Length")

            let (body, http) = try await URLSession.shared.upload(for: req, from: Data(chunk))
            guard let status = (http as? HTTPURLResponse)?.statusCode else { throw OneDriveError.badResponse }

            switch status {
            case 200, 201:
                progress(1.0)
                return try JSONDecoder().decode(DriveItem.self, from: body)
            case 202:
                offset = end
                progress(Double(offset) / Double(data.count))
            default:
                throw OneDriveError.requestFailed(status, String(data: body, encoding: .utf8) ?? "")
            }
        }
        throw OneDriveError.badResponse
    }

    // MARK: - Plumbing

    private func request(url: URL, method: String) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        return req
    }

    @discardableResult
    private func send(
        _ request: URLRequest,
        body: Data? = nil,
        progress: (@MainActor (Double) -> Void)? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        var req = request
        req.setValue("Bearer \(try await auth.accessToken())", forHTTPHeaderField: "Authorization")

        let (data, response): (Data, URLResponse)
        if let body {
            let observer = progress.map(UploadObserver.init)
            (data, response) = try await URLSession.shared.upload(for: req, from: body, delegate: observer)
        } else {
            (data, response) = try await URLSession.shared.data(for: req)
        }

        guard let http = response as? HTTPURLResponse else { throw OneDriveError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode(GraphErrorResponse.self, from: data))?.error.message
                ?? String(data: data, encoding: .utf8)
                ?? ""
            Log.upload.error("graph \(http.statusCode, privacy: .public) \(req.httpMethod ?? "?", privacy: .public) \(req.url?.path ?? "", privacy: .public): \(detail, privacy: .public)")
            throw OneDriveError.requestFailed(http.statusCode, detail)
        }
        return (data, http)
    }
}

/// Reports upload progress from `URLSession`.
///
/// Session callbacks arrive off the main thread, so this one does have to hop — which is
/// exactly why the receiving side guards against applying an update once the transfer has
/// reached a terminal state.
private final class UploadObserver: NSObject, URLSessionTaskDelegate {
    private let onProgress: @MainActor (Double) -> Void

    init(onProgress: @escaping @MainActor (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        let fraction = min(1.0, Double(totalBytesSent) / Double(totalBytesExpectedToSend))
        let handler = onProgress
        Task { @MainActor in handler(fraction) }
    }
}

// MARK: - Wire types

private struct ChildrenResponse: Decodable {
    let value: [DriveItem]
    let nextLink: String?
    enum CodingKeys: String, CodingKey {
        case value
        case nextLink = "@odata.nextLink"
    }
}

private struct UploadSessionResponse: Decodable {
    let uploadUrl: String?
}

private struct GraphErrorResponse: Decodable {
    struct Detail: Decodable { let message: String }
    let error: Detail
}
