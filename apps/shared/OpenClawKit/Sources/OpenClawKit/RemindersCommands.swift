import Foundation

public enum VersoRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
    case add = "reminders.add"
}

public enum VersoReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct VersoRemindersListParams: Codable, Sendable, Equatable {
    public var status: VersoReminderStatusFilter?
    public var limit: Int?

    public init(status: VersoReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct VersoRemindersAddParams: Codable, Sendable, Equatable {
    public var title: String
    public var dueISO: String?
    public var notes: String?
    public var listId: String?
    public var listName: String?

    public init(
        title: String,
        dueISO: String? = nil,
        notes: String? = nil,
        listId: String? = nil,
        listName: String? = nil)
    {
        self.title = title
        self.dueISO = dueISO
        self.notes = notes
        self.listId = listId
        self.listName = listName
    }
}

public struct VersoReminderPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var dueISO: String?
    public var completed: Bool
    public var listName: String?

    public init(
        identifier: String,
        title: String,
        dueISO: String? = nil,
        completed: Bool,
        listName: String? = nil)
    {
        self.identifier = identifier
        self.title = title
        self.dueISO = dueISO
        self.completed = completed
        self.listName = listName
    }
}

public struct VersoRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [VersoReminderPayload]

    public init(reminders: [VersoReminderPayload]) {
        self.reminders = reminders
    }
}

public struct VersoRemindersAddPayload: Codable, Sendable, Equatable {
    public var reminder: VersoReminderPayload

    public init(reminder: VersoReminderPayload) {
        self.reminder = reminder
    }
}
