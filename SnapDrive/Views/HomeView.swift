import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var auth: OneDriveAuth
    @StateObject private var scan = ScanCoordinator()

    @State private var showScanner = false
    @State private var showSettings = false
    @State private var showReview = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    scanButton
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                Section("Destination") {
                    accountRow
                    if auth.isSignedIn {
                        NavigationLink {
                            FolderPickerView(selection: $settings.defaultFolder)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Folder")
                                    Text(settings.defaultFolder.displayPath)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "folder")
                            }
                        }
                    }
                }

                if !settings.recents.isEmpty {
                    Section("Recent") {
                        ForEach(settings.recents) { record in
                            RecentRow(record: record)
                        }
                    }
                }
            }
            .navigationTitle("SnapDrive")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .fullScreenCover(isPresented: $showScanner) {
                DocumentScannerView(
                    onFinish: { images in
                        showScanner = false
                        // Show the review screen immediately so its progress panel covers
                        // processing, which is a few seconds a page once OCR is running.
                        scan.prepare(pageCount: images.count)
                        showReview = true
                        Task { await scan.begin(with: images, settings: settings) }
                    },
                    onCancel: { showScanner = false }
                )
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $showReview, onDismiss: { scan.reset() }) {
                ReviewView(scan: scan)
            }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { errorMessage != nil },
                    set: { if !$0 { errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) { }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var scanButton: some View {
        Button {
            showScanner = true
        } label: {
            VStack(spacing: 10) {
                Image(systemName: "doc.viewfinder")
                    .font(.system(size: 44, weight: .light))
                Text("Scan Document")
                    .font(.headline)
                if !auth.isSignedIn {
                    Text("You can scan now and sign in before uploading")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var accountRow: some View {
        if let account = auth.account, auth.isSignedIn {
            HStack {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.displayName)
                        if !account.email.isEmpty {
                            Text(account.email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: "person.crop.circle.fill.badge.checkmark")
                        .foregroundStyle(.green)
                }
                Spacer()
                Button("Sign Out") { auth.signOut() }
                    .font(.caption)
                    .buttonStyle(.bordered)
            }
        } else {
            Button {
                Task {
                    do { try await auth.signIn() }
                    catch OneDriveError.authCancelled { }
                    catch { errorMessage = error.localizedDescription }
                }
            } label: {
                Label(
                    Config.isConfigured ? "Sign in to OneDrive" : "Add an Azure client ID in Settings",
                    systemImage: Config.isConfigured ? "person.crop.circle.badge.plus" : "exclamationmark.triangle"
                )
            }
            .disabled(!Config.isConfigured || auth.isWorking)
        }
    }
}

private struct RecentRow: View {
    let record: UploadRecord

    var body: some View {
        HStack {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.filename)
                    .lineLimit(1)
                Text("\(record.pageCount) page\(record.pageCount == 1 ? "" : "s") · \(Format.bytes(record.byteCount)) · \(record.folderPath)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(Format.relative(record.date))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}
