// The last numbers each wallet had, so showing one again doesn't start from nothing. They're never current, so the store only
// shows them while it reads, and marks them as old. It's numbers and addresses, like what the server sends, with nothing that can move money.

import Foundation

extension URL {
    /// In Caches, which backups leave out, and the system can clear if it needs the room.
    public static var portfolioCache: URL { .cachesDirectory.appending(path: "Portfolios", directoryHint: .isDirectory) }
}

struct PortfolioCache {
    /// Each is one wallet in one method, currency and rule. More than anyone goes back and forth between.
    private static let limit = 40
    /// A wallet nobody has looked at for this long has nothing worth showing.
    private static let keepFor: TimeInterval = 30 * 24 * 3600
    /// A wallet can be read on every block, and the newest few seconds aren't worth a write each time.
    private static let writeEvery: TimeInterval = 60

    private struct Entry: Codable, Sendable {
        let server: URL
        let address: String
        let portfolio: Portfolio
    }

    /// Newest first.
    private var entries: [Entry] = []
    /// Where they stay across launches, or nil to keep them only in memory. Each wallet keeps its latest.
    private let directory: URL?
    /// One at a time and in order, or a write could bring back a wallet that was just removed.
    private static let disk = DispatchQueue(label: "PortfolioCache.disk", qos: .utility)
    private var readFromDisk: Set<String> = []
    private var writtenAt: [String: Date] = [:]

    init(directory: URL?, now: Date) {
        self.directory = directory
        guard let directory else { return }
        Self.disk.async {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            for file in files {
                let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
                if let modified, now.timeIntervalSince(modified) > Self.keepFor { try? FileManager.default.removeItem(at: file) }
            }
        }
    }

    /// The last numbers for this wallet on this server: those `isWanted` prefers if there are any, and otherwise the newest. Never another wallet's.
    mutating func last(of address: String, on server: URL, preferring isWanted: (Portfolio) -> Bool) -> Portfolio? {
        loadFromDisk(address, server)
        let known = entries.filter { $0.server == server && $0.address == address }
        return (known.first { isWanted($0.portfolio) } ?? known.first)?.portfolio
    }

    mutating func remember(_ portfolio: Portfolio, of address: String, on server: URL, at now: Date) {
        let entry = Entry(server: server, address: address, portfolio: portfolio)
        entries.removeAll { $0.server == server && $0.address == address && $0.portfolio.method == portfolio.method && $0.portfolio.currency == portfolio.currency && $0.portfolio.rule == portfolio.rule }
        entries.insert(entry, at: 0)
        if entries.count > Self.limit { entries.removeLast(entries.count - Self.limit) }
        write(entry, at: now)
    }

    /// It's off the user's list, so nothing about it stays here.
    mutating func forget(_ address: String) {
        entries.removeAll { $0.address == address }
        readFromDisk = readFromDisk.filter { !$0.hasPrefix(address) }
        writtenAt = writtenAt.filter { !$0.key.hasPrefix(address) }
        guard let directory else { return }
        Self.disk.async {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            for file in files where file.lastPathComponent.hasPrefix(address) { try? FileManager.default.removeItem(at: file) }
        }
    }

    /// Only a real address, because this becomes a file's name. The demo's numbers come straight from its fixtures anyway.
    private func fileName(_ address: String, _ server: URL) -> String? {
        guard WalletAddress.isValid(address), !WalletAddress.isDemo(address) else { return nil }
        return "\(address)-\(server.host() ?? "")-\(server.port ?? 0).json"
    }

    private mutating func loadFromDisk(_ address: String, _ server: URL) {
        guard let directory, let name = fileName(address, server), readFromDisk.insert(name).inserted else { return }
        let file = directory.appending(path: name)
        // Waits for any write still going, and it's small enough to show in the same moment as the wallet's name.
        guard let data = Self.disk.sync(execute: { try? Data(contentsOf: file) }) else { return }
        // From another version, it just isn't there. The next read replaces it.
        guard let entry = try? JSONDecoder().decode(Entry.self, from: data), entry.server == server, entry.address == address, entry.portfolio.address.lowercased() == address else { return }
        if !entries.contains(where: { $0.server == server && $0.address == address }) { entries.append(entry) }
    }

    private mutating func write(_ entry: Entry, at now: Date) {
        guard let directory, let name = fileName(entry.address, entry.server) else { return }
        if let last = writtenAt[name], now.timeIntervalSince(last) < Self.writeEvery { return }
        writtenAt[name] = now
        Self.disk.async {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            guard let data = try? JSONEncoder().encode(entry) else { return }
            try? data.write(to: directory.appending(path: name), options: .atomic)
        }
    }
}
