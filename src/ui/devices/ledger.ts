// A Ledger over USB, straight from the browser. This module loads only when someone picks Ledger, because it's most of the app's
// dependencies. WebHID needs Chromium, a secure page and a click to start, and the device does all the signing.

import { ContextModuleBuilder, ContextModuleChainID, type ContextModule } from "@ledgerhq/context-module"
import { DeviceActionStatus, DeviceManagementKitBuilder, UserInteractionRequired, type DeviceManagementKit, type DeviceSessionId } from "@ledgerhq/device-management-kit"
import { SignerEthBuilder, type SignerEth } from "@ledgerhq/device-signer-kit-ethereum"
import { webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid"
import { firstValueFrom, type Observable } from "rxjs"
import { normalizeAddress } from "@pricetag/sdk/core"
import { BASE_CHAIN_ID, yParityOf, type ColdAccount, type DeviceSigner, type DevicePrompt } from "../../core/cold.ts"
import { LEDGER_BUSY, LEDGER_NOT_CHOSEN, REFUSED_ON_DEVICE, ledgerMessage } from "../../core/device-wording.ts"

/** Where Ledger's own app keeps accounts, so these are the ones someone already has there. */
const pathOf = (index: number) => `44'/60'/${index}'/0/0`

const promptOf = (interaction: UserInteractionRequired | undefined): DevicePrompt => {
  switch (interaction) {
    case UserInteractionRequired.UnlockDevice:
      return "unlock"
    case UserInteractionRequired.ConfirmOpenApp:
      return "open-app"
    case UserInteractionRequired.VerifyAddress:
      return "confirm-address"
    case UserInteractionRequired.SignTransaction:
      return "confirm-transaction"
    default:
      return "working"
  }
}

type DeviceAction<Output> = {
  observable: Observable<{ status: DeviceActionStatus; output?: Output; error?: unknown; intermediateValue?: { requiredUserInteraction?: UserInteractionRequired } }>
}

/** Waits for what the device does, saying along the way what it's waiting on. */
function finished<Output>({ observable }: DeviceAction<Output>, onPrompt: (prompt: DevicePrompt) => void): Promise<Output> {
  return new Promise((resolve, reject) => {
    observable.subscribe({
      next(state) {
        if (state.status === DeviceActionStatus.Pending) onPrompt(promptOf(state.intermediateValue?.requiredUserInteraction))
        else if (state.status === DeviceActionStatus.Completed) resolve(state.output as Output)
        else if (state.status === DeviceActionStatus.Error) reject(new Error(ledgerMessage(state.error)))
        else if (state.status === DeviceActionStatus.Stopped) reject(new Error(REFUSED_ON_DEVICE))
      },
      error: (error: unknown) => reject(new Error(ledgerMessage(error))),
    })
  })
}

function buildSigner(dmk: DeviceManagementKit, sessionId: DeviceSessionId): SignerEth {
  const context = new ContextModuleBuilder({ loggerFactory: (tag) => dmk.getLoggerFactory()(["ContextModule", tag]) }).setChain(ContextModuleChainID.Ethereum).build()
  // It would otherwise tell Ledger about what's signed. It only ever needs to ask about tokens, which says nothing about whose they are.
  const quiet = Object.create(context, { report: { value: async () => {} }, signReport: { value: async () => {} } }) as ContextModule
  return new SignerEthBuilder({ dmk, sessionId }).withContextModule(quiet).build()
}

/** Has to start from a click, or the browser won't show its device picker. */
export async function connectLedger(): Promise<DeviceSigner> {
  const dmk = new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build()
  let sessionId: DeviceSessionId
  try {
    const device = await firstValueFrom(dmk.startDiscovering({}))
    await dmk.stopDiscovering()
    sessionId = await dmk.connect({ device })
  } catch (error) {
    dmk.close()
    throw new Error((error as { _tag?: string })?._tag === "NoAccessibleDeviceError" ? LEDGER_NOT_CHOSEN : ledgerMessage(error))
  }
  const eth = buildSigner(dmk, sessionId)
  const address = async (path: string, options: { checkOnDevice: boolean; skipOpenApp?: boolean }, onPrompt: (prompt: DevicePrompt) => void) => {
    const { address } = await finished(eth.getAddress(path, { chainId: BASE_CHAIN_ID, ...options }) as DeviceAction<{ address: string }>, onPrompt)
    return normalizeAddress(address)
  }

  return {
    kind: "ledger",
    name: "Ledger",
    async listAccounts(start, count, onPrompt) {
      const accounts: ColdAccount[] = []
      for (let index = start; index < start + count; index++) {
        const path = pathOf(index)
        // One at a time, because a device does one thing at a time. The first one opens the app if it has to.
        accounts.push({ address: await address(path, { checkOnDevice: false, skipOpenApp: index > start }, onPrompt), path })
      }
      return accounts
    },
    async showAddress(account, onPrompt) {
      if (!account.path) throw new Error(LEDGER_BUSY)
      const shown = await address(account.path, { checkOnDevice: true }, onPrompt)
      if (shown !== normalizeAddress(account.address)) throw new Error("The device has a different address there. Don't use this one.")
      return "shown-on-device"
    },
    async signTransaction(account, unsigned, onPrompt) {
      if (!account.path) throw new Error(LEDGER_BUSY)
      const bytes = Uint8Array.from((unsigned.slice(2).match(/../g) as string[]).map((byte) => Number.parseInt(byte, 16)))
      const { r, s, v } = await finished(eth.signTransaction(account.path, bytes) as DeviceAction<{ r: `0x${string}`; s: `0x${string}`; v: number }>, onPrompt)
      return { r, s, yParity: yParityOf(v) }
    },
    async close() {
      await dmk.disconnect({ sessionId }).catch(() => {})
      dmk.close()
    },
  }
}
