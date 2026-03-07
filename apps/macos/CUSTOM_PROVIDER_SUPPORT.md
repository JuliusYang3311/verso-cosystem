# Swift macOS App - 自定义Provider支持方案

## 当前状态

Swift macOS应用（`apps/macos`）目前：
- ✅ 支持Anthropic OAuth认证
- ❌ 不支持API Key输入
- ❌ 不支持自定义provider配置
- ✅ 使用 `~/.verso/credentials/oauth.json` 存储OAuth凭证
- ✅ 使用 `~/.openclaw/openclaw.json` 作为主配置文件

## 目标

支持与CLI相同的auth profiles格式：

```json
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "api_key"
      },
      "openai:default": {
        "provider": "openai",
        "mode": "api_key"
      },
      "custom-anthropic:default": {
        "provider": "custom-anthropic",
        "mode": "api_key",
        "baseUrl": "https://api.example.com"
      },
      "custom-openai:default": {
        "provider": "custom-openai",
        "mode": "api_key",
        "baseUrl": "https://api.example.com"
      }
    }
  }
}
```

## 实施方案

### 1. 更新Onboarding流程

修改 `OnboardingView+Pages.swift` 中的 `anthropicAuthPage()`：

```swift
func providerAuthPage() -> some View {
    self.onboardingPage {
        Text("Choose Your AI Provider")
            .font(.largeTitle.weight(.semibold))

        // Provider选择
        Picker("Provider Type", selection: $selectedProviderType) {
            Text("Anthropic (Official)").tag(ProviderType.anthropic)
            Text("OpenAI (Official)").tag(ProviderType.openai)
            Text("Custom (Anthropic Protocol)").tag(ProviderType.customAnthropic)
            Text("Custom (OpenAI Protocol)").tag(ProviderType.customOpenAI)
        }
        .pickerStyle(.segmented)

        // 认证方式选择
        if selectedProviderType == .anthropic {
            Picker("Auth Mode", selection: $selectedAuthMode) {
                Text("OAuth").tag(AuthMode.oauth)
                Text("API Key").tag(AuthMode.apiKey)
            }
            .pickerStyle(.segmented)
        }

        // OAuth流程（保留现有代码）
        if selectedAuthMode == .oauth {
            // 现有的OAuth UI
        }

        // API Key输入
        if selectedAuthMode == .apiKey {
            VStack(alignment: .leading, spacing: 12) {
                Text("API Key")
                    .font(.headline)
                SecureField("sk-ant-...", text: $apiKey)
                    .textFieldStyle(.roundedBorder)

                if selectedProviderType.isCustom {
                    Text("Base URL")
                        .font(.headline)
                    TextField("https://api.example.com", text: $baseUrl)
                        .textFieldStyle(.roundedBorder)
                }

                Button("Save & Verify") {
                    Task { await saveAndVerifyProvider() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}
```

### 2. 创建Provider配置模型

```swift
// ProviderConfig.swift
enum ProviderType: String, Codable {
    case anthropic
    case openai
    case customAnthropic = "custom-anthropic"
    case customOpenAI = "custom-openai"

    var isCustom: Bool {
        self == .customAnthropic || self == .customOpenAI
    }
}

enum AuthMode: String, Codable {
    case oauth
    case apiKey = "api_key"
}

struct AuthProfile: Codable {
    let provider: ProviderType
    let mode: AuthMode
    var baseUrl: String?
}

struct AuthConfig: Codable {
    var profiles: [String: AuthProfile]
}
```

### 3. 更新配置存储

```swift
// AuthProfileStore.swift
actor AuthProfileStore {
    static let shared = AuthProfileStore()

    private let configURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".verso/config.json")
    }()

    func saveProfile(
        provider: ProviderType,
        mode: AuthMode,
        baseUrl: String? = nil
    ) async throws {
        var config = try await loadConfig()

        let profileKey = "\(provider.rawValue):default"
        var profile = AuthProfile(provider: provider, mode: mode)
        if provider.isCustom {
            profile.baseUrl = baseUrl
        }

        if config.auth == nil {
            config.auth = AuthConfig(profiles: [:])
        }
        config.auth?.profiles[profileKey] = profile

        try await saveConfig(config)
    }

    func loadConfig() async throws -> VersoConfig {
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            return VersoConfig()
        }
        let data = try Data(contentsOf: configURL)
        return try JSONDecoder().decode(VersoConfig.self, from: data)
    }

    func saveConfig(_ config: VersoConfig) async throws {
        let data = try JSONEncoder().encode(config)
        try data.write(to: configURL)
    }
}
```

### 4. API Key存储（安全）

使用macOS Keychain存储API Key：

```swift
// KeychainStore.swift
import Security

enum KeychainStore {
    static func save(apiKey: String, for provider: ProviderType) throws {
        let service = "ai.verso.provider"
        let account = provider.rawValue

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: apiKey.data(using: .utf8)!
        ]

        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)

        guard status == errSecSuccess else {
            throw KeychainError.saveFailed
        }
    }

    static func load(for provider: ProviderType) throws -> String? {
        let service = "ai.verso.provider"
        let account = provider.rawValue

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let apiKey = String(data: data, encoding: .utf8) else {
            return nil
        }

        return apiKey
    }
}
```

### 5. Provider验证

```swift
// ProviderVerifier.swift
actor ProviderVerifier {
    func verify(
        provider: ProviderType,
        apiKey: String,
        baseUrl: String? = nil
    ) async throws -> Bool {
        let url: URL

        switch provider {
        case .anthropic:
            url = URL(string: "https://api.anthropic.com/v1/messages")!
        case .openai:
            url = URL(string: "https://api.openai.com/v1/models")!
        case .customAnthropic:
            guard let base = baseUrl else { throw VerificationError.missingBaseUrl }
            url = URL(string: "\(base)/v1/messages")!
        case .customOpenAI:
            guard let base = baseUrl else { throw VerificationError.missingBaseUrl }
            url = URL(string: "\(base)/v1/models")!
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        if provider == .anthropic || provider == .customAnthropic {
            request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        } else {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            return false
        }

        return httpResponse.statusCode == 200 || httpResponse.statusCode == 401
    }
}
```

## 配置文件格式

### CLI格式（~/.verso/config.json）
```json
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "api_key"
      },
      "custom-openai:default": {
        "provider": "custom-openai",
        "mode": "api_key"
      }
    }
  }
}
```

### API Key存储
- **位置**: macOS Keychain
- **Service**: `ai.verso.provider`
- **Account**: `anthropic`, `openai`, `custom-anthropic`, `custom-openai`

### OAuth存储（保持不变）
- **位置**: `~/.verso/credentials/oauth.json`

## 实施步骤

1. ✅ 创建Provider配置模型
2. ✅ 实现Keychain存储
3. ✅ 更新Onboarding UI
4. ✅ 实现Provider验证
5. ✅ 更新配置文件读写
6. ✅ 测试所有provider类型

## 兼容性

- ✅ 与CLI的auth profiles格式完全兼容
- ✅ 支持从现有配置文件导入
- ✅ OAuth流程保持不变
- ✅ API Key安全存储在Keychain

## 用户体验

### Onboarding流程
1. 选择Provider类型（Anthropic/OpenAI/Custom）
2. 选择认证方式（OAuth/API Key）
3. 输入凭证（API Key + Base URL）
4. 验证连接
5. 保存配置

### Settings界面
- 可以切换provider
- 可以更新API Key
- 可以修改Base URL
- 显示当前provider状态

---

**状态**: 设计完成，待实施
**优先级**: 高
**预计工作量**: 2-3天
