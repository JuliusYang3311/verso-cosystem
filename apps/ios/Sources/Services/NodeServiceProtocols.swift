import CoreLocation
import Foundation
import VersoKit
import UIKit

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: VersoCameraSnapParams) async throws -> (format: String, base64: String, width: Int, height: Int)
    func clip(params: VersoCameraClipParams) async throws -> (format: String, base64: String, durationMs: Int, hasAudio: Bool)
}

protocol ScreenRecordingServicing: Sendable {
    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
}

@MainActor
protocol LocationServicing: Sendable {
    func authorizationStatus() -> CLAuthorizationStatus
    func accuracyAuthorization() -> CLAccuracyAuthorization
    func ensureAuthorization(mode: VersoLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: VersoLocationGetParams,
        desiredAccuracy: VersoLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
}

protocol DeviceStatusServicing: Sendable {
    func status() async throws -> VersoDeviceStatusPayload
    func info() -> VersoDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: VersoPhotosLatestParams) async throws -> VersoPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: VersoContactsSearchParams) async throws -> VersoContactsSearchPayload
    func add(params: VersoContactsAddParams) async throws -> VersoContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: VersoCalendarEventsParams) async throws -> VersoCalendarEventsPayload
    func add(params: VersoCalendarAddParams) async throws -> VersoCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: VersoRemindersListParams) async throws -> VersoRemindersListPayload
    func add(params: VersoRemindersAddParams) async throws -> VersoRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: VersoMotionActivityParams) async throws -> VersoMotionActivityPayload
    func pedometer(params: VersoPedometerParams) async throws -> VersoPedometerPayload
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
