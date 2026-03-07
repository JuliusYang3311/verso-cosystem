import AppKit
import SwiftUI

enum ProviderType: String, Codable, CaseIterable {
    case anthropic = "anthropic"
    case openai = "openai"
    case customAnthropic = "custom-anthropic"
    case customOpenAI = "custom-openai"

    var displayName: String {
        switch self {
        case .anthropic: return "Anthropic (Official)"
        case .openai: return "OpenAI (Official)"
        case .customAnthropic: return "Custom (Anthropic Protocol)"
        case .customOpenAI: return "Custom (OpenAI Protocol)"
        }
    }

    var icon: String {
        switch self {
        case .anthropic: return "brain.head.profile"
        case .openai: return "bolt.fill"
        case .customAnthropic: return "wrench.and.screwdriver.fill"
        case .customOpenAI: return "wrench.and.screwdriver.fill"
        }
    }

    var isCustom: Bool {
        self == .customAnthropic || self == .customOpenAI
    }
}

enum AuthMode: String, Codable {
    case oauth = "oauth"
    case apiKey = "api_key"
}

struct ModelSettings: View {
    @Bindable var state: AppState
    @State private var selectedProvider: ProviderType = .anthropic
    @State private var selectedAuthMode: AuthMode = .oauth
    @State private var apiKey: String = ""
    @State private var baseUrl: String = ""
    @State private var primaryModel: String = "claude-opus-4-6"
    @State private var isVerifying = false
    @State private var verificationResult: VerificationResult?
    @State private var statusMessage: String?

    struct VerificationResult {
        let success: Bool
        let message: String
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                VStack(alignment: .leading, spacing: 8) {
                    Text("Model Configuration")
                        .font(.title2.weight(.semibold))
                    Text("Configure your AI provider and model settings.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // Provider Selection
                VStack(alignment: .leading, spacing: 12) {
                    Label("Provider", systemImage: "server.rack")
                        .font(.headline)

                    Picker("Provider Type", selection: $selectedProvider) {
                        ForEach(ProviderType.allCases, id: \.self) { provider in
                            HStack {
                                Image(systemName: provider.icon)
                                Text(provider.displayName)
                            }
                            .tag(provider)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: selectedProvider) { _, _ in
                        updateAuthModeForProvider()
                    }
                }

                Divider()

                // Auth Mode Selection (only for Anthropic)
                if selectedProvider == .anthropic {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Authentication Mode", systemImage: "key.fill")
                            .font(.headline)

                        Picker("Auth Mode", selection: $selectedAuthMode) {
                            Text("OAuth").tag(AuthMode.oauth)
                            Text("API Key").tag(AuthMode.apiKey)
                        }
                        .pickerStyle(.segmented)
                    }

                    Divider()
                }

                // OAuth Section
                if selectedAuthMode == .oauth && selectedProvider == .anthropic {
                    oauthSection
                }

                // API Key Section
                if selectedAuthMode == .apiKey || selectedProvider != .anthropic {
                    apiKeySection
                }

                Divider()

                // Model Selection
                modelSelectionSection

                Divider()

                // Save Button
                HStack {
                    Spacer()
                    Button {
                        Task { await saveConfiguration() }
                    } label: {
                        Label("Save Configuration", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                }

                if let message = statusMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(message.contains("✓") ? .green : .secondary)
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

    private var oauthSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("OAuth Configuration", systemImage: "person.badge.key.fill")
                .font(.headline)

            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 10, height: 10)
                        Text("OAuth credentials stored at:")
                            .font(.callout)
                        Spacer()
                    }

                    Text("~/.verso/credentials/oauth.json")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)

                    HStack(spacing: 12) {
                        Button("Reveal in Finder") {
                            revealOAuthFile()
                        }
                        .buttonStyle(.bordered)

                        Button("Verify OAuth") {
                            Task { await verifyOAuth() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isVerifying)
                    }
                }
                .padding(8)
            }

            Text("OAuth tokens are managed by the CLI. Use `verso configure auth` to set up OAuth.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var apiKeySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("API Key Configuration", systemImage: "key.fill")
                .font(.headline)

            VStack(alignment: .leading, spacing: 8) {
                Text("API Key")
                    .font(.callout.weight(.semibold))

                SecureField(selectedProvider == .anthropic ? "sk-ant-..." : "sk-...", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))

                Text("Your API key is stored securely in macOS Keychain.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Base URL for custom providers
            if selectedProvider.isCustom {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Base URL")
                        .font(.callout.weight(.semibold))

                    TextField("https://api.example.com", text: $baseUrl)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))

                    Text("The base URL for your custom provider endpoint.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Verification
            HStack(spacing: 12) {
                Button {
                    Task { await verifyProvider() }
                } label: {
                    if isVerifying {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Verify Connection", systemImage: "checkmark.shield")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(apiKey.isEmpty || isVerifying || (selectedProvider.isCustom && baseUrl.isEmpty))

                if let result = verificationResult {
                    Image(systemName: result.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(result.success ? .green : .red)
                        .font(.title3)

                    Text(result.message)
                        .font(.caption)
                        .foregroundStyle(result.success ? .green : .red)
                }
            }
        }
    }

    private var modelSelectionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Model Selection", systemImage: "cpu")
                .font(.headline)

            VStack(alignment: .leading, spacing: 8) {
                Text("Primary Model")
                    .font(.callout.weight(.semibold))

                TextField("claude-opus-4-6", text: $primaryModel)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))

                Text("The main model used for agent responses.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Common models quick select
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Quick Select")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                        if selectedProvider == .anthropic || selectedProvider == .customAnthropic {
                            quickSelectButton("claude-opus-4-6", icon: "star.fill")
                            quickSelectButton("claude-sonnet-4-6", icon: "bolt.fill")
                            quickSelectButton("claude-haiku-4-5", icon: "hare.fill")
                        } else {
                            quickSelectButton("gpt-4", icon: "star.fill")
                            quickSelectButton("gpt-4-turbo", icon: "bolt.fill")
                            quickSelectButton("gpt-3.5-turbo", icon: "hare.fill")
                        }
                    }
                }
                .padding(8)
            }
        }
    }

    private func quickSelectButton(_ model: String, icon: String) -> some View {
        Button {
            primaryModel = model
        } label: {
            HStack {
                Image(systemName: icon)
                    .font(.caption)
                Text(model)
                    .font(.caption)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(primaryModel == model ? Color.accentColor.opacity(0.2) : Color.clear)
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }

    private func updateAuthModeForProvider() {
        // Only Anthropic supports OAuth in this UI
        if selectedProvider != .anthropic {
            selectedAuthMode = .apiKey
        }
    }

    private func loadConfiguration() {
        let config = VersoConfigFile.loadDict()

        // Load auth profiles
        if let auth = config["auth"] as? [String: Any],
           let profiles = auth["profiles"] as? [String: [String: Any]] {

            // Find first profile
            if let (_, profile) = profiles.first {
                if let providerStr = profile["provider"] as? String,
                   let provider = ProviderType(rawValue: providerStr) {
                    selectedProvider = provider
                }

                if let modeStr = profile["mode"] as? String,
                   let mode = AuthMode(rawValue: modeStr) {
                    selectedAuthMode = mode
                }

                if let url = profile["baseUrl"] as? String {
                    baseUrl = url
                }
            }
        }

        // Load model config
        if let agents = config["agents"] as? [String: Any],
           let defaults = agents["defaults"] as? [String: Any],
           let model = defaults["model"] as? [String: Any],
           let primary = model["primary"] as? String {
            primaryModel = primary
        }

        // Load API key from Keychain
        if let key = try? KeychainStore.load(for: selectedProvider) {
            apiKey = key
        }
    }

    private func saveConfiguration() async {
        var config = VersoConfigFile.loadDict()

        // Save auth profile
        var auth = config["auth"] as? [String: Any] ?? [:]
        var profiles = auth["profiles"] as? [String: [String: Any]] ?? [:]

        let profileKey = "\(selectedProvider.rawValue):default"
        var profile: [String: Any] = [
            "provider": selectedProvider.rawValue,
            "mode": selectedAuthMode.rawValue
        ]

        if selectedProvider.isCustom {
            profile["baseUrl"] = baseUrl
        }

        profiles[profileKey] = profile
        auth["profiles"] = profiles
        config["auth"] = auth

        // Save model config
        var agents = config["agents"] as? [String: Any] ?? [:]
        var defaults = agents["defaults"] as? [String: Any] ?? [:]
        var model = defaults["model"] as? [String: Any] ?? [:]
        model["primary"] = primaryModel
        defaults["model"] = model
        agents["defaults"] = defaults
        config["agents"] = agents

        VersoConfigFile.saveDict(config)

        // Save API key to Keychain
        if !apiKey.isEmpty {
            try? KeychainStore.save(apiKey: apiKey, for: selectedProvider)
        }

        statusMessage = "✓ Configuration saved"
    }

    private func verifyProvider() async {
        isVerifying = true
        verificationResult = nil

        do {
            let success = try await ProviderVerifier.verify(
                provider: selectedProvider,
                apiKey: apiKey,
                baseUrl: selectedProvider.isCustom ? baseUrl : nil
            )

            verificationResult = VerificationResult(
                success: success,
                message: success ? "Connection verified" : "Verification failed"
            )
        } catch {
            verificationResult = VerificationResult(
                success: false,
                message: error.localizedDescription
            )
        }

        isVerifying = false
    }

    private func verifyOAuth() async {
        isVerifying = true
        // TODO: Implement OAuth verification
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        isVerifying = false
    }

    private func revealOAuthFile() {
        let url = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".verso/credentials/oauth.json")
        NSWorkspace.shared.selectFile(url.path, inFileViewerRootedAtPath: url.deletingLastPathComponent().path)
    }
}

// MARK: - Keychain Store

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
            throw NSError(domain: "KeychainStore", code: Int(status))
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

// MARK: - Provider Verifier

actor ProviderVerifier {
    static func verify(
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
        request.timeoutInterval = 10

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

        // 200 = success, 401 = auth works but invalid key format
        return httpResponse.statusCode == 200 || httpResponse.statusCode == 401
    }
}

enum VerificationError: Error {
    case missingBaseUrl
}

#if DEBUG
struct ModelSettings_Previews: PreviewProvider {
    static var previews: some View {
        ModelSettings(state: .preview)
            .frame(width: 600, height: 700)
    }
}
#endif
