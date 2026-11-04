// What the inspector shows. An answer only ever appears for the exact request it was asked for.

import Foundation
import Observation

@MainActor
@Observable
public final class ExplanationModel {
    public private(set) var request: ExplanationRequest?
    /// Always the answer to `request`. A refresh keeps it up until the next one arrives, so nothing flashes.
    public private(set) var explanation: Explanation?
    public private(set) var failure: String?

    @ObservationIgnored private let fetch: @MainActor (ExplanationRequest) async throws -> Explanation
    @ObservationIgnored private var loading: ExplanationRequest?

    public init(fetch: @escaping @MainActor (ExplanationRequest) async throws -> Explanation) {
        self.fetch = fetch
    }

    public func show(_ next: ExplanationRequest?) async {
        if next != request {
            request = next
            explanation = nil
            failure = nil
        }
        await load()
    }

    /// Reads again, for a new block. Does nothing during a read: it would never finish if each block started over.
    public func refresh() async {
        if loading != request { await load() }
    }

    private func load() async {
        guard let asked = request else { return }
        loading = asked
        defer { if loading == asked { loading = nil } }
        do {
            let answer = try await fetch(asked)
            guard asked == request else { return }
            explanation = answer
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            guard asked == request else { return }
            // A refused request means this number doesn't exist here, unlike a server that's only out of reach.
            if case FetchError.rejected = error { explanation = nil }
            if explanation == nil { failure = Self.message(for: error) }
        }
    }

    private static func message(for error: any Error) -> String {
        switch error as? FetchError {
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message): message
        case .unreachable, nil: "Can't reach the server."
        }
    }
}
