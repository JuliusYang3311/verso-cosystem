import AppKit
import SwiftUI

struct WorkspaceSettings: View {
    @Bindable var state: AppState
    @State private var workspacePath: String = ""
    @State private var isCreating = false
    @State private var statusMessage: String?
    @State private var showFilePicker = false

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("Workspace")
                        .font(.title2.weight(.semibold))
                    Text("Configure where Verso stores agent data, skills, and memory.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Workspace Path Section
                VStack(alignment: .leading, spacing: 12) {
                    Label("Workspace Directory", systemImage: "folder.fill")
                        .font(.headline)

                    Text("This is where Verso stores agent data, skills, and memory.")
                        .font(.callout)
                        .foregroundStyle(.secondary)

                    HStack(spacing: 12) {
                        TextField("~/verso", text: $workspacePath)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.body, design: .monospaced))

                        Button("Browse...") {
                            selectWorkspaceDirectory()
                        }
                        .buttonStyle(.bordered)
                    }

                    // Workspace Structure Preview
                    GroupBox {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Workspace will contain:")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)

                            workspaceStructureRow(icon: "wrench.and.screwdriver.fill", name: "tools/", description: "Custom tools")
                            workspaceStructureRow(icon: "sparkles", name: "skills/", description: "Installed skills")
                            workspaceStructureRow(icon: "brain.head.profile", name: "memory/", description: "Agent memory")
                            workspaceStructureRow(icon: "heart.fill", name: "soul/", description: "Personality config")
                            workspaceStructureRow(icon: "doc.text.fill", name: "sessions/", description: "Chat sessions")
                        }
                        .padding(8)
                    }

                    // Action Buttons
                    HStack(spacing: 12) {
                        Button {
                            Task { await createWorkspace() }
                        } label: {
                            if isCreating {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Label("Create Workspace", systemImage: "plus.circle.fill")
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isCreating || workspacePath.isEmpty)

                        Button {
                            openWorkspaceInFinder()
                        } label: {
                            Label("Open in Finder", systemImage: "folder")
                        }
                        .buttonStyle(.bordered)

                        Button {
                            Task { await saveWorkspaceConfig() }
                        } label: {
                            Label("Save Config", systemImage: "square.and.arrow.down")
                        }
                        .buttonStyle(.bordered)
                        .disabled(workspacePath.isEmpty)
                    }

                    if let message = statusMessage {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(message.contains("✓") ? .green : .secondary)
                    }
                }

                Divider()

                // Quick Actions
                VStack(alignment: .leading, spacing: 12) {
                    Label("Quick Actions", systemImage: "bolt.fill")
                        .font(.headline)

                    HStack(spacing: 12) {
                        Button {
                            revealWorkspaceInFinder()
                        } label: {
                            Label("Reveal Workspace", systemImage: "arrow.right.circle")
                        }
                        .buttonStyle(.bordered)

                        Button {
                            openWorkspaceInTerminal()
                        } label: {
                            Label("Open in Terminal", systemImage: "terminal")
                        }
                        .buttonStyle(.bordered)
                    }
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
        .onAppear {
            loadWorkspacePath()
        }
    }

    private func workspaceStructureRow(icon: String, name: String, description: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)

            Text(name)
                .font(.caption.monospaced())
                .foregroundStyle(.primary)

            Text("- \(description)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func loadWorkspacePath() {
        // Load from config
        let config = VersoConfigFile.loadDict()
        if let agents = config["agents"] as? [String: Any],
           let defaults = agents["defaults"] as? [String: Any],
           let workspace = defaults["workspace"] as? String {
            workspacePath = workspace
        } else {
            workspacePath = "~/verso"
        }
    }

    private func selectWorkspaceDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select workspace directory"

        if panel.runModal() == .OK, let url = panel.url {
            workspacePath = url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        }
    }

    private func createWorkspace() async {
        isCreating = true
        statusMessage = "Creating workspace..."

        // Expand tilde
        let expandedPath = workspacePath.replacingOccurrences(of: "~", with: NSHomeDirectory())
        let url = URL(fileURLWithPath: expandedPath)

        do {
            let fileManager = FileManager.default

            // Create main workspace directory
            try fileManager.createDirectory(at: url, withIntermediateDirectories: true)

            // Create subdirectories
            let subdirs = ["tools", "skills", "memory", "soul", "sessions"]
            for subdir in subdirs {
                let subdirURL = url.appendingPathComponent(subdir)
                try fileManager.createDirectory(at: subdirURL, withIntermediateDirectories: true)
            }

            // Create TOOLS.md
            let toolsURL = url.appendingPathComponent("tools/TOOLS.md")
            let toolsContent = """
            # Tools

            This directory contains custom tools for your Verso agent.

            ## Structure

            - `temp/` - Temporary tools created by Verso
            - `permanent/` - Solidified tools (managed by Evolver)

            """
            try toolsContent.write(to: toolsURL, atomically: true, encoding: .utf8)

            // Create BOOTSTRAP.md
            let bootstrapURL = url.appendingPathComponent("BOOTSTRAP.md")
            let bootstrapContent = """
            # Verso Workspace

            Welcome to your Verso workspace!

            This workspace contains:
            - **tools/** - Custom tools and scripts
            - **skills/** - Installed skills
            - **memory/** - Agent memory and embeddings
            - **soul/** - Personality configuration
            - **sessions/** - Chat session history

            """
            try bootstrapContent.write(to: bootstrapURL, atomically: true, encoding: .utf8)

            statusMessage = "✓ Workspace created successfully"

            // Auto-save to config
            await saveWorkspaceConfig()

        } catch {
            statusMessage = "Error: \(error.localizedDescription)"
        }

        isCreating = false
    }

    private func saveWorkspaceConfig() async {
        var config = VersoConfigFile.loadDict()

        var agents = config["agents"] as? [String: Any] ?? [:]
        var defaults = agents["defaults"] as? [String: Any] ?? [:]
        defaults["workspace"] = workspacePath
        agents["defaults"] = defaults
        config["agents"] = agents

        VersoConfigFile.saveDict(config)
        statusMessage = "✓ Saved to ~/.verso/config.json"
    }

    private func openWorkspaceInFinder() {
        let expandedPath = workspacePath.replacingOccurrences(of: "~", with: NSHomeDirectory())
        let url = URL(fileURLWithPath: expandedPath)
        NSWorkspace.shared.open(url)
    }

    private func revealWorkspaceInFinder() {
        let expandedPath = workspacePath.replacingOccurrences(of: "~", with: NSHomeDirectory())
        let url = URL(fileURLWithPath: expandedPath)
        NSWorkspace.shared.selectFile(url.path, inFileViewerRootedAtPath: url.deletingLastPathComponent().path)
    }

    private func openWorkspaceInTerminal() {
        let expandedPath = workspacePath.replacingOccurrences(of: "~", with: NSHomeDirectory())
        let script = """
        tell application "Terminal"
            activate
            do script "cd '\(expandedPath)'"
        end tell
        """

        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
        }
    }
}

#if DEBUG
struct WorkspaceSettings_Previews: PreviewProvider {
    static var previews: some View {
        WorkspaceSettings(state: .preview)
            .frame(width: 600, height: 500)
    }
}
#endif
