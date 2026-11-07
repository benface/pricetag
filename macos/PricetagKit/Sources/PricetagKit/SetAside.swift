import Foundation

/// What's saved here that this version couldn't read, exactly as it was, so a later change can't lose it. Nothing ever removes one.
enum SetAside {
    private struct Entry: Codable, Equatable {
        let key: String
        let bytes: Data
    }

    private static let key = "unreadableSaved"
    private static let seenKey = "unreadableSavedSeen"

    /// What's saved under `key`. What can't be read is copied first, and stays where it is until something replaces it.
    static func decoded<Value: Decodable>(_ type: Value.Type, key: String, in defaults: UserDefaults) -> Value? {
        guard let bytes = defaults.data(forKey: key) else { return nil }
        if let value = try? JSONDecoder().decode(type, from: bytes) { return value }
        keep(key: key, in: defaults)
        return nil
    }

    /// For what can be read, but only means something with what couldn't.
    static func keep(key: String, in defaults: UserDefaults) {
        guard let bytes = defaults.data(forKey: key) else { return }
        let kept = entries(in: defaults)
        let entry = Entry(key: key, bytes: bytes)
        guard !kept.contains(entry), let encoded = try? JSONEncoder().encode(kept + [entry]) else { return }
        defaults.set(encoded, forKey: Self.key)
    }

    static func hasUnseen(in defaults: UserDefaults) -> Bool {
        entries(in: defaults).count > defaults.integer(forKey: seenKey)
    }

    static func markSeen(in defaults: UserDefaults) {
        defaults.set(entries(in: defaults).count, forKey: seenKey)
    }

    private static func entries(in defaults: UserDefaults) -> [Entry] {
        guard let bytes = defaults.data(forKey: key) else { return [] }
        // This isn't thrown away either.
        return (try? JSONDecoder().decode([Entry].self, from: bytes)) ?? [Entry(key: key, bytes: bytes)]
    }
}
