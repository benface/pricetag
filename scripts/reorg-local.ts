// Forces reorgs through a real local Amp and checks what the dataset and the SDK do with them (WORK-497). Run it with
// scripts/reorg-local.sh, which starts what it needs:
//
//   ANVIL_URL=… FLIGHT_URL=… START_BLOCK=… node scripts/reorg-local.ts [depth...]
//
// It needs an Anvil fork of Base with `--no-mining`, and an `ampd` following it as `base-mainnet`, with
// edgeandnode/base_mainnet@0.0.2 and benface/pricetag@0.0.1 deployed from START_BLOCK. Anvil signs with its own unlocked
// accounts, and the USDC comes from an impersonated pool, so no key is involved.
//
// For each depth, smallest first: put a transfer to the watched wallet on the chain, wait for the wallet to show it, then
// revert and replace at least `depth` blocks with a longer chain that has a different transfer. Then it times how long
// Amp's tables, its stream and two wallets, one following the stream and one polling, take to match the new chain.

import { createPricetag, type WalletUpdate } from "@pricetag/sdk"
import { createQuery, createRangeStream, followSql, pricetagClient, readHeadMark, settledThrough } from "@pricetag/sdk/internal"

const ANVIL = process.env.ANVIL_URL ?? "http://127.0.0.1:18597"
const FLIGHT = process.env.FLIGHT_URL ?? "http://127.0.0.1:11602"
const START = Number(process.env.START_BLOCK)
const DEPTHS = process.argv.slice(2).map(Number)
const RAW = "edgeandnode/base_mainnet@0.0.2"
const DATASET = "benface/pricetag@0.0.1"
const NETWORK = "base-mainnet"
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 150_000)

/** Anvil's first unlocked account, which only has funds on this fork. */
const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
/** The watched wallet. Nobody has its key: it only receives. */
const WALLET = "0x4970000000000000000000000000000000000497"
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const WETH = "0x4200000000000000000000000000000000000006"
/** Uniswap v3's USDC/WETH pool, impersonated on the fork as a source of USDC. */
const USDC_SOURCE = "0xd0b53d9277642d899df5c87a3966a349a798f224"
const ROUTER = "0x2626664c2603336e57b271c5c0b26f421741e481"
/** An unlisted token that only emits a `Transfer` from its caller to its caller. */
const UNLISTED = "0x4970000000000000000000000000000000000001"
const UNLISTED_CODE = "0x60016000523333" + "7fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" + "60206000a300"

const T0 = Date.now()
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: ((Date.now() - T0) / 1000).toFixed(2), event, ...data }))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const { result, error } = (await response.json()) as { result: T; error?: { message: string } }
  if (error) throw new Error(`${method}: ${error.message}`)
  return result
}
const hex = (n: bigint | number) => `0x${n.toString(16)}`
const word = (value: string | bigint) => (typeof value === "bigint" ? value.toString(16) : value.slice(2)).padStart(64, "0")
const head = async () => Number(await rpc<string>("eth_blockNumber"))
const blockHash = async (n: number) => (await rpc<{ hash: string }>("eth_getBlockByNumber", [hex(n), false])).hash
const ethBalance = async (block: number) => BigInt(await rpc<string>("eth_getBalance", [WALLET, hex(block)]))
const usdcBalance = async (block: number) => BigInt(await rpc<string>("eth_call", [{ to: USDC, data: `0x70a08231${word(WALLET)}` }, hex(block)]))

const sendEth = (wei: bigint) => rpc<string>("eth_sendTransaction", [{ from: SENDER, to: WALLET, value: hex(wei) }])
const sendUsdc = (units: bigint) => rpc<string>("eth_sendTransaction", [{ from: USDC_SOURCE, to: USDC, data: `0xa9059cbb${word(WALLET)}${word(units)}`, gas: hex(200_000) }])

/**
 * The SDK counts a table as processed up to its newest row, and Base always has swaps and unlisted tokens. A quiet fork
 * doesn't, so the chain gets one of each every few blocks, from the sender, never the watched wallet.
 */
async function activity() {
  await swapEth(10n ** 15n)
  await rpc("eth_sendTransaction", [{ from: SENDER, to: UNLISTED, data: "0x", gas: hex(100_000) }])
}

/** The sender sells `wei` of ETH for USDC on Uniswap, which gives `priced_legs` a row for it. */
function swapEth(wei: bigint) {
  const swap = `0x04e45aaf${word(WETH)}${word(USDC)}${word(500n)}${word(SENDER)}${word(wei)}${word(0n)}${word(0n)}`
  return rpc<string>("eth_sendTransaction", [{ from: SENDER, to: ROUTER, value: hex(wei), data: swap, gas: hex(400_000) }])
}

/**
 * Every transaction in these blocks, as `<block>:<hash>`. A hash alone isn't enough: after a reorg the miner sends the old
 * chain's transactions again, and with the same nonce and data they get the same hash, in a later block.
 */
async function txsIn(from: number, to: number): Promise<Set<string>> {
  const txs = new Set<string>()
  for (let n = from; n <= to; n++) for (const tx of (await rpc<{ transactions: string[] }>("eth_getBlockByNumber", [hex(n), false])).transactions) txs.add(`${n}:${tx.toLowerCase()}`)
  return txs
}

/** `blocks` blocks at once, after anything already sent, with activity in the last one. */
async function mineNow(blocks: number) {
  if (blocks > 1) await rpc("anvil_mine", [hex(blocks - 1)])
  await activity()
  await rpc("anvil_mine", ["0x1"])
}

/** A block every 200 ms like Base, with activity in every 5th, except while a reorg is being set up. */
const miner = { paused: false, idle: Promise.resolve(), stopped: false }
async function runMiner() {
  for (let n = 0; !miner.stopped; n++) {
    if (!miner.paused) {
      let done = () => {}
      miner.idle = new Promise((resolve) => (done = resolve))
      try {
        if (n % 5 === 0) await activity()
        await rpc("anvil_mine", ["0x1"])
      } finally {
        done()
      }
    }
    await sleep(200)
  }
}
async function pauseMiner() {
  miner.paused = true
  await miner.idle
}

const query = createQuery(FLIGHT, undefined, { logger: { warn: (message) => log("query warn", { message }) } })
const count = async (sql: string) => Number((await query<{ n: unknown }>(sql))[0]?.n ?? 0)
const hashOf = (value: unknown) => `0x${String(value).replace(/^0x/, "").toLowerCase()}`
const hashList = (txs: readonly string[]) => txs.map((tx) => `X'${tx.slice(2).toLowerCase()}'`).join(", ") || "X'00'"
/** Every transaction a table has a row for, from `first` on, as `<block>:<hash>`. */
const txsOf = async (table: string, first: number) =>
  new Set((await query<{ block_num: unknown; tx_hash: unknown }>(`SELECT DISTINCT block_num, tx_hash FROM ${table} WHERE block_num >= ${first}`)).map((r) => `${Number(r.block_num)}:${hashOf(r.tx_hash)}`))
const pricedTxs = (first: number) => txsOf(`"${DATASET}".priced_legs`, first)
const hasTx = (rows: Set<string>, tx: string) => [...rows].some((row) => row.endsWith(`:${tx}`))

type Rewind = { table: string; start: number; previousEnd: number; at: number }

/** Each rewind the stream sends for `sql`: a range that starts at or before the last one's end, with another hash. */
function watchRanges(table: string, sql: string, signal: AbortSignal, rewinds: Rewind[]) {
  const stream = createRangeStream(FLIGHT, undefined, NETWORK)
  void (async () => {
    while (!signal.aborted) {
      try {
        const mark = await readHeadMark(query, RAW, null)
        if (!mark) throw new Error("no blocks yet")
        let last = { end: mark.blockNum, hash: mark.hash }
        for await (const range of stream(sql, mark, signal)) {
          if (range.start <= last.end && !(range.end === last.end && range.hash === last.hash)) {
            rewinds.push({ table, start: range.start, previousEnd: last.end, at: Date.now() })
            log("stream rewind", { table, start: range.start, end: range.end, previousEnd: last.end })
          }
          if (range.complete) last = range
        }
      } catch (error) {
        if (!signal.aborted) log("stream error", { table, message: String(error).slice(0, 200) })
        await sleep(1000)
      }
    }
  })()
}

type Watcher = { name: string; updates: (WalletUpdate & { at: number })[] }
function watch(name: string, updates: AsyncGenerator<WalletUpdate>): Watcher {
  const watcher: Watcher = { name, updates: [] }
  void (async () => {
    for await (const update of updates) {
      watcher.updates.push({ ...update, at: Date.now() })
      if (update.reorgFrom !== null) log("wallet reorg", { watcher: name, reorgFrom: update.reorgFrom, toBlock: update.blocks.toBlock, via: update.via })
    }
  })().catch((error) => log("watch error", { watcher: name, message: String(error) }))
  return watcher
}

/** Seconds until `check` holds, or null if it doesn't within the timeout. */
async function until(what: string, since: number, check: () => Promise<boolean>): Promise<number | null> {
  let lastError = ""
  while (Date.now() - since < TIMEOUT_MS) {
    try {
      if (await check()) {
        const seconds = (Date.now() - since) / 1000
        log("reached", { what, seconds })
        return seconds
      }
    } catch (error) {
      const message = String(error).slice(0, 200)
      if (message !== lastError) log("check failed", { what, message })
      lastError = message
    }
    await sleep(250)
  }
  log("timed out", { what })
  return null
}

/** The wallet's newest update has every one of `txs`, none of `gone`, and both balances match the chain at its block. */
async function walletMatches(watcher: Watcher, since: number, txs: readonly string[], gone: readonly string[]): Promise<boolean> {
  const latest = watcher.updates.at(-1)
  if (!latest || latest.at < since) return false
  const legs = latest.legs.filter((l) => !l.opening).map((l) => l.txHash)
  if (gone.some((tx) => legs.includes(tx)) || !txs.every((tx) => legs.includes(tx))) return false
  const at = latest.blocks.toBlock
  const matches = (asset: string, actual: bigint) => {
    const r = latest.positions.find((p) => p.asset === asset)?.reconciliation
    return r === undefined ? actual === 0n : r?.status === "reconciled" && BigInt(r.computedQty) === actual && BigInt(r.actualQty) === actual
  }
  return matches("ETH", await ethBalance(at)) && matches("USDC", await usdcBalance(at))
}

/** What the wallet's newest update says, for the record. */
function describeWallet(watcher: Watcher, gone: readonly string[]) {
  const latest = watcher.updates.at(-1)
  if (!latest) return null
  const recon = (asset: string) => {
    const r = latest.positions.find((p) => p.asset === asset)?.reconciliation
    return r && r.status !== "unchecked" ? `${r.status}: computed ${r.computedQty}, actual ${r.actualQty}` : (r?.status ?? "none")
  }
  return { toBlock: latest.blocks.toBlock, orphanedLegs: latest.legs.filter((l) => gone.includes(l.txHash)).length, unsettledFrom: latest.unsettledFrom, eth: recon("ETH"), usdc: recon("USDC") }
}

/** What Amp serves for the replaced blocks, when it didn't match the new chain: which chain each probe's hash is from. */
async function diagnose(first: number, newHead: number, probes: number[], oldHashes: Map<number, string>, newHashes: Map<number, string>, oldTxs: string[], newTxs: string[]) {
  const attempt = async <T>(read: () => Promise<T>) => read().catch((error) => `failed: ${String(error).slice(0, 160)}`)
  const rows = await attempt(() => query<{ block_num: unknown; hash: unknown }>(`SELECT block_num, hash FROM "${RAW}".blocks WHERE block_num IN (${probes.join(", ")})`))
  const served =
    typeof rows === "string"
      ? rows
      : rows.map((r) => {
          const n = Number(r.block_num)
          const h = hashOf(r.hash)
          return `${n}: ${h === newHashes.get(n) ? "new chain" : h === oldHashes.get(n) ? "OLD chain" : "neither"}`
        })
  const blockRows = await attempt(() => count(`SELECT count(*) AS n FROM "${RAW}".blocks WHERE block_num BETWEEN ${first} AND ${newHead}`))
  const orphanedTxs = await attempt(() => count(`SELECT count(*) AS n FROM "${RAW}".transactions WHERE block_num >= ${first} AND tx_hash IN (${hashList(oldTxs)})`))
  const newTxRows = await attempt(() => count(`SELECT count(*) AS n FROM "${RAW}".transactions WHERE block_num >= ${first} AND tx_hash IN (${hashList(newTxs)})`))
  const legs = await attempt(async () =>
    (await query<{ tx_hash: unknown }>(`SELECT tx_hash FROM "${DATASET}".legs WHERE block_num >= ${first} AND account = X'${WALLET.slice(2)}'`)).map((r) => {
      const tx = hashOf(r.tx_hash)
      return oldTxs.includes(tx) ? "OLD" : newTxs.includes(tx) ? "new" : tx
    }),
  )
  const pricedHead = await attempt(async () => (await query<{ h: unknown }>(`SELECT max(block_num) AS h FROM "${DATASET}".priced_legs`))[0]?.h)
  log("diagnosis", { served, blockRows, expectedBlockRows: newHead - first + 1, orphanedTxs, newTxRows, walletLegs: legs, pricedLegsHead: pricedHead, chainHead: await head() })
}

const stop = new AbortController()
const rewinds: Rewind[] = []
let watchers: Watcher[] = []

async function reorg(depth: number, round: number) {
  const label = `depth ${depth}`
  const ETH = 10n ** 18n
  await pauseMiner()
  const forkPoint = await head()
  const snapshot = await rpc<string>("evm_snapshot")
  const oldTxs = [await sendEth(BigInt(round + 1) * ETH), await sendUsdc(BigInt(round + 1) * 10_000_000n)]
  // A swap of an amount no other block has, so its price row on each chain is told apart.
  const oldSwap = await swapEth(2n * 10n ** 15n + BigInt(round))
  await rpc("anvil_mine", ["0x1"])
  await mineNow(depth - 1)
  miner.paused = false
  const oldSince = Date.now()
  for (const w of watchers) await until(`${label}: ${w.name} shows the old chain`, oldSince, () => walletMatches(w, oldSince, oldTxs, []))
  // The old chain's price row has to be there for its removal to mean anything.
  const oldPriced = await until(`${label}: priced_legs has the old swap`, oldSince, async () => hasTx(await pricedTxs(forkPoint + 1), oldSwap))

  await pauseMiner()
  const oldHead = await head()
  const oldTip = await blockHash(oldHead)
  const first = forkPoint + 1
  const probes = [first, Math.floor((first + oldHead) / 2), oldHead]
  const oldHashes = new Map<number, string>()
  for (const n of probes) oldHashes.set(n, (await blockHash(n)).toLowerCase())
  const oldChainTxs = await txsIn(first, oldHead)
  await rpc("evm_revert", [snapshot])
  // Another transfer in the first replaced block, then a chain one block longer than the old one, so it wins.
  const newTxs = [await sendEth(ETH / BigInt(round + 2)), await sendUsdc(BigInt(round + 1) * 1_000_000n)]
  const newSwap = await swapEth(3n * 10n ** 15n + BigInt(round))
  const since = Date.now()
  await rpc("anvil_mine", ["0x1"])
  await mineNow(oldHead - forkPoint)
  const newHead = await head()
  miner.paused = false
  const replaced = oldHead - forkPoint
  log("reorg", { label, forkPoint, oldHead, newHead, replaced, oldTip, outsideWindow: forkPoint + 1 <= settledThrough(oldHead) })

  const newHashes = new Map<number, string>()
  for (const n of [...probes, newHead]) newHashes.set(n, (await blockHash(n)).toLowerCase())
  // What only the old chain had. A transaction the same on both chains, like a repeated swap, isn't orphaned.
  const newChainTxs = await txsIn(first, newHead)
  const orphaned = [...oldChainTxs].filter((tx) => !newChainTxs.has(tx))
  const isOrphaned = new Set(orphaned)
  log("orphaned", { label, transactions: orphaned.length, oldSwapRow: oldPriced !== null })
  const result: Record<string, number | null> = {}
  await Promise.all([
    until(`${label}: raw tables replaced`, since, async () => {
      const rows = await query<{ block_num: unknown; hash: unknown }>(`SELECT block_num, hash FROM "${RAW}".blocks WHERE block_num IN (${[...newHashes.keys()].join(", ")})`)
      const hashesMatch = [...newHashes].every(([n, h]) => rows.some((r) => Number(r.block_num) === n && hashOf(r.hash) === h))
      const total = await count(`SELECT count(*) AS n FROM "${RAW}".blocks WHERE block_num BETWEEN ${first} AND ${newHead}`)
      if (!hashesMatch || total !== newHead - forkPoint) return false
      const txs = await txsOf(`"${RAW}".transactions`, first)
      return ![...txs].some((tx) => isOrphaned.has(tx))
    }).then((s) => (result.raw = s)),
    // Every row from the replaced blocks gone, from any account, and the new chain's transfers there.
    until(`${label}: legs replaced`, since, async () => {
      const legs = await txsOf(`"${DATASET}".legs`, first)
      return ![...legs].some((tx) => isOrphaned.has(tx)) && newTxs.every((tx) => hasTx(legs, tx))
    }).then((s) => (result.legs = s)),
    // The same for prices, with the new chain's swap priced, and only if the old one's price was there to remove.
    until(`${label}: priced_legs replaced`, since, async () => {
      const priced = await pricedTxs(first)
      return oldPriced !== null && ![...priced].some((tx) => isOrphaned.has(tx)) && hasTx(priced, newSwap)
    }).then((s) => (result.pricedLegs = s)),
    until(`${label}: raw stream rewound`, since, async () => rewinds.some((r) => r.table === "blocks" && r.at >= since && r.start <= first)).then((s) => (result.rawStream = s)),
    until(`${label}: priced_legs stream rewound`, since, async () => rewinds.some((r) => r.table === "priced_legs" && r.at >= since && r.start <= first)).then((s) => (result.pricedStream = s)),
    until(`${label}: stream wallet said reorg`, since, async () => watchers[0]!.updates.some((u) => u.at >= since && u.reorgFrom !== null && u.reorgFrom <= first)).then((s) => (result.walletReorg = s)),
    ...watchers.map((w) => until(`${label}: ${w.name} matches the new chain`, since, () => walletMatches(w, since, newTxs, oldTxs)).then((s) => (result[w.name] = s))),
  ])
  if (result.raw === null || result.legs === null || result.pricedLegs === null) await diagnose(first, newHead, probes, oldHashes, newHashes, oldTxs, newTxs)
  const wallets = Object.fromEntries(watchers.map((w) => [w.name, describeWallet(w, oldTxs)]))
  log("result", { label, replaced, outsideWindow: forkPoint + 1 <= settledThrough(oldHead), seconds: result, wallets })
  return { replaced, result }
}

if (!Number.isSafeInteger(START)) throw new Error("Set START_BLOCK to the datasets' start block")
await rpc("anvil_impersonateAccount", [USDC_SOURCE])
await rpc("anvil_setBalance", [USDC_SOURCE, hex(10n ** 18n)])
await rpc("anvil_setCode", [UNLISTED, UNLISTED_CODE])
void runMiner()
await sleep(20_000)

watchRanges("blocks", `SELECT block_num FROM "${RAW}".blocks WHERE block_num < 0`, stop.signal, rewinds)
watchRanges("priced_legs", followSql(DATASET), stop.signal, rewinds)
const config = { url: FLIGHT, dataset: DATASET, baseDataset: RAW, startBlock: START, logger: { warn: (message: string) => log("sdk warn", { message: message.slice(0, 200) }) } }
watchers = [
  watch("stream wallet", createPricetag(config).watchWallet(WALLET, { signal: stop.signal })),
  // Polling only, which is what a client gets while the stream is down. It only finds a reorg at the head.
  watch("polling wallet", pricetagClient(createQuery(FLIGHT, undefined), { ...config, follow: { pollMs: 1000 } }).watchWallet(WALLET, { signal: stop.signal })),
]
await sleep(10_000)

const summary = []
for (const [round, depth] of (DEPTHS.length > 0 ? DEPTHS : [5, 100, 250, 350, 600]).entries()) {
  const { replaced, result } = await reorg(depth, round)
  summary.push({ depth, replaced, ...result })
  if (result.legs === null || result.pricedLegs === null) {
    log("stopping", { reason: "the dataset didn't recover, so a deeper reorg would say nothing new" })
    break
  }
  await sleep(10_000)
}
log("summary", { summary })
miner.stopped = true
stop.abort()
process.exit(0)
