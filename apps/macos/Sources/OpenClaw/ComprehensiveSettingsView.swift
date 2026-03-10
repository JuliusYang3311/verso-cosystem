import SwiftUI

/// Comprehensive Settings Window with all CLI features
struct ComprehensiveSettingsView: View {
    @Bindable var state: AppState
    @State private var selectedTab: SettingsTab = .general

    enum SettingsTab: String, CaseIterable, Identifiable {
        case general = "General"
        case workspace = "Workspace"
        case model = "Model"
        case browser = "Browser"
        case webTools = "Web Tools"
        case channels = "Channels"
        case evolver = "Evolver"
        case health = "Health"
        case skills = "Skills"
        case permissions = "Permissions"
        case debug = "Debug"

        var id: String { rawValue }

        var icon: String {
            switch self {
            case .general: return "gearshape"
            case .workspace: return "folder"
            case .model: return "brain.head.profile"
            case .browser: return "safari"
            case .webTools: return "globe"
            case .channels: return "bubble.left.and.bubble.right"
            case .evolver: return "wand.and.stars"
            case .health: return "heart.text.square"
            case .skills: return "sparkles"
            case .permissions: return "lock.shield"
            case .debug: return "ladybug"
            }
        }
    }

    var body: some View {
        NavigationSplitView {
            // Sidebar
            List(SettingsTab.allCases, selection: $selectedTab) { tab in
                Label(tab.rawValue, systemImage: tab.icon)
                    .tag(tab)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 220)
        } detail: {
            // Detail view
            Group {
                switch selectedTab {
                case .general:
                    GeneralSettings(state: state)
                case .workspace:
                    WorkspaceSettings(state: state)
                case .model:
                    ModelSettings(state: state)
                case .browser:
                    BrowserSettings()
                case .webTools:
                    WebToolsSettings()
                case .channels:
                    ChannelsSettings(state: state)
                case .evolver:
                    EvolverSettings()
                case .health:
                    HealthCheckSettings()
                case .skills:
                    SkillsSettings(state: state)
                case .permissions:
                    PermissionsSettings()
                case .debug:
                    DebugSettings(state: state)
                }
            }
            .frame(minWidth: 600, minHeight: 500)
        }
    }
}

/// Settings window opener helper
@MainActor
struct ComprehensiveSettingsWindowOpener {
    static func open(tab: ComprehensiveSettingsView.SettingsTab = .general) {
        // Find or create settings window
        let windows = NSApplication.shared.windows
        if let existingWindow = windows.first(where: { $0.identifier?.rawValue == "ComprehensiveSettingsWindow" }) {
            existingWindow.makeKeyAndOrderFront(nil)
            return
        }

        // Create new window
        let contentView = ComprehensiveSettingsView(state: AppStateStore.shared)
        let hostingController = NSHostingController(rootView: contentView)

        let window = NSWindow(contentViewController: hostingController)
        window.identifier = NSUserInterfaceItemIdentifier("ComprehensiveSettingsWindow")
        window.title = "Verso Settings"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 900, height: 600))
        window.center()
        window.makeKeyAndOrderFront(nil)

        // Keep window alive
        window.isReleasedWhenClosed = false
    }
}

#if DEBUG
struct ComprehensiveSettingsView_Previews: PreviewProvider {
    static var previews: some View {
        ComprehensiveSettingsView(state: .preview)
            .frame(width: 900, height: 600)
    }
}
#endif
