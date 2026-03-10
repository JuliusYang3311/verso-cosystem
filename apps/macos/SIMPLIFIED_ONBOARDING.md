# Swift macOS App - 简化版Onboarding/Config方案

## 设计原则

**简化优先** - App只保留最核心的7个配置项，其他高级配置通过CLI完成

## 7个核心配置项

### 1. ✅ Workspace (必需)
- 设置workspace目录
- 创建sessions目录结构
- 初始化BOOTSTRAP.md等文件

### 2. ○ Model
- Provider选择（Anthropic/OpenAI/Custom）
- API Key配置
- 主模型选择

### 3. ○ Browser
- 启用/禁用headless browser
- Browser设置

### 4. ○ Web tools
- Brave Search API配置
- Web fetch设置

### 5. ○ Channels
- Telegram/Discord/Slack等配置
- 选择要启用的channels

### 6. ○ Evolver
- 启用/禁用Evolver
- Workspace路径
- 优化规则配置

### 7. ✅ Health check
- 运行系统健康检查
- 显示诊断结果

## Onboarding流程（简化版）

```swift
enum OnboardingPage: Int, CaseIterable {
    case welcome = 0        // 欢迎 + 风险警告
    case workspace = 1      // Workspace配置 (必需)
    case model = 2          // Model配置
    case browser = 3        // Browser配置
    case webTools = 4       // Web tools配置
    case channels = 5       // Channels配置
    case evolver = 6        // Evolver配置
    case healthCheck = 7    // Health check
    case complete = 8       // 完成

    var isRequired: Bool {
        switch self {
        case .welcome, .workspace, .healthCheck:
            return true
        default:
            return false
        }
    }

    var canSkip: Bool {
        return !isRequired
    }
}
```

## 1. Welcome Page

```swift
func welcomePage() -> some View {
    VStack(spacing: 24) {
        Image("VersoIcon")
            .resizable()
            .frame(width: 120, height: 120)

        Text("Welcome to Verso")
            .font(.largeTitle.weight(.semibold))

        Text("Your personal AI assistant")
            .font(.body)
            .foregroundStyle(.secondary)

        // 简化的安全警告
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Security Notice")
                        .font(.headline)

                    Text("Verso can execute commands and access files. Only use with trusted prompts.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color.orange.opacity(0.1))
        .cornerRadius(12)
        .frame(maxWidth: 500)

        Toggle("I understand and accept the risks", isOn: $riskAccepted)
            .toggleStyle(.checkbox)

        Button("Continue") {
            nextPage()
        }
        .buttonStyle(.borderedProminent)
        .disabled(!riskAccepted)
    }
}
```

## 2. Workspace Page (必需)

```swift
func workspacePage() -> some View {
    VStack(spacing: 24) {
        Text("Workspace")
            .font(.largeTitle.weight(.semibold))

        Text("Choose where Verso stores agent data, skills, and memory")
            .font(.body)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 500)

        VStack(alignment: .leading, spacing: 12) {
            Text("Workspace Path")
                .font(.headline)

            HStack {
                TextField("~/Documents/my-verso-workspace", text: $workspacePath)
                    .textFieldStyle(.roundedBorder)

                Button("Browse...") {
                    selectWorkspaceDirectory()
                }
                .buttonStyle(.bordered)
            }

            Text("Default: ~/verso")
                .font(.caption)
                .foregroundStyle(.secondary)

            // Workspace结构预览
            VStack(alignment: .leading, spacing: 4) {
                Text("Workspace will contain:")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text("  • tools/     - Custom tools")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Text("  • skills/    - Installed skills")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Text("  • memory/    - Agent memory")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Text("  • soul/      - Personality config")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .padding()
            .background(Color(.controlBackgroundColor))
            .cornerRadius(8)
        }
        .frame(maxWidth: 500)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                createWorkspace()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
            .disabled(workspacePath.isEmpty)
        }
    }
}
```

## 3. Model Page

```swift
func modelPage() -> some View {
    VStack(spacing: 24) {
        Text("Model")
            .font(.largeTitle.weight(.semibold))

        Text("Configure your AI provider")
            .font(.body)
            .foregroundStyle(.secondary)

        VStack(spacing: 16) {
            // Provider选择
            Picker("Provider", selection: $selectedProvider) {
                Text("Anthropic").tag(ProviderType.anthropic)
                Text("OpenAI").tag(ProviderType.openai)
                Text("Custom (Anthropic)").tag(ProviderType.customAnthropic)
                Text("Custom (OpenAI)").tag(ProviderType.customOpenAI)
            }
            .pickerStyle(.segmented)

            // API Key
            VStack(alignment: .leading, spacing: 8) {
                Text("API Key")
                    .font(.headline)
                SecureField("sk-...", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
            }

            // Base URL (仅custom)
            if selectedProvider.isCustom {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Base URL")
                        .font(.headline)
                    TextField("https://api.example.com", text: $baseUrl)
                        .textFieldStyle(.roundedBorder)
                }
            }

            // 验证按钮
            HStack {
                Button("Verify") {
                    Task { await verifyProvider() }
                }
                .disabled(apiKey.isEmpty)

                if isVerifying {
                    ProgressView().controlSize(.small)
                }

                if let result = verificationResult {
                    Image(systemName: result.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(result.success ? .green : .red)
                }
            }
        }
        .frame(maxWidth: 500)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Skip") { nextPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                saveModelConfig()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
            .disabled(apiKey.isEmpty)
        }
    }
}
```

## 4. Browser Page

```swift
func browserPage() -> some View {
    VStack(spacing: 24) {
        Text("Browser")
            .font(.largeTitle.weight(.semibold))

        Text("Configure headless browser for web automation")
            .font(.body)
            .foregroundStyle(.secondary)

        VStack(alignment: .leading, spacing: 16) {
            Toggle("Enable browser tools", isOn: $browserEnabled)

            if browserEnabled {
                Toggle("Headless mode", isOn: $browserHeadless)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Browser tools allow Verso to:")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("  • Take screenshots")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("  • Navigate web pages")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("  • Fill forms")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: 500)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Skip") { nextPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                saveBrowserConfig()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
```

## 5. Web Tools Page

```swift
func webToolsPage() -> some View {
    VStack(spacing: 24) {
        Text("Web Tools")
            .font(.largeTitle.weight(.semibold))

        Text("Configure web search and fetch capabilities")
            .font(.body)
            .foregroundStyle(.secondary)

        VStack(alignment: .leading, spacing: 16) {
            Toggle("Enable web tools", isOn: $webToolsEnabled)

            if webToolsEnabled {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Brave Search API Key (optional)")
                        .font(.headline)
                    SecureField("BSA...", text: $braveApiKey)
                        .textFieldStyle(.roundedBorder)
                    Text("Get your API key at: https://brave.com/search/api/")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Toggle("Enable web fetch", isOn: $webFetchEnabled)
            }
        }
        .frame(maxWidth: 500)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Skip") { nextPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                saveWebToolsConfig()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
```

## 6. Channels Page

```swift
func channelsPage() -> some View {
    VStack(spacing: 24) {
        Text("Channels")
            .font(.largeTitle.weight(.semibold))

        Text("Connect Verso to messaging platforms")
            .font(.body)
            .foregroundStyle(.secondary)

        ScrollView {
            VStack(spacing: 12) {
                // Telegram
                ChannelToggle(
                    name: "Telegram",
                    icon: "paperplane.fill",
                    enabled: $telegramEnabled
                ) {
                    if telegramEnabled {
                        TelegramConfigView(config: $telegramConfig)
                    }
                }

                // Discord
                ChannelToggle(
                    name: "Discord",
                    icon: "bubble.left.and.bubble.right.fill",
                    enabled: $discordEnabled
                ) {
                    if discordEnabled {
                        DiscordConfigView(config: $discordConfig)
                    }
                }

                // Slack
                ChannelToggle(
                    name: "Slack",
                    icon: "number",
                    enabled: $slackEnabled
                ) {
                    if slackEnabled {
                        SlackConfigView(config: $slackConfig)
                    }
                }

                // WhatsApp
                ChannelToggle(
                    name: "WhatsApp",
                    icon: "message.fill",
                    enabled: $whatsappEnabled
                ) {
                    if whatsappEnabled {
                        WhatsAppConfigView(config: $whatsappConfig)
                    }
                }
            }
        }
        .frame(maxWidth: 600, maxHeight: 400)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Skip") { nextPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                saveChannelsConfig()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
```

## 7. Evolver Page

```swift
func evolverPage() -> some View {
    VStack(spacing: 24) {
        Text("Evolver")
            .font(.largeTitle.weight(.semibold))

        Text("Automatic workspace optimization")
            .font(.body)
            .foregroundStyle(.secondary)

        VStack(alignment: .leading, spacing: 16) {
            Toggle("Enable Evolver", isOn: $evolverEnabled)

            if evolverEnabled {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Evolver will automatically:")
                        .font(.headline)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("  • Monitor tools in your workspace")
                            .font(.callout)
                        Text("  • Optimize frequently used tools")
                            .font(.callout)
                        Text("  • Clean up unused tools")
                            .font(.callout)
                        Text("  • Solidify useful tools")
                            .font(.callout)
                    }
                    .foregroundStyle(.secondary)

                    Divider()

                    // 只有一个配置：是否需要review
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle("Require review before applying changes", isOn: $evolverRequireReview)

                        Text(evolverRequireReview
                            ? "You'll be asked to approve changes before they're applied"
                            : "Changes will be applied automatically after testing")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
                .background(Color(.controlBackgroundColor))
                .cornerRadius(12)
            }
        }
        .frame(maxWidth: 500)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Skip") { nextPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                saveEvolverConfig()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
```

## 8. Health Check Page (必需)

```swift
func healthCheckPage() -> some View {
    VStack(spacing: 24) {
        Text("Health Check")
            .font(.largeTitle.weight(.semibold))

        Text("Verifying your Verso installation")
            .font(.body)
            .foregroundStyle(.secondary)

        if isRunningHealthCheck {
            VStack(spacing: 16) {
                ProgressView()
                    .controlSize(.large)
                Text("Running health checks...")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        } else if let report = healthReport {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(report.checks) { check in
                        HealthCheckRow(check: check)
                    }
                }
            }
            .frame(maxWidth: 600, maxHeight: 400)

            if report.hasErrors {
                Button("Run Doctor") {
                    runDoctor()
                }
                .buttonStyle(.bordered)
            }
        }

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            if healthReport?.isHealthy == true {
                Button("Complete") {
                    completeOnboarding()
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button("Retry") {
                    runHealthCheck()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
    .onAppear {
        runHealthCheck()
    }
}

struct HealthCheckRow: View {
    let check: HealthCheck

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: check.status.icon)
                .foregroundStyle(check.status.color)
                .font(.title3)

            VStack(alignment: .leading, spacing: 4) {
                Text(check.name)
                    .font(.headline)
                if let message = check.message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
        }
        .padding()
        .background(Color(.controlBackgroundColor))
        .cornerRadius(8)
    }
}
```

## Settings Window (简化版)

```swift
struct SettingsView: View {
    @ObservedObject var state: AppState

    var body: some View {
        TabView {
            WorkspaceSettingsView(state: state)
                .tabItem { Label("Workspace", systemImage: "folder") }

            ModelSettingsView(state: state)
                .tabItem { Label("Model", systemImage: "brain") }

            BrowserSettingsView(state: state)
                .tabItem { Label("Browser", systemImage: "safari") }

            WebToolsSettingsView(state: state)
                .tabItem { Label("Web Tools", systemImage: "globe") }

            ChannelsSettingsView(state: state)
                .tabItem { Label("Channels", systemImage: "bubble.left.and.bubble.right") }

            EvolverSettingsView(state: state)
                .tabItem { Label("Evolver", systemImage: "wand.and.stars") }

            HealthSettingsView(state: state)
                .tabItem { Label("Health", systemImage: "heart.text.square") }
        }
        .frame(width: 700, height: 500)
    }
}
```

## 配置文件格式（简化版）

```json
{
  "wizard": {
    "lastRunAt": "2026-03-06T...",
    "lastRunVersion": "1.0.0",
    "lastRunCommand": "onboard",
    "lastRunMode": "app"
  },
  "agents": {
    "defaults": {
      "workspace": "~/Documents/my-verso-workspace"
    }
  },
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "api_key"
      }
    }
  },
  "browser": {
    "enabled": true,
    "headless": true
  },
  "tools": {
    "web": {
      "enabled": true,
      "braveApiKey": "BSA..."
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "..."
    }
  },
  "evolver": {
    "enabled": true,
    "workspace": "~/Documents/my-verso-workspace",
    "rules": {
      "solidify": {
        "minUsageCount": 5
      },
      "cleanup": {
        "enabled": true,
        "unusedDays": 30
      }
    }
  }
}
```

## 对比：简化版 vs 完整版

### 简化版（App）
- **7个配置项**
- **8个onboarding页面**
- **快速上手**（5-10分钟）
- **适合普通用户**

### 完整版（CLI）
- **20+配置项**
- **13个onboarding页面**
- **完整配置**（15-30分钟）
- **适合高级用户**

## 实施优先级

### Phase 1: 核心流程（1周）
1. Welcome + Risk
2. Workspace (必需)
3. Model
4. Health Check (必需)
5. Complete

### Phase 2: 扩展功能（1周）
1. Browser
2. Web Tools
3. Channels
4. Evolver

### Phase 3: Settings界面（1周）
1. 7个Settings标签页
2. 配置读写
3. 实时验证

---

**状态**: 简化设计完成
**目标**: 快速上手 + 核心功能
**预计工作量**: 3周
