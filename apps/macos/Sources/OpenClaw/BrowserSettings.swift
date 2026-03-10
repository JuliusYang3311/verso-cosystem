import AppKit
import SwiftUI

struct BrowserSettings: View {
    @State private var browserEnabled = false
    @State private var headlessMode = true
    @State private var statusMessage: String?

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("Browser Configuration")
                        .font(.title2.weight(.semibold))
                    Text("Configure headless browser for web automation.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Enable Browser
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(isOn: $browserEnabled) {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Enable Browser Tools", systemImage: "safari.fill")
                                .font(.headline)
                            Text("Allow Verso to use headless browser for web automation")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch)
                }

                if browserEnabled {
                    Divider()

                    // Headless Mode
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: $headlessMode) {
                            VStack(alignment: .leading, spacing: 4) {
                                Label("Headless Mode", systemImage: "eye.slash.fill")
                                    .font(.headline)
                                Text("Run browser without visible window")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.switch)
                    }

                    Divider()

                    // Capabilities
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Browser Capabilities", systemImage: "list.bullet")
                            .font(.headline)

                        GroupBox {
                            VStack(alignment: .leading, spacing: 8) {
                                capabilityRow(icon: "camera.fill", title: "Take screenshots", description: "Capture webpage screenshots")
                                capabilityRow(icon: "arrow.right.circle.fill", title: "Navigate pages", description: "Visit and interact with websites")
                                capabilityRow(icon: "doc.text.fill", title: "Fill forms", description: "Automatically fill web forms")
                                capabilityRow(icon: "hand.tap.fill", title: "Click elements", description: "Interact with page elements")
                                capabilityRow(icon: "text.cursor", title: "Extract content", description: "Read and extract webpage content")
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

    private func capabilityRow(icon: String, title: String, description: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.green)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
    }

    private func loadConfiguration() {
        let config = VersoConfigFile.loadDict()

        if let browser = config["browser"] as? [String: Any] {
            browserEnabled = browser["enabled"] as? Bool ?? false
            headlessMode = browser["headless"] as? Bool ?? true
        }
    }

    private func saveConfiguration() {
        var config = VersoConfigFile.loadDict()

        var browser: [String: Any] = [
            "enabled": browserEnabled,
            "headless": headlessMode
        ]

        config["browser"] = browser
        VersoConfigFile.saveDict(config)

        statusMessage = "✓ Configuration saved"
    }
}

#if DEBUG
struct BrowserSettings_Previews: PreviewProvider {
    static var previews: some View {
        BrowserSettings()
            .frame(width: 600, height: 500)
    }
}
#endif
