import Foundation

public enum VersoChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(VersoChatEventPayload)
    case agent(VersoAgentEventPayload)
    case seqGap
}

public protocol VersoChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> VersoChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [VersoChatAttachmentPayload]) async throws -> VersoChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> VersoChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<VersoChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension VersoChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "VersoChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> VersoChatSessionsListResponse {
        throw NSError(
            domain: "VersoChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
