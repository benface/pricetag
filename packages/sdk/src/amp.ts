// The only file that talks to Amp, and the only place the token is used. `core.ts` must never reach this, so it stays out of browsers.

import { create, toBinary } from "@bufbuild/protobuf"
import { AnySchema, anyPack } from "@bufbuild/protobuf/wkt"
import { Arrow, ArrowFlight, createAuthInterceptor, createClient } from "@edgeandnode/amp"
import * as Flight from "@edgeandnode/amp/proto/Flight_pb"
import * as FlightSql from "@edgeandnode/amp/proto/FlightSql_pb"
import type { Interceptor } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"
import { Table, tableFromIPC } from "apache-arrow"
import * as Schema from "effect/Schema"

export type Query = <T>(sql: string, timeoutMs?: number) => Promise<T[]>

/** Where the SDK says something went wrong without stopping, like a slow query or a read it will retry. */
export type Logger = { warn(message: string): void }

export type QueryOptions = {
  /** How long one query can take, in ms. It defaults to 60 s. */
  timeoutMs?: number | undefined
  /** It defaults to `console`. */
  logger?: Logger | undefined
  /** How many queries can run at once. It defaults to 1, because a hosted Amp is shared. */
  maxConcurrent?: number | undefined
}

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

export function createQuery(url: string, token: string | undefined, { timeoutMs: maxTimeoutMs = DEFAULT_TIMEOUT_MS, logger = console, maxConcurrent = 1 }: QueryOptions = {}): AmpQuery {
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
  // Staging is shared, so only this many queries run at once, whatever they read through. The rest wait in order.
  let running = 0
  const waiting: (() => void)[] = []
  const startTurn = () =>
    new Promise<void>((start) => {
      if (running < maxConcurrent) {
        running += 1
        start()
      } else waiting.push(start)
    })
  const endTurn = () => {
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }

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
      throw new Error(describeError(error), { cause: error })
    } finally {
      clearTimeout(timer)
    }
  }

  // A caller's limit is the most any query gets, including ones that normally ask for less.
  const queryWith = (client: ReturnType<typeof clientWith>): Query => async <T>(sql: string, timeoutMs = maxTimeoutMs) => {
    await startTurn()
    try {
      const started = Date.now()
      const rows = await run<T>(client, sql, Math.min(timeoutMs, maxTimeoutMs))
      const took = Date.now() - started
      if (took > 5000) logger.warn(`Slow Amp query: ${took} ms, ${rows.length} rows: ${sql.replace(/\s+/g, " ").slice(0, 100)}…`)
      return rows
    } finally {
      endTurn()
    }
  }
  return Object.assign(queryWith(clientWith()), { aliased: (aliases: Record<string, string>) => queryWith(clientWith(aliases)) })
}

/** A block and its hash, which is what a stream resumes from. */
export type BlockMark = { blockNum: number; hash: string }

/** The blocks one message of a stream covers. `complete` means every row in them has been sent. */
export type StreamRange = { start: number; end: number; hash: string; complete: boolean }

/** A query followed as new blocks arrive, from just after `resume`. It says what each message covers, and leaves the rows. */
export type StreamRanges = (sql: string, resume: BlockMark, signal: AbortSignal) => AsyncIterable<StreamRange>

/** What a stream message says it covers, or null for one that says nothing, like a keepalive or the schema. */
export function parseStreamRange(metadata: Uint8Array, network: string): StreamRange | null {
  if (metadata.length === 0) return null
  const { ranges, ranges_complete: complete } = JSON.parse(new TextDecoder().decode(metadata)) as {
    ranges: { network: string; numbers: { start: number; end: number }; hash: string }[]
    ranges_complete: boolean
  }
  const range = ranges.find((r) => r.network === network)
  if (!range) throw new Error(`The stream reports ${ranges.map((r) => r.network).join(", ") || "no network"}, not ${network}`)
  return { start: range.numbers.start, end: range.numbers.end, hash: range.hash, complete }
}

/** Asks Amp to follow a query from just after `resume`, and gives what comes back with the schema Amp said it has. */
function createFollow(url: string, token: string | undefined, network: string) {
  const { client } = ArrowFlight.make(createGrpcTransport({ baseUrl: url, interceptors: token ? [createAuthInterceptor(token)] : [] }))
  return async (sql: string, resume: BlockMark, signal: AbortSignal) => {
    const command = anyPack(FlightSql.CommandStatementQuerySchema, create(FlightSql.CommandStatementQuerySchema, { query: sql }))
    const descriptor = create(Flight.FlightDescriptorSchema, { type: Flight.FlightDescriptor_DescriptorType.CMD, cmd: toBinary(AnySchema, command) })
    const headers = { "amp-stream": "true", "amp-resume": JSON.stringify({ [network]: { number: resume.blockNum, hash: resume.hash } }) }
    const info = await client.getFlightInfo(descriptor, { signal, headers })
    const ticket = info.endpoint[0]?.ticket
    if (!ticket) throw new Error("Amp didn't answer the stream with a ticket")
    return { schema: info.schema, messages: client.doGet(ticket, { signal }) }
  }
}

/**
 * Amp's own `client.stream` can't be used here, for two reasons found by running it. It drops each batch's block ranges, and
 * they're the only way to see a reorg. And it fails on the empty keepalive Amp sends every 30 s, because it reads that
 * as Arrow data. So this reads Flight directly, and only the metadata: rows come from a bounded query, or `createRowStream`.
 *
 * `network` is the name Amp's block ranges use, like `base-mainnet`.
 */
export function createRangeStream(url: string, token: string | undefined, network: string): StreamRanges {
  const follow = createFollow(url, token, network)
  return async function* (sql, resume, signal) {
    for await (const message of (await follow(sql, resume, signal)).messages) {
      const range = parseStreamRange(message.appMetadata, network)
      if (range) yield range
    }
  }
}

/** A stream message: the blocks it covers, and the rows it brought, in the shape a bounded query gives them. */
export type StreamBatch = StreamRange & { rows: Record<string, unknown>[] }

/** A query followed as new blocks arrive, rows included, from just after `resume`. */
export type StreamRows = (sql: string, resume: BlockMark, signal: AbortSignal) => AsyncIterable<StreamBatch>

/** One Flight message as Arrow's IPC format. The body has to start on a multiple of 8 bytes. */
function ipcOf(header: Uint8Array, body: Uint8Array): Uint8Array {
  const padding = (8 - ((8 + header.length) % 8)) % 8
  const bytes = new Uint8Array(8 + header.length + padding + body.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xffffffff, true)
  view.setUint32(4, header.length, true)
  bytes.set(header, 8)
  bytes.set(body, 8 + header.length + padding)
  return bytes
}

/** `createRangeStream` with the rows. Each message is decoded alone, so a keepalive has nothing to trip over. */
export function createRowStream(url: string, token: string | undefined, network: string): StreamRows {
  const follow = createFollow(url, token, network)
  return async function* (sql, resume, signal) {
    const { schema: schemaIpc, messages } = await follow(sql, resume, signal)
    const { schema } = tableFromIPC(schemaIpc)
    // What `client.query` does with a batch, so a row is the same either way.
    const encode = Schema.encodeSync(Schema.Array(Arrow.generateSchema(schema)))
    for await (const message of messages) {
      const range = parseStreamRange(message.appMetadata, network)
      if (!range) continue
      if (message.dataBody.length === 0) {
        yield { ...range, rows: [] }
        continue
      }
      const table = new Table(tableFromIPC(concat(schemaIpc, ipcOf(message.dataHeader, message.dataBody))).batches)
      yield { ...range, rows: [...encode([...table] as never)] as Record<string, unknown>[] }
    }
  }
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(first.length + second.length)
  bytes.set(first)
  bytes.set(second, first.length)
  return bytes
}
