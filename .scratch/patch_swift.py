K='macos/PricetagKit/Sources/PricetagKit/'
p=K+'Models.swift'; s=open(p).read()
s=s.replace('''    public let realizedUsdMicros: String?
    public let unrealizedUsdMicros: String?
}

/// How a position's activity''','''    public let realizedUsdMicros: String?
    public let unrealizedUsdMicros: String?
    public let estimatedCostUsdMicros: String
    public let estimatedRealizedUsdMicros: String
}

/// Which of a position's numbers rest on an estimate, so they can look different from exact ones.
public struct Estimates: Codable, Sendable, Equatable {
    public let cost: Bool
    public let value: Bool
    public let realized: Bool
    public let unrealized: Bool
}

/// How a position's activity''')
s=s.replace('''    public let legCount: Int
    public let reconciliation: Reconciliation?

    public var id: String { asset }''','''    public let legCount: Int
    public let reconciliation: Reconciliation?
    /// No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL.
    public let noMarket: Bool
    public let estimates: Estimates
    /// Its cost is unknown, and answering a question could change that.
    public let resolvable: Bool

    public var id: String { asset }''')
s=s.replace('''    public let unpricedGas: Bool
    public let coverage: TotalsCoverage
}''','''    public let unpricedGas: Bool
    public let coverage: TotalsCoverage
    /// What's held with an unknown cost, at today's price. It's not in any PnL.
    public let unresolvedUsdMicros: String
    /// How much of what these sums are made of is an estimate.
    public let estimatedUsdMicros: String
    public let estimated: TotalEstimates
    /// Assets with no market, which aren't in any of this.
    public let noMarket: [String]
}

public struct TotalEstimates: Codable, Sendable, Equatable {
    public let value: Bool
    public let realized: Bool
    public let unrealized: Bool
}''')
s=s.replace('''    public let pnlStatus: PnlStatus
    public let points: [PnlPoint]

    /// Nothing moved''','''    public let pnlStatus: PnlStatus
    public let points: [PnlPoint]
    /// What's left to ask, most useful first.
    public let questions: [Question]
    public let meter: Meter
    /// Linked wallets that aren't read yet, so what came from them shows as unresolved for now.
    public let linkedReading: [String]
    /// Tokens off the allowlist that moved here, which have no position or price.
    public let unlistedTokens: Int
    public let marketChecked: Bool

    /// What the holdings table lists. Tokens with no market go in a group of their own, so real warnings stay noticeable.
    public var listedPositions: [Position] { positions.filter { !$0.noMarket } }
    public var noMarketPositions: [Position] { positions.filter(\\.noMarket) }

    /// Nothing moved''')
s=s.replace('''    public let costLabel: String
    public let blockNum: Int''','''    public let costLabel: String
    /// Its cost or proceeds rest on an estimate.
    public let estimated: Bool
    /// Some of what arrived has a known cost and some doesn't.
    public let partlyUnknown: Bool
    public let blockNum: Int''')
s=s.replace('''public enum WalletAddress {''','''/// A public name for an address. It's only evidence: exchanges send everyone's withdrawals from shared addresses.
public struct KnownSender: Codable, Sendable, Equatable {
    public let name: String
    public let kind: String
}

public struct Arrival: Codable, Sendable, Equatable, Identifiable {
    public let asset: String
    public let decimals: Int
    public let units: String

    public var id: String { asset }
}

/// One thing the app can't work out by itself, asked once per address however many transfers it covers.
public struct Question: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        /// Who is this?
        case sender
        /// There's nobody to ask about, so what did it cost?
        case cost
    }

    public let id: String
    public let kind: Kind
    public let wallet: String
    public let sender: String?
    public let known: KnownSender?
    public let costKey: String?
    /// They said it's their exchange account, and it still needs a cost.
    public let needsCost: Bool
    public let arrivals: [Arrival]
    public let transfers: Int
    public let firstAt: String
    public let lastAt: String
    /// Facts that might help. Never a preselected answer.
    public let evidence: [String]
    public let valueUsdMicros: String?
}

public struct Meter: Codable, Sendable, Equatable {
    public let open: Int
    public let answered: Int

    /// How far through the questions this is, from 0 to 1.
    public var progress: Double {
        let total = open + answered
        return total == 0 ? 1 : Double(answered) / Double(total)
    }

    public var isBalanced: Bool { open == 0 && answered > 0 }
}

/// What the headline would say with a different set of answers, before any of them is final.
public struct BookPreview: Codable, Sendable, Equatable {
    public let pnlUsdMicros: String?
    public let pnlStatus: PnlStatus
    public let estimatedUsdMicros: String
    public let unresolvedUsdMicros: String
    public let open: Int
    /// A wallet these answers link hasn't been read yet, so this can't say yet.
    public let pending: Bool
}

/// A withdrawal found in an exchange's history, with what it cost.
public struct ExchangeWithdrawal: Codable, Sendable, Equatable {
    public let exchange: String
    public let asset: String
    public let units: String
    public let at: String
    public let costUsdMicros: String
    public let toAddress: String?
}

public struct ExchangeImport: Codable, Sendable, Equatable {
    public let withdrawals: [ExchangeWithdrawal]
    /// Withdrawals with no usable cost: bought in another currency, or with a history this can't follow.
    public let skipped: Int
}

public struct SenderAnswer: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case mine
        case myExchange = "my-exchange"
        case someoneElse = "someone-else"
    }

    public let kind: Kind
    /// What was paid for everything from this address, by asset, in micro-USD.
    public let costs: [String: String]?

    public init(kind: Kind, costs: [String: String]? = nil) {
        self.kind = kind
        self.costs = costs
    }

    public static let mine = SenderAnswer(kind: .mine)
    public static let someoneElse = SenderAnswer(kind: .someoneElse)
}

/// The user's answers. They stay on this device, and go along with each request. The server doesn't keep them.
public struct Book: Codable, Sendable, Equatable, Hashable {
    public var senders: [String: SenderAnswer]
    public var costs: [String: String]
    public var withdrawals: [ExchangeWithdrawal]

    public init(senders: [String: SenderAnswer] = [:], costs: [String: String] = [:], withdrawals: [ExchangeWithdrawal] = []) {
        self.senders = senders
        self.costs = costs
        self.withdrawals = withdrawals
    }

    /// Saying a sender's yours says the wallet you're looking at is yours too.
    public func answering(_ sender: String, _ answer: SenderAnswer, focus: String?) -> Book {
        var next = self
        next.senders[sender.lowercased()] = answer
        if answer.kind == .mine, let focus, WalletAddress.isValid(focus) { next.senders[focus.lowercased()] = .mine }
        return next
    }

    public func enteringCost(_ key: String, usdMicros: String) -> Book {
        var next = self
        next.costs[key] = usdMicros
        return next
    }

    public var linkedWallets: [String] {
        senders.filter { $0.value.kind == .mine }.keys.sorted()
    }

    public var isEmpty: Bool { senders.isEmpty && costs.isEmpty && withdrawals.isEmpty }
}

extension SenderAnswer: Hashable {}
extension ExchangeWithdrawal: Hashable {}

public enum WalletAddress {''')
open(p,'w').write(s)

p=K+'PricetagClient.swift'; s=open(p).read()
s=s.replace('''public protocol PortfolioSource: Sendable {
    func portfolio(address: String, method: CostMethod, timeout: Duration) async throws -> Portfolio
    func explanation(of target: ExplainTarget, address: String, method: CostMethod) async throws -> Explanation
}
''','''public protocol PortfolioSource: Sendable {
    func portfolio(address: String, method: CostMethod, book: Book, timeout: Duration) async throws -> Portfolio
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, book: Book) async throws -> Explanation
    /// What each set of answers would do to the headline, in the same order.
    func previews(address: String, method: CostMethod, candidates: [Book]) async throws -> [BookPreview]
    func exportCSV(address: String, method: CostMethod, book: Book) async throws -> String
    func importCoinbase(csv: String) async throws -> ExchangeImport
    func verifyLink(owner: String, address: String, signature: String) async throws -> Bool
}

/// Nothing here needs to be there for a source that only reads, like one in a test.
extension PortfolioSource {
    public func previews(address: String, method: CostMethod, candidates: [Book]) async throws -> [BookPreview] { throw FetchError.unreachable }
    public func exportCSV(address: String, method: CostMethod, book: Book) async throws -> String { throw FetchError.unreachable }
    public func importCoinbase(csv: String) async throws -> ExchangeImport { throw FetchError.unreachable }
    public func verifyLink(owner: String, address: String, signature: String) async throws -> Bool { throw FetchError.unreachable }
}
''')
a=s.index('    public func portfolio(address: String, method: CostMethod, timeout'); b=s.index('        let data: Data\n')
s=s[:a]+'''    public func portfolio(address: String, method: CostMethod, book: Book, timeout: Duration) async throws -> Portfolio {
        try await decoded(post("/api/portfolio/\\(address)", body: FoldBody(method: method, book: book), timeout: timeout))
    }

    public func explanation(of target: ExplainTarget, address: String, method: CostMethod, book: Book) async throws -> Explanation {
        try await decoded(post("/api/portfolio/\\(address)/explain", query: target.queryItems, body: FoldBody(method: method, book: book), timeout: .seconds(30)))
    }

    public func previews(address: String, method: CostMethod, candidates: [Book]) async throws -> [BookPreview] {
        let answer: PreviewAnswer = try await decoded(post("/api/portfolio/\\(address)/preview", body: PreviewBody(method: method, candidates: candidates), timeout: .seconds(30)))
        return answer.previews
    }

    public func exportCSV(address: String, method: CostMethod, book: Book) async throws -> String {
        let data = try await post("/api/portfolio/\\(address)/export", body: FoldBody(method: method, book: book), timeout: .seconds(30))
        guard let text = String(data: data, encoding: .utf8) else { throw FetchError.rejected("The server sent something this version can't read.") }
        return text
    }

    public func importCoinbase(csv: String) async throws -> ExchangeImport {
        try await decoded(post("/api/import/coinbase", body: ["csv": csv], timeout: .seconds(30)))
    }

    public func verifyLink(owner: String, address: String, signature: String) async throws -> Bool {
        let answer: VerifyAnswer = try await decoded(post("/api/links/verify", body: ["owner": owner, "address": address, "signature": signature], timeout: .seconds(15)))
        return answer.verified
    }

    private func decoded<Body: Decodable>(_ data: Data) throws -> Body {
        do {
            return try JSONDecoder().decode(Body.self, from: data)
        } catch {
            throw FetchError.rejected("The server sent something this version can't read.")
        }
    }

    /// A post, because answers don't belong in a URL, where they'd end up in logs.
    private func post<Body: Encodable>(_ path: String, query: [URLQueryItem] = [], body: Body, timeout: Duration) async throws -> Data {
        var components = URLComponents(url: serverURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw FetchError.rejected("That server address isn't a valid URL.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = Double(timeout.components.seconds)

'''+s[b:]
s=s.replace('''        if status == 200 {
            do {
                return try JSONDecoder().decode(Body.self, from: data)
            } catch {
                throw FetchError.rejected("The server sent something this version can't read.")
            }
        }
''','''        if status == 200 { return data }
''')
s=s.replace('''    private struct ErrorBody: Decodable {
        let error: String
    }
''','''    private struct ErrorBody: Decodable {
        let error: String
    }

    private struct FoldBody: Encodable {
        let method: CostMethod
        let book: Book
    }

    private struct PreviewBody: Encodable {
        let method: CostMethod
        let candidates: [Book]
    }

    private struct PreviewAnswer: Decodable {
        let previews: [BookPreview]
    }

    private struct VerifyAnswer: Decodable {
        let verified: Bool
    }
''')
open(p,'w').write(s)

p=K+'PortfolioStore.swift'; s=open(p).read()
s=s.replace('''    public let method: CostMethod
    public let serverURL: URL
}''','''    public let method: CostMethod
    public let serverURL: URL
    public let book: Book
}''')
s=s.replace('''    public private(set) var serverURL: URL

    @ObservationIgnored private var source''','''    public private(set) var serverURL: URL
    /// What the user has said about where things came from. It stays on this device.
    public private(set) var book: Book
    /// What each answer replaced, newest last, so Undo is always there.
    public private(set) var undoStack: [Book] = []

    @ObservationIgnored private var source''')
s=s.replace('''        self.serverURL = serverURL
        self.feed = address == nil''','''        self.serverURL = serverURL
        self.book = defaults.data(forKey: Keys.book).flatMap { try? JSONDecoder().decode(Book.self, from: $0) } ?? Book()
        self.feed = address == nil''')
s=s.replace('''    /// nil with no wallet, when there's nothing to explain.
    public func explanationRequest(for target: ExplainTarget) -> ExplanationRequest? {
        address.map { ExplanationRequest(target: target, address: $0, method: method, serverURL: serverURL) }
    }
''','''    /// Takes effect right away, and the numbers follow as soon as the server has folded them. Undo goes back to what this replaced.
    public func setBook(_ next: Book) {
        guard next != book else { return }
        undoStack.append(book)
        store(next)
    }

    public func undo() {
        guard let previous = undoStack.popLast() else { return }
        store(previous)
    }

    private func store(_ next: Book) {
        book = next
        defaults.set(try? JSONEncoder().encode(next), forKey: Keys.book)
        start()
    }

    /// What these answers would do to the headline. Nothing's kept, so asking changes nothing.
    public func previews(of candidates: [Book]) async throws -> [BookPreview] {
        guard let address else { throw FetchError.unreachable }
        return try await source.previews(address: address, method: method, candidates: candidates)
    }

    /// Every movement as a spreadsheet, marked so an estimate or an unknown can't pass for an exact number.
    public func exportCSV() async throws -> String {
        guard let address else { throw FetchError.unreachable }
        return try await source.exportCSV(address: address, method: method, book: book)
    }

    /// Reads an exchange's history, and keeps what it found on this device. Says how many withdrawals had no usable cost.
    public func importCoinbase(csv: String) async throws -> ExchangeImport {
        let imported = try await source.importCoinbase(csv: csv)
        var next = book
        next.withdrawals = imported.withdrawals
        setBook(next)
        return imported
    }

    /// Links a wallet that proved it's this user's by signing. Says whether the signature holds up.
    public func linkProved(_ wallet: String, signature: String) async throws -> Bool {
        guard let address, WalletAddress.isValid(address) else { return false }
        guard try await source.verifyLink(owner: address, address: wallet, signature: signature) else { return false }
        setBook(book.answering(wallet, .mine, focus: address))
        return true
    }

    /// nil with no wallet, when there's nothing to explain.
    public func explanationRequest(for target: ExplainTarget) -> ExplanationRequest? {
        address.map { ExplanationRequest(target: target, address: $0, method: method, serverURL: serverURL, book: book) }
    }
''')
s=s.replace('''return try await source.explanation(of: request.target, address: request.address, method: request.method)''','''return try await source.explanation(of: request.target, address: request.address, method: request.method, book: request.book)''')
s=s.replace('''        let serverURL = self.serverURL
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { [self] in !Task.isCancelled && address == self.address && method == self.method && serverURL == self.serverURL }''','''        let serverURL = self.serverURL
        let book = self.book
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { [self] in !Task.isCancelled && address == self.address && method == self.method && serverURL == self.serverURL && book == self.book }''')
s=s.replace('''let next = try await source.portfolio(address: address, method: method, timeout: timeout)''','''let next = try await source.portfolio(address: address, method: method, book: book, timeout: timeout)''')
s=s.replace('''        static let server = "serverURL"
''','''        static let server = "serverURL"
        static let book = "book"
''')
open(p,'w').write(s)

p=K+'Format.swift'; s=open(p).read()
s=s.replace('''    public static func block(_ number: Int) -> String {''','''    /// An estimate has to look different from an exact value, wherever it's shown.
    public static func estimate(_ text: String, _ isEstimate: Bool) -> String {
        isEstimate ? "≈\\(text)" : text
    }

    /// Micro-USD from what someone typed, like "$1,234.50". nil when it isn't an amount. Cents past six places are cut.
    public static func micros(fromDollars text: String) -> String? {
        let clean = text.filter { !" $,".contains($0) }
        guard clean.wholeMatch(of: /\\d+(\\.\\d*)?|\\.\\d+/) != nil else { return nil }
        let parts = clean.split(separator: ".", omittingEmptySubsequences: false)
        let whole = parts.first.map(String.init) ?? ""
        let fraction = parts.count > 1 ? String(parts[1].prefix(6)) : ""
        let digits = (whole + fraction.padding(toLength: 6, withPad: "0", startingAt: 0)).drop { $0 == "0" }
        return digits.isEmpty ? "0" : String(digits)
    }

    public static func block(_ number: Int) -> String {''')
open(p,'w').write(s)

p=K+'Wording.swift'; s=open(p).read()
s=s.replace('''    public static let unpricedGas =''','''    /// What sits right next to a total, so it never appears bare. nil when it's exact and whole.
    public static func headlineCaveat(_ totals: Totals) -> String? {
        var parts: [String] = []
        if isPositive(totals.unresolvedUsdMicros) { parts.append("\\(Format.usd(totals.unresolvedUsdMicros)) unresolved") }
        if isPositive(totals.estimatedUsdMicros) { parts.append("\\(Format.usd(totals.estimatedUsdMicros)) estimated") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What isn't listed with the holdings, and why it doesn't matter to the numbers. nil when there's nothing.
    public static func noMarket(_ portfolio: Portfolio) -> String? {
        let listed = portfolio.noMarketPositions.map(\\.asset)
        let total = listed.count + portfolio.unlistedTokens
        if total == 0 { return nil }
        let off = portfolio.unlistedTokens == 0 ? "" : "\\(listed.isEmpty ? "" : ", plus ")\\(portfolio.unlistedTokens) we don't track"
        return "\\(total) \\(total == 1 ? "token" : "tokens") with no market: \\(listed.joined(separator: ", "))\\(off). Often spam, and not counted in any total."
    }

    /// Where a price came from, in plain words.
    public static func priceSource(_ source: String) -> String {
        switch source {
        case "oracle": "price feed"
        case "swap": "swap"
        case "market": "recent trades"
        default: source
        }
    }

    /// Where a cost came from, in plain words.
    public static func costSource(_ label: String) -> String {
        switch label {
        case "paid": "what you paid"
        case "inherited": "from your other wallet"
        case "received at market": "price when it arrived"
        case "self-reported": "what you reported"
        default: label
        }
    }

    public static func kind(_ kind: String) -> String {
        kind == "swap" ? "trade" : kind == "gas" ? "network fee" : kind
    }

    /// A preview's headline, as it would read.
    public static func consequence(_ preview: BookPreview) -> String {
        if preview.pending { return "Reading that wallet…" }
        guard let pnl = preview.pnlUsdMicros else { return "PnL still unavailable" }
        let number = Format.estimate(Format.signedUSD(pnl), isPositive(preview.estimatedUsdMicros))
        return isPositive(preview.unresolvedUsdMicros) ? "\\(number) · \\(Format.usd(preview.unresolvedUsdMicros)) unresolved" : number
    }

    public static let unpricedGas =''')
open(p,'w').write(s)

p=K+'FeedSummary.swift'; s=open(p).read()
s=s.replace('''            (text, isWarning) = (prefix + Format.signedUSD(pnl), portfolio.pnlStatus == .partial)''','''            (text, isWarning) = (prefix + Format.estimate(Format.signedUSD(pnl), isPositive(portfolio.totals.estimatedUsdMicros)), portfolio.pnlStatus == .partial)''')
open(p,'w').write(s)

p=K+'Views/PnlHeadline.swift'; s=open(p).read()
s=s.replace('''    let onOpen: () -> Void

    public init(portfolio: Portfolio, isLive: Bool, size: CGFloat, onOpen: @escaping () -> Void) {
        self.portfolio = portfolio
        self.isLive = isLive
        self.size = size
        self.onOpen = onOpen
    }
''','''    let onOpen: () -> Void
    let onResolve: () -> Void

    public init(portfolio: Portfolio, isLive: Bool, size: CGFloat, onOpen: @escaping () -> Void, onResolve: @escaping () -> Void = {}) {
        self.portfolio = portfolio
        self.isLive = isLive
        self.size = size
        self.onOpen = onOpen
        self.onResolve = onResolve
    }

    private var isEstimate: Bool { isPositive(portfolio.totals.estimatedUsdMicros) }
''')
s=s.replace('''LiveNumber(Format.signedUSD(pnl), tone: isLive ? Tone(signed: pnl) : .neutral)''','''LiveNumber(Format.estimate(Format.signedUSD(pnl), isEstimate), tone: isLive ? Tone(signed: pnl) : .neutral)''')
s=s.replace('''.accessibilityLabel("Total PnL, \\(pnl.map(Format.signedUSD) ?? Wording.pnlUnavailable)")''','''.accessibilityLabel("Total PnL, \\(pnl.map { Format.estimate(Format.signedUSD($0), isEstimate) } ?? Wording.pnlUnavailable)")''')
s=s.replace('''            PnlCaveats(portfolio: portfolio)
        }
    }
}
''','''            HStack(spacing: 8) {
                if let caveat = Wording.headlineCaveat(portfolio.totals) {
                    Text(caveat).font(.callout.weight(.medium)).foregroundStyle(Tone.warning.style).monospacedDigit()
                }
                if !portfolio.questions.isEmpty {
                    Button("Resolve \\(portfolio.questions.count)", action: onResolve)
                        .controlSize(.small)
                        .help("Answer what the app can't work out by itself")
                }
            }
            PnlCaveats(portfolio: portfolio)
        }
    }
}
''')
s=s.replace('''            (.value, "Value", totals.valueUsdMicros.map(Format.usd), totals.coverage.value),
            (.realized, "Realized", totals.realizedUsdMicros.map(Format.signedUSD), totals.coverage.realized),
            (.unrealized, "Unrealized", totals.unrealizedUsdMicros.map(Format.signedUSD), totals.coverage.unrealized),''','''            (.value, "Value", totals.valueUsdMicros.map { Format.estimate(Format.usd($0), totals.estimated.value) }, totals.coverage.value),
            (.realized, "Realized", totals.realizedUsdMicros.map { Format.estimate(Format.signedUSD($0), totals.estimated.realized) }, totals.coverage.realized),
            (.unrealized, "Unrealized", totals.unrealizedUsdMicros.map { Format.estimate(Format.signedUSD($0), totals.estimated.unrealized) }, totals.coverage.unrealized),''')
open(p,'w').write(s)

p=K+'Views/HoldingRow.swift'; s=open(p).read()
s=s.replace('''        if let average = position.values.averageCostUsdMicros { return "Cost \\(Format.price(average))" }''','''        if let average = position.values.averageCostUsdMicros { return "Cost \\(Format.estimate(Format.price(average), position.estimates.cost))" }''')
s=s.replace('''        position.pnlUsdMicros.map(Format.signedUSD) ?? Wording.pnlUnavailable''','''        position.pnlUsdMicros.map { Format.estimate(Format.signedUSD($0), position.estimates.realized || position.estimates.unrealized) } ?? Wording.pnlUnavailable''')
s=s.replace('''        return position.values.valueUsdMicros.map(Format.usd) ?? "No price"''','''        return position.values.valueUsdMicros.map { Format.estimate(Format.usd($0), position.estimates.value) } ?? "No price"''')
open(p,'w').write(s)

p=K+'Views/ExplanationPane.swift'; s=open(p).read()
s=s.replace('''            Tag(leg.kind)
            if let price = leg.priceUsdMicros, let source = leg.priceSource {
                Tag("\\(Format.price(price)) · \\(source)")
            } else {''','''            Tag(Wording.kind(leg.kind))
            if let price = leg.priceUsdMicros, let source = leg.priceSource {
                Tag("\\(Format.price(price)) · \\(Wording.priceSource(source))")
            } else {''')
s=s.replace('''                if leg.costLabel == "unknown" {
                    Tag("Cost unknown", isWarning: true)
                } else {
                    Tag("Cost: \\(leg.costLabel)")
                }
            }''','''                if leg.costLabel == "unknown" {
                    Tag("Cost unknown", isWarning: true)
                } else {
                    Tag("Cost: \\(Wording.costSource(leg.costLabel))")
                    if leg.partlyUnknown { Tag("Partly unknown", isWarning: true) }
                }
            }
            if leg.estimated { Tag("Estimate") }''')
open(p,'w').write(s)

# App
A='macos/App/'
p=A+'Navigation.swift'; s=open(p).read()
s=s.replace('''    var showsTransactions = false
''','''    var showsTransactions = false
    var isResolving = false
    /// Which holding Resolve was clicked on, so its questions come first.
    var resolvingAsset: String?
    var isExporting = false

    func resolve(_ asset: String? = nil) {
        resolvingAsset = asset
        isResolving = true
    }
''')
open(p,'w').write(s)

p=A+'MacApp.swift'; s=open(p).read()
s=s.replace('''                Button("Change Wallet…") { navigation.isChangingWallet = true }
                    .keyboardShortcut("l", modifiers: .command)
            }
''','''                Button("Change Wallet…") { navigation.isChangingWallet = true }
                    .keyboardShortcut("l", modifiers: .command)
            }
            CommandGroup(after: .newItem) {
                Button("Resolve Unknowns…") { navigation.resolve() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(store.portfolio?.questions.isEmpty != false)
                Button("Export as CSV…") { navigation.isExporting = true }
                    .keyboardShortcut("e", modifiers: .command)
                    .disabled(store.portfolio == nil)
            }
            CommandGroup(replacing: .undoRedo) {
                Button("Undo Answer") { store.undo() }
                    .keyboardShortcut("z", modifiers: .command)
                    .disabled(store.undoStack.isEmpty)
            }
''')
open(p,'w').write(s)

p=A+'PopoverView.swift'; s=open(p).read()
s=s.replace('''PnlHeadline(portfolio: portfolio, isLive: isLive, size: 30) { open(.total(.pnl)) }''','''PnlHeadline(portfolio: portfolio, isLive: isLive, size: 30, onOpen: { open(.total(.pnl)) }, onResolve: {
                    navigation.resolve()
                    open(nil)
                })''')
s=s.replace('''                ForEach(portfolio.positions) { position in
                    Button { open(.asset(position.asset, .amount)) } label: {''','''                ForEach(portfolio.listedPositions) { position in
                    Button { open(.asset(position.asset, .amount)) } label: {''')
s=s.replace('''            .padding(4)
        }
        .frame(maxHeight: 300)''','''            .padding(4)
            if let noMarket = Wording.noMarket(portfolio) {
                Text(noMarket)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }
        }
        .frame(maxHeight: 300)''')
s=s.replace('''guard let assets = portfolio?.positions.map(\\.asset), !assets.isEmpty''','''guard let assets = portfolio?.listedPositions.map(\\.asset), !assets.isEmpty''')
open(p,'w').write(s)

p=A+'MainWindow.swift'; s=open(p).read()
s=s.replace('''            .sheet(isPresented: $navigation.isChangingWallet) {
                WalletSheet(store: store)
            }
''','''            .sheet(isPresented: $navigation.isChangingWallet) {
                WalletSheet(store: store)
            }
            .sheet(isPresented: $navigation.isResolving) {
                ResolveFlow(store: store, firstAsset: navigation.resolvingAsset)
            }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .commaSeparatedText, defaultFilename: "\\(AppName.current) \\(subtitle)") { result in
                if case .failure(let error) = result { exportError = error.localizedDescription }
                exportDocument = nil
            }
            .alert("Couldn't export", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(exportError ?? "")
            }
            // The menu asks for it. The file's written only once the server has answered.
            .onChange(of: navigation.isExporting) { _, asked in
                guard asked else { return }
                navigation.isExporting = false
                Task {
                    do {
                        exportDocument = CSVDocument(text: try await store.exportCSV())
                        exporting = true
                    } catch {
                        exportError = "The server couldn't make this file."
                    }
                }
            }
''')
s=s.replace('''    @Bindable var navigation: Navigation

    private var portfolio''','''    @Bindable var navigation: Navigation
    @State private var exporting = false
    @State private var exportDocument: CSVDocument?
    @State private var exportError: String?

    private var portfolio''')
s=s.replace('''        ToolbarItem(placement: .status) {
            FeedBadge(feed: store.feed, portfolio: portfolio)''','''        ToolbarItem(placement: .primaryAction) {
            if let open = portfolio?.questions.count, open > 0 {
                Button("Resolve \\(open)", systemImage: "questionmark.circle") { navigation.resolve() }
                    .help("Answer what the app can't work out by itself (⇧⌘R)")
            }
        }
        ToolbarItem(placement: .status) {
            FeedBadge(feed: store.feed, portfolio: portfolio)''')
s=s.replace('''HoldingsTable(portfolio: portfolio, isLive: isLive, target: $navigation.target)
                    .frame(minHeight: 150)
''','''HoldingsTable(portfolio: portfolio, isLive: isLive, target: $navigation.target) { navigation.resolve($0) }
                    .frame(minHeight: 150)
                if let noMarket = Wording.noMarket(portfolio) {
                    Text(noMarket)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
''')
s=s.replace('''        if portfolio.mode == .demo {
            Notice(.info, Wording.demo)
        }
''','''        if portfolio.mode == .demo {
            Notice(.info, Wording.demo)
        }
        if !portfolio.linkedReading.isEmpty {
            Notice(.info, "Reading your other \\(portfolio.linkedReading.count == 1 ? "wallet" : "wallets"). What came from \\(portfolio.linkedReading.count == 1 ? "it" : "them") shows as unresolved until that's done.")
        }
''')
s=s.replace('''PnlHeadline(portfolio: portfolio, isLive: isLive, size: 40) { navigation.target = .total(.pnl) }''','''PnlHeadline(portfolio: portfolio, isLive: isLive, size: 40, onOpen: { navigation.target = .total(.pnl) }, onResolve: { navigation.resolve() })''')
s=s.replace('''    @Binding var target: ExplainTarget?
    @State private var selection: Position.ID?

    var body: some View {
        Table(portfolio.positions, selection: $selection) {''','''    @Binding var target: ExplainTarget?
    let onResolve: (String) -> Void
    @State private var selection: Position.ID?

    var body: some View {
        Table(portfolio.listedPositions, selection: $selection) {''')
s=s.replace('''number(position, .average, position.values.averageCostUsdMicros.map(Format.price) ?? "Unknown", tone''','''number(position, .average, position.values.averageCostUsdMicros.map { Format.estimate(Format.price($0), position.estimates.cost) } ?? "Unknown", tone''')
s=s.replace('''number(position, .value, value.map(Format.usd) ?? "No price", tone''','''number(position, .value, value.map { Format.estimate(Format.usd($0), position.estimates.value) } ?? "No price", tone''')
s=s.replace('''number(position, .realized, realized.map(Format.signedUSD) ?? Wording.pnlUnavailable, tone''','''number(position, .realized, realized.map { Format.estimate(Format.signedUSD($0), position.estimates.realized) } ?? Wording.pnlUnavailable, tone''')
s=s.replace('''                    number(position, .unrealized, unrealized.map(Format.signedUSD) ?? Wording.pnlUnavailable, tone: Tone(signed: unrealized), warn: unrealized == nil)
''','''                    HStack(spacing: 6) {
                        number(position, .unrealized, unrealized.map { Format.estimate(Format.signedUSD($0), position.estimates.unrealized) } ?? Wording.pnlUnavailable, tone: Tone(signed: unrealized), warn: unrealized == nil)
                        if position.resolvable {
                            Button("Resolve") { onResolve(position.asset) }
                                .controlSize(.mini)
                                .accessibilityLabel("Resolve \\(position.asset)")
                        }
                    }
''')
s=s.replace('''            .width(min: 110, ideal: 130)
            .alignment(.numeric)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .onChange(of: selection) { _, asset in''','''            .width(min: 180, ideal: 200)
            .alignment(.numeric)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .onChange(of: selection) { _, asset in''')
s=s.replace('''import PricetagKit
import SwiftUI

/// The details''','''import PricetagKit
import SwiftUI
import UniformTypeIdentifiers

/// The file a CSV export writes.
struct CSVDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.commaSeparatedText]
    let text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

/// The details''')
open(p,'w').write(s)

p=A+'SettingsView.swift'; s=open(p).read()
s=s.replace('''    @State private var serverError: String?

    var body: some View {
        Form {''','''    @State private var serverError: String?
    @State private var proving = ""
    @State private var signature = ""
    @State private var linkResult: String?

    private var linkMessage: String {
        let owner = (store.address ?? "").lowercased()
        return "Patina: \\(proving.lowercased()) is my wallet, and belongs with \\(owner).\\n\\nThis only links them in my own app. It can't move funds or approve anything."
    }

    var body: some View {
        Form {''')
s=s.replace('''                Text("Watch-only. There are no keys in this app, and it doesn't sign anything.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
''','''                Text("Watch-only. There are no keys in this app, and it doesn't sign anything.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Your Other Wallets") {
                ForEach(store.book.linkedWallets.filter { $0 != store.address }, id: \\.self) { wallet in
                    LabeledContent(Format.shortHash(wallet)) {
                        Button("Unlink") {
                            var next = store.book
                            next.senders[wallet] = nil
                            store.setBook(next)
                        }
                    }
                }
                TextField("Wallet to add, 0x…", text: $proving)
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                if WalletAddress.isValid(proving), store.address.map(WalletAddress.isValid) == true {
                    LabeledContent("Sign this with that wallet") {
                        Text(linkMessage).font(.caption).textSelection(.enabled)
                    }
                    TextField("Signature, 0x…", text: $signature)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                    Button("Link It") {
                        Task {
                            do {
                                let linked = try await store.linkProved(proving, signature: signature.trimmingCharacters(in: .whitespacesAndNewlines))
                                linkResult = linked ? "Linked." : "That signature isn't from this wallet."
                                if linked {
                                    proving = ""
                                    signature = ""
                                }
                            } catch {
                                linkResult = "Couldn't check it. Is the server running?"
                            }
                        }
                    }
                    .disabled(signature.isEmpty)
                }
                if let linkResult { Text(linkResult).font(.callout) }
            }
            Section {
                Button("Forget All My Answers", role: .destructive) { store.setBook(Book()) }
                    .disabled(store.book.isEmpty)
            } footer: {
                Text("Your answers about who sent what stay on this Mac. They're only sent to the server above, to work out your numbers, and it doesn't keep them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
''')
open(p,'w').write(s)

p='macos/Config/App.xcconfig'; s=open(p).read()
s=s.replace('''// Sandboxed, and its only permission is to open connections: it holds no keys and touches no files.
ENABLE_APP_SANDBOX = YES
''','''// Sandboxed, and its only permissions are to open connections and to read or write a file the user picks in a dialog,
// which is how an exchange history comes in and a CSV goes out. It holds no keys.
ENABLE_APP_SANDBOX = YES
ENABLE_USER_SELECTED_FILES = readwrite
''')
open(p,'w').write(s)

T='macos/PricetagKit/Tests/PricetagKitTests/'
import re
p=T+'FeedTests.swift'; s=open(p).read()
s=s.replace('func portfolio(address: String, method: CostMethod, timeout: Duration) async throws -> Portfolio','func portfolio(address: String, method: CostMethod, book: Book, timeout: Duration) async throws -> Portfolio')
s=s.replace('func explanation(of target: ExplainTarget, address: String, method: CostMethod) async throws -> Explanation','func explanation(of target: ExplainTarget, address: String, method: CostMethod, book: Book) async throws -> Explanation')
open(p,'w').write(s)
