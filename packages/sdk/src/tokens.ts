// The allowlist. Matching is by address, because symbols aren't unique: another token also calls itself AERO.
// `symbol()` and `decimals()` were checked onchain for each one.

/** Stands in for native ETH in the `token` column. */
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000"
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"
export const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

export const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"
export const USDC_USD_FEED = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B"

const SHORT_HEARTBEAT = 3600
const DAILY_HEARTBEAT = 26 * 3600

/** A Chainlink feed for a token the dataset has no oracle reads for. It only gives current prices and a chart's marks, and its bounds are the token's `sanity`. */
export type TokenFeed = {
  address: string
  /** What `description()` says onchain. */
  description: string
  decimals: number
  /** The answer is in ETH rather than USD, so it's only as good as ETH's price. */
  answersInEth: boolean
  /** Past the feed's heartbeat with room to spare. Older than this and the price is gone rather than old. */
  maxAgeSeconds: number
}

const usdFeed = (address: string, description: string, maxAgeSeconds: number): TokenFeed => ({ address, description, decimals: 8, answersInEth: false, maxAgeSeconds })

/** By asset. The hot wallet reads the same ones with its own copy, `Oracle.others` in `Chain.swift`, which a test compares to this. */
export const TOKEN_FEEDS: Readonly<Record<string, TokenFeed | undefined>> = {
  USDT: usdFeed("0xf19d560eb8d2adf07bd6d13ed03e1d11215721f9", "USDT / USD", DAILY_HEARTBEAT),
  DAI: usdFeed("0x591e79239a7d679378ec8c847e5038150364c78f", "DAI / USD", DAILY_HEARTBEAT),
  cbETH: usdFeed("0xd7818272b9e248357d13057aab0b417af31e817d", "CBETH / USD", SHORT_HEARTBEAT),
  // There's no USD feed for this one on Base.
  wstETH: { address: "0x43a5c292a453a3bf3606fa856197f09d7b74251a", description: "WSTETH / ETH", decimals: 18, answersInEth: true, maxAgeSeconds: DAILY_HEARTBEAT },
  cbBTC: usdFeed("0x07da0e54543a844a80abe69c8a12f22b3aa59f9d", "cbBTC / USD", SHORT_HEARTBEAT),
  AERO: usdFeed("0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0", "AERO / USD", DAILY_HEARTBEAT),
  VIRTUAL: usdFeed("0xeaf310161c9ef7c813a14f8fef6fb271434019f7", "VIRTUAL / USD", DAILY_HEARTBEAT),
  DEGEN: usdFeed("0xe62bce5d7cb9d16ab8b4d622538bc0a50a5799c2", "DEGEN / USD", DAILY_HEARTBEAT),
}

/**
 * The contracts that emit each of `TOKEN_FEEDS`' `AnswerUpdated`, by asset. A new one goes here, and needs a new version of the
 * feeds dataset. Longest gaps seen over 17 days: 24 h for USDT, DAI and wstETH, 21 min for cbETH and cbBTC, 3.7 h for AERO, 5.3 h for VIRTUAL and 14 h for DEGEN.
 */
export const TOKEN_FEED_AGGREGATORS: Readonly<Record<string, readonly string[] | undefined>> = {
  USDT: ["0x84640bb7b71b0963e8eb57ad379a0b204eb2fdc8"],
  DAI: ["0x4bb0a4edbafd66e6891fdcf23f95428fd5b27564"],
  cbETH: ["0x71e021bc2e8a709b72ac7b6036e5b2bf30f263d0"],
  wstETH: ["0x1b70e0ee4041fa9f0e0fa2879b8818eaf4e2d81c"],
  cbBTC: ["0x51ce3091cf646587e02cad83b580992f8723e718"],
  AERO: ["0xfcddfb2294beba43987516371febb2e677eb403e"],
  VIRTUAL: ["0xf9036c275a07f5ce669416ca1108388e071d6ab2"],
  DEGEN: ["0x8597c19e048ea1deff99e9ef233eaf2ff6c0d508"],
}

/** How far back an update of `TOKEN_FEEDS` can still count. */
export const TOKEN_FEED_WINDOW_SECONDS = Math.max(...Object.values(TOKEN_FEEDS).map((feed) => feed?.maxAgeSeconds ?? 0))

export type FeedName = "eth" | "usdc"

export type PriceFeed = {
  name: FeedName
  pair: string
  /** What `latestRoundData()` and `aggregator()` are called on. It emits no log, not even when its aggregator changes. */
  proxy: string
  /** The contracts that emit this feed's `AnswerUpdated`. A new aggregator goes here, and needs a new dataset version. */
  aggregators: readonly string[]
  /** How long an update counts. After that the price is unknown, not stale. It's in time because feeds update on a clock, whatever the block rate. Longest gaps seen: 1,236 s and 86,490 s. */
  validSeconds: number
}

export const PRICE_FEEDS: readonly [PriceFeed, PriceFeed] = [
  { name: "eth", pair: "ETH/USD", proxy: ETH_USD_FEED, aggregators: ["0x05c84a58FE042275b37db038bAAcD15F410c7bB0"], validSeconds: 2_600 },
  { name: "usdc", pair: "USDC/USD", proxy: USDC_USD_FEED, aggregators: ["0x68bE4C50235205Ede361ac8244B1ee221CDDA5E2"], validSeconds: 90_000 },
]

/**
 * Stands in for the transaction of a price read from a feed's contract instead of a log. A local Amp has no logs from
 * before its start, so that's where its first prices come from. A real transaction can't have this hash.
 */
export const SEED_TX = `0x${"0".repeat(64)}`

/**
 * A swap price outside this range is rejected, and the leg has no usable price. Swaps can imply absurd prices:
 * we've seen up to 6.6e12× the oracle. The ranges are wide on purpose, so they only catch those.
 */
type Sanity = { usd: [min: number, max: number] } | { eth: [min: number, max: number] }

export type Token = {
  address: string
  symbol: string
  decimals: number
  /** The position this token folds into. WETH and ETH are one position, so wrapping is never a sale. */
  asset: string
  /** The dataset tracks a Chainlink feed for it at every block, so `sanity` only applies to a swap at a block where the feed has no price. */
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
  // Nearly always already normalized, and this runs for every row a busy wallet has, several times a read.
  return BY_ADDRESS.get(address) ?? BY_ADDRESS.get(normalizeAddress(address))
}

const BY_SYMBOL = new Map(TOKENS.map((t) => [t.symbol, t]))

/** By symbol, which is also how an asset names its main token: `ETH`, not `WETH`. */
export const tokenBySymbol = (symbol: string): Token | undefined => BY_SYMBOL.get(symbol)

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
