import Foundation
import Testing
@testable import Verso

@Suite(.serialized)
struct VersoConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            #expect(VersoConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            VersoConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(VersoConfigFile.remoteGatewayPort() == 19999)
            #expect(VersoConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(VersoConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(VersoConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            VersoConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            VersoConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = VersoConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": dir,
        ]) {
            #expect(VersoConfigFile.stateDirURL().path == dir)
            #expect(VersoConfigFile.url().path == "\(dir)/openclaw.json")
        }
    }
}
