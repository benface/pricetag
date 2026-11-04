// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { isAddress, isCurrencyCode, latestPrices, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import { DEFAULT_RPC_URL, createL1FeeReader, createQuery, createWallets, datasetSource, describeError, type Source } from "@pricetag/sdk/internal"
import type { Head, WalletResponse } from "../src/core/api.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, ruleNote, type PricingRule } from "../src/core/rules.ts"
import { compareRules, explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
import { createRates } from "./rates.ts"
import { createDepositReader } from "./block.ts"
import { createManifestReader, createProofs, proofOf, verificationOf, type BlockRead, type Proofs } from "./proof.ts"
import { feedRounds, rawSource } from "./source.ts"
import { TAX_COUNTRIES, isTaxCountryCode, taxReportOf, type TaxScope } from "../src/core/tax.ts"

type Env = Record<string, string | undefined>

const POLL_MS = 2000
const DEMO_UNVERIFIABLE = "This is the demo wallet, so there's no real block to check."

function parseMethod(value: string | null): Method | null {
  if (value === null || value === "average") return "average"
  return value === "fifo" ? "fifo" : null
}

function parseScope(value: string | null): TaxScope | null {
  return value === "pooled" || value === "per-wallet" ? value : null
}

/** How many other wallets a report can add. Each is a full read. */
const MAX_OTHER_WALLETS = 20

function parseCurrency(value: string | null): CurrencyCode | null {
  if (value === null) return "USD"
  return isCurrencyCode(value) ? value : null
}

/** A pricing rule, and where a wallet's rows come from when it's read through that rule. */
type RuleSource = { rule: PricingRule; source: Source }

const MANIFEST_HASH = /^[0-9a-f]{64}$/

/** A dataset reference pinned to the manifest it's meant to be, so what's shown as the rule's hash is what gets read. */
function pinned(dataset: string, hash: string | undefined): string {
  if (!hash || !MANIFEST_HASH.test(hash)) throw new Error(`PRICETAG_FORK_DATASET needs the manifest hash of ${dataset}`)
  return `${dataset.split("@")[0]}@${hash}`
}

function createSource(env: Env): { source: Source; rules?: RuleSource[]; readRates: ReturnType<typeof createRates>; proofs: Proofs } | null {
  if (!env.AMP_QUERY_URL) return null
  const query = createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined)
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  const readRates = createRates(feedRounds(query, { baseDataset, network }))
  const proofs = createProofs(query, {
    baseDataset,
    dataset: env.PRICETAG_DATASET || null,
    readDeposits: createDepositReader(env.BASE_RPC_URL || DEFAULT_RPC_URL),
    readManifestHash: createManifestReader(env.AMP_ADMIN_URL || `${env.AMP_QUERY_URL}/controller`, env.AMP_QUERY_TOKEN || undefined),
  })
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    if (env.PRICETAG_FORK_DATASET) {
      // The same SQL for both. The header alone says which prices it reads, and the transactions always come from the
      // first, so they can't differ.
      const dataset = pinned(env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH)
      const ruleSource = (id: string, name: string, hash: string | undefined, priceDataset: string): RuleSource => ({
        rule: { id, ...RULE_TEXT[id]!, dataset: name, hash: hash as string },
        source: datasetSource(query.aliased({ pricetag: dataset, pricing: priceDataset }), { baseDataset, dataset: "pricetag", priceDataset: "pricing", startBlock, network }),
      })
      const rules = [
        ruleSource(MARKET_RULE_ID, env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH, dataset),
        ruleSource(CAUTIOUS_RULE_ID, env.PRICETAG_FORK_DATASET, env.PRICETAG_FORK_HASH, pinned(env.PRICETAG_FORK_DATASET, env.PRICETAG_FORK_HASH)),
      ]
      return { source: rules[0]!.source, rules, readRates, proofs }
    }
    return { source: datasetSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock, network }), readRates, proofs }
  }
  const historyBlocks = Number(env.PRICETAG_HISTORY_BLOCKS || 1800)
  if (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return { source: rawSource(query, { baseDataset, network, historyBlocks }), readRates, proofs }
}

/** Each one is a wallet read, so this stays well under what the server keeps in memory. */
const MAX_LINKED_WALLETS = 10

/** The user's other wallets, or null when that isn't what was sent. */
function parseLinked(value: string | null): string[] | null {
  if (value === null || value === "") return []
  const addresses = value.split(",")
  if (addresses.length > MAX_LINKED_WALLETS || !addresses.every(isAddress)) return null
  return [...new Set(addresses.map((address) => address.toLowerCase()))]
}

/** The request's decoded path, or null when the URL is malformed. Clients can send anything here. */
export function pathOf(req: IncomingMessage): string | null {
  try {
    return decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

/** Query errors can quote our SQL or the endpoint. The browser gets a fixed message, and the detail stays in the server log. */
function sendAmpError(res: ServerResponse, error: unknown, message = "Couldn't read this wallet's data.") {
  console.error("Amp query failed:", describeError(error))
  sendJson(res, 502, { error: message })
}

export function createApi(env: Env, created: ReturnType<typeof createSource> = createSource(env)) {
  const source = created?.source ?? null

  let head: Head | null = null
  const subscribers = new Set<ServerResponse>()
  let polling = false

  async function pollHead(): Promise<Head> {
    if (!source) throw new Error("No Amp source")
    const next = await source.head(head?.blockNum ?? null)
    if (next) head = next
    if (!head) throw new Error("No blocks yet")
    return head
  }

  // Only polls while a browser is watching, one query at a time.
  async function pollLoop() {
    if (polling) return
    polling = true
    let last = head?.blockNum ?? null
    while (subscribers.size > 0) {
      const started = Date.now()
      let message: string
      try {
        const current = await pollHead()
        if (current.blockNum === last) message = ""
        else {
          last = current.blockNum
          message = `event: head\ndata: ${JSON.stringify(current)}\n\n`
        }
      } catch (error) {
        console.error("Head poll failed:", describeError(error))
        message = `event: down\ndata: {}\n\n`
      }
      if (message) for (const subscriber of subscribers) subscriber.write(message)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, POLL_MS - (Date.now() - started))))
    }
    polling = false
  }

  const readL1Fees = createL1FeeReader(env.BASE_RPC_URL || DEFAULT_RPC_URL)
  const wallets = source ? createWallets(source, pollHead, readL1Fees) : null
  // Each rule keeps its own, so a rule nobody's looking at costs nothing. The first rule is the same as having none.
  const rules = (created?.rules ?? []).map(({ rule, source }, i) => ({ rule, source, note: i === 0 ? null : ruleNote(rule), wallets: i === 0 ? wallets! : createWallets(source, pollHead, readL1Fees) }))

  /**
   * Reads a wallet, or answers the request with why it can't.
   * `fresh: false` settles for the last read if there is one: a read can take seconds, and a click shouldn't wait on it.
   */
  async function readWallet(address: string, res: ServerResponse, { fresh, rule }: { fresh: boolean; rule: (typeof rules)[number] | null } = { fresh: true, rule: null }): Promise<WalletResponse | null> {
    if (address === "demo" || address === DEMO_ADDRESS) return DEMO_WALLET
    if (!isAddress(address)) {
      sendJson(res, 400, { error: "That isn't a Base address." })
      return null
    }
    if (!wallets) {
      sendJson(res, 503, { error: "No data source is set up, so only the demo wallet is available." })
      return null
    }
    try {
      const from = rule?.wallets ?? wallets
      const wallet = (!fresh && from.peek(address)) || (await from.get(address))
      return rule ? { ...wallet, rule: rule.rule.id, ruleNote: rule.note } : wallet
    } catch (error) {
      sendAmpError(res, error)
      return null
    }
  }

  /** A wallet with the rates to show it in `currency`, or answers the request with why it can't. Never falls back to USD. */
  async function inCurrency(wallet: WalletResponse, currency: CurrencyCode, res: ServerResponse): Promise<WalletResponse | null> {
    if (currency === "USD") return wallet
    try {
      const rates = created && wallet.mode !== "demo" ? await created.readRates(currency, wallet) : demoRates(currency)
      return { ...wallet, currency, rates }
    } catch (error) {
      sendAmpError(res, error)
      return null
    }
  }

  /**
   * One wallet by both rules, from one set of facts at one block: the first rule's rows, balances, fees and exchange rates
   * go on both sides, and only prices come from each. Answers with why not when that can't be established.
   */
  async function compare(address: string, currency: CurrencyCode, method: Method, linked: readonly string[], res: ServerResponse): Promise<void> {
    const [first, second] = rules
    if (!first || !second) {
      sendJson(res, 404, { error: "There's only one pricing rule here, so there's nothing to compare." })
      return
    }
    if (!isAddress(address)) {
      sendJson(res, 400, { error: "That isn't a Base address." })
      return
    }
    const notYet = () => sendJson(res, 409, { error: "The two rules haven't reached the same block yet. Try again in a moment." })
    const own = address.toLowerCase()
    const others = linked.filter((other) => other !== own)
    const read: WalletResponse[] = []
    for (const by of [first, second]) {
      for (const wallet of [own, ...others]) {
        const answer = await readWallet(wallet, res, { fresh: true, rule: by })
        if (!answer) return
        read.push(answer)
      }
    }
    // One can be a block or two ahead, so compare where everything has been.
    const blockNum = Math.min(...read.map((wallet) => wallet.coverage.toBlock))
    if (read.some((wallet) => blockNum < wallet.coverage.fromBlock)) return notYet()
    try {
      const [atA, atB] = [await first.source.readLatestReference(blockNum), await second.source.readLatestReference(blockNum)]
      // A current price at another block, or none, would be a difference that isn't the rule.
      if (!atA || !atB || atA.blockNum !== atB.blockNum) return notYet()
      const pair = async (wallet: string, withBalances: boolean): Promise<[WalletResponse, WalletResponse] | null | undefined> => {
        const facts = await first.wallets.factsAt(wallet, blockNum, { withBalances })
        const a = facts && first.wallets.pricedOn(wallet, facts, latestPrices(atA))
        const b = facts && second.wallets.pricedOn(wallet, facts, latestPrices(atB))
        if (!a || !b) return null
        // A block one side has no price for would look like the rule made a number unavailable.
        const blocksOf = (wallet: WalletResponse) => new Set(wallet.references.map((reference) => reference.blockNum))
        const [pricedA, pricedB] = [blocksOf(a), blocksOf(b)]
        if (a.legs.some((leg) => pricedA.has(leg.blockNum) !== pricedB.has(leg.blockNum))) return null
        // One read of the rates, on both sides. Answers the request itself when it fails, so that's not a "not yet".
        const shown = await inCurrency(a, currency, res)
        if (!shown) return undefined
        return [{ ...shown, rule: first.rule.id, ruleNote: first.note }, { ...b, currency: shown.currency, rates: shown.rates, rule: second.rule.id, ruleNote: second.note }]
      }
      const main = await pair(own, true)
      if (main === undefined) return
      if (main === null) return notYet()
      const linkedA: WalletResponse[] = []
      const linkedB: WalletResponse[] = []
      for (const other of others) {
        const both = await pair(other, false)
        if (both === undefined) return
        if (both === null) return notYet()
        linkedA.push(both[0])
        linkedB.push(both[1])
      }
      sendJson(res, 200, compareRules({ rule: first.rule, wallet: main[0], reference: atA, linked: linkedA }, { rule: second.rule, wallet: main[1], reference: atB, linked: linkedB }, method, blockNum))
    } catch (error) {
      sendAmpError(res, error)
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = pathOf(req)
    if (path === null) {
      sendJson(res, 400, { error: "Bad request" })
      return true
    }
    if (!path.startsWith("/api/")) return false
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" })
      return true
    }

    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
      res.write(": connected\n\n")
      if (!source) return true
      subscribers.add(res)
      req.on("close", () => subscribers.delete(res))
      void pollLoop()
      return true
    }

    if (path === "/api/rules") {
      sendJson(res, 200, { rules: rules.map(({ rule }) => rule) })
      return true
    }

    const params = new URL(req.url ?? "/", "http://localhost").searchParams
    const ruleId = params.get("rule")
    const rule = ruleId === null ? (rules[0] ?? null) : (rules.find((r) => r.rule.id === ruleId) ?? null)
    if (ruleId !== null && !rule) {
      sendJson(res, 400, { error: "That pricing rule isn't available here." })
      return true
    }
    const currency = parseCurrency(params.get("currency"))
    if (!currency) {
      sendJson(res, 400, { error: "That currency isn't supported." })
      return true
    }

    const walletMatch = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (walletMatch) {
      const read = await readWallet(walletMatch[1] as string, res, { fresh: true, rule })
      const wallet = read && (await inCurrency(read, currency, res))
      if (wallet) sendJson(res, 200, wallet)
      return true
    }

    const proofMatch = /^\/api\/portfolio\/([^/]+)\/(proof|verify)$/.exec(path)
    if (proofMatch) {
      const wallet = await readWallet(proofMatch[1] as string, res, { fresh: false, rule: null })
      if (!wallet) return true
      const leg = wallet.legs.find(({ id }) => id === params.get("leg"))
      if (!leg || leg.opening) {
        sendJson(res, 404, { error: "There's no transaction behind that." })
        return true
      }
      const proofs = wallet.mode === "demo" ? null : (created?.proofs ?? null)
      if (proofMatch[2] === "proof") {
        sendJson(res, 200, proofOf(leg, wallet.legs, currency, proofs ? await proofs.datasets() : [], proofs ? null : DEMO_UNVERIFIABLE))
        return true
      }
      if (!proofs) {
        sendJson(res, 400, { error: DEMO_UNVERIFIABLE })
        return true
      }
      let read: BlockRead | null
      try {
        read = await proofs.readBlock(leg.blockNum)
      } catch (error) {
        sendAmpError(res, error, "Couldn't read this block.")
        return true
      }
      if (read) sendJson(res, 200, verificationOf(leg, wallet.legs, read.data, read.deposits))
      else sendJson(res, 404, { error: "Amp doesn't have this block." })
      return true
    }

    const portfolioMatch = /^\/api\/portfolio\/([^/]+)(\/explain|\/compare)?$/.exec(path)
    if (portfolioMatch) {
      const method = parseMethod(params.get("method"))
      if (!method) {
        sendJson(res, 400, { error: "The method is either average or fifo." })
        return true
      }
      if (portfolioMatch[2] === "/compare") {
        const linked = parseLinked(params.get("linked"))
        if (!linked) sendJson(res, 400, { error: "Linked wallets are a comma-separated list of Base addresses." })
        else await compare(portfolioMatch[1] as string, currency, method, linked, res)
        return true
      }
      const target = portfolioMatch[2] ? parseExplainTarget(params) : null
      if (portfolioMatch[2] && !target) {
        sendJson(res, 400, { error: "That isn't a number this can explain." })
        return true
      }
      const linked = parseLinked(params.get("linked"))
      if (!linked) {
        sendJson(res, 400, { error: "Linked wallets are a comma-separated list of Base addresses." })
        return true
      }
      const read = await readWallet(portfolioMatch[1] as string, res, { fresh: !target, rule })
      const wallet = read && (await inCurrency(read, currency, res))
      if (!wallet) return true
      const linkedWallets: WalletResponse[] = []
      for (const address of wallet.mode === "demo" ? [] : linked.filter((address) => address !== wallet.address)) {
        // A cost that can't be read isn't a cost of zero, so this answers with the failure instead of a wrong number.
        const other = await readWallet(address, res, { fresh: !target, rule })
        const converted = other && (await inCurrency(other, currency, res))
        if (!converted) return true
        linkedWallets.push(converted)
      }
      if (!target) {
        sendJson(res, 200, portfolioOf(wallet, method, linkedWallets))
        return true
      }
      const explanation = explainPortfolio(wallet, method, target, linkedWallets)
      if (explanation) sendJson(res, 200, explanation)
      else sendJson(res, 404, { error: "This wallet has nothing like that." })
      return true
    }

    const taxMatch = /^\/api\/tax-report\/([^/]+)$/.exec(path)
    if (taxMatch) {
      const country = params.get("country")
      if (!isTaxCountryCode(country)) {
        sendJson(res, 400, { error: "That country isn't supported." })
        return true
      }
      const rules = TAX_COUNTRIES[country]
      const method = params.has("method") ? parseMethod(params.get("method")) : rules.method
      if (!method) {
        sendJson(res, 400, { error: "The method is either average or fifo." })
        return true
      }
      const scope = params.has("scope") ? parseScope(params.get("scope")) : rules.scope
      if (!scope) {
        sendJson(res, 400, { error: "The calculation is either pooled or per-wallet." })
        return true
      }
      const address = (taxMatch[1] as string).toLowerCase()
      const others = (params.get("also") ?? "").split(",").map((other) => other.trim().toLowerCase()).filter(Boolean)
      if (others.length > MAX_OTHER_WALLETS) {
        sendJson(res, 400, { error: `A report can add up to ${MAX_OTHER_WALLETS} other wallets.` })
        return true
      }
      const bad = others.find((other) => !isAddress(other))
      if (bad !== undefined) {
        sendJson(res, 400, { error: `${bad} isn't a Base address.` })
        return true
      }
      // Whichever way round: demo data must never land in a report on a real wallet.
      if (others.length > 0 && [address, ...others].some((wallet) => wallet === "demo" || wallet === DEMO_ADDRESS)) {
        sendJson(res, 400, { error: "The demo wallet can't be combined with other wallets." })
        return true
      }
      // One at a time, because a read that fails answers the request. A report never quietly leaves a wallet out.
      const wallets: WalletResponse[] = []
      for (const next of new Set([address, ...others])) {
        const read = await readWallet(next, res)
        const wallet = read && (await inCurrency(read, currency, res))
        if (!wallet) return true
        wallets.push(wallet)
      }
      sendJson(res, 200, taxReportOf(wallets, { country, method, scope }))
      return true
    }

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
