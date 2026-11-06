// What changes when this server is shared instead of running on one Mac: who may use it, how much, a health check for the host,
// and logs that can't hold a secret or an address. Local runs leave all of it off, so `pnpm mac` works as it always has.

import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { format } from "node:util"
import { pathOf } from "./app.ts"
import { inLane } from "./lanes.ts"

type Env = Record<string, string | undefined>

export type Hosting = {
  /** `PRICETAG_HOSTED=1`: invites, limits and redacted logs, all at once, so a deploy can't forget one. */
  hosted: boolean
  host: string
  port: number
  /** An invite's SHA-256, in hex, and who it's for. Empty means anyone who can reach the server may use it, which only a local one allows. */
  invites: ReadonlyMap<string, string>
  /** The header the host sets to the client's address, overwriting what the client sent. Null reads the socket's. */
  clientIpHeader: string | null
  /** Whether it also serves the web app. A hosted one doesn't by default: see "Hosting" in the README. */
  servesApp: boolean
  limits: Limits
  /** How many people's Amp queries run at once. Each person's own run one at a time, and the head's don't count. */
  ampLanes: number
  /** How long a shutdown waits for requests to finish before closing what's left. */
  drainMs: number
}

export type Limits = {
  /** Requests a minute, for each invite. */
  perMinute: number
  /** Live streams open at once, for each invite. Each one is a Mac or a window. */
  streams: number
  /** Coinbase checkouts an hour, for each invite. */
  checkoutsPerHour: number
  /** Coinbase checkouts a day, for everyone together, so one invite can't use up the account. */
  checkoutsPerDay: number
}

const DEFAULT_LIMITS: Limits = { perMinute: 120, streams: 4, checkoutsPerHour: 10, checkoutsPerDay: 100 }

/** A short read takes 7 queries and about 2 s, so with fewer than this a few people watching at once fall behind the chain. */
const DEFAULT_AMP_LANES = 3

const INVITE = /^([a-z0-9][a-z0-9_-]{0,31}):([0-9a-f]{64})$/

/** `name:sha256` pairs, comma-separated. A bad entry stops the server, because a typo would lock someone out without a word. */
export function parseInvites(value: string | undefined): Map<string, string> {
  const invites = new Map<string, string>()
  for (const entry of (value ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = INVITE.exec(entry)
    if (!match) throw new Error("PRICETAG_INVITES is a comma-separated list of name:sha256 pairs. Make them with `pnpm invite <name>`.")
    invites.set(match[2] as string, match[1] as string)
  }
  return invites
}

function positive(env: Env, name: string, fallback: number): number {
  const value = env[name]
  if (value === undefined || value === "") return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive whole number`)
  return number
}

/** Whether only this machine can reach an address. */
const staysOnThisMachine = (host: string) => host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)

export function hostingOf(env: Env): Hosting {
  const hosted = env.PRICETAG_HOSTED === "1"
  const invites = parseInvites(env.PRICETAG_INVITES)
  if (hosted && invites.size === 0) throw new Error("A hosted server needs PRICETAG_INVITES, or anyone could use its Amp token and Coinbase key.")
  // A host's proxy reaches the server from outside the machine. A local one stays on it.
  const host = env.HOST || (hosted ? "0.0.0.0" : "127.0.0.1")
  if (invites.size === 0 && !staysOnThisMachine(host)) throw new Error(`HOST=${host} needs PRICETAG_INVITES, or anyone who can reach it could use its Amp token and Coinbase key.`)
  const header = env.PRICETAG_CLIENT_IP_HEADER?.trim().toLowerCase() || null
  if (hosted && !header) throw new Error("A hosted server needs PRICETAG_CLIENT_IP_HEADER, like fly-client-ip, or Coinbase would be told the host's proxy's address instead of the buyer's.")
  return {
    hosted,
    host,
    port: positive(env, "PORT", 8787),
    invites,
    clientIpHeader: header,
    servesApp: env.PRICETAG_SERVE_APP ? env.PRICETAG_SERVE_APP === "1" : !hosted,
    limits: {
      perMinute: positive(env, "PRICETAG_LIMIT_PER_MINUTE", DEFAULT_LIMITS.perMinute),
      streams: positive(env, "PRICETAG_LIMIT_STREAMS", DEFAULT_LIMITS.streams),
      checkoutsPerHour: positive(env, "PRICETAG_LIMIT_CHECKOUTS_PER_HOUR", DEFAULT_LIMITS.checkoutsPerHour),
      checkoutsPerDay: positive(env, "PRICETAG_LIMIT_CHECKOUTS_PER_DAY", DEFAULT_LIMITS.checkoutsPerDay),
    },
    ampLanes: positive(env, "PRICETAG_AMP_LANES", DEFAULT_AMP_LANES),
    drainMs: positive(env, "PRICETAG_DRAIN_MS", 10_000),
  }
}

export const hashOf = (invite: string) => createHash("sha256").update(invite, "utf8").digest("hex")

/** Who sent this, by their invite, or null when it has none that's on the list. Only the hash is compared, so the list holds no invite. */
export function inviteOf(req: IncomingMessage, invites: ReadonlyMap<string, string>): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? "")
  return match ? (invites.get(hashOf(match[1] as string)) ?? null) : null
}

/** What a client on this machine's address is, which says nothing a provider could use. */
const isLocal = (ip: string) => ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.")

/** The client's address, for Coinbase to check where a purchase is made from. Null when it's this machine or isn't known. */
export function clientIpOf(req: IncomingMessage, header: string | null): string | null {
  const value = header ? req.headers[header] : req.socket.remoteAddress
  const ip = (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim()
  return ip && !isLocal(ip) ? ip : null
}

/** Counts in fixed windows. Keys are invite names, and the total, so there are only ever a few of them. */
export function createCounter(windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    /** Counts one, or answers how many seconds until there's room, when `limit` is already used. */
    take(key: string, limit: number): number | null {
      const at = now()
      const current = windows.get(key)
      const window = current && at - current.start < windowMs ? current : { start: at, count: 0 }
      if (window.count >= limit) return Math.max(1, Math.ceil((window.start + windowMs - at) / 1000))
      window.count++
      windows.set(key, window)
      return null
    },
  }
}

export function refuse(res: ServerResponse, status: number, error: string, retryAfter?: number) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) })
  res.end(JSON.stringify({ error }))
}

const SLOW_DOWN = "Too many requests from this invite. Try again in a minute."

type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/** Why a Coinbase checkout has to wait, and for how many seconds. */
export type CheckoutRefusal = { error: string; retryAfter: number }

/**
 * Counts a checkout that's about to reach Coinbase, or says why it can't. The API asks once a request is valid, so a bad one
 * costs nobody their purchases.
 */
export function checkoutLimit(hosting: Hosting, now: () => number = Date.now) {
  const hours = createCounter(3_600_000, now)
  const days = createCounter(86_400_000, now)
  return (req: IncomingMessage): CheckoutRefusal | null => {
    const who = inviteOf(req, hosting.invites)
    if (!who) return null
    const hourly = hours.take(who, hosting.limits.checkoutsPerHour)
    if (hourly !== null) return { error: "That's a lot of purchases for one hour. Try again later.", retryAfter: hourly }
    const daily = days.take("everyone", hosting.limits.checkoutsPerDay)
    if (daily === null) return null
    console.error("The day's Coinbase checkouts are used up.")
    return { error: "Buying is paused for today. Try again tomorrow.", retryAfter: daily }
  }
}

/**
 * The API behind its gate. `/healthz` answers anyone, with nothing private, and turns away the host's checks once a shutdown
 * starts. Everything else under `/api/` needs an invite when there's a list of them, and stays within its limits.
 */
export function gate(handle: Handle, hosting: Hosting, health: () => Record<string, boolean>, now: () => number = Date.now) {
  const minutes = createCounter(60_000, now)
  const streams = new Map<string, Set<ServerResponse>>()
  let draining = false

  const handler: Handle = async (req, res) => {
    const path = pathOf(req)
    if (path === "/healthz") {
      if (draining) refuse(res, 503, "Shutting down.")
      else {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        res.end(JSON.stringify({ ok: true, ...health() }))
      }
      return true
    }
    if (path === null || !path.startsWith("/api/") || hosting.invites.size === 0) return handle(req, res)

    const who = inviteOf(req, hosting.invites)
    if (!who) {
      refuse(res, 401, "This server needs an invite.")
      return true
    }
    const wait = minutes.take(who, hosting.limits.perMinute)
    if (wait !== null) {
      refuse(res, 429, SLOW_DOWN, wait)
      return true
    }
    if (path === "/api/events" && req.method === "GET") {
      if (draining) {
        refuse(res, 503, "Shutting down.")
        return true
      }
      const open = streams.get(who) ?? new Set<ServerResponse>()
      if (open.size >= hosting.limits.streams) {
        refuse(res, 429, "Too many windows are open with this invite.", 60)
        return true
      }
      open.add(res)
      streams.set(who, open)
      res.on("close", () => {
        open.delete(res)
        if (open.size === 0) streams.delete(who)
      })
    }
    return inLane(who, () => handle(req, res))
  }

  return Object.assign(handler, {
    /** Stops taking streams and ends the open ones. Clients reconnect, to another instance or to this one once it's back. */
    drain() {
      draining = true
      for (const open of streams.values()) for (const res of open) res.end()
    },
  })
}

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g
const HASH = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g
/** How the SQL spells bytes: an address, a padded topic, a hash or calldata with an address in it, all as `X'…'`. */
const SQL_BYTES = /\b[xX]'[0-9a-fA-F]*'/g
/** What's left: any long run of hex, with or without `0x`, like an address searched for in calldata. */
const LONG_HEX = /(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{40,}(?![0-9a-zA-Z])/g
const URL_TEXT = /\bhttps?:\/\/[^\s"'<>)]+/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

/**
 * A line without what could say whose it is or unlock anything: addresses and transaction hashes, however they're spelled,
 * which point at a wallet, URLs, which can carry a key, bearer tokens, and the exact values of the secrets this server was given.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) if (secret.length >= 8) out = out.replaceAll(secret, "[secret]")
  return out.replace(BEARER, "Bearer [secret]").replace(URL_TEXT, "[url]").replace(SQL_BYTES, "X'[hex]'").replace(HASH, "[hash]").replace(ADDRESS, "[address]").replace(LONG_HEX, "[hex]")
}

/** The env's secrets, by name, so a new one only has to be added here. */
const SECRET_NAMES = ["AMP_QUERY_TOKEN", "COINBASE_ONRAMP_KEY_ID", "COINBASE_ONRAMP_KEY_SECRET", "BASE_RPC_URL", "AMP_QUERY_URL", "AMP_ADMIN_URL"]

/**
 * Every line the process writes, as one JSON object, redacted. It replaces `console` itself, so the SDK's lines go through it too,
 * and nothing has to remember to. Only for a hosted server: a local one's log stays readable, on the Mac it's about.
 */
export function useStructuredLogs(env: Env, write: (line: string) => void = (line) => process.stderr.write(line)) {
  const secrets = SECRET_NAMES.map((name) => env[name] ?? "").filter(Boolean)
  const emit = (level: string) => (...args: unknown[]) => write(`${JSON.stringify({ time: new Date().toISOString(), level, message: redact(format(...args.map((arg) => (arg instanceof Error ? arg.message : arg))), secrets) })}\n`)
  console.log = emit("info")
  console.info = emit("info")
  console.warn = emit("warn")
  console.error = emit("error")
  console.debug = () => {}
}
