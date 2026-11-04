p='src/core/fixtures.ts'; s=open(p).read()
s=s.replace('''// that also moved a token off the allowlist, an opening balance, and a balance the legs don't explain.
''','''// that also moved a token off the allowlist, an opening balance, a balance the legs don't explain, and senders to answer
// for: another of this user's wallets, a stranger, an exchange address and a bridge. Answering them is the demo.
''')
s=s.replace('''export const DEMO_ADDRESS = "0x00000000000000000000000000000000000de300"
''','''export const DEMO_ADDRESS = "0x00000000000000000000000000000000000de300"
/** The demo's other wallet. Nothing links them until someone answers that it's theirs. */
export const DEMO_SAVINGS_ADDRESS = "0x00000000000000000000000000000000000de301"
const STRANGER = "0x000000000000000000000000000000000000be11"
const SELLER = "0x000000000000000000000000000000000000be12"
const COINBASE = "0x71660c4005ba85c37ccec55d0c4493e66fe775d3"
const ACROSS = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"
''')
s=s.replace('''const VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"
''','''const VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"
''')
s=s.replace('''function tx(blockOffset: number, movements: [token: string, side: LegRow["side"], amount: bigint, kind?: LegKind][]): LegRow[] {
  txCounter++
''','''function tx(blockOffset: number, movements: [token: string, side: LegRow["side"], amount: bigint, kind?: LegKind, counterparty?: string][], account = DEMO_ADDRESS, sameTx = false): LegRow[] {
  if (!sameTx) txCounter++
''')
s=s.replace('''  return movements.map(([token, side, amount, kind], log_index) => ({''','''  return movements.map(([token, side, amount, kind, counterparty], log_index) => ({''')
s=s.replace('''    account: DEMO_ADDRESS,
    side,
    amount: amount.toString(),
    kind: kind ?? (token === ETH_ADDRESS ? "eth" : "erc20"),
  }))''','''    account,
    side,
    amount: amount.toString(),
    kind: kind ?? (token === ETH_ADDRESS ? "eth" : "erc20"),
    ...(counterparty ? { counterparty } : {}),
  }))''')
s=s.replace('''  // Funded with USDC from somewhere: its cost is unknown.
  ...tx(0, [[USDC_ADDRESS, "credit", 5_000n * E6]]),
  // Plain ETH arrives for gas: the price is known, the cost isn't.
  ...tx(150, [[ETH_ADDRESS, "credit", E18 / 50n]]),
''','''  // Funded with USDC from the other wallet, which nothing says yet. Its cost is unknown until someone answers.
  ...tx(0, [[USDC_ADDRESS, "credit", 5_000n * E6, undefined, DEMO_SAVINGS_ADDRESS]]),
  // Plain ETH arrives for gas from a stranger: the price is known, the cost isn't.
  ...tx(150, [[ETH_ADDRESS, "credit", E18 / 50n, undefined, STRANGER]]),
''')
s=s.replace('''  // Wraps ETH: nothing is sold.''','''  // From a bridge, so it isn't this user's own wallet: it's worth what it was worth on arrival, as an estimate.
  ...tx(1200, [[USDT, "credit", 200n * E6, undefined, ACROSS]]),
  // Wraps ETH: nothing is sold.''')
s=s.replace('''  // cbBTC arrives with no payment: unknown cost, and no price without a swap.
  ...tx(3000, [[CBBTC, "credit", 2_000_000n]]),''','''  // cbBTC arrives from an exchange's address with no payment: unknown cost, and whose withdrawal it was isn't known.
  ...tx(3000, [[CBBTC, "credit", 2_000_000n, undefined, COINBASE]]),''')
s=s.replace('''  ...tx(4800, [[ETH_ADDRESS, "debit", GAS, "gas"], [WETH_ADDRESS, "debit", E18 / 2n], [USDC_ADDRESS, "credit", 1_300n * E6]]),
]
''','''  ...tx(4800, [[ETH_ADDRESS, "debit", GAS, "gas"], [WETH_ADDRESS, "debit", E18 / 2n], [USDC_ADDRESS, "credit", 1_300n * E6]]),
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
''')
s=s.replace('''const references: ReferenceRow[] = [
  reference(0, 2380),''','''const references: ReferenceRow[] = [
  reference(-300, 2370),
  reference(0, 2380),''')
s=s.replace('''  reference(900, 2436),
''','''  reference(900, 2436),
  reference(1200, 2450),
''')
s=s.replace('''  reference(4800, 2600),
''','''  reference(4800, 2600),
  reference(5000, 2620),
''')
s=s.replace('''...buildPricedLegs({ account: DEMO_ADDRESS, rows, references, priced: derivePricedRows(rows, references) }),''','''...buildPricedLegs({ account: DEMO_ADDRESS, rows, references, priced: derivePricedRows(rows, references), market }),''')
a=s.index('export const DEMO_WALLET'); b=s.index('export const DEMO_ROWS')
s=s[:a]+'''const prices: WalletResponse["prices"] = {
  ETH: { usdMicros: "2640000000", source: "oracle", blockNum: START_BLOCK + HEAD_OFFSET },
  USDC: { usdMicros: "999800", source: "oracle", blockNum: START_BLOCK + HEAD_OFFSET },
  ...Object.fromEntries(Object.entries(MARKET).map(([asset, usdMicros]) => [asset, { usdMicros, source: "market" as const, blockNum: START_BLOCK + HEAD_OFFSET - 12 }])),
}

const common = {
  mode: "demo" as const,
  references,
  prices,
  latest: { blockNum: START_BLOCK + HEAD_OFFSET, timestamp: new Date(START_TIME + HEAD_OFFSET * 2000).toISOString() },
  gasUnknownTxs: [],
  l1FeeUnknownTxs: [],
  openingUnread: [],
  lastBalances: {},
  unreadBalances: [],
  notes: [],
  marketChecked: true,
}

export const DEMO_WALLET: WalletResponse = {
  ...common,
  address: DEMO_ADDRESS,
  coverage: { fromBlock: START_BLOCK, toBlock: START_BLOCK + HEAD_OFFSET },
  legs,
  balances: { blockNum: START_BLOCK + HEAD_OFFSET, amounts: Object.fromEntries([...balances].map(([asset, amount]) => [asset, amount.toString()])) },
  unlistedTokens: [UNLISTED],
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
  unlistedTokens: [],
}

/** The fixture at this address, if it's one of the demo's. */
export const demoWallet = (address: string): WalletResponse | null => (address === DEMO_SAVINGS_ADDRESS ? DEMO_SAVINGS_WALLET : null)

'''+s[b:]
open(p,'w').write(s)

import json
p='package.json'; d=json.load(open(p)); d['dependencies']['viem']='2.57.16'; d['dependencies']=dict(sorted(d['dependencies'].items()))
open(p,'w').write(json.dumps(d,indent=2)+"\n")
