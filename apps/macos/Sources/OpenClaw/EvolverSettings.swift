import AppKit
import SwiftUI

struct EvolverSettings: View {
    @State private var evolverEnabled = false
    @State private var requireReview = true
    @State private var workspacePath: String = ""
    @State private var statusMessage: String?

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("Evolver Configuration")
                        .font(.title2.weight(.semibold))
                    Text("Automatic workspace optimization and tool management.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Enable Evolver
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(isOn: $evolverEnabled) {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Enable Evolver", systemImage: "wand.and.stars")
                                .font(.headline)
                            Text("Automatically optimize and manage workspace tools")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch)
                }

                if evolverEnabled {
                    Divider()

                    // What Evolver Does
                    VStack(alignment: .leading, spacing: 12) {
                        Label("What Evolver Does", systemImage: "info.circle.fill")
                            .font(.headline)

                        GroupBox {
                            VStack(alignment: .leading, spacing: 10) {
                                evolverFeatureRow(
                                    icon: "eye.fill",
                                    title: "Monitor Tools",
                                    description: "Track usage of tools in your workspace"
                                )
                                evolverFeatureRow(
                                    icon: "arrow.up.circle.fill",
                                    title: "Optimize Code",
                                    description: "Improve code quality and performance"
                                )
                                evolverFeatureRow(
                                    icon: "checkmark.seal.fill",
                                    title: "Solidify Tools",
                                    description: "Promote frequently used tools to permanent"
                                )
                                evolverFeatureRow(
                                    icon: "trash.fill",
                                    title: "Clean Up",
                                    description: "Remove unused tools automatically"
                                )
                            }
                            .padding(8)
                        }
                    }

                    Divider()

                    // Review Requirement
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: $requireReview) {
                            VStack(alignment: .leading, spacing: 4) {
                                Label("Require Review Before Applying Changes", systemImage: "hand.raised.fill")
                                    .font(.headline)
                                Text(requireReview
                                    ? "You'll be asked to approve changes before they're applied"
                                    : "Changes will be applied automatically after testing")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.switch)
                    }

                    Divider()

                    // Workspace Info
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Workspace", systemImage: "folder.fill")
                            .font(.headline)

                        HStack {
                            Text(workspacePath.isEmpty ? "Not configured" : workspacePath)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)

                            Spacer()

                            if !workspacePath.isEmpty {
                                Button("Open") {
                                    openWorkspace()
                                }
                                .buttonStyle(.link)
                                .font(.caption)
                            }
                        }

                        Text("Evolver operates on the workspace configured in Workspace settings.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
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

    private func evolverFeatureRow(icon: String, title: String, description: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.blue)
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

        // Load evolver config
        if let evolver = config["evolver"] as? [String: Any] {
            evolverEnabled = evolver["enabled"] as? Bool ?? false

            if let notifications = evolver["notifications"] as? [String: Any] {
                requireReview = notifications["requireConfirmation"] as? Bool ?? true
            }

            if let workspace = evolver["workspace"] as? String {
                workspacePath = workspace
            }
        }

        // Load workspace from agents.defaults if not in evolver
        if workspacePath.isEmpty,
           let agents = config["agents"] as? [String: Any],
           let defaults = agents["defaults"] as? [String: Any],
           let workspace = defaults["workspace"] as? String {
            workspacePath = workspace
        }
    }

    private func saveConfiguration() {
        var config = VersoConfigFile.loadDict()

        var evolver: [String: Any] = [
            "enabled": evolverEnabled,
            "workspace": workspacePath,
            "rules": [
                "solidify": [
                    "minUsageCount": 5
                ],
                "cleanup": [
                    "enabled": true,
                    "unusedDays": 30
                ]
            ],
            "notifications": [
                "onSolidify": true,
                "onOptimize": true,
                "onCleanup": true,
                "requireConfirmation": requireReview
            ]
        ]

        config["evolver"] = evolver
        VersoConfigFile.saveDict(config)

        statusMessage = "✓ Configuration saved"
    }

    private func openWorkspace() {
        let expandedPath = workspacePath.replacingOccurrences(of: "~", with: NSHomeDirectory())
        let url = URL(fileURLWithPath: expandedPath)
        NSWorkspace.shared.open(url)
    }
}

#if DEBUG
struct EvolverSettings_Previews: PreviewProvider {
    static var previews: some View {
        EvolverSettings()
            .frame(width: 600, height: 600)
    }
}
#endif
