/**
 * Detection of an installed dsh runtime for `installed` mode (no VS Code
 * dependency — unit-testable in plain Node):
 *  1. an explicitly configured path
 *  2. the global npm root (after `npm i -g @deepseek-ai/dsh`)
 *  3. an npx cache entry (after `npx @deepseek-ai/dsh web` ran once)
 */

import { execFileSync } from 'node:child_process'
import { accessSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

/** The node executable used to spawn dsh (system node, not Code.exe). */
export function nodeCommand(configuredPath: string | undefined): string {
  return configuredPath ?? 'node'
}

/**
 * Builds the installed-mode runtime launch for an npm-installed dsh.
 * Uses `--profile web` (not the `web` alias) so launcher flags are
 * accepted by the release package.
 */
export function installedLaunch(runtimePath: string, nodePath: string | undefined, port = 0): RuntimeLaunch {
  const bin = dshBinIn(runtimePath)
  return {
    command: nodeCommand(nodePath),
    args: [bin, '--profile', 'web', '--port', String(port)],
    cwd: runtimePath,
  }
}

/** The sharp version pinned by the extension (0.35.3 is a broken release). */
export const SHARP_PIN = '0.35.2'

/**
 * Files that must exist after an install; their absence means the install
 * pulled from a corrupt npm cache (a recurring flaky-network symptom).
 */
const RUNTIME_ESSENTIALS: ReadonlyArray<readonly [string, string]> = [
  ['@deepseek-ai/dsh', 'lib/bin.js'],
  ['commander', 'index.js'],
  ['@deepseek-ai/cordis', 'index.js'],
  ['typebox', 'build/type/action/module.mjs'],
  ['js-yaml', 'dist/js-yaml.mjs'],
]

/** Returns the essential files missing under a node_modules root (empty = healthy). */
export function missingRuntimeFiles(runtimePath: string): string[] {
  const missing: string[] = []
  for (const [pkg, file] of RUNTIME_ESSENTIALS) {
    try {
      accessSync(join(runtimePath, 'node_modules', pkg, file))
    } catch {
      missing.push(`${pkg}/${file}`)
    }
  }
  return missing
}

/** Reads the installed sharp version under a node_modules root, or undefined. */
export function sharpVersion(runtimePath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(runtimePath, 'node_modules', 'sharp', 'package.json'), 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Ensures `<runtimeRoot>/package.json` pins sharp to {@link SHARP_PIN} via
 * npm overrides, so a reinstall replaces the broken 0.35.3 release across
 * the whole dependency tree.
 * @returns the path of the (possibly created) package.json.
 */
export function ensureSharpPin(runtimeRoot: string): string {
  // The runtime directory may not exist yet (first auto-install): npm
  // install would create it, but the pin file is written before that.
  mkdirSync(runtimeRoot, { recursive: true })
  const pkgPath = join(runtimeRoot, 'package.json')
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  } catch {
    pkg = {}
  }
  const overrides = (pkg.overrides ?? {}) as Record<string, unknown>
  overrides.sharp = SHARP_PIN
  pkg.overrides = overrides
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
  return pkgPath
}

export interface RuntimeLaunch {
  command: string
  args: string[]
  /** Working directory for the child (also anchors module resolution). */
  cwd: string
}
