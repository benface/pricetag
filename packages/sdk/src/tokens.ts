// The allowlist. Matching is by address, because symbols aren't unique: another token also calls itself AERO.
// `symbol()` and `decimals()` were checked onchain for each one.

/** Stands in for native ETH in the `token` column. */
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000"
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"
export const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

export const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"
export const USDC_USD_FEED = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B"

export type FeedName = "eth" | "usdc"

export type PriceFeed = {
  name: FeedName
  pair: string
  /** What `latestRoundData()` and `aggregator()` are called on. It emits no log, not even when its aggregator changes. */
  proxy: string
  /** The contracts that emit this feed's `AnswerUpdated`. A new aggregator goes here, and needs a new dataset version. */
  aggregators: readonly string[]
  /** How long an update counts, in blocks. After that the price is unknown, not stale. Longest gaps seen: 618 and 43,245. */
  validBlocks: number
}

export const PRICE_FEEDS: readonly [PriceFeed, PriceFeed] = [
  { name: "eth", pair: "ETH/USD", proxy: ETH_USD_FEED, aggregators: ["0x05c84a58FE042275b37db038bAAcD15F410c7bB0"], validBlocks: 1_300 },
  { name: "usdc", pair: "USDC/USD", proxy: USDC_USD_FEED, aggregators: ["0x68bE4C50235205Ede361ac8244B1ee221CDDA5E2"], validBlocks: 45_000 },
]

/**
 * A swap price outside this range is rejected, and the leg has no usable price. Swaps can imply absurd prices:
 * WORK-319 saw up to 6.6e12× the oracle. The ranges are wide on purpose, so they only catch those.
 */
type Sanity = { usd: [min: number, max: number] } | { eth: [min: number, max: number] }

export type Token = {
  address: string
  symbol: string
  decimals: number
  /** The position this token folds into. WETH and ETH are one position, so wrapping is never a sale. */
  asset: string
  /** A Chainlink feed prices it, so `sanity` only applies to a swap at a block where the feed has no price. */
  oracle?: "eth" | "usdc"
  sanity?: Sanity
}

export const TOKENS: readonly Token[] = [
  { address: ETH_ADDRESS, symbol: "ETH", decimals: 18, asset: "ETH", oracle: "eth", sanity: { usd: [100, 100_000] } },
  { address: WETH_ADDRESS, symbol: "WETH", decimals: 18, asset: "ETH", oracle: "eth" },
  { address: USDC_ADDRESS, symbol: "USDC", decimals: 6, asset: "USDC", oracle: "usdc", sanity: { usd: [0.8, 1.2] } },
  { address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", symbol: "USDT", decimals: 6, asset: "USDT", sanity: { usd: [0.8, 1.2] } },
  { address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", symbol: "DAI", decimals: 18, asset: "DAI", sanity: { usd: [0.8, 1.2] } },
  { address: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", symbol: "cbETH", decimals: 18, asset: "cbETH", sanity: { eth: [0.8, 1.6] } },
  { address: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", symbol: "wstETH", decimals: 18, asset: "wstETH", sanity: { eth: [0.8, 1.6] } },
  { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", symbol: "cbBTC", decimals: 8, asset: "cbBTC", sanity: { eth: [5, 200] } },
  { address: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", symbol: "AERO", decimals: 18, asset: "AERO", sanity: { usd: [0.001, 1000] } },
  { address: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", symbol: "VIRTUAL", decimals: 18, asset: "VIRTUAL", sanity: { usd: [0.001, 1000] } },
  { address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", symbol: "DEGEN", decimals: 18, asset: "DEGEN", sanity: { usd: [0.00001, 100] } },
]

const BY_ADDRESS = new Map(TOKENS.map((t) => [t.address, t]))

export function tokenByAddress(address: string): Token | undefined {
  return BY_ADDRESS.get(normalizeAddress(address))
}

export function normalizeAddress(address: string): string {
  const hex = address.toLowerCase()
  return hex.startsWith("0x") ? hex : `0x${hex}`
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isAddress(value: string): boolean {
  return ADDRESS.test(value)
}

/** The positions tokens fold into, which is what balances are read and compared by. */
export const ASSETS: readonly string[] = [...new Set(TOKENS.map((t) => t.asset))]

/** The tokens the dataset's `legs` table keeps, excluding native ETH, which has no contract. */
export const ERC20_ADDRESSES = TOKENS.filter((t) => t.address !== ETH_ADDRESS).map((t) => t.address)
