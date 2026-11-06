import PricetagKit
import SwiftUI

/// Holdings with no price. They stay out of the holdings table, because nothing about them adds up to anything, and likely spam is tucked behind a disclosure.
struct OtherTokensSection: View {
    let portfolio: Portfolio

    @State private var showsTucked = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Wording.otherTokensTitle).font(.headline)
            Text(Wording.otherTokensNote)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(portfolio.shownOtherTokens) { OtherTokenRow(token: $0) }
            if !portfolio.tuckedOtherTokens.isEmpty {
                DisclosureGroup("\(Wording.possibleSpamTitle) (\(portfolio.tuckedOtherTokens.count))", isExpanded: $showsTucked) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Wording.possibleSpamRule)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(portfolio.tuckedOtherTokens) { OtherTokenRow(token: $0) }
                    }
                    .padding(.top, 4)
                }
            }
            if let more = Wording.otherTokensLeftOut(portfolio.otherTokensLeftOut ?? 0) {
                Text(more)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct OtherTokenRow: View {
    let token: OtherToken

    var body: some View {
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
        // "PANDA, 9, no price" doesn't say which number is which.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Wording.otherTokenName(token)), \(Wording.otherTokenAmount(token)), no price\(token.tucked.map { ". \($0)" } ?? "")")
    }
}
