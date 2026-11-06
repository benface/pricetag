// What a row's proof shows: what's behind its price, read when it opens, and the check of its block, run when asked.

import Foundation
import Observation

@MainActor
@Observable
public final class ProofModel {
    public private(set) var proof: Proof?
    public private(set) var failure: String?
    public private(set) var verification: Verification?
    public private(set) var verificationFailure: String?
    public private(set) var isVerifying = false

    @ObservationIgnored private let fetch: @MainActor () async throws -> Proof
    @ObservationIgnored private let verifyBlock: @MainActor (Proof?) async throws -> Verification

    public init(fetch: @escaping @MainActor () async throws -> Proof, verify: @escaping @MainActor (Proof?) async throws -> Verification) {
        self.fetch = fetch
        verifyBlock = verify
    }

    public func load() async {
        guard proof == nil else { return }
        do {
            proof = try await fetch()
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            failure = failureMessage(for: error)
        }
    }

    /// Runs the check again if it's asked again. It only ever shows the newest answer, and never a result alongside a failure.
    public func verify() async {
        guard !isVerifying else { return }
        isVerifying = true
        defer { isVerifying = false }
        do {
            let answer = try await verifyBlock(proof)
            verification = answer
            verificationFailure = nil
        } catch is CancellationError {
            return
        } catch FetchError.priceChanged(let message) {
            // What's on screen is about something else now, so it goes, and the new proof takes its place.
            verification = nil
            verificationFailure = message
            proof = nil
            await load()
        } catch {
            verification = nil
            verificationFailure = failureMessage(for: error)
        }
    }
}
