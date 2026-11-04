// A demo wallet in the `legs` and `reference_prices` shapes. Every case the UI has to get right is in here:
// swaps, gas, a wrap, a plain transfer with an unknown cost, an absurd swap price, a sale of unknown-cost tokens, a swap
// that also moved a token off the allowlist, an opening balance, and a balance the legs don't explain.

import { ETH_ADDRESS, USDC_ADDRESS, WETH_ADDRESS, buildPricedLegs, derivePricedRows, normalizeAddress, openingLegs, type CurrencyCode, type LegKind, type LegRow, type Rates, type Reference } from "@pricetag/sdk/core"
import type { WalletResponse } from "./api.ts"

export const DEMO_ADDRESS = "0x00000000000000000000000000000000000de300"

const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"
const VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"
const UNLISTED = "0x000000000000000000000000000000000000f00d"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

const START_BLOCK = 53_500_000
const START_TIME = Date.UTC(2026, 10, 4, 8, 0, 0)

let txCounter = 0

function tx(blockOffset: number, movements: [token: string, side: LegRow["side"], amount: bigint, kind?: LegKind][]): LegRow[] {
  txCounter++
  const block_num = START_BLOCK + blockOffset
  const tx_hash = normalizeAddress(`de30${txCounter.toString(16).padStart(60, "0")}`)
  const timestamp = new Date(START_TIME + blockOffset * 2000).toISOString()
  return movements.map(([token, side, amount, kind], log_index) => ({
    block_num,
    timestamp,
    tx_hash,
    tx_index: 7,
    log_index,
    token,
    account: DEMO_ADDRESS,
    side,
    amount: amount.toString(),
    kind: kind ?? (token === ETH_ADDRESS ? "eth" : "erc20"),
  }))
}

const GAS = 40_000_000_000_000n

const rows: LegRow[] = [
  // Funded with USDC from somewhere: its cost is unknown.
  ...tx(0, [[USDC_ADDRESS, "credit", 5_000n * E6]]),
  // Plain ETH arrives for gas: the price is known, the cost isn't.
  ...tx(150, [[ETH_ADDRESS, "credit", E18 / 50n]]),
  // Buys ETH with USDC, then AERO with USDC.
  ...tx(300, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 2_400n * E6], [WETH_ADDRESS, "credit", E18]]),
  ...tx(900, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 1_000n * E6], [AERO, "credit", 800n * E18]]),
  // Wraps ETH: nothing is sold.
  ...tx(1500, [[ETH_ADDRESS, "debit", GAS, "gas"], [ETH_ADDRESS, "debit", E18 / 4n], [WETH_ADDRESS, "credit", E18 / 4n, "wrap"]]),
  // Sells part of the AERO at a gain.
  ...tx(2400, [[ETH_ADDRESS, "debit", GAS, "gas"], [AERO, "debit", 300n * E18], [USDC_ADDRESS, "credit", 450n * E6]]),
  // cbBTC arrives with no payment: unknown cost, and no price without a swap.
  ...tx(3000, [[CBBTC, "credit", 2_000_000n]]),
  // A swap implying an absurd DEGEN price: rejected, so it never reaches a total.
  ...tx(3600, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 1n], [DEGEN, "credit", 50_000n * E18]]),
  // Pays USDC for VIRTUAL and a token off the allowlist, so VIRTUAL's share of the payment can't be known.
  ...tx(4200, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 100n * E6], [VIRTUAL, "credit", 50n * E18], [UNLISTED, "credit", 9n * E18, "unlisted"]]),
  // Sells ETH higher than it was bought.
  ...tx(4800, [[ETH_ADDRESS, "debit", GAS, "gas"], [WETH_ADDRESS, "debit", E18 / 2n], [USDC_ADDRESS, "credit", 1_300n * E6]]),
]

function reference(blockOffset: number, ethUsd: number, usdcUsd = 0.9998): Reference {
  return {
    blockNum: START_BLOCK + blockOffset,
    ethUsd: String(Math.round(ethUsd * 1e8)),
    usdcUsd: String(Math.round(usdcUsd * 1e8)),
  }
}

const HEAD_OFFSET = 5400

const references: Reference[] = [
  reference(0, 2380),
  reference(150, 2392),
  reference(300, 2400),
  reference(900, 2436),
  reference(1500, 2465),
  reference(2400, 2510),
  reference(3000, 2552),
  reference(3600, 2583),
  reference(4200, 2590),
  reference(4800, 2600),
  reference(HEAD_OFFSET, 2640),
]

const legs = [
  // DAI that was already there before the first block read, and hasn't moved since.
  ...openingLegs({ blockNum: START_BLOCK - 1, amounts: { DAI: (250n * E18).toString() } }, new Date(START_TIME - 2000).toISOString()),
  ...buildPricedLegs({ account: DEMO_ADDRESS, rows, references, priced: derivePricedRows(rows, references) }),
]

// Everything matches the chain, except cbBTC: it holds more than the legs explain.
const balances = new Map<string, bigint>()
for (const leg of legs) balances.set(leg.asset, (balances.get(leg.asset) ?? 0n) + BigInt(leg.delta))
balances.set("cbBTC", (balances.get("cbBTC") ?? 0n) + 500_000n)

export const DEMO_WALLET: WalletResponse = {
  address: DEMO_ADDRESS,
  mode: "demo",
  coverage: { fromBlock: START_BLOCK, toBlock: START_BLOCK + HEAD_OFFSET },
  legs,
  references,
  prices: {
    ETH: { micros: "2640000000", source: "oracle", blockNum: START_BLOCK + HEAD_OFFSET },
    USDC: { micros: "999800", source: "oracle", blockNum: START_BLOCK + HEAD_OFFSET },
  },
  latest: { blockNum: START_BLOCK + HEAD_OFFSET, timestamp: new Date(START_TIME + HEAD_OFFSET * 2000).toISOString() },
  gasUnknownTxs: [],
  unlisted: [{ token: "0x00000000000000000000000000000000000000f1", transfers: 1 }],
  l1FeeUnknownTxs: [],
  openingUnread: [],
  unseenEth: [],
  lastBalances: {},
  unreadBalances: [],
  balances: { blockNum: START_BLOCK + HEAD_OFFSET, amounts: Object.fromEntries([...balances].map(([asset, amount]) => [asset, amount.toString()])) },
  currency: "USD",
  rates: null,
}

/** USD for one Canadian dollar, moving enough that converting at the wrong moment would show. */
const CAD_USD: [blockOffset: number, usd: number][] = [
  [0, 0.742],
  [150, 0.741],
  [300, 0.738],
  [900, 0.734],
  [1500, 0.731],
  [2400, 0.728],
  [3000, 0.725],
  [3600, 0.723],
  [4200, 0.72],
  [4800, 0.718],
  [HEAD_OFFSET, 0.715],
]

/** What the feed would have answered for the demo's blocks. A currency with no demo data has no rates, like any other missing rate. */
export function demoRates(currency: CurrencyCode): Rates {
  const rounds = (currency === "CAD" ? CAD_USD : []).map(([offset, usd]) => ({
    blockNum: START_BLOCK + offset,
    round: { answer: String(Math.round(usd * 1e8)), updatedAt: (START_TIME + offset * 2000) / 1000 },
  }))
  return { byBlock: Object.fromEntries(rounds.map((r) => [r.blockNum, r.round])), latest: rounds.at(-1) ?? null }
}

export const DEMO_ROWS = rows
export const DEMO_REFERENCES = references
