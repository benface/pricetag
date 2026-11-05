// Buying through Coinbase's hosted page: the session that opens it, and what its order says happened. The key only ever
// lives here, in the server's environment. Clients get a page's address and an order's facts, and neither can sign anything.

import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto"
import { TOKENS, isCurrencyCode, normalizeAddress } from "@pricetag/sdk/core"
import { DEFAULT_RPC_URL } from "@pricetag/sdk/internal"
import type { OnrampOrder } from "../src/core/api.ts"

type Env = Record<string, string | undefined>

const API_HOST = "api.developer.coinbase.com"
const PAGE = "https://pay.coinbase.com/buy/select-asset"
const NETWORK = "base"
const TIMEOUT_MS = 15_000

/** What's on sale here: tokens this app tracks and prices, on the one chain it reads. */
export const ONRAMP_ASSETS = ["ETH", "USDC"]

/** Coinbase said no, or couldn't be reached. Its detail stays in the server's log. */
export class OnrampError extends Error {}

/** Ed25519 keys are base64 of the seed and the public key. Older ones are EC keys in PEM form. */
function signerOf(secret: string): { alg: "EdDSA" | "ES256"; sign: (data: Buffer) => Buffer } {
  if (secret.includes("BEGIN")) {
    const key: KeyObject = createPrivateKey(secret.replaceAll("\\n", "\n"))
    return { alg: "ES256", sign: (data) => sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }) }
  }
  const bytes = Buffer.from(secret, "base64")
  if (bytes.length !== 64) throw new Error("Not a key")
  const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", d: bytes.subarray(0, 32).toString("base64url"), x: bytes.subarray(32).toString("base64url") } })
  return { alg: "EdDSA", sign: (data) => sign(null, data, key) }
}

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A short-lived token for one request. Coinbase's samples say `uri` and its current SDK says `uris`, so this says both. */
export function requestToken(keyId: string, secret: string, method: string, path: string, now = Math.floor(Date.now() / 1000)): string {
  const signer = signerOf(secret)
  const uri = `${method} ${API_HOST}${path}`
  const header = encoded({ alg: signer.alg, typ: "JWT", kid: keyId, nonce: randomBytes(16).toString("hex") })
  const claims = encoded({ sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uri, uris: [uri] })
  return `${header}.${claims}.${signer.sign(Buffer.from(`${header}.${claims}`)).toString("base64url")}`
}

/** A decimal amount in a token's smallest unit, or null when it isn't one, or is finer than the token goes. Never rounded. */
export function unitsOf(value: unknown, decimals: number): string | null {
  const match = typeof value === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(value) : null
  if (!match) return null
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  if (fraction.length > decimals) return null
  return (BigInt(match[1] as string) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString()
}

const recordOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const STATUSES: Record<string, OnrampOrder["status"]> = {
  ONRAMP_TRANSACTION_STATUS_CREATED: "pending",
  ONRAMP_TRANSACTION_STATUS_IN_PROGRESS: "pending",
  ONRAMP_TRANSACTION_STATUS_SUCCESS: "succeeded",
  ONRAMP_TRANSACTION_STATUS_FAILED: "failed",
}

const FAILURES: Record<string, NonNullable<OnrampOrder["failure"]>> = { FAILURE_REASON_BUY_FAILED: "payment", FAILURE_REASON_SEND_FAILED: "delivery" }

/** An order as Coinbase's API sends it, in what this app can use. What's missing or unreadable is null, and never filled in. */
export function orderOf(raw: unknown): OnrampOrder | null {
  const row = recordOf(raw)
  if (typeof row.transaction_id !== "string" || typeof row.status !== "string") return null
  const asset = typeof row.purchase_currency === "string" ? row.purchase_currency : null
  const token = TOKENS.find((t) => t.symbol === asset)
  const total = recordOf(row.payment_total)
  const currency = typeof total.currency === "string" && isCurrencyCode(total.currency) ? total.currency : null
  const paid = currency ? unitsOf(total.value, 6) : null
  const usd = recordOf(row.payment_total_usd)
  const usdMicros = usd.currency === "USD" || usd.currency === undefined ? unitsOf(usd.value, 6) : null
  const txHash = typeof row.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(row.tx_hash) ? row.tx_hash.toLowerCase() : null
  const wallet = typeof row.wallet_address === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.wallet_address) ? normalizeAddress(row.wallet_address) : null
  const status = STATUSES[row.status] ?? "pending"
  return {
    id: row.transaction_id,
    status,
    failure: status === "failed" ? (FAILURES[row.failure_reason as string] ?? "payment") : null,
    asset,
    units: token ? unitsOf(recordOf(row.purchase_amount).value, token.decimals) : null,
    wallet,
    network: typeof row.purchase_network === "string" ? row.purchase_network : null,
    txHash,
    blockNum: null,
    cost: paid !== null && currency ? { micros: paid, currency } : null,
    costUsdMicros: usdMicros,
  }
}

export type Onramp = {
  session(request: { address: string; asset: string; cryptoAmount: string; clientIp: string | null }): Promise<{ url: string; ref: string }>
  orders(ref: string): Promise<OnrampOrder[]>
}

/** Null when there's no key, which clients say plainly. `BASE_RPC_URL` finds the block a delivery landed in. */
export function createOnramp(env: Env, send: typeof fetch = fetch): Onramp | null {
  const keyId = env.COINBASE_ONRAMP_KEY_ID
  const secret = env.COINBASE_ONRAMP_KEY_SECRET
  if (!keyId || !secret) return null
  // A bad key turns off buying, and not the whole server. Its name goes in the log, and never its value.
  try {
    signerOf(secret)
  } catch {
    console.error("COINBASE_ONRAMP_KEY_SECRET isn't a key Coinbase gave out, so buying is off.")
    return null
  }
  const rpcUrl = env.BASE_RPC_URL || DEFAULT_RPC_URL
  const mocked = env.COINBASE_ONRAMP_MOCK === "1"

  async function call(method: "GET" | "POST", path: string, query: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await send(`https://${API_HOST}${path}${query}`, {
        method,
        headers: { authorization: `Bearer ${requestToken(keyId as string, secret as string, method, path)}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      console.error("Coinbase couldn't be reached:", error instanceof Error ? error.message : "unknown error")
      throw new OnrampError("Coinbase can't be reached right now.")
    }
    if (!response.ok) {
      // Its message says what it objected to. The request's token isn't in it.
      console.error(`Coinbase answered ${method} ${path} with ${response.status}:`, (await response.text().catch(() => "")).slice(0, 300))
      throw new OnrampError(`Coinbase said no (${response.status}).`)
    }
    try {
      return await response.json()
    } catch {
      throw new OnrampError("Coinbase sent something this server can't read.")
    }
  }

  /** The block a transaction is in, or null when that can't be read yet. Only an RPC knows this as soon as it lands. */
  async function blockOf(txHash: string): Promise<number | null> {
    try {
      const response = await send(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }), signal: AbortSignal.timeout(TIMEOUT_MS) })
      const { result } = recordOf(await response.json())
      const hex = recordOf(result).blockNumber
      return typeof hex === "string" && /^0x[0-9a-f]+$/i.test(hex) ? Number(hex) : null
    } catch (error) {
      // Not the URL: a dedicated RPC's has a key in it.
      console.error("Couldn't read a delivery's block:", error instanceof Error ? error.message : "unknown error")
      return null
    }
  }

  return {
    async session({ address, asset, cryptoAmount, clientIp }) {
      const answer = recordOf(await call("POST", "/onramp/v1/token", "", { addresses: [{ address, blockchains: [NETWORK] }], assets: ONRAMP_ASSETS, ...(clientIp ? { clientIp } : {}) }))
      if (typeof answer.token !== "string" || answer.token === "") throw new OnrampError("Coinbase sent something this server can't read.")
      // One to a purchase, so an order can't be mistaken for another. It has to stay under 50 characters. The prefix is what asks for Coinbase's mocked mode.
      const ref = `${mocked ? "sandbox-" : ""}${randomBytes(16).toString("hex")}`
      const params = new URLSearchParams({ sessionToken: answer.token, defaultNetwork: NETWORK, defaultAsset: asset, presetCryptoAmount: cryptoAmount, partnerUserRef: ref })
      return { url: `${PAGE}?${params}`, ref }
    },
    async orders(ref) {
      const answer = recordOf(await call("GET", `/onramp/v1/buy/user/${encodeURIComponent(ref)}/transactions`, "?page_size=10"))
      const orders = (Array.isArray(answer.transactions) ? answer.transactions : []).map(orderOf).filter((order) => order !== null)
      return Promise.all(orders.map(async (order) => (order.status === "succeeded" && order.txHash ? { ...order, blockNum: await blockOf(order.txHash) } : order)))
    },
  }
}
