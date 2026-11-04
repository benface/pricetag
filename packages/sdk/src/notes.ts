// A note is a cost someone published themselves: a zero-value transaction from a wallet to itself, with this in its data.
// Only a wallet's own note counts, because the transaction's sender is the author, and nobody else can set your cost.

export type CostNote = { noteTx: string; blockNum: number; txHash: string; asset: string; usdMicros: string }

const NOTE = /^patina:cost:1:(0x[0-9a-f]{64}):([A-Za-z0-9]{1,16}):(\d{1,30})$/

/** What a note's calldata says, or null when it isn't one. Takes hex, with or without its 0x. */
export function parseNote(input: string): Pick<CostNote, "txHash" | "asset" | "usdMicros"> | null {
  const hex = input.replace(/^0x/, "")
  if (hex.length === 0 || hex.length > 512 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const match = NOTE.exec(new TextDecoder().decode(Uint8Array.from(hex.match(/../g) as string[], (byte) => parseInt(byte, 16))))
  return match ? { txHash: match[1] as string, asset: match[2] as string, usdMicros: match[3] as string } : null
}

/** The calldata for a note. Publishing one ties the amount to the wallet in public, so clients warn before sending it. */
export function encodeNote(txHash: string, asset: string, usdMicros: string): string {
  return `0x${[...new TextEncoder().encode(`patina:cost:1:${txHash}:${asset}:${usdMicros}`)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
