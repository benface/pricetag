// The only file that talks to Amp, and the only place the token is used. `core.ts` must never reach this, so it stays out of browsers.

import { createAuthInterceptor, createClient } from "@edgeandnode/amp"
import type { Interceptor } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"

export type Query = <T>(sql: string, timeoutMs?: number) => Promise<T[]>

/** A query that can also read through dataset aliases. */
export type AmpQuery = Query & {
  /**
   * The same query, sending Amp's `amp-alias` header, which binds names in the SQL to datasets for that one request. So
   * the SQL can stay the same, and the header alone picks what it reads. A local Amp may be too old to read the header.
   */
  aliased(aliases: Record<string, string>): Query
}

const DEFAULT_TIMEOUT_MS = 60_000

/** Amp's client returns Decimal128 values as Arrow big numbers, not strings. */
export const decimalString = (value: unknown): string | null => (value == null ? null : String(value).replaceAll('"', ""))

export const hexOf = (address: string) => address.replace(/^0x/, "").toLowerCase()
export const asNumber = (value: unknown) => Number(value)
export const asIso = (value: unknown) => new Date(Number(value)).toISOString()
export const prefixed = (hex: string) => `0x${hex}`

/** Amp's client wraps errors a few levels deep, and the outer ones have no message. Nothing here contains the token. */
export function describeError(error: unknown): string {
  for (let e = error as { cause?: unknown; rawMessage?: unknown; message?: unknown } | null | undefined; e; e = e.cause as typeof e) {
    if (typeof e.rawMessage === "string" && e.rawMessage) return e.rawMessage
    if (e.cause === undefined && typeof e.message === "string" && e.message) return e.message
  }
  return String(error)
}

/** What Amp answers when a table's job hasn't written anything yet. It isn't an outage: that table just has no blocks. */
export const isNotStarted = (error: unknown) => describeError(error).includes("no common canonical watermark")

export function createQuery(url: string, token: string | undefined): AmpQuery {
  const clientWith = (aliases?: Record<string, string>) => {
    const auth: Interceptor[] = token ? [createAuthInterceptor(token)] : []
    const alias: Interceptor[] = aliases
      ? [
          (next) => (request) => {
            request.header.set("amp-alias", JSON.stringify(aliases))
            return next(request)
          },
        ]
      : []
    return createClient(createGrpcTransport({ baseUrl: url, interceptors: [...auth, ...alias] }))
  }
  // Staging is shared, so run one query at a time, whatever it reads through.
  let queue: Promise<unknown> = Promise.resolve()

  const run = async <T>(client: ReturnType<typeof clientWith>, sql: string, timeoutMs: number): Promise<T[]> => {
    const iterator = client.query(sql)[Symbol.asyncIterator]()
    const rows: T[] = []
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs} ms`)), timeoutMs)
    })
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), timeout])
        if (next.done) return rows
        rows.push(...(next.value as readonly T[]))
      }
    } catch (error) {
      // Stop the stream, without waiting on a server that may not answer.
      void iterator.return?.().catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  const queryWith = (client: ReturnType<typeof clientWith>): Query => <T>(sql: string, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const result = queue.then(async () => {
      const started = Date.now()
      const rows = await run<T>(client, sql, timeoutMs)
      const took = Date.now() - started
      if (took > 5000) console.warn(`Slow Amp query: ${took} ms, ${rows.length} rows: ${sql.replace(/\s+/g, " ").slice(0, 100)}…`)
      return rows
    })
    queue = result.catch(() => {})
    return result
  }
  return Object.assign(queryWith(clientWith()), { aliased: (aliases: Record<string, string>) => queryWith(clientWith(aliases)) })
}
