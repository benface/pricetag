#if DEBUG
import AppKit
import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// Every kind of thing the menu bar item says, for each choice of what it shows, on a light, a dark and a tinted bar. These are stand-ins for the real menu bar,
/// which only macOS can draw: the system picks the item's color, so this shows the words and their lengths, not the real thing.
struct MenuBarLabelScene: View {
    let portfolio: () -> Portfolio?

    private func summaries(_ shows: MenuBarShows) -> [FeedSummary] {
        let states: [FeedState] = [.noWallet, .reading, .live, .behind(seconds: 600), .serverUnreachable]
        return states.map { FeedSummary(feed: $0, portfolio: portfolio(), shows: shows) }
    }

    private func bar(_ shows: MenuBarShows, _ background: Color, _ foreground: Color) -> some View {
        let summaries = summaries(shows)
        return HStack(spacing: 16) {
            ForEach(Array(summaries.enumerated()), id: \.offset) { MenuBarLabelContent(summary: $0.element, isAlarm: false) }
            MenuBarLabelContent(summary: summaries[0], isAlarm: true)
        }
        .font(.system(size: 13))
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .frame(height: 24)
        .background(background)
    }

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            ForEach(MenuBarShows.allCases) { shows in
                GridRow {
                    Text(shows.label).font(.caption).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        bar(shows, Color(white: 0.92), .black)
                        bar(shows, Color(white: 0.14), .white)
                        bar(shows, Color(red: 0.1, green: 0.32, blue: 0.62), .white)
                    }
                }
            }
        }
        .padding(8)
    }
}

/// What a motion scene changes while it's being captured, from outside the views.
@Observable @MainActor
final class MotionCue {
    var revision = 0
    var range = ChartRange.all
    var metric = TestMode.chartMetric
    var scrubbed: Int?
    var stage = ProgressFooter.Stage.working("Sending…")
    var purchase = PurchasePhase.onItsWay
}

/// The chart, on its own, doing what the scene's cue says.
struct MotionChartScene: View {
    let store: PortfolioStore
    let cue: MotionCue

    var body: some View {
        Group {
            if let portfolio = store.portfolio {
                PnlHistorySection(portfolio: portfolio, isLive: true, range: Binding(get: { cue.range }, set: { cue.range = $0 }), metric: Binding(get: { cue.metric }, set: { cue.metric = $0 }), scrubbedIndex: cue.scrubbed) { _ in }
                    .id(cue.revision)
            }
        }
        .padding(20)
        .frame(width: 760, height: 340)
        .background(.background)
    }
}

/// The page's numbers and boxes with Increase Contrast on, which can't be turned on from here for real.
struct ContrastScene: View {
    let store: PortfolioStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let portfolio = store.portfolio {
                Notice(.info, Wording.demo)
                Notice(.warning, "This wallet's numbers aren't updating.")
                PortfolioSummary(portfolio: portfolio, isLive: true, size: 40) { _ in }
                PortfolioAttention(portfolio: portfolio, onOpen: { _ in }, onResolve: {})
                PnlHistorySection(portfolio: portfolio, isLive: true, range: .constant(.all), metric: .constant(TestMode.chartMetric)) { _ in }
                    .frame(height: 260)
            }
        }
        .padding(20)
        .frame(width: 900)
        .background(.background)
        .environment(\._colorSchemeContrast, .increased)
    }
}

/// What a send's confirmation goes through once Touch ID has said yes.
struct MotionSendScene: View {
    let cue: MotionCue

    var body: some View {
        ConfirmationView(asker: .spendingMoney, hero: .amount("12.5", symbol: "USDC"), worth: "$12.50", rows: [ConfirmationRow(label: "To", value: "0x00000000000000000000000000000000000de302", isAddress: true, name: "Ledger"), ConfirmationRow(label: "Network fee", value: "About $0.0032")]) {
            ProgressFooter(stage: cue.stage, close: {})
        }
        .frame(width: 460)
        .background(.background)
    }
}

/// A purchase going from on its way to arrived, with its cost.
struct MotionPurchaseScene: View {
    let cue: MotionCue

    private static let purchase = TrackedPurchase(
        ref: "arriving", wallet: HotWalletFixture.spending.lowercased, asset: "ETH", dollars: 25, startedAt: .now,
        order: OnrampOrder(id: "arriving", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: HotWalletFixture.spending.lowercased, network: "base", txHash: "0x" + String(repeating: "ab", count: 32), blockNum: 50)
    )

    var body: some View {
        PurchaseRow(purchase: Self.purchase, phase: cue.purchase, main: .USD) {}
            .padding(20)
            .frame(width: 420)
            .background(.background)
    }
}

/// Scenes press real buttons. What those save goes no further than this run, or the next scene, on any branch, would start from it.
nonisolated final class SceneDefaults: UserDefaults, @unchecked Sendable {
    override func set(_ value: Any?, forKey key: String) {
        if let value { register(defaults: [key: value]) }
    }

    override func removeObject(forKey key: String) {}
}

/// The card in each state it can be in, from what `test/hold.test.ts` wrote.
struct HoldComparisonScene: View {
    private struct Vector: Decodable {
        let currency: CurrencyCode
        let comparison: HoldComparison
    }

    private let vectors: [Vector] = {
        guard let url = Bundle.main.url(forResource: "hold-vectors", withExtension: "json"), let data = try? Data(contentsOf: url), let vectors = try? JSONDecoder().decode([Vector].self, from: data) else { TestMode.fail("There's no fixture called hold-vectors.") }
        return vectors
    }()

    var body: some View {
        VStack(spacing: 12) {
            ForEach(vectors.indices, id: \.self) { index in
                HoldComparisonCard(comparison: vectors[index].comparison, currency: vectors[index].currency, isLive: true) {}
            }
        }
        .padding(16)
        .frame(width: 800)
        .background(.background)
    }
}

/// Says every wallet is savings, so the only way to publish is from a device. Nothing here ever signs.
final class SavingsNoteWriter: CostNoteWriter {
    func canWriteNote(from wallet: String) -> Bool { false }
    func canWriteNoteOnDevice(from wallet: String) -> Bool { true }
    func writeNote(_ calldata: [UInt8], asset: String, from wallet: String) async -> Bool { false }
    var noteProblem: String? { nil }
}

final class ReadOnce {
    var isDone = false
}
#endif
