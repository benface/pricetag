// The real SDK, with a client that reads the fixtures in FAKE_AMP. This file's export wins over the same name in `export *`.

import { fakeAmp } from "./fake-amp.ts"

export * from "@pricetag/sdk"

export function createPricetag() {
  const { tables, through } = JSON.parse(process.env.FAKE_AMP!)
  return fakeAmp(tables, through).client
}
