import Foundation

/// A transaction this Mac signed, before the server has seen it land: still on its way, or failed.
public struct SentTransaction: Equatable, Sendable {
    public enum Status: Sendable { case pending, failed }

    public let txHash: String
    public let date: Date
    /// What it does, in words.
    public let summary: String
    public let to: String?
    public let asset: String?
    public let status: Status

    public init(txHash: String, date: Date, summary: String, to: String?, asset: String?, status: Status) {
        self.txHash = txHash.lowercased()
        self.date = date
        self.summary = summary
        self.to = to?.lowercased()
        self.asset = asset
        self.status = status
    }
}

/// One row of the Transactions list.
public struct TransactionItem: Identifiable, Equatable, Sendable {
    public enum Status: Sendable { case done, pending, failed }

    public let txHash: String
    public let date: Date?
    public let summary: String?
    public let assets: [String]
    public let counterparty: String?
    /// The wallet's saved name for `counterparty`, if it has one.
    public let counterpartyName: String?
    public let amount: TransactionAmount?
    public let gain: TransactionGain?
    public let unknownCost: [String]
    public let status: Status
    /// The server has it, so its details can be explained.
    public let isRead: Bool
    let day: Date?
    /// Everything a search looks in, lowercased, as bytes, because a busy wallet's every transaction is searched with each key typed.
    let searchText: [UInt8]

    public var id: String { txHash }

    /// Who's on the other side, by name when there is one.
    public var counterpartyTitle: String? {
        counterpartyName ?? counterparty.map(Format.shortHash)
    }

    init(point: PnlPoint, txHash: String, status: Status, names: [String: String], calendar: Calendar) {
        let date = point.date
        let name = point.counterparty.flatMap { names[$0] }
        self.txHash = txHash
        self.date = date
        summary = point.summary
        assets = point.assets
        counterparty = point.counterparty
        counterpartyName = name
        amount = point.amount
        gain = point.gain
        unknownCost = point.unknownCost
        self.status = status
        isRead = true
        day = date.map(calendar.startOfDay)
        searchText = Self.searchText([point.summary, point.assets.joined(separator: " "), point.counterparty, name, txHash])
    }

    init(signed: SentTransaction, names: [String: String], calendar: Calendar) {
        let name = signed.to.flatMap { names[$0] }
        txHash = signed.txHash
        date = signed.date
        summary = signed.summary
        assets = signed.asset.map { [$0] } ?? []
        counterparty = signed.to
        counterpartyName = name
        amount = nil
        gain = nil
        unknownCost = []
        status = signed.status == .pending ? .pending : .failed
        isRead = false
        day = calendar.startOfDay(for: signed.date)
        searchText = Self.searchText([signed.summary, signed.asset, signed.to, name, txHash])
    }

    private static func searchText(_ parts: [String?]) -> [UInt8] {
        Array(parts.compactMap(\.self).joined(separator: "\n").lowercased().utf8)
    }

    func contains(_ word: [UInt8]) -> Bool {
        searchText.withUnsafeBytes { text in
            word.withUnsafeBytes { word in memmem(text.baseAddress, text.count, word.baseAddress, word.count) != nil }
        }
    }
}

/// A day of transactions, newest first.
public struct TransactionDay: Identifiable, Equatable, Sendable {
    /// The day's start, or nil for transactions with no readable date.
    public let day: Date?
    public let title: String
    public let items: [TransactionItem]

    /// Its first transaction's, because two days can share a date when one of them has none.
    public var id: String { items.first?.id ?? title }
}

/// Every transaction a wallet has, newest first, ready to search, filter and group by day.
/// Built once per read, because a busy wallet has tens of thousands, and filtered as the person types.
public struct TransactionLog: Equatable, Sendable {
    public let items: [TransactionItem]
    /// Every token that moved, for the filter.
    public let assets: [String]

    /// `names` maps lowercase addresses to what the person calls them. `signed` is what this Mac sent lately, which can be newer than what's read.
    public init(points: [PnlPoint], signed: [SentTransaction] = [], names: [String: String] = [:], calendar: Calendar = .current) {
        let failed = Set(signed.filter { $0.status == .failed }.map(\.txHash))
        var read = Set<String>()
        var items: [TransactionItem] = []
        items.reserveCapacity(points.count + signed.count)
        for point in points.reversed() {
            guard let hash = point.txHash else { continue }
            read.insert(hash)
            // A failed transaction still paid its fee, so it can be read, and only this Mac knows it failed.
            items.append(TransactionItem(point: point, txHash: hash, status: failed.contains(hash) ? .failed : .done, names: names, calendar: calendar))
        }
        // What hasn't been read yet goes where its date puts it. A failed one can be days old.
        let unread = signed.filter { !read.contains($0.txHash) }.sorted { $0.date > $1.date }.map { TransactionItem(signed: $0, names: names, calendar: calendar) }
        self.items = Self.merge(unread, into: items)
        assets = Set(self.items.flatMap(\.assets)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    public var isEmpty: Bool { items.isEmpty }

    /// Both newest first. One with no date stays where it is among the read ones.
    private static func merge(_ unread: [TransactionItem], into read: [TransactionItem]) -> [TransactionItem] {
        guard !unread.isEmpty else { return read }
        var merged: [TransactionItem] = []
        merged.reserveCapacity(read.count + unread.count)
        var next = unread.startIndex
        for item in read {
            while next < unread.endIndex, let date = item.date, let unreadDate = unread[next].date, unreadDate >= date {
                merged.append(unread[next])
                next += 1
            }
            merged.append(item)
        }
        return merged + unread[next...]
    }

    /// What matches every word of `query`, in what happened, a token, a name, an address or a hash, and moved `asset` if there is one.
    public func filtered(query: String, asset: String?) -> [TransactionItem] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map { Array($0.utf8) }
        if words.isEmpty, asset == nil { return items }
        return items.filter { item in
            (asset.map(item.assets.contains) ?? true) && words.allSatisfy(item.contains)
        }
    }

    /// The same, by day, newest first.
    public func days(query: String, asset: String?, now: Date = .now, calendar: Calendar = .current) -> [TransactionDay] {
        Self.group(filtered(query: query, asset: asset), now: now, calendar: calendar)
    }

    static func group(_ items: [TransactionItem], now: Date, calendar: Calendar) -> [TransactionDay] {
        var days: [TransactionDay] = []
        var start = items.startIndex
        while start < items.endIndex {
            let day = items[start].day
            var end = start + 1
            while end < items.endIndex, items[end].day == day { end += 1 }
            days.append(TransactionDay(day: day, title: title(of: day, now: now, calendar: calendar), items: Array(items[start..<end])))
            start = end
        }
        return days
    }

    /// Today and yesterday by name, then the date, with the year only when it isn't this one.
    static func title(of day: Date?, now: Date, calendar: Calendar) -> String {
        guard let day else { return "Unknown Date" }
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) { return "Yesterday" }
        return Format.day(day, withYear: !calendar.isDate(day, equalTo: now, toGranularity: .year), calendar: calendar)
    }
}

extension TransactionItem {
    /// What moved, signed by which way it went. A trade went both ways, so it has no sign. nil when nothing's known about it.
    public func amountText(_ currency: CurrencyCode) -> String? {
        guard let amount else { return nil }
        guard let micros = amount.micros else { return Wording.noPrice }
        let money = Format.money(micros, currency)
        guard Tone(signed: micros) != .neutral else { return money }
        switch amount.direction {
        case .in: return "+\(money)"
        case .out, .fee: return "-\(money)"
        case .trade: return money
        }
    }

    /// What a sale realized, or nil when nothing was sold.
    public func gainText(_ currency: CurrencyCode) -> String? {
        guard let gain else { return nil }
        return gain.micros.map { Format.estimate(Format.signedMoney($0, currency), gain.estimated) } ?? Wording.unknown
    }

    /// The first of its unknown costs that an open question asks about, which is where Fill In starts. That holds after
    /// all of it was sold or sent, since answering still fixes what the sale made. nil when no answer could change it.
    public func answerableAsset(in questions: [Question]) -> String? {
        unknownCost.first { asset in questions.contains { $0.arrivals.contains { $0.asset == asset } } }
    }

    /// Who's on the other side, from this wallet's point of view.
    public var counterpartyText: String? {
        guard let title = counterpartyTitle else { return nil }
        switch amount?.direction {
        case .in: return "From \(title)"
        case .out: return "To \(title)"
        // Only what this Mac sent is unread, and it was sent to them.
        case nil where !isRead: return "To \(title)"
        default: return title
        }
    }
}
