import SwiftUI

/// Browses the OneDrive folder tree and picks a destination.
struct FolderPickerView: View {
    @Binding var selection: FolderRef
    @EnvironmentObject private var auth: OneDriveAuth
    @Environment(\.dismiss) private var dismiss

    /// The path from the drive root to wherever we currently are.
    @State private var breadcrumb: [FolderRef] = [.root]
    @State private var folders: [DriveItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showNewFolder = false
    @State private var newFolderName = ""

    private var current: FolderRef { breadcrumb.last ?? .root }

    var body: some View {
        List {
            if breadcrumb.count > 1 {
                Button {
                    breadcrumb.removeLast()
                    Task { await load() }
                } label: {
                    Label("Back to \(breadcrumb[breadcrumb.count - 2].displayPath)", systemImage: "chevron.left")
                }
            }

            Section {
                Button {
                    selection = current
                    dismiss()
                } label: {
                    HStack {
                        Label("Upload here", systemImage: "checkmark.circle")
                        Spacer()
                        Text(current.displayPath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .fontWeight(.medium)
            }

            Section("Folders") {
                if isLoading {
                    HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                } else if folders.isEmpty {
                    Text("No subfolders").foregroundStyle(.secondary)
                } else {
                    ForEach(folders) { folder in
                        Button {
                            breadcrumb.append(FolderRef(
                                id: folder.id,
                                displayPath: current.displayPath + "/" + folder.name
                            ))
                            Task { await load() }
                        } label: {
                            HStack {
                                Label(folder.name, systemImage: "folder")
                                Spacer()
                                if let count = folder.childCount, count > 0 {
                                    Text("\(count)").font(.caption).foregroundStyle(.tertiary)
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.caption).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Choose Folder")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewFolder = true } label: {
                    Image(systemName: "folder.badge.plus")
                }
                .disabled(!auth.isSignedIn)
            }
        }
        .alert("New Folder", isPresented: $showNewFolder) {
            TextField("Name", text: $newFolderName)
            Button("Cancel", role: .cancel) { newFolderName = "" }
            Button("Create") { Task { await createFolder() } }
        }
        .task { await load() }
    }

    private func load() async {
        guard auth.isSignedIn else {
            errorMessage = "Sign in to OneDrive first."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            folders = try await OneDriveClient(auth: auth).folders(in: current)
        } catch {
            folders = []
            errorMessage = error.localizedDescription
        }
    }

    private func createFolder() async {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        newFolderName = ""
        guard !name.isEmpty else { return }
        do {
            _ = try await OneDriveClient(auth: auth).createFolder(named: name, in: current)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
