import Foundation
import Testing
@testable import PricetagKit

@MainActor
@Suite struct ProofModelTests {
    func model(
        proof: @escaping @MainActor () async throws -> Proof = { try resource("proof", as: Proof.self) },
        verify: @escaping @MainActor () async throws -> Verification = { try resource("verification", as: Verification.self) }
    ) -> ProofModel {
        ProofModel(fetch: proof, verify: verify)
    }

    @Test func readsWhatTheServerSends() throws {
        let proof = try resource("proof", as: Proof.self)
        #expect(proof.source.isEmpty == false)
        #expect(proof.datasets.first?.hash?.count == 64)
        // A fingerprint that couldn't be read stays nil, and is never filled in.
        #expect(proof.datasets.last?.hash == nil)
        #expect(proof.unavailable == nil)
        #expect(proof.links.allSatisfy { $0.destination != nil })
        #expect(proof.scope.first?.contains("doesn't show that the header is on Base's real chain") == true)

        let demo = try resource("demo-proof", as: Proof.self)
        #expect(demo.unavailable?.contains("demo wallet") == true)

        let passed = try resource("verification", as: Verification.self)
        #expect(passed.status == .passed)
        #expect(passed.checks.count == 4)
        #expect(passed.checks.allSatisfy { $0.status == .passed })

        let failed = try resource("verification-failed", as: Verification.self)
        #expect(failed.status == .failed)
        #expect(failed.checks.contains { $0.status == .unchecked })
    }

    @Test func loadsOnceItHasAnAnswer() async {
        var reads = 0
        let model = model(proof: {
            reads += 1
            return try resource("proof", as: Proof.self)
        })
        await model.load()
        await model.load()
        #expect(reads == 1)
        #expect(model.proof != nil)
    }

    @Test func readsAgainAfterAFailure() async {
        var reads = 0
        let model = model(proof: {
            reads += 1
            if reads == 1 { throw FetchError.unreachable }
            return try resource("proof", as: Proof.self)
        })
        await model.load()
        #expect(model.failure == "Can't reach the server.")
        await model.load()
        #expect(model.failure == nil)
        #expect(model.proof != nil)
    }

    @Test func checksOnlyWhenAsked() async {
        var checks = 0
        let model = model(verify: {
            checks += 1
            return try resource("verification", as: Verification.self)
        })
        await model.load()
        #expect(checks == 0)
        #expect(model.verification == nil)
        await model.verify()
        #expect(checks == 1)
        #expect(model.verification?.status == .passed)
        #expect(model.isVerifying == false)
    }

    @Test func aFailedCheckNeverLeavesAnOldPassBehind() async {
        var checks = 0
        let model = model(verify: {
            checks += 1
            if checks == 2 { throw FetchError.ampUnavailable("Couldn't read this block.") }
            return try resource("verification", as: Verification.self)
        })
        await model.verify()
        #expect(model.verification != nil)
        await model.verify()
        #expect(model.verification == nil)
        #expect(model.verificationFailure == "Couldn't read this block.")
        await model.verify()
        #expect(model.verification != nil)
        #expect(model.verificationFailure == nil)
    }

    @Test func aRefusedProofSaysWhy() async {
        let model = model(proof: { throw FetchError.rejected("There's no transaction behind that.") })
        await model.load()
        #expect(model.failure == "There's no transaction behind that.")
    }
}
