import SwiftUI

struct ReviewView: View {
    @ObservedObject var scan: ScanCoordinator
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var auth: OneDriveAuth
    @Environment(\.dismiss) private var dismiss

    @State private var pageIndex = 0
    @State private var showFolderPicker = false

    var body: some View {
        NavigationStack {
            Group {
                switch scan.stage {
                case .processing(let done, let total):
                    ProgressPanel(
                        title: "Processing",
                        detail: "Page \(min(done + 1, total)) of \(total)",
                        fraction: total > 0 ? Double(done) / Double(total) : 0
                    )
                case .uploading(let fraction):
                    ProgressPanel(title: "Uploading", detail: scan.sanitizedFilename, fraction: fraction)
                case .finished(let record):
                    FinishedPanel(record: record) { dismiss() }
                case .failed(let message):
                    FailedPanel(message: message) { scan.backToReview() } onClose: { dismiss() }
                default:
                    reviewBody
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if case .review = scan.stage {
                        Button("Discard", role: .destructive) { dismiss() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if case .review = scan.stage, scan.pages.count > 1 {
                        Button(role: .destructive) {
                            scan.removePage(at: pageIndex)
                            pageIndex = min(pageIndex, scan.pages.count - 1)
                        } label: {
                            Label("Remove Page", systemImage: "trash")
                        }
                    }
                }
            }
            .sheet(isPresented: $showFolderPicker) {
                NavigationStack {
                    FolderPickerView(selection: $scan.folder)
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private var title: String {
        switch scan.stage {
        case .finished: return "Uploaded"
        case .failed: return "Upload Failed"
        default: return scan.pages.count == 1 ? "1 Page" : "\(scan.pages.count) Pages"
        }
    }

    private var reviewBody: some View {
        VStack(spacing: 0) {
            if scan.pages.isEmpty {
                ContentUnavailableView("No pages", systemImage: "doc")
            } else {
                TabView(selection: $pageIndex) {
                    ForEach(Array(scan.pages.enumerated()), id: \.element.id) { index, page in
                        PagePreview(page: page).tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: scan.pages.count > 1 ? .automatic : .never))
                .frame(maxHeight: .infinity)

                Divider()
                controls
            }
        }
    }

    private var controls: some View {
        ScrollView {
            VStack(spacing: 16) {
                colorModeControl
                qualityControl

                VStack(alignment: .leading, spacing: 6) {
                    Text("File name").font(.caption).foregroundStyle(.secondary)
                    TextField("File name", text: $scan.filename)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                }

                Button { showFolderPicker = true } label: {
                    HStack {
                        Label("Folder", systemImage: "folder")
                        Spacer()
                        Text(scan.folder.displayPath)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!auth.isSignedIn)

                uploadButton
            }
            .padding()
        }
        .frame(maxHeight: 340)
        .background(.bar)
    }

    private var colorModeControl: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Colour").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if case .auto = scan.colorSelection, let detected = currentPage?.detectedMode {
                    Text("Auto chose \(detected.shortLabel) for this page")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                if let page = currentPage, page.byteCount > 0 {
                    Text(Format.bytes(page.byteCount))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }

            Picker("Colour", selection: Binding(
                get: { scan.colorSelection },
                set: { selection in Task { await scan.updateColorSelection(selection) } }
            )) {
                Text("Auto").tag(ColorModeSelection.auto)
                ForEach(ColorMode.allCases) { mode in
                    Text(mode.shortLabel).tag(ColorModeSelection.forced(mode))
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var qualityControl: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Quality").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(scan.pages.count) page\(scan.pages.count == 1 ? "" : "s") · \(Format.bytes(scan.totalBytes)) total")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            Picker("Quality", selection: Binding(
                get: { scan.quality },
                set: { tier in Task { await scan.updateQuality(tier) } }
            )) {
                ForEach(QualityTier.allCases) { tier in
                    Text(tier.label).tag(tier)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var uploadButton: some View {
        Button {
            Task {
                // Signing in and uploading are the same button: if you scanned before
                // signing in, one tap authenticates and then continues into the upload.
                if !auth.isSignedIn {
                    do { try await auth.signIn() }
                    catch OneDriveError.authCancelled { return }
                    catch {
                        scan.reportFailure(error.localizedDescription)
                        return
                    }
                }
                await scan.upload(using: OneDriveClient(auth: auth), settings: settings)
            }
        } label: {
            Label(
                auth.isSignedIn ? "Upload to OneDrive" : "Sign in and Upload",
                systemImage: auth.isSignedIn ? "arrow.up.circle.fill" : "person.crop.circle.badge.plus"
            )
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!scan.hasPages || !Config.isConfigured)
    }

    private var currentPage: PageDraft? {
        scan.pages.indices.contains(pageIndex) ? scan.pages[pageIndex] : nil
    }
}

// MARK: - Pieces

private struct PagePreview: View {
    let page: PageDraft

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
            if let preview = page.preview {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFit()
                    .padding(12)
                    .shadow(radius: 3, y: 1)
            } else {
                ProgressView()
            }
        }
    }
}

private struct ProgressPanel: View {
    let title: String
    let detail: String
    let fraction: Double

    var body: some View {
        VStack(spacing: 16) {
            ProgressView(value: fraction)
                .progressViewStyle(.linear)
                .frame(maxWidth: 260)
            Text(title).font(.headline)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FinishedPanel: View {
    let record: UploadRecord
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)
            Text(record.filename).font(.headline).multilineTextAlignment(.center)
            Text("\(record.pageCount) page\(record.pageCount == 1 ? "" : "s") · \(Format.bytes(record.byteCount)) · \(record.folderPath)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Button("Done", action: onDone)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.top, 8)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FailedPanel: View {
    let message: String
    let onRetry: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.orange)
            Text(message)
                .multilineTextAlignment(.center)
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal)

            // Back to review rather than straight out — the pages are still in memory and
            // losing a scan to a flaky network would be worse than a second tap.
            Button("Back to Review", action: onRetry)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            Button("Discard Scan", role: .destructive, action: onClose)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
