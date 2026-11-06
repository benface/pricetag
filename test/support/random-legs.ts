import type { FoldLeg } from "@pricetag/sdk/core"

/** Mulberry32, so a failure comes back with the same seed. It only picks test data, and has nothing to do with keys. */
export function randomFrom(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  return {
    below: (limit: number) => Math.floor(next() * limit),
    /** Up to `digits` random digits, so amounts run from dust to whole tokens and don't divide evenly. */
    amount: (digits: number) => {
      let text = ""
      for (let i = 1 + Math.floor(next() * digits); i > 0; i--) text += Math.floor(next() * 10)
      return BigInt(text)
    },
  }
}

export type LegMix = {
  /** Only buys and sales with a known cost and proceeds, each sale no bigger than what's held, and nothing sent away. */
  known?: boolean
  /** Also sends some away, which carries cost off without a gain or a loss. Only with `known`. */
  transfers?: boolean
}

/** One asset's legs in the order they happened, at a new block each. Each seed gives the same legs. */
export function randomLegs(seed: number, count: number, decimals: number, { known = false, transfers = false }: LegMix = {}): FoldLeg[] {
  const random = randomFrom(seed)
  const digits = decimals + 3
  const legs: FoldLeg[] = []
  let held = 0n
  for (let i = 0; i < count; i++) {
    const base = { id: `leg-${i}`, decimals, blockNum: i + 1, timestamp: new Date(Date.UTC(2026, 10, 4) + i * 1000).toISOString(), priceMicros: null, costMicros: null, proceedsMicros: null, costLabel: "unknown" as const }
    const price = random.amount(10) + 1n
    const roll = random.below(known ? (transfers ? 3 : 2) : 6)
    const qty = (roll === 0 || held === 0n ? random.amount(digits) : known ? random.amount(digits) % (held + 1n) : random.amount(digits)) + 1n
    if (held === 0n && known && roll !== 0) {
      // Nothing to sell yet, so this one's a buy.
      held += qty
      legs.push({ ...base, delta: qty.toString(), kind: "swap", priceMicros: price.toString(), costMicros: random.amount(10).toString(), costLabel: "paid" })
      continue
    }
    const out = known && roll !== 0 && qty > held ? held : qty
    switch (roll) {
      case 0:
        held += qty
        legs.push({ ...base, delta: qty.toString(), kind: "swap", priceMicros: price.toString(), costMicros: random.amount(10).toString(), costLabel: "paid" })
        break
      case 1:
        held -= out
        legs.push({ ...base, delta: (-out).toString(), kind: "swap", priceMicros: price.toString(), proceedsMicros: random.amount(10).toString() })
        break
      case 2:
        held -= out
        legs.push({ ...base, delta: (-out).toString(), kind: known ? "transfer" : "gas", priceMicros: known || random.below(2) === 0 ? price.toString() : null })
        break
      case 3:
        // Arrived from someone, with no cost anyone knows.
        held += qty
        legs.push({ ...base, delta: qty.toString(), kind: "transfer" })
        break
      case 4:
        held = held > qty ? held - qty : 0n
        legs.push({ ...base, delta: (-qty).toString(), kind: "transfer" })
        break
      default:
        // Sold for something nobody can read.
        held = held > qty ? held - qty : 0n
        legs.push({ ...base, delta: (-qty).toString(), kind: "swap", priceMicros: price.toString() })
    }
  }
  return legs
}
