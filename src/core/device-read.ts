// What the chain says, read directly from Base's public RPC. The money is on the line here, and this doesn't depend on our server.

import { ERC20_ADDRESSES, ETH_ADDRESS, PRICE_FEEDS, formatAmount, plainAmount, type Token } from "@pricetag/sdk/core"
import { erc20Abi, parseAbi, parseUnits, type Address, type PublicClient } from "viem"
import { estimateL1Fee } from "viem/op-stack"
import type { ColdRequest } from "./cold.ts"
import type { AccountActivity } from "./device-accounts.ts"

const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)"])

/** Whether anything's happened to an account on Base. A failed read says so, because that's not the same as nothing. */
export async function readActivity(client: PublicClient, address: string): Promise<AccountActivity> {
  try {
    const [nonce, ethUnits, tokens] = await Promise.all([
      client.getTransactionCount({ address: address as Address }),
      client.getBalance({ address: address as Address }),
      client.multicall({ allowFailure: false, contracts: ERC20_ADDRESSES.map((token) => ({ address: token as Address, abi: erc20Abi, functionName: "balanceOf" as const, args: [address as Address] })) }),
    ])
    return { nonce, ethUnits, tokenCount: tokens.filter((balance) => balance > 0n).length }
  } catch {
    return null
  }
}

export const readBalance = (client: PublicClient, address: string, token: Token): Promise<bigint> =>
  token.address === ETH_ADDRESS ? client.getBalance({ address: address as Address }) : client.readContract({ address: token.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] })

/** ETH's price now, from Chainlink's feed, or null if it's missing or too old to go by. */
export async function readEthPriceMicros(client: PublicClient, nowMs = Date.now()): Promise<bigint | null> {
  const feed = PRICE_FEEDS[0]
  try {
    const [, answer, , updatedAt] = await client.readContract({ address: feed.proxy as Address, abi: FEED_ABI, functionName: "latestRoundData" })
    if (answer <= 0n || nowMs / 1000 - Number(updatedAt) > feed.validSeconds) return null
    return answer / 100n
  } catch {
    return null
  }
}

/** An amount as typed, in a token's own units. Null if it isn't one, or has more digits than the token can hold. Nothing gets rounded on its way to the device. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const clean = plainAmount(text)
  if (clean === null || !/^(\d{1,30}(\.\d*)?|\.\d+)$/.test(clean)) return null
  if ((clean.split(".")[1]?.length ?? 0) > decimals) return null
  const units = parseUnits(clean as `${number}`, decimals)
  return units > 0n ? units : null
}

/** A dollar amount in a token, for filling in a form. ETH keeps six places, since nobody needs more to read it, and USDC is taken as dollars. */
export function amountForUsd(usdMicros: string, token: Token, ethPriceMicros: bigint | null): string | null {
  if (token.address === ETH_ADDRESS) {
    if (!ethPriceMicros) return null
    const millionths = (BigInt(usdMicros) * 1_000_000n) / ethPriceMicros
    return millionths > 0n ? (Number(millionths) / 1_000_000).toFixed(6).replace(/0+$/, "") : null
  }
  return token.symbol === "USDC" ? (Number(usdMicros) / 1_000_000).toFixed(2) : null
}

/** `blocks` means it can't go through, as opposed to a read that failed, which shouldn't stop anyone. */
export type SendCheck = { feeUnits: bigint | null; problem: string | null; blocks: boolean }

const NOT_ENOUGH_ETH = "This wallet doesn't hold enough ETH for this and its network fee."

/** Whether this can go through, and about what it costs. Base also charges for posting to Ethereum, which `estimateGas` leaves out. */
export async function checkSend(client: PublicClient, from: string, request: ColdRequest, spend: { token: Token; units: bigint } | null): Promise<SendCheck> {
  const call = { account: from as Address, to: request.to as Address, value: request.value, ...(request.data ? { data: request.data } : {}) }
  const eth = await client.getBalance({ address: from as Address }).catch(() => null)
  if (spend && spend.token.address !== ETH_ADDRESS) {
    const balance = await readBalance(client, from, spend.token).catch(() => null)
    if (balance !== null && balance < spend.units) return { feeUnits: null, problem: `This wallet holds ${formatAmount(balance, spend.token.decimals)} ${spend.token.symbol}, which isn't enough.`, blocks: true }
  }
  if (eth !== null && eth < request.value) return { feeUnits: null, problem: NOT_ENOUGH_ETH, blocks: true }
  try {
    const [gas, fees, l1Fee] = await Promise.all([
      client.estimateGas(call),
      client.estimateFeesPerGas(),
      estimateL1Fee(client as never, { ...call, chain: client.chain } as never).catch(() => 0n),
    ])
    const feeUnits = gas * fees.maxFeePerGas + l1Fee
    const short = eth !== null && eth < request.value + feeUnits
    return { feeUnits, problem: short ? NOT_ENOUGH_ETH : null, blocks: short }
  } catch {
    // Most often that's no ETH for gas, and whatever it is, the transaction would fail the same way.
    return eth === 0n ? { feeUnits: null, problem: NOT_ENOUGH_ETH, blocks: true } : { feeUnits: null, problem: "Couldn't work out the network fee, so this may not go through.", blocks: false }
  }
}
