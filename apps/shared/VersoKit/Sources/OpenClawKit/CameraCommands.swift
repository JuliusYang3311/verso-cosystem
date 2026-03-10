import Foundation

public enum VersoCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum VersoCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum VersoCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum VersoCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct VersoCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: VersoCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: VersoCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: VersoCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: VersoCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct VersoCameraClipParams: Codable, Sendable, Equatable {
    public var facing: VersoCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: VersoCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: VersoCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: VersoCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
