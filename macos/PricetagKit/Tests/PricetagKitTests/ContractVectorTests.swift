import Foundation
import Testing
@testable import PricetagKit

/// What the server sends that the bigger fixtures don't carry, written by the TypeScript tests from the code that sends it.
/// Each one comes back out of its Swift type as the same JSON, so a field that's renamed or dropped on either side fails here,
/// even an optional one, which would otherwise just read as nil.
@Suite struct ContractVectorTests {
    private func json(_ name: String) throws -> Any {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Resources"))
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url))
    }

    /// A nil is left out when it's encoded, and `ignoring` is what's sent that this app has no use for.
    private func withoutNils(_ value: Any, ignoring: Set<String>) -> Any {
        switch value {
        case let object as [String: Any]:
            object.filter { !($0.value is NSNull) && !ignoring.contains($0.key) }.mapValues { withoutNils($0, ignoring: ignoring) }
        case let list as [Any]:
            list.map { withoutNils($0, ignoring: ignoring) }
        default:
            value
        }
    }

    @discardableResult
    private func expectSame<T: Codable>(_ value: Any, as type: T.Type, ignoring: Set<String> = []) throws -> T {
        let decoded = try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
        let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded))
        #expect(NSDictionary(dictionary: ["value": back]) == NSDictionary(dictionary: ["value": withoutNils(value, ignoring: ignoring)]), "\(T.self) doesn't carry what the server sent")
        return decoded
    }

    @Test func aPreview() throws {
        let previews = try expectSame(json("book-preview-vectors"), as: [BookPreview].self)
        #expect(previews.map(\.pending) == [false, true, true])
        #expect(previews.map(\.failed) == [false, false, true])
    }

    @Test func anExchangeHistory() throws {
        let imported = try expectSame(json("exchange-import-vectors"), as: ExchangeImport.self)
        #expect(imported.withdrawals.first?.toAddress != nil)
        #expect(imported.needsALook)
    }

    @Test func aCostThatsWithheld() throws {
        try expectSame(json("withheld-vectors"), as: [WithheldCost].self)
    }

    @Test func aReconciliationOfEveryKind() throws {
        // What's held is already in the position's amount.
        let vectors = try expectSame(json("reconciliation-vectors"), as: [Reconciliation].self, ignoring: ["heldQty"])
        #expect(vectors.map(\.status) == [.reconciled, .incomplete, .unchecked, .unchecked, .unchecked, .unchecked])
        #expect(vectors[1].unseenEth?.first?.txHashes == ["0xswap"])
        #expect(vectors[2].reason != nil)
        #expect(vectors[2].heldIsCurrent == false)
        #expect(vectors[4].heldIsCurrent == true)
    }

    @Test func aPurchaseFromStartToFinish() throws {
        let vectors = try #require(json("onramp-vectors") as? [String: Any])
        let checkout = try expectSame(try #require(vectors["checkout"]), as: OnrampCheckout.self)
        #expect(checkout.page != nil, "This app only opens a provider's page it knows")
        let orders = try expectSame(try #require(vectors["orders"]), as: [OnrampOrder].self)
        #expect(orders.map(\.status) == [.succeeded, .succeeded, .pending, .failed])
        #expect(orders[0].purchase != nil)
        #expect(orders[1].paidIn == "SEK")
        #expect(orders[1].purchase == nil)
        #expect(orders[3].failure == .delivery)
        let matches = try expectSame(try #require(vectors["matches"]), as: [PurchaseMatch].self)
        #expect(matches.map(\.state) == [.recorded, .unmatched, .waiting])
    }
}
