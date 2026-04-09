import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { createRequire } from "node:module"
import { QON_ERROR_CODE, QonError } from "./errors"

const requireFromHere = createRequire(resolve(process.cwd(), "package.json"))

const PLATFORM_TO_PACKAGE: Record<string, string> = {
  "win32-x64": "@qonjs/win32-x64",
  "win32-arm64": "@qonjs/win32-arm64",
  "win32-ia32": "@qonjs/win32-ia32",
  "linux-x64": "@qonjs/linux-x64",
  "linux-arm64": "@qonjs/linux-arm64",
  "linux-arm": "@qonjs/linux-arm",
  "darwin-x64": "@qonjs/darwin-x64",
  "darwin-arm64": "@qonjs/darwin-arm64"
}

function getPackageForRuntime(): string {
  const key = `${process.platform}-${process.arch}`
  const pkg = PLATFORM_TO_PACKAGE[key]
  if (!pkg) {
    throw new QonError(
      QON_ERROR_CODE.BINARY_UNSUPPORTED_PLATFORM,
      `No Qon binary package available for runtime ${key}.`
    )
  }
  return pkg
}

function resolveCandidate(pathLike: string): string | null {
  try {
    const resolved = requireFromHere.resolve(pathLike)
    if (existsSync(resolved)) {
      return resolved
    }
  } catch {
    return null
  }
  return null
}

function resolveFromPackage(pkgName: string): string | null {
  const exe = process.platform === "win32" ? "qon.exe" : "qon"
  return resolveCandidate(`${pkgName}/bin/${exe}`)
}

export function resolveBinaryPath(explicitPath?: string): string {
  const candidateFromEnv = process.env.QON_BINARY_PATH
  const manual = explicitPath || candidateFromEnv

  if (manual && manual.trim().length > 0) {
    const absolute = isAbsolute(manual) ? manual : resolve(process.cwd(), manual)
    if (!existsSync(absolute)) {
      throw new QonError(
        QON_ERROR_CODE.BINARY_NOT_FOUND,
        `Configured Qon binary path does not exist: ${absolute}`
      )
    }
    return absolute
  }

  const pkgName = getPackageForRuntime()
  const resolved = resolveFromPackage(pkgName)
  if (resolved) {
    return resolved
  }

  throw new QonError(
    QON_ERROR_CODE.BINARY_NOT_FOUND,
    `Could not resolve Qon binary from package ${pkgName}. Install optional dependency or configure binaryPath/QON_BINARY_PATH.`
  )
}