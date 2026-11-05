import SwiftUI

extension WalletKind {
    public var symbol: String {
        switch self {
        case .spendingMoney: "banknote.fill"
        case .savings: "lock.fill"
        case .yours: "wallet.bifold.fill"
        case .watching: "eye.fill"
        case .demo: "sparkles"
        }
    }

    /// What the icon stands for, for whoever wonders. They're chosen by what the wallet is, and never by hand, so one can't pass for another.
    public var meaning: String {
        switch self {
        case .spendingMoney: "On this Mac, and ready to send"
        case .savings: "On a hardware device, and where sweeps can go"
        case .yours: "Yours, so costs follow money between it and your other wallets"
        case .watching: "Only being watched. Nothing here can sign for it"
        case .demo: "Sample data"
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

/// Always the kind of wallet, so a watched one can't look like one of the user's.
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
            .help(kind.meaning)
            .accessibilityHidden(true)
    }
}
