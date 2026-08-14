/**
 * Detection of an installed dsh runtime for `installed` mode (no VS Code
 * dependency — unit-testable in plain Node):
 *  1. an explicitly configured path
 *  2. the global npm root (after `npm i -g @deepseek-ai/dsh`)
 *  3. an npx cache entry (after `npx @deepseek-ai/dsh web` ran once)
 */

import { execFileSync } from 'node:child_process'
import { accessSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The npm-installed dsh bin path inside a node_modules root. */
export function dshBinIn(runtimePath: string): string {
  return join(runtimePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** True when the dsh bin is present under the given node_modules root. */
export function hasDshBin(runtimePath: string): boolean {
  try {
    accessSync(dshBinIn(runtimePath))
    return true
  } catch {
    return false
  }
}

/**
 * Detects an installed dsh in priority order: configured path, global npm
 * root, newest npx cache entry.
 * @param configuredPath - `dsh.runtime.path`, or undefined for auto-detection.
 * @returns a node_modules root containing a usable dsh, or undefined.
 */
export function findInstalledDsh(configuredPath: string | undefined): string | undefined {
  if (configuredPath !== undefined && configuredPath.length > 0 && hasDshBin(configuredPath)) {
    return configuredPath
  }
  const global = globalNpmRoot()
  if (global !== undefined && hasDshBin(global)) return global
  return npxCacheDsh()
}

/** The npm executable (npm.cmd on Windows — spawn/execFile need the shim). */
export function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Runs `npm root -g` to locate the global node_modules root. */
export function globalNpmRoot(): string | undefined {
  try {
    // shell: true — .cmd shims (npm.cmd) fail with EINVAL via CreateProcess.
    const out = execFileSync(npmCommand(), ['root', '-g'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: true })
    const root = out.trim()
    return root.length > 0 ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Scans the npm cache's `_npx` directory for a previously downloaded dsh.
 * Returns the newest entry's node_modules root, or undefined.
 */
export function npxCacheDsh(): string | undefined {
  const cacheRoot = process.env.LOCALAPPDATA
  if (cacheRoot === undefined) return undefined
  const npxRoot = join(cacheRoot, 'npm-cache', '_npx')
  let entries: string[]
  try {
    entries = readdirSync(npxRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return undefined
  }
  // _npx entries are content-hash dirs; pick the newest containing a dsh bin.
  let newest: string | undefined
  let newestMtime = 0
  for (const name of entries) {
    const candidate = join(npxRoot, name)
    if (!hasDshBin(candidate)) continue
    try {
      const st = statSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh'))
      if (st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs
        newest = candidate
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return newest
}
