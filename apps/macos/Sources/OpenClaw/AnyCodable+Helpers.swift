import VersoKit
import VersoProtocol
import Foundation

// Prefer the VersoKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = VersoKit.AnyCodable
typealias InstanceIdentity = VersoKit.InstanceIdentity

extension AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: AnyCodable]? { self.value as? [String: AnyCodable] }
    var arrayValue: [AnyCodable]? { self.value as? [AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}

extension VersoProtocol.AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: VersoProtocol.AnyCodable]? { self.value as? [String: VersoProtocol.AnyCodable] }
    var arrayValue: [VersoProtocol.AnyCodable]? { self.value as? [VersoProtocol.AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: VersoProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [VersoProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}
