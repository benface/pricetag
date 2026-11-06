import SwiftUI

/// The app's type scale. Everything else is a system text style: `title2` and `title3` semibold for titles, `headline` for sections, `body`,
/// `callout`, `subheadline` for labels over numbers and addresses, and `caption` for fine print. Weights are regular, medium and semibold.
extension Font {
    /// The one number a page is about. The text styles stop at 26 points, which is too small to anchor a page.
    public static let displayLarge = display(40)
    /// The one number on something smaller, like the popover.
    public static let displayMedium = display(30)
    /// What sits beside a display number, and a big sentence in its place.
    public static let displaySmall = display(24)
    /// What a sheet is called.
    public static let sheetTitle = Font.title2.weight(.semibold)

    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold)
    }
}

/// A big amount, with what's least important made quieter: the mark that says it's an estimate, and the cents.
/// It's still the whole amount, and it can be selected or read out as it's written.
public struct DisplayNumber: View {
    let text: String
    let size: CGFloat
    let tone: Tone

    public init(_ text: String, size: CGFloat, tone: Tone = .neutral) {
        self.text = text
        self.size = size
        self.tone = tone
    }

    private var styled: AttributedString {
        let parts = Format.amountParts(text)
        var mark = AttributedString(parts.mark)
        mark.font = .system(size: size * 0.72, weight: .regular).monospacedDigit()
        var main = AttributedString(parts.main)
        main.font = Font.display(size).monospacedDigit()
        var cents = AttributedString(parts.cents)
        cents.font = Font.display(size * 0.62).monospacedDigit()
        return mark + main + cents
    }

    public var body: some View {
        LiveNumber(styled, plain: text, tone: tone)
            .accessibilityLabel(text)
    }
}

/// A whole address, in groups of four so it can actually be compared. The gaps are spacing and not spaces, so what's selected and copied is the address as it is.
public struct AddressLine: View {
    let address: String
    let gap: CGFloat
    let marked: Set<Int>

    /// `gap` is in points. It suits the small sizes addresses appear at. `marked` are characters to call out, counting `0x`, like where two
    /// addresses differ.
    public init(_ address: String, gap: CGFloat = 3.5, marked: Set<Int> = []) {
        self.address = address
        self.gap = gap
        self.marked = marked
    }

    private var grouped: AttributedString {
        var result = AttributedString()
        var offset = 0
        for group in Format.addressGroups(address) {
            var run = AttributedString(group)
            for (index, position) in run.characters.indices.enumerated() where marked.contains(offset + index) {
                let range = position..<run.characters.index(after: position)
                run[range].foregroundColor = Tone.warning.color
                run[range].inlinePresentationIntent = .stronglyEmphasized
            }
            if let last = run.characters.indices.last { run[last..<run.endIndex].kern = gap }
            offset += group.count
            result += run
        }
        return result
    }

    public var body: some View {
        Text(grouped)
            .monospaced()
            .accessibilityLabel(address)
            .contextMenu { AddressActions(address: address) }
    }
}
