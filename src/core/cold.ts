// Signing with a hardware wallet. Every signature goes through here, whichever device it's on, and the rule about what a cold
// wallet may sign is checked here too, right before the device is asked. No key ever reaches this code, only addresses and signatures.

import { ETH_ADDRESS, TOKENS, isAddress, normalizeAddress, parseNote, tokenByAddress, type Token } from "@pricetag/sdk/core"
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  http,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Hex,
  type LocalAccount,
  type TransactionSerializable,
} from "viem"
import { toAccount } from "viem/accounts"
import { base } from "viem/chains"

export const BASE_RPC = "https://mainnet.base.org"
export const BASE_CHAIN_ID = base.id

/** One account on a device. It's enough to ask the device for it again, and says nothing the chain doesn't. */
export type ColdAccount = {
  address: string
  /** Where it is on the device, like `44'/60'/0'/0/0`. A browser wallet doesn't say. */
  path: string | null
  /** Keystone's sign requests name the device this way. It's a fingerprint of a public key, and reveals no key. */
  deviceId?: string
}

export type Signature = { r: Hex; s: Hex; yParity: 0 | 1 }

/** What the person should be doing right now, which the screen says while it waits. */
export type DevicePrompt = "unlock" | "open-app" | "confirm-address" | "confirm-transaction" | "working"

/** Whether the device itself put the address up, or the person has to go and find it there. */
export type AddressCheck = "shown-on-device" | "look-on-device"

type SignerBase = {
  kind: "ledger" | "keystone" | "browser"
  name: string
  /** Accounts in order, with no prompt on the device beyond unlocking it. Nothing here is checked until `showAddress`. */
  listAccounts(start: number, count: number, onPrompt: (prompt: DevicePrompt) => void): Promise<ColdAccount[]>
  /** Rejects if the person refuses on the device, or if the device says a different address. */
  showAddress(account: ColdAccount, onPrompt: (prompt: DevicePrompt) => void): Promise<AddressCheck>
  close(): Promise<void>
}

/** A device we talk to directly: it signs, and we broadcast. */
export type DeviceSigner = SignerBase & {
  signTransaction(account: ColdAccount, unsigned: Hex, onPrompt: (prompt: DevicePrompt) => void): Promise<Signature>
}

/** A browser wallet in front of a device: it signs and broadcasts by itself. */
export type WalletSigner = SignerBase & {
  provider: EIP1193Provider
}

export type ColdSigner = DeviceSigner | WalletSigner

export const isWalletSigner = (signer: ColdSigner): signer is WalletSigner => "provider" in signer

/** A signature's `v` as devices give it: 0 or 1 for this kind of transaction, or 27 or 28 from some. Anything else isn't for this kind. */
export function yParityOf(v: number): 0 | 1 {
  if (v === 0 || v === 27) return 0
  if (v === 1 || v === 28) return 1
  throw new Error("The device's signature doesn't fit this transaction. Nothing was sent.")
}

/** A signature as 65 bytes, which is how Keystone gives it. */
export function signatureFromHex(signature: string): Signature {
  const hex = signature.replace(/^0x/, "")
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error("That isn't a signature. Nothing was sent.")
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, yParity: yParityOf(Number.parseInt(hex.slice(128), 16)) }
}

export type ColdRequest = { to: string; value: bigint; data?: Hex }

export type ColdIntent =
  | { kind: "transfer"; token: Token; to: string; units: bigint }
  | { kind: "note"; txHash: string; asset: string; usdMicros: string }

export const NOT_YOURS = "A hardware wallet only sends to your own wallets here. Say this one's yours first."
export const NOT_ALLOWED = "A hardware wallet only signs plain transfers to your own wallets, and notes, here. It can't sign this."
export const NOT_LISTED = "This app only sends ETH and the tokens it tracks."

const ETH = TOKENS.find((token) => token.address === ETH_ADDRESS) as Token

/**
 * What a transaction does, or why a cold wallet can't sign it. Anything that isn't plainly one of the three things allowed is
 * refused, so swaps, approvals, permits and anything new are all covered without being named.
 */
export function readColdRequest(request: ColdRequest, from: string, own: ReadonlySet<string>): { intent: ColdIntent } | { refused: string } {
  if (!isAddress(request.to) || !isAddress(from)) return { refused: NOT_ALLOWED }
  const to = normalizeAddress(request.to)
  const sender = normalizeAddress(from)
  const data = request.data && request.data !== "0x" ? request.data : null

  if (!data) {
    if (request.value <= 0n) return { refused: NOT_ALLOWED }
    return to !== sender && own.has(to) ? { intent: { kind: "transfer", token: ETH, to, units: request.value } } : { refused: NOT_YOURS }
  }
  if (request.value !== 0n) return { refused: NOT_ALLOWED }

  if (to === sender) {
    const note = parseNote(data)
    return note ? { intent: { kind: "note", ...note } } : { refused: NOT_ALLOWED }
  }

  const transfer = readTransfer(data)
  if (!transfer) return { refused: NOT_ALLOWED }
  const token = tokenByAddress(to)
  if (!token || token.address === ETH_ADDRESS) return { refused: NOT_LISTED }
  const recipient = normalizeAddress(transfer.to)
  if (recipient === sender || !own.has(recipient)) return { refused: NOT_YOURS }
  return { intent: { kind: "transfer", token, to: recipient, units: transfer.units } }
}

function readTransfer(data: Hex): { to: string; units: bigint } | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data })
    if (functionName !== "transfer" || args[1] <= 0n) return null
    // Decoding ignores anything extra on the end, which a device might show differently.
    return encodeFunctionData({ abi: erc20Abi, functionName, args }) === data.toLowerCase() ? { to: args[0], units: args[1] } : null
  } catch {
    return null
  }
}

/** A transfer as a transaction. */
export function transferRequest(token: Token, to: string, units: bigint): ColdRequest {
  if (token.address === ETH_ADDRESS) return { to, value: units }
  return { to: token.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, units] }) }
}

/** The one thing that hands a device something to sign. It only takes a plain Base transaction this wallet is allowed to send. */
export function toColdAccount(signer: DeviceSigner, account: ColdAccount, own: ReadonlySet<string>, onPrompt: (prompt: DevicePrompt) => void): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new Error(NOT_ALLOWED)
  }
  return toAccount({
    address: account.address as Address,
    signMessage: refuse,
    signTypedData: refuse,
    async signTransaction(transaction, options) {
      const unsigned = transaction as TransactionSerializable
      const plain = unsigned.chainId === BASE_CHAIN_ID && unsigned.type === "eip1559" && !unsigned.accessList?.length && !("authorizationList" in unsigned && unsigned.authorizationList)
      if (!plain || !unsigned.to) throw new Error(NOT_ALLOWED)
      const check = readColdRequest({ to: unsigned.to, value: unsigned.value ?? 0n, ...(unsigned.data ? { data: unsigned.data } : {}) }, account.address, own)
      if ("refused" in check) throw new Error(check.refused)
      const serialize = (options?.serializer ?? serializeTransaction) as typeof serializeTransaction
      const signature = await signer.signTransaction(account, serialize(unsigned), onPrompt)
      const signed = serialize(unsigned, signature)
      // Sending it would fail or spend from somewhere else, and this is where it can still be said plainly.
      const recovered = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] }).catch(() => null)
      if (recovered === null || normalizeAddress(recovered) !== normalizeAddress(account.address)) throw new Error("The device signed with a different account from the one you chose. Nothing was sent.")
      return signed
    },
  })
}

/** Batched, because a page of accounts is a burst of reads, and the public node limits how many it takes. */
export const publicClient = (rpc: string = BASE_RPC) => createPublicClient({ chain: base, transport: http(rpc, { batch: true }) })

/** A browser wallet can be on any chain. This asks it to move to Base, and says so if it won't. */
async function onBase(provider: EIP1193Provider): Promise<void> {
  const chain = await provider.request({ method: "eth_chainId" })
  if (Number(chain) === BASE_CHAIN_ID) return
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${BASE_CHAIN_ID.toString(16)}` }] })
  if (Number(await provider.request({ method: "eth_chainId" })) !== BASE_CHAIN_ID) throw new Error("Your browser wallet isn't on Base, so nothing was sent.")
}

export type ColdSend = {
  signer: ColdSigner
  account: ColdAccount
  request: ColdRequest
  /** The user's wallets, in lowercase. */
  own: ReadonlySet<string>
  onPrompt: (prompt: DevicePrompt) => void
  rpc?: string
}

/** Sends one transaction from a cold wallet. Every route checks the same rule first. */
export async function sendFromCold({ signer, account, request, own, onPrompt, rpc = BASE_RPC }: ColdSend): Promise<Hash> {
  const check = readColdRequest(request, account.address, own)
  if ("refused" in check) throw new Error(check.refused)
  const call = { to: request.to as Address, value: request.value, ...(request.data ? { data: request.data } : {}) }
  if (isWalletSigner(signer)) {
    await onBase(signer.provider)
    onPrompt("confirm-transaction")
    return createWalletClient({ account: account.address as Address, chain: base, transport: custom(signer.provider) }).sendTransaction(call)
  }
  return createWalletClient({ account: toColdAccount(signer, account, own, onPrompt), chain: base, transport: http(rpc) }).sendTransaction({ ...call, type: "eip1559" })
}
