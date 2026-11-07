// How a wallet's ETH is checked against its balance: claims settled, and ETH that arrived with no row to show for it found,
// along with who sent it. Without traces, the balance is the only witness, so this reads balances only where they can say something.

import { describeError, type Logger } from "./amp.ts"
import { timestampOfBlock } from "./chain.ts"
import { creditUnseenEth, oneWaySendBalanceBlocks, payerOf, sentWithNoFee, settleUnwraps, unseenEthSearchBlocks, type LegRow } from "./legs.ts"
import { foldPositions } from "./portfolio.ts"
import { l1FeeRows, type Cached } from "./wallet-state.ts"
import type { WalletData } from "./wallet-data.ts"
import type { Source } from "./wallets.ts"

/** Each block costs a scan of its transactions' calldata, so a wallet with many of these learns who to ask about them over a few refreshes. */
const MAX_PAYER_BLOCKS_PER_READ = 40

/** A wallet's rows, with each claim settled wherever its balances and fees can say how much arrived. */
export function settle(wallet: Pick<Cached, "rows" | "priced" | "references" | "ethBalances" | "gasUnknown" | "l1Fees" | "staleFeeTxs">) {
  const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
  return settleUnwraps({
    rows: [...wallet.rows, ...l1.rows],
    priced: wallet.priced,
    references: [...wallet.references.values()],
    ethBalances: wallet.ethBalances,
    feeUnknownTxs: [...wallet.gasUnknown.keys(), ...l1.unknownTxs, ...wallet.staleFeeTxs],
    gasUnknownBlocks: [...wallet.gasUnknown.values()],
  })
}

/** A wallet's settled rows, with the ETH its balance says arrived and no row explains. */
export function withUnseenEth(address: string, wallet: Pick<Cached, "fromBlock" | "coveredTo" | "latest" | "rows" | "ethBalances" | "ethPayers" | "gasUnknown" | "l1Fees" | "staleFeeTxs">, rows: readonly LegRow[]): LegRow[] {
  return creditUnseenEth({
    rows,
    ethBalances: wallet.ethBalances,
    feeUnknownTxs: [...wallet.gasUnknown.keys(), ...l1FeeRows(wallet.rows, wallet.l1Fees).unknownTxs, ...wallet.staleFeeTxs],
    gasUnknownBlocks: [...wallet.gasUnknown.values()],
    account: address,
    fromBlock: wallet.fromBlock,
    through: wallet.coveredTo,
    payers: wallet.ethPayers,
    timestampOf: (block) => timestampOfBlock(block, wallet.latest),
  })
}

/** A wallet's response, with what's been worked out from it, kept while nothing it depends on changes. */
export type CurrentResponse = { response: WalletData; ethIncomplete?: boolean; unseenCredits?: LegRow[] }

/** `currentOf` gives the wallet's response as it stands, which is worked out once and shared with everything else a read needs. */
export function createEthChecks(source: Source, logger: Logger, currentOf: (address: string, wallet: Cached) => CurrentResponse) {
  /**
   * The balances a wallet's ETH still needs to say where it went wrong. A wallet whose ETH adds up has nothing unseen to
   * find, so it costs no reads, however many tokens it sends.
   */
  function unreadSendBlocks(address: string, wallet: Cached): number[] {
    const blocks = oneWaySendBalanceBlocks(wallet.rows).filter((block) => !wallet.ethBalances.has(block))
    return blocks.length > 0 && isEthIncomplete(address, wallet) ? blocks : []
  }

  /** The same check the wallet's position gets, because a balance can match after ETH left that never arrived. Whether it did doesn't depend on the method. */
  function isEthIncomplete(address: string, wallet: Cached): boolean {
    const current = currentOf(address, wallet)
    if (current.ethIncomplete === undefined) {
      const { response } = current
      const eth = foldPositions(response.legs.filter((leg) => leg.asset === "ETH"), "average", {}, response).find((position) => position.asset === "ETH")
      current.ethIncomplete = eth?.reconciliation?.status === "incomplete"
    }
    return current.ethIncomplete
  }

  /** The balances a wallet still needs to find ETH that its rows don't explain. One whose ETH adds up has nothing to find, so it costs no reads. */
  function unreadUnseenBlocks(address: string, wallet: Cached): number[] {
    if (!isEthIncomplete(address, wallet)) return []
    return unseenEthSearchBlocks({ rows: settle(wallet).rows, ethBalances: wallet.ethBalances, fromBlock: wallet.fromBlock, through: wallet.coveredTo })
  }

  function unseenCredits(address: string, wallet: Cached): LegRow[] {
    const current = currentOf(address, wallet)
    current.unseenCredits ??= withUnseenEth(address, wallet, settle(wallet).rows).filter((row) => row.kind === "unseen_eth")
    return current.unseenCredits
  }

  const unreadPayerBlocks = (address: string, wallet: Cached) => (source.readPayoutTxs ? unseenCredits(address, wallet).filter((row) => !wallet.ethPayers.has(row.block_num)) : [])

  /** Finds where a wallet's ETH moved without a row to show for it, then what's needed to treat it like any other ETH that arrived. A failed read leaves what's unread as it was. */
  async function findUnseenEth(address: string, wallet: Cached, budget: number) {
    let left = budget
    while (left > 0) {
      const blocks = unreadUnseenBlocks(address, wallet).slice(0, left)
      if (blocks.length === 0) break
      const known = wallet.ethBalances.size
      await readEthBalances(address, blocks, wallet.ethBalances)
      if (wallet.ethBalances.size === known) break
      left -= blocks.length
    }
    const credits = unseenCredits(address, wallet)
    const unpriced = credits.map((row) => row.block_num).filter((block) => !wallet.references.has(block))
    const unread = unreadPayerBlocks(address, wallet).slice(0, MAX_PAYER_BLOCKS_PER_READ)
    try {
      if (unpriced.length > 0) for (const reference of await source.readReferences(unpriced)) wallet.references.set(reference.blockNum, reference)
      if (unread.length > 0 && source.readPayoutTxs) {
        const txs = await source.readPayoutTxs(address, unread.map((row) => row.block_num))
        for (const { block_num, amount } of unread) wallet.ethPayers.set(block_num, payerOf(txs.filter((tx) => tx.blockNum === block_num), address, amount))
        for (const { tx_hash, block_num } of sentWithNoFee(txs, wallet.rows, address)) wallet.gasUnknown.set(tx_hash, block_num)
      }
    } catch (error) {
      logger.warn(`Couldn't read what's behind ETH that arrived unseen: ${describeError(error)}`)
    }
  }

  /** A failed read leaves what's unread as it was. The next refresh tries again. */
  async function readEthBalances(address: string, blocks: readonly number[], into: Map<number, string>) {
    if (blocks.length === 0) return
    try {
      for (const [block, balance] of await source.readEthBalances(address, blocks)) into.set(block, balance)
    } catch (error) {
      logger.warn(`ETH balance read failed: ${describeError(error)}`)
    }
  }

  return { unreadSendBlocks, unreadUnseenBlocks, unreadPayerBlocks, findUnseenEth, readEthBalances }
}
