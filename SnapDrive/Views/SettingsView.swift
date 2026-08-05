import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var auth: OneDriveAuth
    @Environment(\.dismiss) private var dismiss

    @State private var clientID = Config.clientID
    @State private var showLanguages = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Quality", selection: $settings.quality) {
                        ForEach(QualityTier.allCases) { tier in
                            Text(tier.label).tag(tier)
                        }
                    }
                    Text(settings.quality.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Output")
                }

                Section {
                    Picker("Colour mode", selection: $settings.defaultColorMode) {
                        Text("Automatic").tag("auto")
                        ForEach(ColorMode.allCases) { mode in
                            Text(mode.label).tag(mode.rawValue)
                        }
                    }
                } header: {
                    Text("Colour")
                } footer: {
                    Text("Automatic keeps colour only when the page actually has some, uses greyscale for photos and shading, and drops to black & white for plain text — which is by far the smallest. You can always override a page in the review screen.")
                }

                Section {
                    Toggle("Recognise text", isOn: $settings.ocrEnabled)
                    if settings.ocrEnabled {
                        NavigationLink {
                            LanguagePicker(selected: $settings.languages)
                        } label: {
                            HStack {
                                Text("Languages")
                                Spacer()
                                Text(settings.languages.joined(separator: ", "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Toggle("Name files from the first line", isOn: $settings.useOCRTitle)
                    }
                } header: {
                    Text("Text recognition")
                } footer: {
                    Text("Runs entirely on the phone using the Neural Engine — no network, nothing sent anywhere. The recognised text is layered invisibly behind the page so the PDF is searchable.")
                }

                Section {
                    TextField("Application (client) ID", text: $clientID)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(.body, design: .monospaced))
                    Button("Save") {
                        Config.setClientID(clientID)
                        auth.signOut()
                    }
                    .disabled(clientID == Config.clientID)
                } header: {
                    Text("OneDrive app registration")
                } footer: {
                    Text("From your Azure app registration. Changing it signs you out. Redirect URI must be \(Config.redirectURI)")
                }

                if !settings.recents.isEmpty {
                    Section {
                        Button("Clear recent list", role: .destructive) {
                            settings.clearRecents()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct LanguagePicker: View {
    @Binding var selected: [String]
    private let available = OCRService.supportedLanguages

    var body: some View {
        List {
            Section {
                Text("Vision does better when it only considers the languages you actually scan.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(available, id: \.self) { code in
                Button {
                    toggle(code)
                } label: {
                    HStack {
                        Text(displayName(for: code))
                        Spacer()
                        if selected.contains(code) {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle("Languages")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toggle(_ code: String) {
        if let index = selected.firstIndex(of: code) {
            // Never end up with an empty list; Vision needs at least one language.
            if selected.count > 1 { selected.remove(at: index) }
        } else {
            selected.append(code)
        }
    }

    private func displayName(for code: String) -> String {
        let name = Locale.current.localizedString(forIdentifier: code) ?? code
        return "\(name)  (\(code))"
    }
}
