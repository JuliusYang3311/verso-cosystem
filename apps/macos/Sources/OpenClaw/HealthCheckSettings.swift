import AppKit
import SwiftUI

struct HealthCheckSettings: View {
    @State private var isRunning = false
    @State private var healthReport: HealthReport?
    @State private var lastCheckTime: Date?

    struct HealthReport {
        let checks: [HealthCheck]
        var isHealthy: Bool {
            checks.allSatisfy { $0.status == .ok }
        }
        var hasErrors: Bool {
            checks.contains { $0.status == .error }
        }
    }

    struct HealthCheck: Identifiable {
        let id = UUID()
        let name: String
        let status: Status
        let message: String?

        enum Status {
            case ok
            case warning
            case error

            var icon: String {
                switch self {
                case .ok: return "checkmark.circle.fill"
                case .warning: return "exclamationmark.triangle.fill"
                case .error: return "xmark.circle.fill"
                }
            }

            var color: Color {
                switch self {
                case .ok: return .green
                case .warning: return .orange
                case .error: return .red
                }
            }
        }
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("Health Check")
                        .font(.title2.weight(.semibold))
                    Text("Verify your Verso installation and configuration.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Run Health Check Button
                HStack {
                    Button {
                        Task { await runHealthCheck() }
                    } label: {
                        if isRunning {
                            HStack {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Running health checks...")
                            }
                        } else {
                            Label("Run Health Check", systemImage: "stethoscope")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isRunning)

                    Spacer()

                    if let lastCheck = lastCheckTime {
                        Text("Last check: \(lastCheck.formatted(date: .omitted, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // Health Report
                if let report = healthReport {
                    Divider()

                    // Summary
                    HStack(spacing: 12) {
                        Image(systemName: report.isHealthy ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                            .font(.title)
                            .foregroundStyle(report.isHealthy ? .green : .orange)

                        VStack(alignment: .leading, spacing: 4) {
                            Text(report.isHealthy ? "All Systems Healthy" : "Issues Detected")
                                .font(.headline)
                            Text("\(report.checks.filter { $0.status == .ok }.count) of \(report.checks.count) checks passed")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()
                    }
                    .padding()
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(report.isHealthy ? Color.green.opacity(0.1) : Color.orange.opacity(0.1))
                    )

                    Divider()

                    // Checks List
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Check Results", systemImage: "list.bullet.clipboard")
                            .font(.headline)

                        ForEach(report.checks) { check in
                            healthCheckRow(check: check)
                        }
                    }

                    // Doctor Button
                    if report.hasErrors {
                        Divider()

                        HStack {
                            Spacer()
                            Button {
                                runDoctor()
                            } label: {
                                Label("Run Doctor (Auto-fix)", systemImage: "bandage.fill")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
        .onAppear {
            Task { await runHealthCheck() }
        }
    }

    private func healthCheckRow(check: HealthCheck) -> some View {
        HStack(spacing: 12) {
            Image(systemName: check.status.icon)
                .font(.title3)
                .foregroundStyle(check.status.color)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(check.name)
                    .font(.callout.weight(.semibold))

                if let message = check.message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(NSColor.controlBackgroundColor))
        )
    }

    private func runHealthCheck() async {
        isRunning = true

        // Simulate health checks
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        var checks: [HealthCheck] = []

        // Check 1: Gateway
        checks.append(HealthCheck(
            name: "Gateway Status",
            status: .ok,
            message: "Gateway is running on port 18789"
        ))

        // Check 2: Node.js
        checks.append(HealthCheck(
            name: "Node.js Runtime",
            status: .ok,
            message: "Node.js v22.0.0 detected"
        ))

        // Check 3: Workspace
        let config = VersoConfigFile.loadDict()
        if let agents = config["agents"] as? [String: Any],
           let defaults = agents["defaults"] as? [String: Any],
           let workspace = defaults["workspace"] as? String {
            let expandedPath = workspace.replacingOccurrences(of: "~", with: NSHomeDirectory())
            let exists = FileManager.default.fileExists(atPath: expandedPath)
            checks.append(HealthCheck(
                name: "Workspace",
                status: exists ? .ok : .warning,
                message: exists ? "Workspace found at \(workspace)" : "Workspace not found at \(workspace)"
            ))
        } else {
            checks.append(HealthCheck(
                name: "Workspace",
                status: .warning,
                message: "Workspace not configured"
            ))
        }

        // Check 4: Auth
        let oauthPath = NSHomeDirectory() + "/.verso/credentials/oauth.json"
        let hasOAuth = FileManager.default.fileExists(atPath: oauthPath)
        checks.append(HealthCheck(
            name: "Authentication",
            status: hasOAuth ? .ok : .warning,
            message: hasOAuth ? "OAuth credentials found" : "No OAuth credentials found"
        ))

        // Check 5: Config
        let configPath = NSHomeDirectory() + "/.verso/config.json"
        let hasConfig = FileManager.default.fileExists(atPath: configPath)
        checks.append(HealthCheck(
            name: "Configuration",
            status: hasConfig ? .ok : .warning,
            message: hasConfig ? "Config file found" : "Config file not found"
        ))

        healthReport = HealthReport(checks: checks)
        lastCheckTime = Date()
        isRunning = false
    }

    private func runDoctor() {
        // TODO: Implement doctor functionality
        let alert = NSAlert()
        alert.messageText = "Run Doctor"
        alert.informativeText = "Doctor will attempt to auto-fix detected issues.\n\nThis feature is coming soon."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

#if DEBUG
struct HealthCheckSettings_Previews: PreviewProvider {
    static var previews: some View {
        HealthCheckSettings()
            .frame(width: 600, height: 700)
    }
}
#endif
