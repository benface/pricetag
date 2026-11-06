// A demo wallet in the `legs` and `reference_prices` shapes. Every case the UI has to get right is in here:
// swaps, gas, a wrap, a plain transfer with an unknown cost, an absurd swap price, a sale of unknown-cost tokens, a swap
// that also moved a token off the allowlist, an opening balance, a balance the legs don't explain, and senders to answer
// for: another of this user's wallets, a stranger, an exchange address and a bridge. Answering them is the demo.

import { ETH_ADDRESS, USDC_ADDRESS, WETH_ADDRESS, buildPricedLegs, derivePricedRows, markNeeds, normalizeAddress, openingLegs, type CurrencyCode, type LegKind, type LegRow, type Rates, type Reference } from "@pricetag/sdk/core"
import type { WalletResponse } from "./api.ts"
import { DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS } from "./book.ts"

export { DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS }

const STRANGER = "0x000000000000000000000000000000000000be11"
const SELLER = "0x000000000000000000000000000000000000be12"
const COINBASE = "0x71660c4005ba85c37ccec55d0c4493e66fe775d3"
const ACROSS = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"

const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"
const VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"
const UNLISTED = "0x000000000000000000000000000000000000f00d"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

const START_BLOCK = 53_500_000
const START_TIME = Date.UTC(2026, 10, 4, 8, 0, 0)

let txCounter = 0

function tx(blockOffset: number, movements: [token: string, side: LegRow["side"], amount: bigint, kind?: LegKind, counterparty?: string][], account = DEMO_ADDRESS, sameTx = false): LegRow[] {
  if (!sameTx) txCounter++
  const block_num = START_BLOCK + blockOffset
  const tx_hash = normalizeAddress(`de30${txCounter.toString(16).padStart(60, "0")}`)
  const timestamp = new Date(START_TIME + blockOffset * 2000).toISOString()
  return movements.map(([token, side, amount, kind, counterparty], log_index) => ({
    block_num,
    timestamp,
    tx_hash,
    tx_index: 7,
    log_index,
    token,
    account,
    side,
    amount: amount.toString(),
    kind: kind ?? (token === ETH_ADDRESS ? "eth" : "erc20"),
    ...(counterparty ? { counterparty } : {}),
  }))
}

const GAS = 40_000_000_000_000n

const rows: LegRow[] = [
  // Funded with USDC from the other wallet, which nothing says yet. Its cost is unknown until someone answers.
  ...tx(0, [[USDC_ADDRESS, "credit", 5_000n * E6, undefined, DEMO_SAVINGS_ADDRESS]]),
  // Plain ETH arrives for gas from a stranger: the price is known, the cost isn't.
  ...tx(150, [[ETH_ADDRESS, "credit", E18 / 50n, undefined, STRANGER]]),
  // Buys ETH with USDC, then AERO with USDC.
  ...tx(300, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 2_400n * E6], [WETH_ADDRESS, "credit", E18]]),
  ...tx(900, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 1_000n * E6], [AERO, "credit", 800n * E18]]),
  // From a bridge, so it isn't this user's own wallet: it's worth what it was worth on arrival, as an estimate.
  ...tx(1200, [[USDT, "credit", 200n * E6, undefined, ACROSS]]),
  // Wraps ETH: nothing is sold.
  ...tx(1500, [[ETH_ADDRESS, "debit", GAS, "gas"], [ETH_ADDRESS, "debit", E18 / 4n], [WETH_ADDRESS, "credit", E18 / 4n, "wrap"]]),
  // Sells part of the AERO at a gain.
  ...tx(2400, [[ETH_ADDRESS, "debit", GAS, "gas"], [AERO, "debit", 300n * E18], [USDC_ADDRESS, "credit", 450n * E6]]),
  // cbBTC arrives from an exchange's address with no payment: unknown cost, and whose withdrawal it was isn't known.
  ...tx(3000, [[CBBTC, "credit", 2_000_000n, undefined, COINBASE]]),
  // A swap implying an absurd DEGEN price: rejected, so it never reaches a total.
  ...tx(3600, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 1n], [DEGEN, "credit", 50_000n * E18]]),
  // Pays USDC for VIRTUAL and a token off the allowlist, so VIRTUAL's share of the payment can't be known.
  ...tx(4200, [[ETH_ADDRESS, "debit", GAS, "gas"], [USDC_ADDRESS, "debit", 100n * E6], [VIRTUAL, "credit", 50n * E18], [UNLISTED, "credit", 9n * E18, "unlisted"]]),
  // Sells ETH higher than it was bought.
  ...tx(4800, [[ETH_ADDRESS, "debit", GAS, "gas"], [WETH_ADDRESS, "debit", E18 / 2n], [USDC_ADDRESS, "credit", 1_300n * E6]]),
  // Some ETH back to the other wallet, which is the evidence its card shows.
  ...tx(5000, [[ETH_ADDRESS, "debit", GAS, "gas"], [ETH_ADDRESS, "debit", E18 / 500n, undefined, DEMO_SAVINGS_ADDRESS]]),
]

const lastDemoTx = rows[rows.length - 1] as LegRow

/** The other wallet: USDC it reported a cost for in a note, plus some it already held. */
const savingsFunding = tx(-300, [[USDC_ADDRESS, "credit", 4_000n * E6, undefined, SELLER]], DEMO_SAVINGS_ADDRESS)
const savingsRows: LegRow[] = [
  ...savingsFunding,
  // These are the same transactions as the demo wallet's, seen from this side.
  ...[rows[0] as LegRow].map((row): LegRow => ({ ...row, account: DEMO_SAVINGS_ADDRESS, side: "debit", counterparty: DEMO_ADDRESS })),
  { ...lastDemoTx, account: DEMO_SAVINGS_ADDRESS, side: "credit", counterparty: DEMO_ADDRESS },
]
const SAVINGS_FROM = START_BLOCK - 500

/** What these tokens were trading at. In the real thing, this comes from `priced_legs` with guards. DEGEN has no market. */
const MARKET: Record<string, string> = { AERO: "1400000", cbBTC: "68000000000", DAI: "1000100", USDT: "999900", VIRTUAL: "2100000" }
const market = (asset: string) => MARKET[asset] ?? null
/** Where AERO was trading on its way there: near what the wallet paid and sold it for at those blocks. */
const AERO_MARKET: [blockOffset: number, usdMicros: string][] = [[900, "1250000"], [1200, "1310000"], [1500, "1360000"], [2400, "1500000"], [3000, "1470000"], [3600, "1450000"], [4200, "1430000"], [4800, "1410000"], [5000, "1400000"]]
const marketAt = (asset: string, block: number) => (asset === "AERO" ? AERO_MARKET.find(([offset]) => START_BLOCK + offset === block)?.[1] : MARKET[asset]) ?? null

function reference(blockOffset: number, ethUsd: number, usdcUsd = 0.9998): Reference {
  return {
    blockNum: START_BLOCK + blockOffset,
    ethUsd: String(Math.round(ethUsd * 1e8)),
    usdcUsd: String(Math.round(usdcUsd * 1e8)),
  }
}

const HEAD_OFFSET = 5400

const references: Reference[] = [
  reference(-300, 2370),
  reference(0, 2380),
  reference(150, 2392),
  reference(300, 2400),
  reference(900, 2436),
  reference(1200, 2450),
  reference(1500, 2465),
  reference(2400, 2510),
  reference(3000, 2552),
  reference(3600, 2583),
  reference(4200, 2590),
  reference(4800, 2600),
  reference(5000, 2620),
  reference(HEAD_OFFSET, 2640),
]

const opening = { blockNum: START_BLOCK - 1, amounts: { DAI: (250n * E18).toString() } }

const legs = [
  // DAI that was already there before the first block read, and hasn't moved since.
  ...openingLegs(opening, new Date(START_TIME - 2000).toISOString()),
  ...buildPricedLegs({ account: DEMO_ADDRESS, rows, references, priced: derivePricedRows(rows, references), market }),
]

// Everything matches the chain, except cbBTC: it holds more than the legs explain.
const balances = new Map<string, bigint>()
for (const leg of legs) balances.set(leg.asset, (balances.get(leg.asset) ?? 0n) + BigInt(leg.delta))
balances.set("cbBTC", (balances.get("cbBTC") ?? 0n) + 500_000n)

const prices: WalletResponse["prices"] = {
  ETH: { micros: "2640000000", source: "oracle", blockNum: START_BLOCK + HEAD_OFFSET },
  USDC: { micros: "999800", source: "oracle", blockNum: START_BLOCK + HEAD_OFFSET },
  ...Object.fromEntries(Object.entries(MARKET).map(([asset, micros]) => [asset, { micros, source: "market" as const, blockNum: START_BLOCK + HEAD_OFFSET - 12 }])),
}

const common = {
  mode: "demo" as const,
  references,
  prices,
  latest: { blockNum: START_BLOCK + HEAD_OFFSET, timestamp: new Date(START_TIME + HEAD_OFFSET * 2000).toISOString() },
  gasUnknownTxs: [],
  gasUnknownBlocks: [],
  unlisted: [{ token: "0x00000000000000000000000000000000000000f1", transfers: 1 }],
  otherTokens: [
    { token: "0x00000000000000000000000000000000000000f1", kind: "token" as const, name: "Jackfruit", symbol: "JACK", decimals: 18, balance: (9n * E18).toString(), state: "read" as const, note: null, tucked: null },
    { token: "0x00000000000000000000000000000000000000f2", kind: "token" as const, name: "USD Coin", symbol: "USDC", decimals: 6, balance: (5_000n * E6).toString(), state: "read" as const, note: null, tucked: "It calls itself USDC, and it isn't the USDC we know." },
  ],
  otherTokensLeftOut: 0,
  l1FeeUnknownTxs: [],
  openingUnread: [],
  unseenEth: [],
  lastBalances: {},
  lastCheckableEth: null,
  unreadBalances: [],
  currency: "USD" as const,
  rates: null,
  notes: [],
  marketChecked: true,
  marketMarks: {},
}

/** USD for one Canadian dollar, moving enough that converting at the wrong moment would show. */
const CAD_USD: [blockOffset: number, usd: number][] = [
  [SAVINGS_FROM - 1 - START_BLOCK, 0.746],
  [-300, 0.745],
  [-1, 0.743],
  [0, 0.742],
  [150, 0.741],
  [300, 0.738],
  [900, 0.734],
  [1200, 0.732],
  [1500, 0.731],
  [2400, 0.728],
  [3000, 0.725],
  [3600, 0.723],
  [4200, 0.72],
  [4800, 0.718],
  [5000, 0.716],
  [HEAD_OFFSET, 0.715],
]

/** About what one of each is worth in USD, to move each the way CAD does. */
const DEMO_USD_PER: Record<Exclude<CurrencyCode, "USD">, number> = { CAD: 0.715, EUR: 1.12, GBP: 1.35, CHF: 1.23, AUD: 0.7, NZD: 0.56, SGD: 0.78, MXN: 0.053, BRL: 0.18, TRY: 0.02, ZAR: 0.06 }

/** What the feed would have answered for the demo's blocks. USD has no feed, so it has no rates. */
export function demoRates(currency: CurrencyCode): Rates {
  const scale = currency === "USD" ? 0 : DEMO_USD_PER[currency] / DEMO_USD_PER.CAD
  const rounds = (currency === "USD" ? [] : CAD_USD).map(([offset, usd]) => ({
    blockNum: START_BLOCK + offset,
    round: { answer: String(Math.round(usd * scale * 1e8)), updatedAt: (START_TIME + offset * 2000) / 1000 },
  }))
  return { byBlock: Object.fromEntries(rounds.map((r) => [r.blockNum, r.round])), latest: rounds.at(-1) ?? null }
}

const marketMarks: WalletResponse["marketMarks"] = {}
for (const { asset, block } of markNeeds(DEMO_ADDRESS, rows, opening)) {
  const price = marketAt(asset, block)
  if (price) (marketMarks[block] ??= {})[asset] = price
}

export const DEMO_WALLET: WalletResponse = {
  ...common,
  address: DEMO_ADDRESS,
  marketMarks,
  coverage: { fromBlock: START_BLOCK, toBlock: START_BLOCK + HEAD_OFFSET },
  legs,
  balances: { blockNum: START_BLOCK + HEAD_OFFSET, amounts: Object.fromEntries([...balances].map(([asset, amount]) => [asset, amount.toString()])) },
}

const savingsLegs = [
  ...openingLegs({ blockNum: SAVINGS_FROM - 1, amounts: { USDC: (1_000n * E6).toString() } }, new Date(START_TIME - 1200 * 1000).toISOString()),
  ...buildPricedLegs({ account: DEMO_SAVINGS_ADDRESS, rows: savingsRows, references, priced: derivePricedRows(savingsRows, references), market }),
]

export const DEMO_SAVINGS_WALLET: WalletResponse = {
  ...common,
  address: DEMO_SAVINGS_ADDRESS,
  coverage: { fromBlock: SAVINGS_FROM, toBlock: START_BLOCK + HEAD_OFFSET },
  legs: savingsLegs,
  balances: {
    blockNum: START_BLOCK + HEAD_OFFSET,
    amounts: Object.fromEntries(
      [...savingsLegs.reduce((sums, leg) => sums.set(leg.asset, (sums.get(leg.asset) ?? 0n) + BigInt(leg.delta)), new Map<string, bigint>())].map(([asset, amount]) => [asset, amount.toString()]),
    ),
  },
  notes: [{ noteTx: normalizeAddress(`de31${"0".repeat(60)}`), blockNum: START_BLOCK - 299, txHash: (savingsFunding[0] as LegRow).tx_hash, asset: "USDC", usdMicros: (3_990n * E6).toString() }],
}

/** The fixture at this address, if it's one of the demo's. */
export const demoWallet = (address: string): WalletResponse | null => (address === DEMO_SAVINGS_ADDRESS ? DEMO_SAVINGS_WALLET : null)

export const DEMO_ROWS = rows
export const DEMO_REFERENCES = references
