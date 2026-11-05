import SwiftUI

extension WalletKind {
    public var symbol: String {
        switch self {
        case .spendingMoney: "banknote.fill"
        case .savings: "lock.fill"
        case .yours: "person.fill"
        case .watching: "eye.fill"
        case .demo: "sparkles"
        }
    }

    /// Green for money this Mac can move, blue for the user's own, and quiet for what's only being looked at.
    public var tint: Color {
        switch self {
        case .spendingMoney: .green
        case .savings, .yours: .blue
        case .watching, .demo: .secondary
        }
    }
}

public struct WalletIcon: View {
    let kind: WalletKind

    public init(kind: WalletKind) {
        self.kind = kind
    }

    public var body: some View {
        Image(systemName: kind.symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(kind.tint)
            .frame(width: 26, height: 26)
            .background(kind.tint.opacity(0.15), in: Circle())
            .accessibilityHidden(true)
    }
}
