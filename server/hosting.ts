// What changes when this server is shared instead of running on one Mac: who may use it, how much, a health check for the host,
// and logs that can't hold a secret or an address. Local runs leave all of it off, so `pnpm mac` works as it always has.

import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { BlockList, isIP } from "node:net"
import { format } from "node:util"
import { pathOf } from "./app.ts"

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

/** A client can send these itself, and a proxy adds to them instead of replacing them, so they say nothing about who's asking. */
const FORWARDED_HEADERS = new Set(["x-forwarded-for", "forwarded", "x-real-ip", "x-client-ip", "true-client-ip"])

export function hostingOf(env: Env): Hosting {
  const hosted = env.PRICETAG_HOSTED === "1"
  const invites = parseInvites(env.PRICETAG_INVITES)
  if (hosted && invites.size === 0) throw new Error("A hosted server needs PRICETAG_INVITES, or anyone could use its Amp token and Coinbase key.")
  const header = env.PRICETAG_CLIENT_IP_HEADER?.trim().toLowerCase() || null
  if (header && FORWARDED_HEADERS.has(header)) throw new Error(`PRICETAG_CLIENT_IP_HEADER can't be ${header}, because a client can write its own. Use the one the host overwrites, like fly-client-ip.`)
  return {
    hosted,
    // A host's proxy reaches the server from outside the machine. A local one stays on it.
    host: env.HOST || (hosted ? "0.0.0.0" : "127.0.0.1"),
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
    drainMs: positive(env, "PRICETAG_DRAIN_MS", 10_000),
  }
}

export const hashOf = (invite: string) => createHash("sha256").update(invite, "utf8").digest("hex")

/** Who sent this, by their invite, or null when it has none that's on the list. Only the hash is compared, so the list holds no invite. */
export function inviteOf(req: IncomingMessage, invites: ReadonlyMap<string, string>): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? "")
  return match ? (invites.get(hashOf(match[1] as string)) ?? null) : null
}

/** This machine, a local network, or a host's own proxy, none of which say anything a provider could use. */
const NOT_PUBLIC = new BlockList()
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) NOT_PUBLIC.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]] as const) NOT_PUBLIC.addSubnet(network, prefix, "ipv6")

/**
 * The client's address, for Coinbase to check where a purchase is made from: the socket's, or the header the host overwrites.
 * Null when it's not a public address or isn't one at all. A list is too: it means something else added to the header, and its
 * first entry is whatever the client wrote.
 */
export function clientIpOf(req: IncomingMessage, header: string | null): string | null {
  const value = header ? req.headers[header] : req.socket.remoteAddress
  const ip = typeof value === "string" ? value.trim().replace(/^::ffff:(?=\d+\.)/i, "") : ""
  const family = isIP(ip)
  return family !== 0 && !NOT_PUBLIC.check(ip, family === 4 ? "ipv4" : "ipv6") ? ip : null
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

function refuse(res: ServerResponse, status: number, error: string, retryAfter?: number) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) })
  res.end(JSON.stringify({ error }))
}

const SLOW_DOWN = "Too many requests from this invite. Try again in a minute."

type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/**
 * The API behind its gate. `/healthz` answers anyone, with nothing private, and turns away the host's checks once a shutdown
 * starts. Everything else under `/api/` needs an invite when there's a list of them, and stays within its limits.
 */
export function gate(handle: Handle, hosting: Hosting, health: () => Record<string, boolean>, now: () => number = Date.now) {
  const minutes = createCounter(60_000, now)
  const hours = createCounter(3_600_000, now)
  const days = createCounter(86_400_000, now)
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
    if (path === "/api/onramp/checkout" && req.method === "POST") {
      const hourly = hours.take(who, hosting.limits.checkoutsPerHour)
      if (hourly !== null) {
        refuse(res, 429, "That's a lot of purchases for one hour. Try again later.", hourly)
        return true
      }
      const daily = days.take("everyone", hosting.limits.checkoutsPerDay)
      if (daily !== null) {
        console.error("The day's Coinbase checkouts are used up.")
        refuse(res, 429, "Buying is paused for today. Try again tomorrow.", daily)
        return true
      }
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
    return handle(req, res)
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
