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

export type Query = (<T>(sql: string, timeoutMs?: number) => Promise<T[]>) & {
  /**
   * The last block Amp had finished in every table this SQL reads, whatever rows the SQL finds, or null if Amp doesn't say.
   * A plain function can be a `Query` too, for tests and proofs, and it just doesn't have this.
   */
  snapshotEnd?: (sql: string) => Promise<number | null>
}

/** Where the SDK says something went wrong without stopping, like a slow query or a read it will retry. */
export type Logger = { warn(message: string): void }

export type QueryOptions = {
  /** How long one query can take, in ms. It defaults to 60 s. */
  timeoutMs?: number | undefined
  /** It defaults to `console`. */
  logger?: Logger | undefined
  /** How many queries can run at once. It defaults to 1, because a hosted Amp is shared. */
  maxConcurrent?: number | undefined
  /** How long to wait before reading again after a dropped connection, in ms, doubling each time. It defaults to 500 ms. */
  retryPauseMs?: number | undefined
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
const QUERY_ATTEMPTS = 3
const RETRY_PAUSE_MS = 500

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

/** A connection to Amp that was refused or dropped, by its gateway or the network, as opposed to Amp answering with an error or taking too long. */
const isConnectionDrop = (error: unknown) => /upstream connect error|disconnect\/reset before headers|connection refused|ECONNREFUSED|ECONNRESET/i.test(describeError(error))

export function createQuery(url: string, token: string | undefined, { timeoutMs: maxTimeoutMs = DEFAULT_TIMEOUT_MS, logger = console, maxConcurrent = 1, retryPauseMs = RETRY_PAUSE_MS }: QueryOptions = {}): AmpQuery {
  const transportWith = (aliases?: Record<string, string>) => {
    const auth: Interceptor[] = token ? [createAuthInterceptor(token)] : []
    const alias: Interceptor[] = aliases
      ? [
          (next) => (request) => {
            request.header.set("amp-alias", JSON.stringify(aliases))
            return next(request)
          },
        ]
      : []
    return createGrpcTransport({ baseUrl: url, interceptors: [...auth, ...alias] })
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

  const run = async <T>(client: ReturnType<typeof createClient>, sql: string, timeoutMs: number): Promise<T[]> => {
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

  /** Waits its turn, and logged if it's slow. */
  const inTurn = async <R>(sql: string, read: () => Promise<R>, count: (result: R) => number) => {
    await startTurn()
    try {
      const started = Date.now()
      const value = await read()
      const took = Date.now() - started
      if (took > 5000) logger.warn(`Slow Amp query: ${took} ms, ${count(value)} rows: ${sql.replace(/\s+/g, " ").slice(0, 100)}…`)
      return value
    } finally {
      endTurn()
    }
  }

  /**
   * Staging's gateway drops the odd connection, and a wallet shouldn't fail because of one. These are all reads, and each attempt
   * starts over and asks Amp again, so what comes back is as new as any other read. A pause gives up its turn.
   */
  const queued = async <R>(sql: string, read: () => Promise<R>, count: (result: R) => number) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await inTurn(sql, read, count)
      } catch (error) {
        if (attempt === QUERY_ATTEMPTS || !isConnectionDrop(error)) throw error
        logger.warn(`Reading from Amp again after a dropped connection: ${describeError(error)}`)
        await new Promise((resolve) => setTimeout(resolve, retryPauseMs * 2 ** (attempt - 1)))
      }
    }
  }

  const queryWith = (transport: ReturnType<typeof transportWith>): Query => {
    const client = createClient(transport)
    const { client: flight } = ArrowFlight.make(transport)
    // A caller's limit is the most any query gets, including ones that normally ask for less.
    const query: Query = <T>(sql: string, timeoutMs = maxTimeoutMs) => queued(sql, () => run<T>(client, sql, Math.min(timeoutMs, maxTimeoutMs)), (rows) => rows.length)
    const snapshotEnd = (sql: string) =>
      queued(
        sql,
        async () => {
          const signal = AbortSignal.timeout(maxTimeoutMs)
          try {
            const ticket = (await flight.getFlightInfo(statement(sql), { signal })).endpoint[0]?.ticket
            if (!ticket) throw new Error("Amp didn't answer the query with a ticket")
            let end: number | null = null
            for await (const message of flight.doGet(ticket, { signal })) end = parseSnapshotEnd(message.appMetadata) ?? end
            return end
          } catch (error) {
            throw new Error(describeError(error), { cause: error })
          }
        },
        () => 0,
      )
    return Object.assign(query, { snapshotEnd })
  }
  return Object.assign(queryWith(transportWith()), { aliased: (aliases: Record<string, string>) => queryWith(transportWith(aliases)) })
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

/** What a one-shot query's message says is the last block of the snapshot it read, or null for one that says nothing. */
export function parseSnapshotEnd(metadata: Uint8Array): number | null {
  if (metadata.length === 0) return null
  const { ranges } = JSON.parse(new TextDecoder().decode(metadata)) as { ranges: { numbers: { end: number } }[] }
  return ranges.length === 0 ? null : Math.min(...ranges.map((r) => r.numbers.end))
}

const statement = (sql: string) => {
  const command = anyPack(FlightSql.CommandStatementQuerySchema, create(FlightSql.CommandStatementQuerySchema, { query: sql }))
  return create(Flight.FlightDescriptorSchema, { type: Flight.FlightDescriptor_DescriptorType.CMD, cmd: toBinary(AnySchema, command) })
}

/** Asks Amp to follow a query from just after `resume`, and gives what comes back with the schema Amp said it has. */
function createFollow(url: string, token: string | undefined, network: string) {
  const { client } = ArrowFlight.make(createGrpcTransport({ baseUrl: url, interceptors: token ? [createAuthInterceptor(token)] : [] }))
  return async (sql: string, resume: BlockMark, signal: AbortSignal) => {
    const headers = { "amp-stream": "true", "amp-resume": JSON.stringify({ [network]: { number: resume.blockNum, hash: resume.hash } }) }
    const info = await client.getFlightInfo(statement(sql), { signal, headers })
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
