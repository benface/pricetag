// The only file that talks to Amp, and the only place the token is used. Nothing under src/ may import this.

import { createAuthInterceptor, createClient } from "@edgeandnode/amp"
import { createGrpcTransport } from "@connectrpc/connect-node"

export type Query = <T>(sql: string, timeoutMs?: number) => Promise<T[]>

const DEFAULT_TIMEOUT_MS = 60_000

/** Amp's client returns Decimal128 values as Arrow big numbers, not strings. */
export const decimalString = (value: unknown): string | null => (value == null ? null : String(value).replaceAll('"', ""))

export function createQuery(url: string, token: string | undefined): Query {
  const client = createClient(createGrpcTransport({ baseUrl: url, interceptors: token ? [createAuthInterceptor(token)] : [] }))
  // Staging is shared, so run one query at a time.
  let queue: Promise<unknown> = Promise.resolve()

  const run = async <T>(sql: string, timeoutMs: number): Promise<T[]> => {
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

  return <T>(sql: string, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const result = queue.then(async () => {
      const started = Date.now()
      const rows = await run<T>(sql, timeoutMs)
      const took = Date.now() - started
      if (took > 5000) console.log(`Slow Amp query: ${took} ms, ${rows.length} rows: ${sql.replace(/\s+/g, " ").slice(0, 100)}…`)
      return rows
    })
    queue = result.catch(() => {})
    return result
  }
}
