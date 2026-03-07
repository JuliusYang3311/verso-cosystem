import AppKit
import SwiftUI

struct WebToolsSettings: View {
    @State private var webToolsEnabled = false
    @State private var braveApiKey: String = ""
    @State private var webFetchEnabled = true
    @State private var statusMessage: String?

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("Web Tools Configuration")
                        .font(.title2.weight(.semibold))
                    Text("Configure web search and fetch capabilities.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Enable Web Tools
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(isOn: $webToolsEnabled) {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Enable Web Tools", systemImage: "globe")
                                .font(.headline)
                            Text("Allow Verso to search the web and fetch content")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch)
                }

                if webToolsEnabled {
                    Divider()

                    // Brave Search API
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Brave Search API", systemImage: "magnifyingglass")
                            .font(.headline)

                        VStack(alignment: .leading, spacing: 8) {
                            Text("API Key (Optional)")
                                .font(.callout.weight(.semibold))

                            SecureField("BSA...", text: $braveApiKey)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))

                            HStack(spacing: 4) {
                                Text("Get your API key at:")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                Button("brave.com/search/api") {
                                    if let url = URL(string: "https://brave.com/search/api/") {
                                        NSWorkspace.shared.open(url)
                                    }
                                }
                                .buttonStyle(.link)
                                .font(.caption)
                            }
                        }
                    }

                    Divider()

                    // Web Fetch
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: $webFetchEnabled) {
                            VStack(alignment: .leading, spacing: 4) {
                                Label("Enable Web Fetch", systemImage: "arrow.down.circle.fill")
                                    .font(.headline)
                                Text("Allow fetching and parsing web pages")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.switch)
                    }

                    Divider()

                    // Capabilities
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Web Tools Capabilities", systemImage: "list.bullet")
                            .font(.headline)

                        GroupBox {
                            VStack(alignment: .leading, spacing: 8) {
                                capabilityRow(
                                    icon: "magnifyingglass.circle.fill",
                                    title: "Web Search",
                                    description: "Search the web using Brave Search API",
                                    enabled: !braveApiKey.isEmpty
                                )
                                capabilityRow(
                                    icon: "doc.text.fill",
                                    title: "Content Extraction",
                                    description: "Extract and parse webpage content",
                                    enabled: webFetchEnabled
                                )
                                capabilityRow(
                                    icon: "link.circle.fill",
                                    title: "URL Fetching",
                                    description: "Fetch content from any URL",
                                    enabled: webFetchEnabled
                                )
                                capabilityRow(
                                    icon: "newspaper.fill",
                                    title: "Article Parsing",
                                    description: "Parse and extract article content",
                                    enabled: webFetchEnabled
                                )
                            }
                            .padding(8)
                        }
                    }
                }

                Divider()

                // Save Button
                HStack {
                    Spacer()
                    Button {
                        saveConfiguration()
                    } label: {
                        Label("Save Configuration", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                }

                if let message = statusMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.green)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
        .onAppear {
            loadConfiguration()
        }
    }

    private func capabilityRow(icon: String, title: String, description: String, enabled: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(enabled ? .green : .secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(enabled ? .primary : .secondary)
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if enabled {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
        }
    }

    private func loadConfiguration() {
        let config = VersoConfigFile.loadDict()

        if let tools = config["tools"] as? [String: Any],
           let web = tools["web"] as? [String: Any] {
            webToolsEnabled = web["enabled"] as? Bool ?? false
            braveApiKey = web["braveApiKey"] as? String ?? ""
            webFetchEnabled = web["fetchEnabled"] as? Bool ?? true
        }
    }

    private func saveConfiguration() {
        var config = VersoConfigFile.loadDict()

        var tools = config["tools"] as? [String: Any] ?? [:]
        var web: [String: Any] = [
            "enabled": webToolsEnabled,
            "fetchEnabled": webFetchEnabled
        ]

        if !braveApiKey.isEmpty {
            web["braveApiKey"] = braveApiKey
        }

        tools["web"] = web
        config["tools"] = tools

        VersoConfigFile.saveDict(config)

        statusMessage = "✓ Configuration saved"
    }
}

#if DEBUG
struct WebToolsSettings_Previews: PreviewProvider {
    static var previews: some View {
        WebToolsSettings()
            .frame(width: 600, height: 600)
    }
}
#endif
