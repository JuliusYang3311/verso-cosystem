# Swift macOS App - CLI完整功能对等方案

## CLI完整功能清单

### 核心命令

#### 1. Setup & Onboarding
- `verso setup` - 初始化配置
- `verso onboard` - 完整onboarding向导
- `verso configure` - 配置向导（修改现有配置）

#### 2. Agent管理
- `verso agent` - Agent相关操作
- `verso agents` - 列出所有agents
- `verso add [name]` - 添加新agent
- `verso delete <id>` - 删除agent
- `verso set-identity` - 设置agent身份

#### 3. 会话管理
- `verso sessions` - 列出所有会话
- `verso reset` - 重置会话

#### 4. 消息发送
- `verso message` - 发送消息到agent

#### 5. 状态与健康检查
- `verso status` - 显示系统状态
- `verso health` - 健康检查
- `verso doctor` - 诊断和修复问题

#### 6. 节点管理
- `verso nodes` - 管理远程节点

#### 7. Dashboard
- `verso dashboard` - 启动Web控制面板

#### 8. ACP (Agent Control Protocol)
- `verso acp` - ACP相关操作

#### 9. 维护
- `verso uninstall` - 卸载Verso

## Swift App功能对等实施方案

### 架构设计

```
Verso.app/
├── Menu Bar App (主界面)
│   ├── Status显示
│   ├── Quick Actions
│   └── Settings入口
├── Settings Window (设置窗口)
│   ├── Onboarding (首次启动)
│   ├── General Settings
│   ├── Provider Settings
│   ├── Gateway Settings
│   ├── Channels Settings
│   ├── Skills Settings
│   ├── Agents Management
│   ├── Sessions Management
│   └── Advanced Settings
├── Dashboard Window (控制面板)
│   ├── System Status
│   ├── Health Checks
│   ├── Logs Viewer
│   └── Performance Metrics
├── Chat Window (聊天界面)
│   ├── Message Input
│   ├── Message History
│   └── Attachments
└── CLI Bridge (命令行桥接)
    └── 所有CLI命令通过IPC调用
```

### 功能映射表

| CLI命令 | Swift App功能 | 实施方式 | 优先级 |
|---------|--------------|---------|--------|
| `verso setup` | Onboarding Wizard | 原生Swift UI | P0 |
| `verso onboard` | Onboarding Wizard | 原生Swift UI | P0 |
| `verso configure` | Settings Window | 原生Swift UI | P0 |
| `verso status` | Menu Bar Status | 原生Swift UI | P0 |
| `verso health` | Health Check Panel | 原生Swift UI | P1 |
| `verso doctor` | Diagnostic Tool | CLI Bridge | P1 |
| `verso message` | Chat Window | 原生Swift UI | P0 |
| `verso sessions` | Sessions Manager | 原生Swift UI | P1 |
| `verso agents` | Agents Manager | 原生Swift UI | P1 |
| `verso add [name]` | Add Agent Button | 原生Swift UI | P1 |
| `verso delete <id>` | Delete Agent Button | 原生Swift UI | P1 |
| `verso dashboard` | Dashboard Window | 原生Swift UI | P2 |
| `verso nodes` | Nodes Manager | 原生Swift UI | P2 |
| `verso reset` | Reset Session Button | CLI Bridge | P2 |
| `verso acp` | ACP Panel | CLI Bridge | P3 |
| `verso uninstall` | Uninstall Menu Item | CLI Bridge | P3 |

### 详细实施方案

## 1. Menu Bar App (P0)

```swift
// MenuBarApp.swift
@main
struct VersoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        // Menu Bar Extra
        MenuBarExtra {
            MenuBarContent(state: appState)
        } label: {
            MenuBarLabel(state: appState)
        }
        .menuBarExtraStyle(.window)

        // Settings Window
        Settings {
            SettingsView(state: appState)
        }

        // Dashboard Window
        Window("Dashboard", id: "dashboard") {
            DashboardView(state: appState)
        }
        .defaultSize(width: 1200, height: 800)

        // Chat Window
        Window("Chat", id: "chat") {
            ChatView(state: appState)
        }
        .defaultSize(width: 800, height: 600)
    }
}
```

### Menu Bar Content

```swift
struct MenuBarContent: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Status Section
            StatusSection(state: state)
            Divider()

            // Quick Actions
            QuickActionsSection(state: state)
            Divider()

            // Recent Sessions
            RecentSessionsSection(state: state)
            Divider()

            // Settings & Quit
            BottomSection(state: state)
        }
        .frame(width: 320)
    }
}

struct StatusSection: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle()
                    .fill(state.gatewayStatus.color)
                    .frame(width: 8, height: 8)
                Text(state.gatewayStatus.text)
                    .font(.headline)
                Spacer()
            }

            if let stats = state.stats {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Active Sessions")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(stats.activeSessions)")
                            .font(.title3.bold())
                    }
                    Spacer()
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Messages Today")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(stats.messagesToday)")
                            .font(.title3.bold())
                    }
                }
            }
        }
        .padding()
    }
}

struct QuickActionsSection: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(spacing: 4) {
            Button {
                openChatWindow()
            } label: {
                Label("New Message", systemImage: "message")
            }
            .buttonStyle(.plain)

            Button {
                openDashboard()
            } label: {
                Label("Dashboard", systemImage: "chart.bar")
            }
            .buttonStyle(.plain)

            Button {
                runHealthCheck()
            } label: {
                Label("Health Check", systemImage: "heart.text.square")
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
    }
}
```

## 2. Settings Window (P0)

```swift
struct SettingsView: View {
    @ObservedObject var state: AppState

    var body: some View {
        TabView {
            GeneralSettingsView(state: state)
                .tabItem {
                    Label("General", systemImage: "gear")
                }

            ProviderSettingsView(state: state)
                .tabItem {
                    Label("Provider", systemImage: "brain")
                }

            GatewaySettingsView(state: state)
                .tabItem {
                    Label("Gateway", systemImage: "network")
                }

            ChannelsSettingsView(state: state)
                .tabItem {
                    Label("Channels", systemImage: "bubble.left.and.bubble.right")
                }

            SkillsSettingsView(state: state)
                .tabItem {
                    Label("Skills", systemImage: "puzzlepiece")
                }

            AgentsSettingsView(state: state)
                .tabItem {
                    Label("Agents", systemImage: "person.3")
                }

            SessionsSettingsView(state: state)
                .tabItem {
                    Label("Sessions", systemImage: "list.bullet")
                }

            AdvancedSettingsView(state: state)
                .tabItem {
                    Label("Advanced", systemImage: "slider.horizontal.3")
                }
        }
        .frame(width: 800, height: 600)
    }
}
```

### General Settings

```swift
struct GeneralSettingsView: View {
    @ObservedObject var state: AppState

    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $state.theme) {
                    Text("Auto").tag(Theme.auto)
                    Text("Light").tag(Theme.light)
                    Text("Dark").tag(Theme.dark)
                }

                Toggle("Show dock icon", isOn: $state.showDockIcon)
                Toggle("Launch at login", isOn: $state.launchAtLogin)
            }

            Section("Workspace") {
                HStack {
                    TextField("Workspace Path", text: $state.workspacePath)
                    Button("Browse...") {
                        selectWorkspace()
                    }
                }

                Text("Current: \(state.workspacePath)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Notifications") {
                Toggle("Show notifications", isOn: $state.notificationsEnabled)
                Toggle("Play sounds", isOn: $state.soundsEnabled)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}
```

### Provider Settings (完整实现)

```swift
struct ProviderSettingsView: View {
    @ObservedObject var state: AppState
    @State private var selectedProvider: ProviderType = .anthropic
    @State private var authMode: AuthMode = .apiKey
    @State private var apiKey: String = ""
    @State private var baseUrl: String = ""
    @State private var isVerifying = false
    @State private var verificationResult: VerificationResult?

    var body: some View {
        Form {
            Section("Provider Type") {
                Picker("Provider", selection: $selectedProvider) {
                    Text("Anthropic").tag(ProviderType.anthropic)
                    Text("OpenAI").tag(ProviderType.openai)
                    Text("Google").tag(ProviderType.google)
                    Text("Custom (Anthropic)").tag(ProviderType.customAnthropic)
                    Text("Custom (OpenAI)").tag(ProviderType.customOpenAI)
                }
                .onChange(of: selectedProvider) { _, _ in
                    loadProviderConfig()
                }
            }

            Section("Authentication") {
                if selectedProvider == .anthropic {
                    Picker("Auth Mode", selection: $authMode) {
                        Text("API Key").tag(AuthMode.apiKey)
                        Text("OAuth").tag(AuthMode.oauth)
                    }
                }

                if authMode == .apiKey {
                    SecureField("API Key", text: $apiKey)
                        .textFieldStyle(.roundedBorder)

                    if selectedProvider.isCustom {
                        TextField("Base URL", text: $baseUrl)
                            .textFieldStyle(.roundedBorder)
                        Text("Example: https://api.example.com")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else if authMode == .oauth {
                    OAuthSection(provider: selectedProvider)
                }
            }

            Section("Verification") {
                HStack {
                    Button("Verify Connection") {
                        Task { await verifyProvider() }
                    }
                    .disabled(isVerifying || apiKey.isEmpty)

                    if isVerifying {
                        ProgressView()
                            .controlSize(.small)
                    }
                }

                if let result = verificationResult {
                    HStack {
                        Image(systemName: result.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(result.success ? .green : .red)
                        Text(result.message)
                            .font(.caption)
                    }
                }
            }

            Section("Actions") {
                Button("Save") {
                    Task { await saveProviderConfig() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .formStyle(.grouped)
        .padding()
        .onAppear {
            loadProviderConfig()
        }
    }

    func verifyProvider() async {
        isVerifying = true
        defer { isVerifying = false }

        do {
            let verified = try await ProviderVerifier.shared.verify(
                provider: selectedProvider,
                apiKey: apiKey,
                baseUrl: selectedProvider.isCustom ? baseUrl : nil
            )

            verificationResult = VerificationResult(
                success: verified,
                message: verified ? "Connection successful" : "Connection failed"
            )
        } catch {
            verificationResult = VerificationResult(
                success: false,
                message: "Error: \(error.localizedDescription)"
            )
        }
    }

    func saveProviderConfig() async {
        do {
            // Save to Keychain
            try KeychainStore.save(apiKey: apiKey, for: selectedProvider)

            // Save to config file
            try await AuthProfileStore.shared.saveProfile(
                provider: selectedProvider,
                mode: authMode,
                baseUrl: selectedProvider.isCustom ? baseUrl : nil
            )

            // Update app state
            state.currentProvider = selectedProvider
            state.showSuccessAlert("Provider configuration saved")
        } catch {
            state.showErrorAlert("Failed to save: \(error.localizedDescription)")
        }
    }
}
```

## 3. Agents Management (P1)

```swift
struct AgentsSettingsView: View {
    @ObservedObject var state: AppState
    @State private var agents: [Agent] = []
    @State private var selectedAgent: Agent?
    @State private var showingAddAgent = false

    var body: some View {
        HSplitView {
            // Agents List
            List(agents, selection: $selectedAgent) { agent in
                AgentRow(agent: agent)
            }
            .frame(minWidth: 200)
            .toolbar {
                ToolbarItem {
                    Button {
                        showingAddAgent = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }

            // Agent Detail
            if let agent = selectedAgent {
                AgentDetailView(agent: agent, state: state)
            } else {
                Text("Select an agent")
                    .foregroundStyle(.secondary)
            }
        }
        .sheet(isPresented: $showingAddAgent) {
            AddAgentSheet(state: state) { newAgent in
                agents.append(newAgent)
            }
        }
        .onAppear {
            loadAgents()
        }
    }

    func loadAgents() {
        Task {
            agents = try await AgentManager.shared.listAgents()
        }
    }
}

struct AgentDetailView: View {
    let agent: Agent
    @ObservedObject var state: AppState

    var body: some View {
        Form {
            Section("Basic Info") {
                TextField("Name", text: .constant(agent.name))
                    .disabled(true)
                TextField("ID", text: .constant(agent.id))
                    .disabled(true)
            }

            Section("Model Configuration") {
                Picker("Primary Model", selection: .constant(agent.primaryModel)) {
                    ForEach(state.availableModels, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }

                Picker("Embedding Model", selection: .constant(agent.embeddingModel)) {
                    ForEach(state.availableEmbeddingModels, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
            }

            Section("Workspace") {
                TextField("Workspace Path", text: .constant(agent.workspace))
                    .disabled(true)
            }

            Section("Actions") {
                Button("Edit Agent") {
                    editAgent()
                }

                Button("Delete Agent", role: .destructive) {
                    deleteAgent()
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}
```

## 4. Sessions Management (P1)

```swift
struct SessionsSettingsView: View {
    @ObservedObject var state: AppState
    @State private var sessions: [Session] = []
    @State private var selectedSession: Session?

    var body: some View {
        HSplitView {
            // Sessions List
            List(sessions, selection: $selectedSession) { session in
                SessionRow(session: session)
            }
            .frame(minWidth: 250)

            // Session Detail
            if let session = selectedSession {
                SessionDetailView(session: session, state: state)
            } else {
                Text("Select a session")
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            loadSessions()
        }
    }

    func loadSessions() {
        Task {
            sessions = try await SessionManager.shared.listSessions()
        }
    }
}

struct SessionDetailView: View {
    let session: Session
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Session Info
            VStack(alignment: .leading, spacing: 8) {
                Text(session.name)
                    .font(.title2.bold())

                HStack {
                    Label(session.status.rawValue, systemImage: session.status.icon)
                        .font(.caption)
                        .foregroundStyle(session.status.color)

                    Text("•")
                        .foregroundStyle(.secondary)

                    Text("Created: \(session.createdAt.formatted())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            // Session Stats
            Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 12) {
                GridRow {
                    Text("Messages:")
                        .foregroundStyle(.secondary)
                    Text("\(session.messageCount)")
                }

                GridRow {
                    Text("Last Activity:")
                        .foregroundStyle(.secondary)
                    Text(session.lastActivity.formatted())
                }

                GridRow {
                    Text("Agent:")
                        .foregroundStyle(.secondary)
                    Text(session.agentId)
                }
            }

            Divider()

            // Actions
            HStack {
                Button("Open Chat") {
                    openSessionChat(session)
                }
                .buttonStyle(.borderedProminent)

                Button("Reset Session") {
                    resetSession(session)
                }
                .buttonStyle(.bordered)

                Button("Delete Session", role: .destructive) {
                    deleteSession(session)
                }
                .buttonStyle(.bordered)
            }

            Spacer()
        }
        .padding()
    }
}
```

## 5. Dashboard Window (P2)

```swift
struct DashboardView: View {
    @ObservedObject var state: AppState

    var body: some View {
        NavigationSplitView {
            List {
                NavigationLink("Overview") {
                    OverviewDashboard(state: state)
                }

                NavigationLink("Health") {
                    HealthDashboard(state: state)
                }

                NavigationLink("Performance") {
                    PerformanceDashboard(state: state)
                }

                NavigationLink("Logs") {
                    LogsDashboard(state: state)
                }

                NavigationLink("Channels") {
                    ChannelsDashboard(state: state)
                }
            }
            .navigationTitle("Dashboard")
        } detail: {
            OverviewDashboard(state: state)
        }
    }
}

struct OverviewDashboard: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // System Status Cards
                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible()),
                    GridItem(.flexible())
                ], spacing: 16) {
                    StatusCard(
                        title: "Gateway",
                        value: state.gatewayStatus.text,
                        icon: "network",
                        color: state.gatewayStatus.color
                    )

                    StatusCard(
                        title: "Active Sessions",
                        value: "\(state.stats?.activeSessions ?? 0)",
                        icon: "list.bullet",
                        color: .blue
                    )

                    StatusCard(
                        title: "Messages Today",
                        value: "\(state.stats?.messagesToday ?? 0)",
                        icon: "message",
                        color: .green
                    )
                }

                // Charts
                VStack(alignment: .leading, spacing: 12) {
                    Text("Message Activity")
                        .font(.headline)

                    MessageActivityChart(data: state.messageActivity)
                        .frame(height: 200)
                }
                .padding()
                .background(Color(.controlBackgroundColor))
                .cornerRadius(12)

                // Recent Activity
                VStack(alignment: .leading, spacing: 12) {
                    Text("Recent Activity")
                        .font(.headline)

                    ForEach(state.recentActivity) { activity in
                        ActivityRow(activity: activity)
                    }
                }
                .padding()
                .background(Color(.controlBackgroundColor))
                .cornerRadius(12)
            }
            .padding()
        }
    }
}
```

## 6. CLI Bridge (所有命令)

```swift
// CLIBridge.swift
actor CLIBridge {
    static let shared = CLIBridge()

    func execute(_ command: String, args: [String] = []) async throws -> CLIResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/local/bin/verso")
        process.arguments = [command] + args

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        try process.run()
        process.waitUntilExit()

        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()

        let output = String(data: outputData, encoding: .utf8) ?? ""
        let error = String(data: errorData, encoding: .utf8) ?? ""

        return CLIResult(
            exitCode: Int(process.terminationStatus),
            output: output,
            error: error
        )
    }

    // Convenience methods for common commands
    func status() async throws -> SystemStatus {
        let result = try await execute("status", args: ["--json"])
        return try JSONDecoder().decode(SystemStatus.self, from: result.output.data(using: .utf8)!)
    }

    func health() async throws -> HealthReport {
        let result = try await execute("health", args: ["--json"])
        return try JSONDecoder().decode(HealthReport.self, from: result.output.data(using: .utf8)!)
    }

    func doctor(fix: Bool = false) async throws -> DoctorReport {
        var args = ["--json"]
        if fix {
            args.append("--fix")
        }
        let result = try await execute("doctor", args: args)
        return try JSONDecoder().decode(DoctorReport.self, from: result.output.data(using: .utf8)!)
    }

    func listSessions() async throws -> [Session] {
        let result = try await execute("sessions", args: ["--json"])
        return try JSONDecoder().decode([Session].self, from: result.output.data(using: .utf8)!)
    }

    func resetSession(_ sessionId: String) async throws {
        _ = try await execute("reset", args: [sessionId])
    }

    func sendMessage(_ message: String, to: String? = nil) async throws {
        var args = [message]
        if let to = to {
            args.append(contentsOf: ["--to", to])
        }
        _ = try await execute("message", args: args)
    }
}
```

## 7. 功能完整性检查清单

### P0 - 核心功能（必须有）
- [x] Onboarding (完全复刻CLI)
- [x] Provider配置 (所有provider类型)
- [x] Gateway管理
- [x] 消息发送
- [x] 状态显示
- [x] Settings界面

### P1 - 重要功能
- [x] Agents管理
- [x] Sessions管理
- [x] Channels配置
- [x] Skills管理
- [x] Health检查

### P2 - 增强功能
- [x] Dashboard
- [x] Logs查看
- [x] Performance监控
- [x] Nodes管理

### P3 - 高级功能
- [x] ACP支持
- [x] Doctor诊断
- [x] 卸载功能

## 实施时间表

### Week 1: P0核心功能
- Day 1-2: Onboarding完整实现
- Day 3-4: Provider配置完整实现
- Day 5: Gateway管理和消息发送

### Week 2: P1重要功能
- Day 1-2: Agents和Sessions管理
- Day 3-4: Channels和Skills配置
- Day 5: Health检查和测试

### Week 3: P2增强功能
- Day 1-3: Dashboard实现
- Day 4-5: Logs和Performance监控

### Week 4: P3高级功能和优化
- Day 1-2: ACP和Doctor
- Day 3-4: 测试和bug修复
- Day 5: 文档和发布准备

---

**状态**: 完整设计完成
**目标**: Swift App = CLI完整功能 + 原生macOS体验
**预计工作量**: 4周
