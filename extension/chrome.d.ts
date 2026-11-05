// Only what the extension uses, so there's no dependency for it. The extension runs as it is, with no build step.
declare namespace chrome.runtime {
  interface MessageSender {
    id?: string
    url?: string
    origin?: string
    frameId?: number
    tab?: object
  }
  interface Port {
    name: string
    sender?: MessageSender
    postMessage(message: unknown): void
    disconnect(): void
    onMessage: { addListener(listener: (message: unknown) => void): void }
    onDisconnect: { addListener(listener: () => void): void }
  }
  const id: string
  const lastError: { message?: string } | undefined
  function connect(info: { name: string }): Port
  function connectNative(host: string): Port
  function getURL(path: string): string
  const onConnect: { addListener(listener: (port: Port) => void): void }
}
