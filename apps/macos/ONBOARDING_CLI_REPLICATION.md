# Swift macOS App - Onboarding流程复刻方案

## CLI Onboarding完整流程

根据 `src/wizard/onboarding.ts` 分析，CLI的onboarding包含以下步骤：

### 1. Welcome & Risk Acknowledgement
- 显示欢迎信息
- 安全警告（AI可以执行命令、读写文件等）
- 用户必须确认理解风险

### 2. Flow Selection
- **QuickStart**: 快速配置，使用默认值
- **Advanced**: 完整配置，所有选项

### 3. Gateway Mode Selection
- **Local**: 本机运行gateway
- **Remote**: 连接远程gateway

### 4. Workspace Configuration
- 设置workspace目录（默认: `~/verso`）
- 创建workspace结构

### 5. Auth Choice (Provider Selection)
- Anthropic (setup-token/OAuth)
- OpenAI (API key)
- OpenAI Codex (OAuth)
- Google (OAuth)
- Custom providers
- Skip (稍后配置)

### 6. Model Selection
- **Primary model**: 主模型选择
- **Embedding model**: 嵌入模型选择
- **Memory L1 LLM mode**: 内存管理模式

### 7. Context/Compaction Config (Advanced only)
- Context window设置
- Compaction策略

### 8. Gateway Configuration
- Port设置
- Bind模式（loopback/lan/tailnet）
- Auth模式（token/password）
- Tailscale配置

### 9. Channels Setup
- Telegram
- Discord
- Slack
- WhatsApp
- 等等...

### 10. Skills Setup
- 选择要启用的skills
- 安装skills

### 11. Internal Hooks Setup
- Session memory hooks
- 其他内部钩子

### 12. Twitter Config (Advanced only)
- API credentials

### 13. Finalization
- 保存配置
- 启动gateway
- 显示完成信息

## Swift App Onboarding实施方案

### 页面结构

```swift
enum OnboardingPage: Int, CaseIterable {
    case welcome = 0           // 欢迎 + 风险警告
    case flowSelection = 1     // QuickStart vs Advanced
    case gatewayMode = 2       // Local vs Remote
    case workspace = 3         // Workspace配置
    case authChoice = 4        // Provider选择
    case modelSelection = 5    // 模型选择
    case contextConfig = 6     // Context配置（Advanced）
    case gatewayConfig = 7     // Gateway配置
    case channelsSetup = 8     // Channels配置
    case skillsSetup = 9       // Skills配置
    case hooksSetup = 10       // Hooks配置
    case twitterConfig = 11    // Twitter配置（Advanced）
    case complete = 12         // 完成

    var isAdvancedOnly: Bool {
        switch self {
        case .contextConfig, .twitterConfig:
            return true
        default:
            return false
        }
    }
}
```

### 1. Welcome Page (复刻CLI)

```swift
func welcomePage() -> some View {
    VStack(spacing: 24) {
        Text("Welcome to Verso")
            .font(.largeTitle.weight(.semibold))

        Text("Verso is a powerful personal AI assistant that can connect to WhatsApp, Telegram, and more.")
            .font(.body)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 560)

        // 安全警告（与CLI完全一致）
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Security warning — please read.")
                        .font(.headline)

                    Text("""
                    Verso is a hobby project and still in beta. Expect sharp edges.
                    This bot can read files and run actions if tools are enabled.
                    A bad prompt can trick it into doing unsafe things.

                    If you're not comfortable with basic security and access control, don't run Verso.
                    Ask someone experienced to help before enabling tools or exposing it to the internet.

                    Recommended baseline:
                    - Pairing/allowlists + mention gating.
                    - Sandbox + least-privilege tools.
                    - Keep secrets out of the agent's reachable filesystem.
                    - Use the strongest available model for any bot with tools or untrusted inboxes.

                    Run regularly:
                    verso security audit --deep
                    verso security audit --fix

                    Must read: https://docs.verso.ai/gateway/security
                    """)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color.orange.opacity(0.1))
        .cornerRadius(12)
        .frame(maxWidth: 600)

        // 风险确认
        Toggle("I understand this is powerful and inherently risky. Continue?",
               isOn: $riskAccepted)
            .toggleStyle(.checkbox)

        HStack {
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.bordered)

            Button("Continue") { nextPage() }
                .buttonStyle(.borderedProminent)
                .disabled(!riskAccepted)
        }
    }
}
```

### 2. Flow Selection Page

```swift
func flowSelectionPage() -> some View {
    VStack(spacing: 24) {
        Text("Onboarding mode")
            .font(.largeTitle.weight(.semibold))

        VStack(spacing: 16) {
            // QuickStart
            Button {
                selectedFlow = .quickstart
                nextPage()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("QuickStart")
                            .font(.headline)
                        Text("Configure details later via verso configure.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .padding()
                .frame(maxWidth: 500)
                .background(Color.accentColor.opacity(0.1))
                .cornerRadius(12)
            }
            .buttonStyle(.plain)

            // Advanced
            Button {
                selectedFlow = .advanced
                nextPage()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Manual")
                            .font(.headline)
                        Text("Configure port, network, Tailscale, and auth options.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .padding()
                .frame(maxWidth: 500)
                .background(Color.secondary.opacity(0.1))
                .cornerRadius(12)
            }
            .buttonStyle(.plain)
        }
    }
}
```

### 3. Gateway Mode Page

```swift
func gatewayModePage() -> some View {
    VStack(spacing: 24) {
        Text("What do you want to set up?")
            .font(.largeTitle.weight(.semibold))

        VStack(spacing: 16) {
            // Local Gateway
            Button {
                gatewayMode = .local
                nextPage()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Local gateway (this machine)")
                            .font(.headline)
                        Text(localGatewayStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .padding()
                .frame(maxWidth: 500)
            }
            .buttonStyle(.plain)

            // Remote Gateway
            Button {
                gatewayMode = .remote
                nextPage()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Remote gateway (info-only)")
                            .font(.headline)
                        Text(remoteGatewayStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .padding()
                .frame(maxWidth: 500)
            }
            .buttonStyle(.plain)
        }
    }
}
```

### 4. Workspace Page

```swift
func workspacePage() -> some View {
    VStack(spacing: 24) {
        Text("Workspace directory")
            .font(.largeTitle.weight(.semibold))

        Text("This is where Verso stores agent data, skills, and memory.")
            .font(.body)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)

        VStack(alignment: .leading, spacing: 12) {
            Text("Workspace Path")
                .font(.headline)

            HStack {
                TextField("~/verso", text: $workspacePath)
                    .textFieldStyle(.roundedBorder)

                Button("Browse...") {
                    selectWorkspaceDirectory()
                }
                .buttonStyle(.bordered)
            }

            Text("Default: ~/verso")
                .font(.caption)
                .foregroundStyle(.secondary)
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

### 5. Auth Choice Page (完全复刻CLI)

```swift
func authChoicePage() -> some View {
    VStack(spacing: 24) {
        Text("Choose your AI provider")
            .font(.largeTitle.weight(.semibold))

        ScrollView {
            VStack(spacing: 12) {
                // Anthropic (setup-token)
                authChoiceButton(
                    title: "Anthropic (setup-token)",
                    subtitle: "Claude via Anthropic Console token",
                    icon: "brain",
                    selected: authChoice == .anthropicSetupToken
                ) {
                    authChoice = .anthropicSetupToken
                }

                // Anthropic (OAuth)
                authChoiceButton(
                    title: "Anthropic (OAuth)",
                    subtitle: "Claude via OAuth flow",
                    icon: "key.fill",
                    selected: authChoice == .anthropicOAuth
                ) {
                    authChoice = .anthropicOAuth
                }

                // OpenAI (API Key)
                authChoiceButton(
                    title: "OpenAI",
                    subtitle: "GPT models via API key",
                    icon: "bolt.fill",
                    selected: authChoice == .openai
                ) {
                    authChoice = .openai
                }

                // OpenAI Codex (OAuth)
                authChoiceButton(
                    title: "OpenAI Codex",
                    subtitle: "Codex via OAuth",
                    icon: "terminal.fill",
                    selected: authChoice == .openaiCodex
                ) {
                    authChoice = .openaiCodex
                }

                // Google (OAuth)
                authChoiceButton(
                    title: "Google",
                    subtitle: "Gemini via OAuth",
                    icon: "g.circle.fill",
                    selected: authChoice == .google
                ) {
                    authChoice = .google
                }

                // Custom Anthropic
                authChoiceButton(
                    title: "Custom (Anthropic protocol)",
                    subtitle: "Anthropic-compatible API",
                    icon: "wrench.fill",
                    selected: authChoice == .customAnthropic
                ) {
                    authChoice = .customAnthropic
                }

                // Custom OpenAI
                authChoiceButton(
                    title: "Custom (OpenAI protocol)",
                    subtitle: "OpenAI-compatible API",
                    icon: "wrench.fill",
                    selected: authChoice == .customOpenAI
                ) {
                    authChoice = .customOpenAI
                }

                // Skip
                authChoiceButton(
                    title: "Skip (configure later)",
                    subtitle: "Set up authentication later",
                    icon: "arrow.right.circle",
                    selected: authChoice == .skip
                ) {
                    authChoice = .skip
                }
            }
        }
        .frame(maxWidth: 600)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                handleAuthChoice()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
            .disabled(authChoice == nil)
        }
    }
}
```

### 6. Model Selection Page

```swift
func modelSelectionPage() -> some View {
    VStack(spacing: 24) {
        Text("Model selection")
            .font(.largeTitle.weight(.semibold))

        VStack(alignment: .leading, spacing: 20) {
            // Primary Model
            VStack(alignment: .leading, spacing: 8) {
                Text("Primary model")
                    .font(.headline)
                Text("Main model for agent responses")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Primary model", selection: $primaryModel) {
                    ForEach(availableModels, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                .pickerStyle(.menu)
            }

            // Embedding Model
            VStack(alignment: .leading, spacing: 8) {
                Text("Embedding model")
                    .font(.headline)
                Text("Model for vector embeddings and memory")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Embedding model", selection: $embeddingModel) {
                    ForEach(availableEmbeddingModels, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                .pickerStyle(.menu)
            }

            // Memory L1 LLM Mode
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Enable Memory L1 LLM mode", isOn: $memoryL1LlmEnabled)
                Text("Use LLM for memory summarization")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: 500)

        HStack {
            Button("Back") { previousPage() }
                .buttonStyle(.bordered)

            Button("Continue") {
                saveModelConfig()
                nextPage()
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
```

### 配置保存格式（与CLI完全一致）

```swift
struct VersoConfig: Codable {
    var wizard: WizardMetadata?
    var gateway: GatewayConfig?
    var agents: AgentsConfig?
    var auth: AuthConfig?
    var channels: ChannelsConfig?
    var skills: [String]?
    var hooks: HooksConfig?
    var twitter: TwitterConfig?
}

struct WizardMetadata: Codable {
    var lastRunAt: Date
    var lastRunVersion: String
    var lastRunCommand: String
    var lastRunMode: String
}

struct GatewayConfig: Codable {
    var mode: String  // "local" | "remote"
    var port: Int?
    var bind: String?  // "loopback" | "lan" | "tailnet"
    var auth: GatewayAuthConfig?
    var remote: RemoteGatewayConfig?
}

struct AgentsConfig: Codable {
    var defaults: AgentDefaults?
}

struct AgentDefaults: Codable {
    var workspace: String?
    var model: ModelConfig?
}

struct ModelConfig: Codable {
    var primary: String?
    var fallbacks: [String]?
}

struct AuthConfig: Codable {
    var profiles: [String: AuthProfile]
}

struct AuthProfile: Codable {
    var provider: String
    var mode: String  // "api_key" | "oauth"
    var baseUrl: String?
}
```

## 实施优先级

### Phase 1: 核心流程（必需）
1. ✅ Welcome + Risk acknowledgement
2. ✅ Flow selection (QuickStart/Advanced)
3. ✅ Gateway mode (Local/Remote)
4. ✅ Workspace configuration
5. ✅ Auth choice (所有provider)
6. ✅ Model selection
7. ✅ Gateway configuration
8. ✅ Save config

### Phase 2: 扩展功能
1. ⏳ Channels setup
2. ⏳ Skills setup
3. ⏳ Hooks setup
4. ⏳ Context/Compaction config (Advanced)
5. ⏳ Twitter config (Advanced)

### Phase 3: 优化
1. ⏳ 配置验证
2. ⏳ 错误处理
3. ⏳ 进度保存（可以中断后继续）
4. ⏳ 配置导入/导出

## 关键点

1. **完全复刻CLI流程** - 不添加自定义功能
2. **配置格式一致** - 与 `~/.verso/config.json` 完全兼容
3. **Auth profiles支持** - 支持所有CLI支持的provider
4. **QuickStart vs Advanced** - 两种模式，与CLI一致
5. **安全警告** - 必须显示并确认

---

**状态**: 设计完成
**下一步**: 实施Phase 1核心流程
**预计工作量**: 3-5天
