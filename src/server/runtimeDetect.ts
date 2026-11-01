/**
 * Detection of an installed dsh runtime for `installed` mode (no VS Code
 * dependency — unit-testable in plain Node):
 *  1. an explicitly configured path
 *  2. the global npm root (after `npm i -g @deepseek-ai/dsh`)
 *  3. an npx cache entry (after `npx @deepseek-ai/dsh web` ran once)
 */

import { execFileSync } from 'node:child_process'
import { accessSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_PROFILE } from './profileDetect.ts'

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
 * Resolves a candidate path to a node_modules root that {@link dshBinIn}
 * understands. Two layouts occur in practice:
 *  - the root CONTAINING node_modules (extension runtime, npx cache entry);
 *  - the node_modules directory ITSELF (`npm root -g` prints this).
 * @returns the candidate (or its parent) that carries a dsh bin, or
 * undefined when neither layout does.
 */
export function resolveInstallRoot(candidate: string): string | undefined {
  if (hasDshBin(candidate)) return candidate
  const parent = dirname(candidate)
  if (parent !== candidate && hasDshBin(parent)) return parent
  return undefined
}

/**
 * Detects an installed dsh in priority order: configured path, global npm
 * root, newest npx cache entry.
 * @param configuredPath - `dsh.runtime.path`, or undefined for auto-detection.
 * @returns a node_modules root containing a usable dsh, or undefined.
 */
export function findInstalledDsh(configuredPath: string | undefined): string | undefined {
  if (configuredPath !== undefined && configuredPath.length > 0) {
    const configured = resolveInstallRoot(configuredPath)
    if (configured !== undefined) return configured
  }
  const global = globalNpmRoot()
  if (global !== undefined) {
    const resolved = resolveInstallRoot(global)
    if (resolved !== undefined) return resolved
  }
  return npxCacheDsh()
}

/** The npm executable (npm.cmd on Windows — spawn/execFile need the shim). */
export function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Successful `npm root -g` lookups stay cached this long (spawning npm is slow). */
const GLOBAL_ROOT_CACHE_TTL_MS = 60_000
let globalRootCache: { at: number; root: string } | undefined

/**
 * Runs `npm root -g` to locate the global node_modules directory (the
 * output IS the node_modules dir, not its parent — callers pass it through
 * {@link resolveInstallRoot}). Success is cached briefly; failures are not
 * cached, so a user who just ran `npm i -g @deepseek-ai/dsh` is picked up
 * on the next attempt.
 */
export function globalNpmRoot(): string | undefined {
  const now = Date.now()
  if (globalRootCache !== undefined && now - globalRootCache.at < GLOBAL_ROOT_CACHE_TTL_MS) {
    return globalRootCache.root
  }
  try {
    // shell: true only on Windows — .cmd shims (npm.cmd) fail with EINVAL
    // via CreateProcess; POSIX execFile passes argv verbatim.
    const out = execFileSync(npmCommand(), ['root', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      shell: process.platform === 'win32',
    })
    const root = out.trim()
    if (root.length === 0) return undefined
    globalRootCache = { at: now, root }
    return root
  } catch {
    return undefined
  }
}

/** The npm cache's `_npx` directory (Windows: LOCALAPPDATA; POSIX: ~/.npm or XDG). */
function npxCacheRoot(): string | undefined {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    return localAppData === undefined ? undefined : join(localAppData, 'npm-cache', '_npx')
  }
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg !== undefined && xdg.length > 0) return join(xdg, 'npm', '_npx')
  try {
    return join(homedir(), '.npm', '_npx')
  } catch {
    return undefined
  }
}

/**
 * Scans the npm cache's `_npx` directory for a previously downloaded dsh.
 * Returns the newest entry's node_modules root, or undefined.
 */
export function npxCacheDsh(): string | undefined {
  const npxRoot = npxCacheRoot()
  if (npxRoot === undefined) return undefined
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
 * Uses `--profile <name>` (not the `web` subcommand alias) so launcher
 * flags are accepted by the release package.
 */
export function installedLaunch(
  runtimePath: string,
  nodePath: string | undefined,
  port = 0,
  profile = DEFAULT_PROFILE,
  includePort = true,
): RuntimeLaunch {
  const bin = dshBinIn(runtimePath)
  const args = [bin, '--profile', profile]
  // `--port` is a Web-UI flag, not a launcher flag: terminal/TUI profiles
  // (e.g. dsh-console) reject it as an unknown option.
  if (includePort) args.push('--port', String(port))
  return {
    command: nodeCommand(nodePath),
    args,
    cwd: runtimePath,
  }
}

/**
 * The sharp release that is broken (binary fails to load). Only THIS
 * version is rejected by the health checks; other versions — older or
 * newer — are left alone.
 */
export const SHARP_BROKEN = '0.35.3'
/** The sharp version the extension pins for its own auto-install (npm overrides). */
export const SHARP_PIN = '0.35.2'

/**
 * Files that must exist after an install; their absence means the install
 * pulled from a corrupt npm cache (a recurring flaky-network symptom).
 */
const RUNTIME_ESSENTIALS: ReadonlyArray<readonly [string, string]> = [
  ['@deepseek-ai/dsh', 'lib/bin.js'],
  ['commander', 'index.js'],
  // `@deepseek-ai/cordis@4.x` exposes `lib/index.js` as its entry point
  // (`main: lib/index.js`); the root-level `index.js` no longer exists, so
  // pinning that path made every healthy install look incomplete.
  ['@deepseek-ai/cordis', 'lib/index.js'],
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
 * Ensures `<runtimeRoot>/package.json` declares `@deepseek-ai/dsh` as a real
 * dependency and pins sharp to {@link SHARP_PIN} via npm overrides.
 *
 * Declaring the dependency (instead of passing `@deepseek-ai/dsh` as a bare
 * CLI argument to `npm install --prefix <root>`) is what forces npm to write
 * into `<root>/node_modules`: with a bare CLI argument and a manifest that has
 * no `dependencies`, npm may answer "up to date" against an already-present
 * global install and leave `<root>/node_modules` empty.
 * @returns the path of the (possibly created) package.json.
 */
export function ensureRuntimeManifest(runtimeRoot: string): string {
  // The runtime directory may not exist yet (first auto-install): npm
  // install would create it, but the manifest is written before that.
  mkdirSync(runtimeRoot, { recursive: true })
  const pkgPath = join(runtimeRoot, 'package.json')
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  } catch {
    pkg = {}
  }
  pkg.name = 'dsh-runtime'
  pkg.version = '1.0.0'
  pkg.private = true
  const dependencies = (pkg.dependencies ?? {}) as Record<string, unknown>
  dependencies['@deepseek-ai/dsh'] = '*'
  pkg.dependencies = dependencies
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
