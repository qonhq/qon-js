import { Buffer } from "node:buffer"
import { Readable } from "node:stream"
import { resolveBinaryPath } from "./binary"
import { executeBridge } from "./bridge"
import type { BridgeRequest } from "./bridge"
import { QON_ERROR_CODE, QonError } from "./errors"
import { Method } from "./method"
import type { QonConfig, RequestBody, RequestOptions, Response } from "./types"

const SUPPORTED_METHODS = new Set<string>(Object.values(Method))

const defaultConfig: Required<Pick<QonConfig, "timeout" | "priority" | "parseAs">> & Omit<QonConfig, "timeout" | "priority" | "parseAs"> = {
  timeout: 10_000,
  priority: 0,
  parseAs: "auto"
}

let globalConfig: typeof defaultConfig = { ...defaultConfig }

export function configure(config: QonConfig): void {
  globalConfig = {
    ...globalConfig,
    ...config,
    headers: {
      ...(globalConfig.headers ?? {}),
      ...(config.headers ?? {})
    }
  }
}

function validateOptions(options: RequestOptions): void {
  if (!options || typeof options !== "object") {
    throw new QonError(QON_ERROR_CODE.INVALID_INPUT, "Request options are required.")
  }

  if (!options.url || typeof options.url !== "string") {
    throw new QonError(QON_ERROR_CODE.INVALID_INPUT, "Request url must be a non-empty string.")
  }

  try {
    const parsed = new URL(options.url)
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("unsupported protocol")
    }
  } catch {
    throw new QonError(QON_ERROR_CODE.INVALID_INPUT, "Request url must be a valid HTTP or HTTPS URL.")
  }

  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
    throw new QonError(QON_ERROR_CODE.INVALID_INPUT, "timeout must be a positive number in milliseconds.")
  }
}

function normalizeMethod(method?: string): string {
  const value = (method ?? Method.GET).toUpperCase()
  if (!SUPPORTED_METHODS.has(value)) {
    throw new QonError(
      QON_ERROR_CODE.INVALID_INPUT,
      `Unsupported method ${value}. Supported methods: ${Array.from(SUPPORTED_METHODS).join(", ")}.`
    )
  }
  return value
}

async function toBuffer(input?: RequestBody): Promise<Buffer> {
  if (input === undefined || input === null) {
    return Buffer.alloc(0)
  }

  if (Buffer.isBuffer(input)) {
    return input
  }

  if (typeof input === "string") {
    return Buffer.from(input)
  }

  if (input instanceof Uint8Array) {
    return Buffer.from(input)
  }

  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(input)
  }

  if (input instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  throw new QonError(QON_ERROR_CODE.INVALID_INPUT, "Unsupported body type provided.")
}

function shouldDecodeAsText(contentType: string | undefined, parseAs: "auto" | "buffer" | "text"): boolean {
  if (parseAs === "text") {
    return true
  }
  if (parseAs === "buffer") {
    return false
  }
  if (!contentType) {
    return false
  }

  const normalized = contentType.toLowerCase()
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  )
}

export async function request(options: RequestOptions): Promise<Response> {
  validateOptions(options)

  const mergedHeaders = {
    ...(globalConfig.headers ?? {}),
    ...(options.headers ?? {})
  }

  const method = normalizeMethod(options.method)
  const timeout = options.timeout ?? globalConfig.timeout
  const priority = options.priority ?? globalConfig.priority
  const parseAs = options.parseAs ?? globalConfig.parseAs
  const accessKey = options.accessKey ?? globalConfig.accessKey

  const binaryPath = resolveBinaryPath(options.binaryPath ?? globalConfig.binaryPath)
  const bodyBuffer = await toBuffer(options.body)

  const bridgeRequest: BridgeRequest = {
    method,
    url: options.url,
    headers: mergedHeaders,
    timeout_ms: timeout,
    priority
  }

  if (options.query) {
    bridgeRequest.query = options.query
  }
  if (options.traceId) {
    bridgeRequest.trace_id = options.traceId
  }
  if (accessKey) {
    bridgeRequest.access_key = accessKey
  }
  if (bodyBuffer.length > 0) {
    bridgeRequest.body_base64 = bodyBuffer.toString("base64")
  }

  const bridgeOptions: { binaryPath: string; signal?: AbortSignal } = {
    binaryPath
  }
  if (options.signal) {
    bridgeOptions.signal = options.signal
  }

  const wireResponse = await executeBridge(bridgeRequest, bridgeOptions)

  if (wireResponse.error) {
    throw new QonError(
      QON_ERROR_CODE.BRIDGE_EXECUTION_ERROR,
      `${wireResponse.error.kind}: ${wireResponse.error.message}`,
      {
        details: wireResponse.error
      }
    )
  }

  const payloadBuffer = wireResponse.body_base64
    ? Buffer.from(wireResponse.body_base64, "base64")
    : Buffer.alloc(0)

  const body = shouldDecodeAsText(wireResponse.headers?.["Content-Type"] ?? wireResponse.headers?.["content-type"], parseAs)
    ? payloadBuffer.toString("utf8")
    : payloadBuffer

  const response: Response = {
    status: wireResponse.status,
    headers: wireResponse.headers ?? {},
    body,
    duration: wireResponse.duration_ms
  }

  if (wireResponse.trace_id) {
    response.traceId = wireResponse.trace_id
  }

  return response
}