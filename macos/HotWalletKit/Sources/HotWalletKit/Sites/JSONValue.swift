import Foundation

/// Whatever a site sent, or a node answered, without losing what it was.
public indirect enum JSONValue: Equatable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var string: String? {
        if case .string(let value) = self { value } else { nil }
    }

    public var array: [JSONValue]? {
        if case .array(let value) = self { value } else { nil }
    }

    public var object: [String: JSONValue]? {
        if case .object(let value) = self { value } else { nil }
    }

    /// nil past 2^53, where a JSON number has already been rounded. Numbers that big have to come as strings.
    public var integer: Int? {
        guard case .number(let value) = self, value == value.rounded(), abs(value) <= 9_007_199_254_740_991 else { return nil }
        return Int(value)
    }

    public subscript(key: String) -> JSONValue? {
        object?[key]
    }

    public subscript(index: Int) -> JSONValue? {
        guard let array, array.indices.contains(index) else { return nil }
        return array[index]
    }
}

/// EIP-1193's errors, which is all a site ever hears from this wallet.
public struct SiteError: Error, Equatable, Sendable {
    public let code: Int
    public let message: String
    public let data: JSONValue?

    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    static let rejected = SiteError(code: 4001, message: "The user rejected this in \(SiteWording.appName).")
    static let notConnected = SiteError(code: 4100, message: "This site isn't connected to this wallet.")
    static let wrongChain = SiteError(code: 4901, message: "This wallet only works on Base.")
    static let unknownChain = SiteError(code: 4902, message: "This wallet only works on Base.")
    static let tooManyRequests = SiteError(code: -32002, message: "There's already a request waiting in \(SiteWording.appName).")
    static let readLimit = SiteError(code: -32005, message: "Too many requests. Try again in a moment.")

    static func unsupported(_ method: String) -> SiteError {
        SiteError(code: 4200, message: "This wallet doesn't support \(method).")
    }

    static func invalid(_ message: String) -> SiteError {
        SiteError(code: -32602, message: message)
    }

    static func stopped(_ message: String) -> SiteError {
        SiteError(code: 4100, message: message)
    }
}

public typealias RPCAnswer = Result<JSONValue, SiteError>
