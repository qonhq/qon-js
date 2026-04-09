import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { QON_ERROR_CODE, QonError } from "./errors"

const PROTOCOL_VERSION = 1
const MSG_KIND_REQUEST = 1
const MSG_KIND_RESPONSE = 2

export type BridgeRequest = {
  method: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: Uint8Array
  timeout_ms?: number
  priority?: number
  trace_id?: string
  access_key?: string
}

export type BridgeResponse = {
  status: number
  headers: Record<string, string>
  body?: Uint8Array
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

type PendingRequest = {
  resolve: (value: BridgeResponse) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  abortHandler?: () => void
  aborted: boolean
}

const bridges = new Map<string, PersistentBridge>()

class BinaryWriter {
  private readonly parts: Buffer[] = []

  writeU8(value: number): void {
    const out = Buffer.allocUnsafe(1)
    out.writeUInt8(value & 0xff, 0)
    this.parts.push(out)
  }

  writeU32(value: number): void {
    const out = Buffer.allocUnsafe(4)
    out.writeUInt32BE(value >>> 0, 0)
    this.parts.push(out)
  }

  writeI32(value: number): void {
    const out = Buffer.allocUnsafe(4)
    out.writeInt32BE(value | 0, 0)
    this.parts.push(out)
  }

  writeI64(value: number): void {
    const out = Buffer.allocUnsafe(8)
    out.writeBigInt64BE(BigInt(Math.trunc(value)), 0)
    this.parts.push(out)
  }

  writeString(value: string): void {
    const encoded = Buffer.from(value, "utf8")
    this.writeU32(encoded.length)
    if (encoded.length > 0) {
      this.parts.push(encoded)
    }
  }

  writeBytes(value?: Uint8Array): void {
    const encoded = value ? Buffer.from(value) : Buffer.alloc(0)
    this.writeU32(encoded.length)
    if (encoded.length > 0) {
      this.parts.push(encoded)
    }
  }

  writeMap(map?: Record<string, string>): void {
    const entries = map ? Object.entries(map) : []
    this.writeU32(entries.length)
    for (const [key, value] of entries) {
      this.writeString(key)
      this.writeString(value)
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts)
  }
}

class BinaryReader {
  private offset = 0

  constructor(private readonly payload: Buffer) {}

  private take(size: number): Buffer {
    if (this.offset + size > this.payload.length) {
      throw new Error("unexpected EOF while decoding bridge payload")
    }
    const out = this.payload.subarray(this.offset, this.offset + size)
    this.offset += size
    return out
  }

  readU8(): number {
    return this.take(1).readUInt8(0)
  }

  readU32(): number {
    return this.take(4).readUInt32BE(0)
  }

  readI32(): number {
    return this.take(4).readInt32BE(0)
  }

  readI64(): number {
    return Number(this.take(8).readBigInt64BE(0))
  }

  readString(): string {
    const size = this.readU32()
    if (size === 0) {
      return ""
    }
    return this.take(size).toString("utf8")
  }

  readBytes(): Buffer {
    const size = this.readU32()
    if (size === 0) {
      return Buffer.alloc(0)
    }
    return this.take(size)
  }

  readMap(): Record<string, string> {
    const count = this.readU32()
    const out: Record<string, string> = {}
    for (let i = 0; i < count; i += 1) {
      const key = this.readString()
      const value = this.readString()
      out[key] = value
    }
    return out
  }

  ensureDone(): void {
    if (this.offset !== this.payload.length) {
      throw new Error("bridge payload contains trailing bytes")
    }
  }
}

function encodeRequest(req: BridgeRequest): Buffer {
  const payload = new BinaryWriter()
  payload.writeU8(PROTOCOL_VERSION)
  payload.writeU8(MSG_KIND_REQUEST)
  payload.writeString(req.method)
  payload.writeString(req.url)
  payload.writeMap(req.headers)
  payload.writeMap(req.query)
  payload.writeBytes(req.body)
  payload.writeI64(req.timeout_ms ?? 0)
  payload.writeI32(req.priority ?? 0)
  payload.writeString(req.trace_id ?? "")
  payload.writeString(req.access_key ?? "")

  const payloadBuf = payload.toBuffer()
  const frame = Buffer.allocUnsafe(4 + payloadBuf.length)
  frame.writeUInt32BE(payloadBuf.length, 0)
  payloadBuf.copy(frame, 4)
  return frame
}

function decodeResponse(payload: Buffer): BridgeResponse {
  const reader = new BinaryReader(payload)
  const version = reader.readU8()
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported bridge protocol version ${version}`)
  }

  const kind = reader.readU8()
  if (kind !== MSG_KIND_RESPONSE) {
    throw new Error(`invalid bridge message kind ${kind}`)
  }

  const status = reader.readI32()
  const headers = reader.readMap()
  const body = reader.readBytes()
  const duration = reader.readI64()
  const traceId = reader.readString()
  const errorKind = reader.readString()
  const errorMessage = reader.readString()
  reader.ensureDone()

  const out: BridgeResponse = {
    status,
    headers,
    body,
    duration_ms: duration
  }

  if (traceId.length > 0) {
    out.trace_id = traceId
  }
  if (errorKind.length > 0 || errorMessage.length > 0) {
    out.error = {
      kind: errorKind,
      message: errorMessage
    }
  }

  return out
}

class PersistentBridge {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending: PendingRequest[] = []
  private stdoutChunks: Buffer[] = []
  private stdoutLength = 0
  private stderrBuffer = ""
  private closed = false

  constructor(private readonly binaryPath: string) {
    this.child = spawn(binaryPath, ["-mode", "bridge"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutChunks.push(chunk)
      this.stdoutLength += chunk.length
      this.drainFrames()
    })

    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk
      if (this.stderrBuffer.length > 16_384) {
        this.stderrBuffer = this.stderrBuffer.slice(-16_384)
      }
    })

    this.child.on("error", (err) => {
      this.failAll(
        new QonError(QON_ERROR_CODE.BRIDGE_SPAWN_FAILED, "Failed to spawn Qon core binary.", {
          cause: err,
          details: { binaryPath }
        })
      )
    })

    this.child.on("close", (code) => {
      this.closed = true
      bridges.delete(this.binaryPath)
      this.failAll(
        new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Bridge process exited unexpectedly.", {
          details: { exitCode: code, stderr: this.stderrBuffer.trim() }
        })
      )
    })
  }

  execute(req: BridgeRequest, signal?: AbortSignal): Promise<BridgeResponse> {
    if (this.closed) {
      return Promise.reject(
        new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Bridge process is not available.", {
          details: { binaryPath: this.binaryPath }
        })
      )
    }

    return new Promise<BridgeResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        aborted: false
      }

      if (signal) {
        pending.signal = signal
        if (signal.aborted) {
          pending.aborted = true
          reject(new QonError(QON_ERROR_CODE.REQUEST_ABORTED, "Request was aborted by caller."))
          return
        }

        pending.abortHandler = () => {
          if (pending.aborted) {
            return
          }
          pending.aborted = true
          reject(new QonError(QON_ERROR_CODE.REQUEST_ABORTED, "Request was aborted by caller."))
        }
        signal.addEventListener("abort", pending.abortHandler, { once: true })
      }

      this.pending.push(pending)

      let frame: Buffer
      try {
        frame = encodeRequest(req)
      } catch (err) {
        this.pending.pop()
        this.cleanupPending(pending)
        reject(
          new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Failed encoding bridge request.", {
            cause: err
          })
        )
        return
      }

      this.child.stdin.write(frame, (err) => {
        if (!err) {
          return
        }

        const idx = this.pending.indexOf(pending)
        if (idx >= 0) {
          this.pending.splice(idx, 1)
        }
        this.cleanupPending(pending)

        reject(
          new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Failed writing request to bridge stdin.", {
            cause: err
          })
        )
      })
    })
  }

  private drainFrames(): void {
    while (this.stdoutLength >= 4) {
      if (this.stdoutChunks.length > 1) {
        const merged = Buffer.concat(this.stdoutChunks)
        this.stdoutChunks = [merged]
      }
      const buf = this.stdoutChunks[0]!
      const size = buf.readUInt32BE(0)
      if (this.stdoutLength < 4 + size) {
        return
      }

      const payload = buf.subarray(4, 4 + size)
      const consumed = 4 + size
      const remaining = buf.subarray(consumed)
      this.stdoutChunks = remaining.length > 0 ? [remaining] : []
      this.stdoutLength = remaining.length

      const pending = this.pending.shift()
      if (!pending) {
        continue
      }

      this.cleanupPending(pending)

      let decoded: BridgeResponse
      try {
        decoded = decodeResponse(payload)
      } catch (err) {
        pending.reject(
          new QonError(QON_ERROR_CODE.BRIDGE_PROTOCOL_ERROR, "Bridge returned invalid binary response.", {
            cause: err,
            details: { stderr: this.stderrBuffer.trim() }
          })
        )
        continue
      }

      if (!pending.aborted) {
        pending.resolve(decoded)
      }
    }
  }

  private failAll(err: QonError): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift()!
      this.cleanupPending(pending)
      if (!pending.aborted) {
        pending.reject(err)
      }
    }
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler)
    }
  }
}

function getBridge(binaryPath: string): PersistentBridge {
  const existing = bridges.get(binaryPath)
  if (existing) {
    return existing
  }
  const bridge = new PersistentBridge(binaryPath)
  bridges.set(binaryPath, bridge)
  return bridge
}

export function executeBridge(req: BridgeRequest, options: ExecuteBridgeOptions): Promise<BridgeResponse> {
  return getBridge(options.binaryPath).execute(req, options.signal)
}
