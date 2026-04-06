import { spawn } from "node:child_process"
import { QON_ERROR_CODE, QonError } from "./errors"

export type BridgeRequest = {
  method: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body_base64?: string
  timeout_ms?: number
  priority?: number
  trace_id?: string
  access_key?: string
}

export type BridgeResponse = {
  status: number
  headers: Record<string, string>
  body_base64?: string
  duration_ms: number
  trace_id?: string
  error?: {
    kind: string
    message: string
  }
}

type ExecuteBridgeOptions = {
  binaryPath: string
  signal?: AbortSignal
}

export function executeBridge(req: BridgeRequest, options: ExecuteBridgeOptions): Promise<BridgeResponse> {
  return new Promise<BridgeResponse>((resolve, reject) => {
    const child = spawn(options.binaryPath, ["-mode", "bridge"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const settleResolve = (value: BridgeResponse): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }

    const settleReject = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      reject(err)
    }

    const abortHandler = (): void => {
      child.kill("SIGTERM")
      settleReject(new QonError(QON_ERROR_CODE.REQUEST_ABORTED, "Request was aborted by caller."))
    }

    options.signal?.addEventListener("abort", abortHandler)

    child.once("error", (err) => {
      settleReject(
        new QonError(QON_ERROR_CODE.BRIDGE_SPAWN_FAILED, "Failed to spawn Qon core binary.", {
          cause: err,
          details: { binaryPath: options.binaryPath }
        })
      )
    })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", abortHandler)

      if (settled) {
        return
      }

      const line = stdout
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.length > 0)

      if (!line) {
        settleReject(
          new QonError(
            QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR,
            "No bridge response received from Qon core.",
            { details: { exitCode: code, stderr: stderr.trim() } }
          )
        )
        return
      }

      try {
        const parsed = JSON.parse(line) as BridgeResponse
        settleResolve(parsed)
      } catch (err) {
        settleReject(
          new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Bridge returned invalid JSON response.", {
            cause: err,
            details: { rawLine: line, stderr: stderr.trim() }
          })
        )
      }
    })

    try {
      child.stdin.write(`${JSON.stringify(req)}\n`)
      child.stdin.end()
    } catch (err) {
      settleReject(
        new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Failed writing request to bridge stdin.", {
          cause: err
        })
      )
    }
  })
}