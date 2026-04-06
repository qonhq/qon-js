import type { Readable } from "node:stream"
import type { Method } from "./method"

export type HeaderMap = Record<string, string>
export type QueryMap = Record<string, string>

export type RequestBody =
  | string
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Readable

export type ParseAs = "auto" | "buffer" | "text"

export type RequestOptions = {
  url: string
  method?: Method | string
  headers?: HeaderMap
  query?: QueryMap
  body?: RequestBody
  timeout?: number
  priority?: number
  traceId?: string
  accessKey?: string
  binaryPath?: string
  signal?: AbortSignal
  parseAs?: ParseAs
}

export type Response = {
  status: number
  headers: HeaderMap
  body: Buffer | string
  duration: number
  traceId?: string
}

export type QonConfig = {
  timeout?: number
  binaryPath?: string
  accessKey?: string
  priority?: number
  headers?: HeaderMap
  parseAs?: ParseAs
}