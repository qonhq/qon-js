export const QON_ERROR_CODE = {
  INVALID_INPUT: "INVALID_INPUT",
  BINARY_NOT_FOUND: "BINARY_NOT_FOUND",
  BINARY_UNSUPPORTED_PLATFORM: "BINARY_UNSUPPORTED_PLATFORM",
  BRIDGE_SPAWN_FAILED: "BRIDGE_SPAWN_FAILED",
  BRIDGE_PROTOCOL_ERROR: "BRIDGE_PROTOCOL_ERROR",
  BRIDGE_EXECUTION_ERROR: "BRIDGE_EXECUTION_ERROR",
  REQUEST_ABORTED: "REQUEST_ABORTED"
} as const

export type QonErrorCode = (typeof QON_ERROR_CODE)[keyof typeof QON_ERROR_CODE]

export class QonError extends Error {
  readonly code: QonErrorCode
  readonly details?: unknown
  readonly cause?: unknown

  constructor(code: QonErrorCode, message: string, options?: { details?: unknown; cause?: unknown }) {
    super(message)
    this.name = "QonError"
    this.code = code
    this.details = options?.details
    this.cause = options?.cause
  }
}