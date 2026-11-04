import Foundation
@testable import KeyVault
import Testing
@testable import HotWalletKit

private func typedData(_ json: String) throws -> TypedData {
    try TypedData(.string(json))
}

private func digest(_ json: String) throws -> String {
    "0x" + Hex.encode(try #require(try typedData(json).signable().digest))
}

private let mail = """
{"domain":{"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},
"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],
"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},
"primaryType":"Mail",
"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}}
"""

private let permit = """
{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"0x000000000022D473030F116dDEE9F6B43aC78BA3"},
"types":{"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}],
"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}]},
"primaryType":"PermitSingle",
"message":{"details":{"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","amount":"1461501637330902918203684832716283019655932542975","expiration":1893456000,"nonce":7},"spender":"0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD","sigDeadline":"1893456000"}}
"""

private let mixed = """
{"domain":{"name":"Mixed","chainId":"0x2105"},
"types":{"Inner":[{"name":"flag","type":"bool"},{"name":"tag","type":"bytes4"}],
"Mixed":[{"name":"delta","type":"int24"},{"name":"low","type":"int256"},{"name":"blob","type":"bytes"},{"name":"ids","type":"uint256[]"},{"name":"pair","type":"address[2]"},{"name":"inners","type":"Inner[]"},{"name":"grid","type":"uint8[2][]"},{"name":"note","type":"string"}]},
"primaryType":"Mixed",
"message":{"delta":-887272,"low":"-1","blob":"0xdeadbeef","ids":[1,"2","0x3"],"pair":["0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC","0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"],"inners":[{"flag":true,"tag":"0x01020304"},{"flag":false,"tag":"0xffffffff"}],"grid":[[1,2],[3,4]],"note":"héllo"}}
"""

@Suite struct TypedDataTests {
    /// The example from EIP-712 itself.
    @Test func matchesTheSpecsExample() throws {
        #expect(try digest(mail) == "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2")
        #expect(try typedData(mail).encodeType("Mail") == "Mail(Person from,Person to,string contents)Person(string name,address wallet)")
    }

    /// These two answers came from viem's `hashTypedData`, so a mistake here can't also be in what it's compared with.
    @Test func matchesAnotherImplementation() throws {
        #expect(try digest(permit) == "0x45562034bca9f3f4595604f15a6006025cfe729a7be231055c367b68f803df65")
        #expect(try digest(mixed) == "0x62d6bdc9718f7fd266d93ae809aaed64ad371e289e64577dbedf4e3caa3f0aa5")
    }

    @Test func readsTheChain() throws {
        #expect(try typedData(permit).chainID == 8453)
        #expect(try typedData(mixed).chainID == 8453)
        #expect(try typedData(#"{"domain":{"name":"x"},"types":{"A":[]},"primaryType":"A","message":{}}"#).chainID == nil)
    }

    @Test func refusesWhatItCantEncodeExactly() throws {
        let template = { (type: String, value: String) in
            #"{"domain":{"chainId":8453},"types":{"A":[{"name":"v","type":"\#(type)"}]},"primaryType":"A","message":{"v":\#(value)}}"#
        }
        for (type, value) in [
            ("uint8", "256"), ("uint8", "-1"), ("int8", "128"), ("int8", "-129"), ("uint256", "\"not a number\""),
            ("uint256", "1e30"), ("uint256", "\"" + String(repeating: "9", count: 80) + "\""),
            ("address", "\"0x1234\""), ("bool", "1"), ("bytes4", "\"0x0102\""), ("bytes", "\"nothex\""), ("string", "5"),
            ("uint256[2]", "[1]"), ("Missing", "1"), ("uint7", "1"), ("A", "1"),
        ] {
            #expect(throws: TypedData.Failure.self, "\(type) \(value)") { _ = try typedData(template(type, value)).signable() }
        }
        #expect(throws: TypedData.Failure.self) { _ = try typedData(#"{"domain":{},"types":{"A":[{"name":"v","type":"uint8"}]},"primaryType":"A","message":{}}"#).signable() }
        #expect(throws: TypedData.Failure.self) { _ = try typedData(#"{"domain":{},"types":{},"primaryType":"A","message":{}}"#) }
        #expect(throws: TypedData.Failure.self) { _ = try TypedData(.string("not json")) }
    }

    @Test func edgesOfSignedIntegers() throws {
        let minimum = try TypedData.integerWord(.string("-128"), bits: 8, signed: true)
        #expect(minimum == [UInt8](repeating: 0xFF, count: 31) + [0x80])
        let maximum = try TypedData.integerWord(.string("127"), bits: 8, signed: true)
        #expect(maximum == [UInt8](repeating: 0, count: 31) + [0x7F])
        let bottom = try TypedData.integerWord(.string("-57896044618658097711785492504343953926634992332820282019728792003956564819968"), bits: 256, signed: true)
        #expect(bottom == [0x80] + [UInt8](repeating: 0, count: 31))
    }
}
