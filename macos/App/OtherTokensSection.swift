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
