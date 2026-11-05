import "./node-globals.ts"
import { useState } from "react"
import { AnimatedQRCode, AnimatedQRScanner } from "@keystonehq/animated-qr"
import type { ScannedCode } from "./keystone.ts"

/** Reads a code off the device's screen with the webcam. The picture never leaves this page. */
export function CodeScanner({ types, onScan, onProblem }: { types: readonly string[]; onScan: (code: ScannedCode) => void; onProblem: (problem: string) => void }) {
  const [progress, setProgress] = useState(0)
  return (
    <div className="code-box">
      <AnimatedQRScanner
        urTypes={[...types]}
        handleScan={onScan}
        // Anything else is a frame the camera got wrong, and the next one will do.
        handleError={(error) => {
          if (error === "UNEXPECTED_QRCODE" || error === "INVALID_QR_CODE") onProblem("That isn't the code this is waiting for. Check which screen your Keystone is on.")
        }}
        videoLoaded={(canPlay, error) => {
          if (!canPlay && error) onProblem(error === "NO_WEBCAM_FOUND" ? "There's no webcam here to read your Keystone with." : "This page needs your webcam to read your Keystone. Allow it in the address bar, then try again.")
        }}
        onProgress={setProgress}
        options={{ width: 300, height: 300, blur: false }}
      />
      {progress > 0 ? <progress className="code-progress" max={100} value={progress} aria-label="Reading the code" /> : null}
    </div>
  )
}

export function CodeToSign({ code }: { code: ScannedCode }) {
  return (
    <div className="code-box code-light">
      <AnimatedQRCode type={code.type} cbor={code.cbor} options={{ size: 280 }} />
    </div>
  )
}
