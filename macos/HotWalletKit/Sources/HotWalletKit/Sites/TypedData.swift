import Foundation
import KeyVault

/// EIP-712: turns what a site sent into the two hashes the vault signs. Anything it can't encode exactly is an error, because a
/// signature over something other than what was shown could be anything at all.
struct TypedData: Equatable, Sendable {
    struct Field: Equatable, Sendable {
        let name: String
        let type: String
    }

    enum Failure: Error, Equatable {
        case malformed(String)
    }

    private static let domainFields = [
        Field(name: "name", type: "string"), Field(name: "version", type: "string"), Field(name: "chainId", type: "uint256"),
        Field(name: "verifyingContract", type: "address"), Field(name: "salt", type: "bytes32"),
    ]

    let types: [String: [Field]]
    let primaryType: String
    let domain: JSONValue
    let message: JSONValue

    /// `eth_signTypedData_v4` takes this as a JSON string, though some sites send the object itself.
    init(_ value: JSONValue) throws(Failure) {
        let parsed: JSONValue
        if let text = value.string {
            guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { throw .malformed("It isn't JSON.") }
            parsed = decoded
        } else {
            parsed = value
        }
        guard let types = parsed["types"]?.object, let primaryType = parsed["primaryType"]?.string, let domain = parsed["domain"], domain.object != nil, let message = parsed["message"], message.object != nil else {
            throw .malformed("It needs types, primaryType, domain and message.")
        }
        var fields: [String: [Field]] = [:]
        for (name, list) in types {
            guard let list = list.array else { throw .malformed("The type \(name) isn't a list.") }
            var parsedFields: [Field] = []
            for field in list {
                guard let fieldName = field["name"]?.string, let type = field["type"]?.string else { throw .malformed("The type \(name) has a malformed field.") }
                guard !parsedFields.contains(where: { $0.name == fieldName }) else { throw .malformed("The type \(name) has \(fieldName) twice.") }
                parsedFields.append(Field(name: fieldName, type: type))
            }
            fields[name] = parsedFields
        }
        // Sites may leave this out, and it's fully determined by which fields the domain has.
        if fields["EIP712Domain"] == nil {
            fields["EIP712Domain"] = Self.domainFields.filter { domain[$0.name] != nil }
        }
        // What's in `domain` gets shown and checked, but only what the type lists gets signed. A chain or contract that's only claimed
        // would be shown as if the signature were tied to it, so the two have to say the same thing, with the standard types.
        let domainSchema = fields["EIP712Domain"] ?? []
        guard domainSchema.allSatisfy(Self.domainFields.contains), Set(domainSchema.map(\.name)) == Set(domain.object?.keys.map { $0 } ?? []) else {
            throw .malformed("The domain's fields don't match its type.")
        }
        guard fields[primaryType] != nil else { throw .malformed("The primary type \(primaryType) isn't defined.") }
        self.types = fields
        self.primaryType = primaryType
        self.domain = domain
        self.message = message
    }

    func signable() throws(Failure) -> SignableMessage {
        .typedData(domainSeparator: try hashStruct("EIP712Domain", domain, depth: 0), structHash: try hashStruct(primaryType, message, depth: 0))
    }

    /// The chain the domain names, or nil if it doesn't name one, in which case the signature isn't tied to any.
    var chainID: UInt64? {
        get throws(Failure) {
            guard let value = domain["chainId"] else { return nil }
            let word = try Self.integerWord(value, bits: 256, signed: false)
            guard word.prefix(24).allSatisfy({ $0 == 0 }) else { throw .malformed("The chain ID is out of range.") }
            return word.suffix(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        }
    }

    func encodeType(_ name: String) throws(Failure) -> String {
        var found = Set<String>()
        try collectDependencies(of: name, into: &found)
        found.remove(name)
        var text = ""
        for type in [name] + found.sorted() {
            let fields = types[type] ?? []
            text += "\(type)(\(fields.map { "\($0.type) \($0.name)" }.joined(separator: ",")))"
        }
        return text
    }

    private func collectDependencies(of name: String, into found: inout Set<String>) throws(Failure) {
        guard !found.contains(name), let fields = types[name] else { return }
        found.insert(name)
        for field in fields {
            try collectDependencies(of: Self.baseType(field.type), into: &found)
        }
    }

    private func hashStruct(_ name: String, _ value: JSONValue, depth: Int) throws(Failure) -> [UInt8] {
        guard depth < 32 else { throw .malformed("It's nested too deeply.") }
        guard let fields = types[name], let object = value.object else { throw .malformed("\(name) isn't an object.") }
        // Leaving a field out would sign something other than what the type says, so it isn't filled in with zero. An extra one
        // would be shown without being signed, so what's on screen could say anything.
        guard Set(fields.map(\.name)) == Set(object.keys) else { throw .malformed("\(name)'s fields don't match its type.") }
        var encoded = keccak256(Array(try encodeType(name).utf8))
        for field in fields {
            guard let fieldValue = value[field.name] else { throw .malformed("\(name) is missing \(field.name).") }
            encoded += try encodeField(field.type, fieldValue, depth: depth + 1)
        }
        return keccak256(encoded)
    }

    private func encodeField(_ type: String, _ value: JSONValue, depth: Int) throws(Failure) -> [UInt8] {
        if type.hasSuffix("]") {
            guard let open = type.lastIndex(of: "[") else { throw .malformed("\(type) isn't a type.") }
            let inner = String(type[..<open])
            let size = type[type.index(after: open)...].dropLast()
            guard let items = value.array else { throw .malformed("\(type) needs a list.") }
            if !size.isEmpty {
                guard Int(size) == items.count else { throw .malformed("\(type) needs \(size) items.") }
            }
            var joined: [UInt8] = []
            for item in items {
                joined += try encodeField(inner, item, depth: depth + 1)
            }
            return keccak256(joined)
        }
        if types[type] != nil { return try hashStruct(type, value, depth: depth) }
        switch type {
        case "string":
            guard let text = value.string else { throw .malformed("A string field isn't a string.") }
            return keccak256(Array(text.utf8))
        case "bytes":
            guard let text = value.string, text.hasPrefix("0x"), let bytes = Hex.decode(text) else { throw .malformed("A bytes field isn't hex.") }
            return keccak256(bytes)
        case "bool":
            guard case .bool(let flag) = value else { throw .malformed("A bool field isn't true or false.") }
            return [UInt8](repeating: 0, count: 31) + [flag ? 1 : 0]
        case "address":
            guard let text = value.string, let address = EthereumAddress(text) else { throw .malformed("An address field isn't an address.") }
            return [UInt8](repeating: 0, count: 12) + address.bytes
        default:
            break
        }
        if type.hasPrefix("bytes"), let size = Int(type.dropFirst(5)), (1...32).contains(size) {
            guard let text = value.string, text.hasPrefix("0x"), let bytes = Hex.decode(text), bytes.count == size else { throw .malformed("A \(type) field is the wrong length.") }
            return bytes + [UInt8](repeating: 0, count: 32 - size)
        }
        for (prefix, signed) in [("uint", false), ("int", true)] where type.hasPrefix(prefix) {
            let digits = type.dropFirst(prefix.count)
            guard let bits = Int(digits), (8...256).contains(bits), bits.isMultiple(of: 8) else { continue }
            return try Self.integerWord(value, bits: bits, signed: signed)
        }
        throw .malformed("\(type) isn't a type.")
    }

    private static func baseType(_ type: String) -> String {
        type.firstIndex(of: "[").map { String(type[..<$0]) } ?? type
    }

    /// A JSON number, decimal string or hex string, as a 32-byte word. Out of range for its type is an error, never a wraparound.
    static func integerWord(_ value: JSONValue, bits: Int, signed: Bool) throws(Failure) -> [UInt8] {
        let text: String
        if let number = value.integer {
            text = String(number)
        } else if let string = value.string {
            text = string
        } else {
            throw .malformed("A number is missing, or too big to be sent as a JSON number.")
        }
        let isNegative = text.hasPrefix("-")
        guard !isNegative || signed else { throw .malformed("A uint can't be negative.") }
        let digits = isNegative ? String(text.dropFirst()) : text
        guard var word = magnitude(of: digits) else { throw .malformed("\(text) isn't a number that fits in 256 bits.") }

        // How many of the word's bits this type can use. A negative value of intN can reach exactly 2^(N-1).
        let highestBit = signed ? bits - 1 : bits
        let isExactlyLimit = isNegative && isPowerOfTwo(word, bit: highestBit)
        guard fits(word, bits: highestBit) || isExactlyLimit else { throw .malformed("\(text) is out of range.") }
        if isNegative { word = twosComplement(word) }
        return word
    }

    private static func magnitude(of text: String) -> [UInt8]? {
        guard !text.isEmpty else { return nil }
        if text.hasPrefix("0x") {
            let digits = String(text.dropFirst(2))
            guard !digits.isEmpty, digits.count <= 64, let bytes = Hex.decode(digits.count.isMultiple(of: 2) ? digits : "0" + digits) else { return nil }
            return [UInt8](repeating: 0, count: 32 - bytes.count) + bytes
        }
        var word = [UInt8](repeating: 0, count: 32)
        for digit in text.utf8 {
            guard (48...57).contains(digit) else { return nil }
            var carry = UInt16(digit - 48)
            for index in word.indices.reversed() {
                let next = UInt16(word[index]) * 10 + carry
                word[index] = UInt8(truncatingIfNeeded: next)
                carry = next >> 8
            }
            guard carry == 0 else { return nil }
        }
        return word
    }

    private static func fits(_ word: [UInt8], bits: Int) -> Bool {
        guard bits < 256 else { return true }
        let wholeBytes = bits / 8
        let leading = word.prefix(32 - wholeBytes - (bits % 8 == 0 ? 0 : 1))
        guard leading.allSatisfy({ $0 == 0 }) else { return false }
        guard bits % 8 != 0 else { return true }
        return word[31 - wholeBytes] >> UInt8(bits % 8) == 0
    }

    private static func isPowerOfTwo(_ word: [UInt8], bit: Int) -> Bool {
        var expected = [UInt8](repeating: 0, count: 32)
        expected[31 - bit / 8] = 1 << UInt8(bit % 8)
        return word == expected
    }

    private static func twosComplement(_ word: [UInt8]) -> [UInt8] {
        var result = word.map { ~$0 }
        for index in result.indices.reversed() {
            let (sum, overflow) = result[index].addingReportingOverflow(1)
            result[index] = sum
            if !overflow { break }
        }
        return result
    }
}
