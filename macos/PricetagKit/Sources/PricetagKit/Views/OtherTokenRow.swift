import SwiftUI

/// One holding with no price. Its name is whatever its contract claims, so its address is always with it.
public struct OtherTokenRow: View {
    let token: OtherToken

    public init(token: OtherToken) {
        self.token = token
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    // `verbatim`, because a contract writes this, and other text can be read as Markdown with a link in it.
                    Text(verbatim: Wording.otherTokenName(token)).fontWeight(.medium).lineLimit(1)
                    if token.name != nil, let symbol = token.symbol {
                        Text(verbatim: symbol).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                AddressLine(token.token)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                ForEach([token.tucked, token.note].compactMap(\.self), id: \.self) { line in
                    Text(verbatim: line)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: Wording.otherTokenAmount(token)).monospacedDigit().lineLimit(1)
                Text("No price").font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Spoken.otherToken(token))
    }
}
