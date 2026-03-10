import Foundation

public enum VersoDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum VersoBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum VersoThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum VersoNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum VersoNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct VersoBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: VersoBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: VersoBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct VersoThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: VersoThermalState

    public init(state: VersoThermalState) {
        self.state = state
    }
}

public struct VersoStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct VersoNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: VersoNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [VersoNetworkInterfaceType]

    public init(
        status: VersoNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [VersoNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct VersoDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: VersoBatteryStatusPayload
    public var thermal: VersoThermalStatusPayload
    public var storage: VersoStorageStatusPayload
    public var network: VersoNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: VersoBatteryStatusPayload,
        thermal: VersoThermalStatusPayload,
        storage: VersoStorageStatusPayload,
        network: VersoNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct VersoDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
