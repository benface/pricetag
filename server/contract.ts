const MAX_REMEMBERED = 1000

/** What a wallet that's only delegated its code starts with (EIP-7702). Someone still holds its key, so it's a person's wallet. */
const DELEGATED = "0xef0100"

/**
 * Whether an address has code, which a person's plain wallet doesn't. Null when the node didn't say.
 * A smart wallet has code too, so this is something to mention, not something to refuse. An address's answer almost never changes, so it's kept.
 */
export function createContractCheck(url: string, send: typeof fetch = fetch) {
  const known = new Map<string, boolean>()
  return async function isContract(address: string): Promise<boolean | null> {
    const remembered = known.get(address)
    if (remembered !== undefined) return remembered
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
        signal: AbortSignal.timeout(5000),
      })
      const { result } = (await response.json()) as { result?: unknown }
      if (!response.ok || typeof result !== "string" || !result.startsWith("0x")) return null
      const answer = result !== "0x" && !result.startsWith(DELEGATED)
      if (known.size >= MAX_REMEMBERED) known.delete(known.keys().next().value as string)
      known.set(address, answer)
      return answer
    } catch {
      return null
    }
  }
}
