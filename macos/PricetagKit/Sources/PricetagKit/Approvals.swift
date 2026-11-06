import Foundation
import Observation

/// One approval a wallet gave that still lets someone spend from it, as the server checked it onchain.
public struct TokenApproval: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        /// The token's own approval.
        case token
        /// Permit2's, which only works while the token also lets Permit2 spend it, and expires.
        case permit2
        /// Every NFT in a collection.
        case collection
    }

    public enum Found: String, Codable, Sendable {
        /// In the wallet's history, with the transaction that gave it.
        case history
        /// Only by checking well-known apps, so it may be older than the history.
        case knownSpender = "known-spender"
    }

    public let id: String
    public let kind: Kind
    public let token: String
    /// Only a tracked token's. Anything else can call itself anything, so it's never named.
    public let symbol: String?
    public let decimals: Int?
    public let spender: String
    /// Whose contract it is, when it's a well-known one. That says who, never that it's safe.
    public let spenderName: String?
    public let amount: String?
    public let amountText: String?
    public let unlimited: Bool
    public let expiresAt: String?
    public let grantedTx: String?
    public let grantedBlock: Int?
    public let grantedAt: String?
    public let found: Found

    public var expiry: Date? { expiresAt.flatMap(parseTimestamp) }
    public var grantedDate: Date? { grantedAt.flatMap(parseTimestamp) }
}

/// Everything a wallet lets others spend, and where that list comes from.
public struct WalletApprovals: Codable, Sendable, Equatable {
    public struct History: Codable, Sendable, Equatable {
        public let fromBlock: Int
        public let throughBlock: Int
        public let dataset: String
    }

    public let mode: Mode
    public let address: String
    public let checkedAt: Head
    public let history: History
    public let source: [String]
    public let approvals: [TokenApproval]
    /// Approvals in the history whose contract didn't answer, so what they allow isn't known.
    public let unreadable: Int

    public var unlimitedCount: Int { approvals.count { $0.unlimited } }

    /// The same list, said of another wallet, for fixtures that stand in for any of them.
    public func said(of address: String) -> WalletApprovals {
        WalletApprovals(mode: mode, address: address, checkedAt: checkedAt, history: history, source: source, approvals: approvals, unreadable: unreadable)
    }
}

/// A wallet's approvals, read when they're asked for and again after something changes them. It never keeps another wallet's.
@MainActor
@Observable
public final class ApprovalsModel {
    public enum State: Equatable {
        case reading
        case read(WalletApprovals)
        case failed(String)
    }

    public private(set) var state = State.reading
    /// A read is under way while the last one's still showing.
    public private(set) var isRefreshing = false
    /// Why the last read failed, while an older one is still showing. That one may be out of date, so it can't vouch for anything.
    public private(set) var refreshFailure: String?
    public let address: String
    @ObservationIgnored private let fetch: @Sendable (String) async throws -> WalletApprovals

    public init(address: String, fetch: @escaping @Sendable (String) async throws -> WalletApprovals) {
        self.address = address
        self.fetch = fetch
    }

    public var approvals: WalletApprovals? {
        if case .read(let approvals) = state { approvals } else { nil }
    }

    public func load() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let read = try await fetch(address)
            // A server that answers for another wallet has nothing to say about this one.
            guard read.address.lowercased() == address.lowercased() else {
                state = .failed("The server answered for another wallet.")
                return
            }
            state = .read(read)
            refreshFailure = nil
        } catch is CancellationError {
            return
        } catch let error as FetchError {
            failed(Self.message(error))
        } catch {
            failed("Couldn't read this wallet's approvals.")
        }
    }

    private func failed(_ message: String) {
        if approvals == nil { state = .failed(message) } else { refreshFailure = message }
    }

    static func message(_ error: FetchError) -> String {
        switch error {
        case .unreachable: "Can't reach the server."
        case .timedOut: "The server took too long. Try again in a moment."
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message), .rateLimited(let message, _): message
        }
    }
}
