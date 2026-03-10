import Foundation

public enum VersoCapability: String, Codable, Sendable {
    case canvas
    case camera
    case screen
    case voiceWake
    case location
}
