# qon-js

Official JavaScript and TypeScript client for the Qon core networking engine.

The package provides a type-safe API while delegating network execution to the native Qon binary over a binary framed stdin/stdout bridge.

## Features

- Type-safe request API
- String methods and method constants
- Runtime binary resolution by platform and architecture
- Binary framed bridge transport over stdin/stdout
- Persistent bridge process for high-throughput request workloads
- Structured bridge and runtime errors
- Support for headers, query params, priority, trace IDs, and access keys

## Install

```bash
npm install qon
# or
yarn add qon
# or
pnpm add qon
# or
bun add qon
```

## Quick Start

```ts
import { request, Method } from "qon"

const response = await request({
	url: "https://api.example.com",
	method: Method.GET,
	headers: {
		Authorization: "Bearer token"
	},
	timeout: 5000
})

console.log(response.status)
console.log(response.body)
```

## API

### request

```ts
request(options: RequestOptions): Promise<Response>
```

### RequestOptions

```ts
type RequestOptions = {
	url: string
	method?: Method | string
	headers?: Record<string, string>
	query?: Record<string, string>
	body?: string | Buffer | Uint8Array | ArrayBuffer | ArrayBufferView | Readable
	timeout?: number
	priority?: number
	traceId?: string
	accessKey?: string
	binaryPath?: string
	signal?: AbortSignal
}
```

### Response

```ts
type Response = {
	status: number
	headers: Record<string, string>
	body: Buffer | string
	duration: number
	traceId?: string
}
```

## Configuration

Global defaults can be configured:

```ts
import { configure } from "qon"

configure({
	timeout: 5000,
	accessKey: "my-access-key",
	priority: 1
})
```

Supported config keys:

- timeout
- binaryPath
- accessKey
- priority
- headers
- parseAs

## Bridge Protocol

The client maintains one persistent bridge process per resolved binary path and sends framed binary request/response messages.

For each request the client:

1. Encodes the request into the binary bridge payload format
2. Writes one length-prefixed frame to bridge stdin
3. Reads one length-prefixed frame from bridge stdout
4. Decodes and returns the response

Bridge payload fields are aligned with the current Qon core binary bridge implementation.

## Error Handling

Errors are represented by QonError with a stable code and optional cause.

Common codes:

- INVALID_INPUT
- BINARY_NOT_FOUND
- BRIDGE_SPAWN_FAILED
- BRIDGE_PROTOCOL_ERROR
- BRIDGE_EXECUTION_ERROR
- REQUEST_ABORTED

## Development

```bash
pnpm install
pnpm run build
pnpm run typecheck
```
