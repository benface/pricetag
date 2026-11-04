import Foundation

public enum Hex {
    public static func encode(_ bytes: some Sequence<UInt8>) -> String {
        var text = ""
        for byte in bytes {
            text += String(byte >> 4, radix: 16) + String(byte & 0xF, radix: 16)
        }
        return text
    }

    /// nil unless it's an even number of hex digits, with or without 0x.
    public static func decode(_ text: String) -> [UInt8]? {
        let digits = Array((text.hasPrefix("0x") ? String(text.dropFirst(2)) : text).utf8)
        guard digits.count.isMultiple(of: 2) else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(digits.count / 2)
        for index in stride(from: 0, to: digits.count, by: 2) {
            guard let high = nibble(digits[index]), let low = nibble(digits[index + 1]) else { return nil }
            bytes.append(high << 4 | low)
        }
        return bytes
    }

    private static func nibble(_ digit: UInt8) -> UInt8? {
        switch digit {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): digit - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): digit - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): digit - UInt8(ascii: "A") + 10
        default: nil
        }
    }
}
