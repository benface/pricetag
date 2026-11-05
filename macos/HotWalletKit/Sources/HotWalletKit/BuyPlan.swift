import Foundation

/// Where a purchase ends up. It all lands here, and what's above the cap sweeps to savings, so this says how much of each, and whether that can work.
public struct BuyPlan: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        /// Below what the provider takes for some ways to pay. Its page has the last word.
        case belowMinimum
        /// More than fits, with no savings wallet for the rest to go to.
        case needsSavings
        /// A token with no ETH here to pay for moving it, so what's above the cap would be stuck.
        case noGasToSweep
    }

    public static let minimumDollars = 5

    public let stays: UInt128
    public let sweeps: UInt128
    public let problem: Problem?

    /// Nothing above the room and the minimum is this app's to limit. The provider applies its own limits to the account.
    public init(dollars: Int, isNative: Bool, roomUsdMicros: UInt128, ethBalanceWei: UInt128, hasSavings: Bool) {
        let amount = UInt128(max(dollars, 0)) * Money.dollar
        stays = min(amount, roomUsdMicros)
        sweeps = amount.subtractingClamped(roomUsdMicros)
        if dollars < Self.minimumDollars {
            problem = .belowMinimum
        } else if sweeps > 0, !hasSavings {
            problem = .needsSavings
        } else if sweeps > 0, !isNative, ethBalanceWei < SweepPlanner.minimumGasReserveWei {
            problem = .noGasToSweep
        } else {
            problem = nil
        }
    }

    /// In plain digits for the provider, rounded down, so this never asks for more than was chosen.
    public static func decimal(_ units: UInt128, decimals: Int, keeping: Int) -> String {
        let text = String(units)
        let padded = String(repeating: "0", count: max(0, decimals + 1 - text.count)) + text
        let fraction = padded.suffix(decimals).prefix(keeping)
        return "\(padded.dropLast(decimals)).\(fraction)"
    }
}
