import Foundation
import Testing
@testable import PricetagKit

/// Holds each read open until it's told how to answer.
@MainActor
final class ExplanationGate {
    private var waiting: [ExplanationRequest: CheckedContinuation<Explanation, any Error>] = [:]
    private(set) var asked: [ExplanationRequest] = []

    func fetch(_ request: ExplanationRequest) async throws -> Explanation {
        asked.append(request)
        return try await withCheckedThrowingContinuation { waiting[request] = $0 }
    }

    func waitUntilAsked(_ request: ExplanationRequest) async {
        while waiting[request] == nil { await Task.yield() }
    }

    func answer(_ request: ExplanationRequest, _ result: Result<Explanation, FetchError>) {
        waiting.removeValue(forKey: request)?.resume(with: result.mapError { $0 as any Error })
    }
}

@MainActor
@Suite struct ExplanationModelTests {
    let server = URL(string: "http://127.0.0.1:8787")!

    func request(address: String = "0xaaa", method: CostMethod = .average, server: URL? = nil, target: ExplainTarget = .asset("AERO", .realized)) -> ExplanationRequest {
        ExplanationRequest(target: target, address: address, method: method, currency: .USD, rule: nil, linked: [], serverURL: server ?? self.server, book: Book())
    }

    func explanation(_ title: String) -> Explanation {
        Explanation(currency: .USD, title: title, value: "+$74.99", sourceValue: nil, lines: [], legCount: 0, legs: [])
    }

    func makeModel() -> (ExplanationModel, ExplanationGate) {
        let gate = ExplanationGate()
        return (ExplanationModel(fetch: { try await gate.fetch($0) }), gate)
    }

    /// Shows a request and answers it, so the model holds a result.
    func loaded(_ model: ExplanationModel, _ gate: ExplanationGate, _ asked: ExplanationRequest, _ title: String) async {
        let task = Task { await model.show(asked) }
        await gate.waitUntilAsked(asked)
        gate.answer(asked, .success(explanation(title)))
        await task.value
    }

    @Test func showsTheAnswerToWhatWasAsked() async {
        let (model, gate) = makeModel()
        await loaded(model, gate, request(), "demo")
        #expect(model.explanation?.title == "demo")
    }

    @Test func anotherWalletWithoutThisNumberDoesntKeepTheOldAnswer() async {
        let (model, gate) = makeModel()
        await loaded(model, gate, request(address: "demo"), "demo AERO")
        let other = request(address: "0xbbb")
        let task = Task { await model.show(other) }
        await gate.waitUntilAsked(other)
        // Nothing from the old wallet while the new one's answer is on its way.
        #expect(model.explanation == nil)
        gate.answer(other, .failure(.rejected("This wallet has nothing like that.")))
        await task.value
        #expect(model.explanation == nil)
        #expect(model.failure == "This wallet has nothing like that.")
    }

    @Test func forgettingTheWalletClearsTheAnswer() async {
        let (model, gate) = makeModel()
        await loaded(model, gate, request(), "demo")
        await model.show(nil)
        #expect(model.explanation == nil)
        #expect(model.failure == nil)
    }

    @Test func aNewMethodDoesntKeepTheOldAnswerWhenItFails() async {
        let (model, gate) = makeModel()
        await loaded(model, gate, request(), "average")
        let fifo = request(method: .fifo)
        let task = Task { await model.show(fifo) }
        await gate.waitUntilAsked(fifo)
        #expect(model.explanation == nil)
        gate.answer(fifo, .failure(.unreachable))
        await task.value
        #expect(model.explanation == nil)
        #expect(model.failure == "Can't reach the server.")
    }

    @Test func aNewServerDoesntKeepTheOldAnswer() async {
        let (model, gate) = makeModel()
        await loaded(model, gate, request(), "old server")
        let moved = request(server: URL(string: "http://127.0.0.1:9999")!)
        let task = Task { await model.show(moved) }
        await gate.waitUntilAsked(moved)
        #expect(model.explanation == nil)
        gate.answer(moved, .success(explanation("new server")))
        await task.value
        #expect(model.explanation?.title == "new server")
    }

    @Test func ignoresALateAnswerToAnOldRequest() async {
        let (model, gate) = makeModel()
        let old = request(address: "0xaaa"), new = request(address: "0xbbb")
        let first = Task { await model.show(old) }
        await gate.waitUntilAsked(old)
        let second = Task { await model.show(new) }
        await gate.waitUntilAsked(new)
        gate.answer(new, .success(explanation("new")))
        await second.value
        gate.answer(old, .success(explanation("old")))
        await first.value
        #expect(model.explanation?.title == "new")
    }

    @Test func ignoresALateFailureOfAnOldRequest() async {
        let (model, gate) = makeModel()
        let old = request(address: "0xaaa"), new = request(address: "0xbbb")
        let first = Task { await model.show(old) }
        await gate.waitUntilAsked(old)
        let second = Task { await model.show(new) }
        await gate.waitUntilAsked(new)
        gate.answer(old, .failure(.unreachable))
        await first.value
        #expect(model.failure == nil)
        gate.answer(new, .success(explanation("new")))
        await second.value
        #expect(model.explanation?.title == "new")
    }

    @Test func aRefreshKeepsTheAnswerUpUntilTheNextOne() async {
        let (model, gate) = makeModel()
        let asked = request()
        await loaded(model, gate, asked, "first")
        let task = Task { await model.refresh() }
        await gate.waitUntilAsked(asked)
        #expect(model.explanation?.title == "first")
        gate.answer(asked, .success(explanation("second")))
        await task.value
        #expect(model.explanation?.title == "second")
    }

    @Test func aRefreshThatCantReachTheServerKeepsTheAnswer() async {
        let (model, gate) = makeModel()
        let asked = request()
        await loaded(model, gate, asked, "first")
        let task = Task { await model.refresh() }
        await gate.waitUntilAsked(asked)
        gate.answer(asked, .failure(.unreachable))
        await task.value
        #expect(model.explanation?.title == "first")
        #expect(model.failure == nil)
    }

    @Test func aRefreshTheServerRefusesDropsTheAnswer() async {
        let (model, gate) = makeModel()
        let asked = request()
        await loaded(model, gate, asked, "first")
        let task = Task { await model.refresh() }
        await gate.waitUntilAsked(asked)
        gate.answer(asked, .failure(.rejected("This wallet has nothing like that.")))
        await task.value
        #expect(model.explanation == nil)
        #expect(model.failure == "This wallet has nothing like that.")
    }

    @Test func aNewBlockDuringAReadDoesntStartAnother() async {
        let (model, gate) = makeModel()
        let asked = request()
        let task = Task { await model.show(asked) }
        await gate.waitUntilAsked(asked)
        await model.refresh()
        #expect(gate.asked.count == 1)
        gate.answer(asked, .success(explanation("only")))
        await task.value
    }
}
