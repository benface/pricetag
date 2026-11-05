// Loaded with --import, so test/example.test.ts can run the real example against fake-amp.ts.

import { registerHooks } from "node:module"

const FAKE_SDK = new URL("./example-sdk.ts", import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@pricetag/sdk" && context.parentURL?.includes("/sdk/examples/")) return { url: FAKE_SDK, shortCircuit: true }
    return next(specifier, context)
  },
})
