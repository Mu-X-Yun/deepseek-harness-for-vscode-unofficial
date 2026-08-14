/**
 * Extension settings, runtime resolution, and environment synthesis.
 *
 * `buildEnv` is a pure function so it can be unit-tested without VS Code.
 * The dsh bootstrap rejects `DEEPSEEK_BASE_URL` / `DSH_*` variables coming
 * from `.env` files (BOOTSTRAP_NAMES blacklist in packages/boot/app-boot);
 * injecting them through the spawned process env is the only supported path,
 * which is exactly what buildEnv does.
 */

import { accessSync } from 'node:fs'
import { dirname } from 'node:path'
import type * as vscode from 'vscode'

export type RuntimeMode = 'repo' | 'installed' | 'auto-install'
export type UiMode = 'embedded' | 'native'

export interface DshConfig {
  /** DEEPSEEK_API_KEY from settings, undefined when unset. */
  apiKey: string | undefined
  /** Optional custom endpoint base URL. */
  baseUrl: string | undefined
  /** Where to find the dsh runtime. */
  runtimeMode: RuntimeMode
  /** Explicit runtime path override (empty string when unset). */
  runtimePath: string | undefined
  /** Node executable for spawning dsh (default: `node` from PATH). */
  nodePath: string | undefined
  /** Permission preset (DSH_PERMISSION_MODE). */
  permissionMode: string
  /** Default model id for new sessions. */
  model: string
  /** Web server port (0 = random; default 3080). */
  port: number | undefined
  logLevel: string
  /** Sidebar UI flavor. */
  uiMode: UiMode
}

/**
 * Reads the extension settings into a DshConfig.
 * @param get - VS Code configuration accessor (injectable for tests).
 */
export function loadConfig(get: () => vscode.WorkspaceConfiguration): DshConfig {
  const cfg = get()
  return {
    apiKey: readString(cfg, 'deepseekApiKey'),
    baseUrl: readString(cfg, 'deepseekBaseUrl'),
    runtimeMode: (readString(cfg, 'runtime.mode') as RuntimeMode | undefined) ?? 'auto-install',
    runtimePath: readString(cfg, 'runtime.path'),
    nodePath: readString(cfg, 'runtime.nodePath'),
    permissionMode: readString(cfg, 'permissionMode') ?? 'workspace-write',
    model: readString(cfg, 'model') ?? 'deepseek-v4-flash',
    port: cfg.get<number>('runtime.port'),
    logLevel: readString(cfg, 'logLevel') ?? 'info',
    uiMode: (readString(cfg, 'ui.mode') as UiMode | undefined) ?? 'embedded',
  }
}

function readString(cfg: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const value = cfg.get<string>(key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Synthesizes the child process environment for a dsh spawn.
 * Pure: no I/O, no VS Code API.
 * @param baseEnv - the inherited environment (usually process.env).
 * @param cfg - the effective settings.
 */
export function buildEnv(baseEnv: NodeJS.ProcessEnv, cfg: Pick<DshConfig, 'apiKey' | 'baseUrl' | 'permissionMode'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (cfg.apiKey !== undefined) env.DEEPSEEK_API_KEY = cfg.apiKey
  if (cfg.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = cfg.baseUrl
  env.DSH_TELEMETRY_DISABLED = '1'
  env.DSH_PERMISSION_MODE = cfg.permissionMode
  return env
}

/**
 * Detects the `deepseek-harness-master` source checkout as a sibling of the
 * extension directory (repo mode default). Returns undefined when absent.
 */
export function defaultRepoPath(extensionDir: string): string | undefined {
  const candidate = `${dirname(extensionDir)}/deepseek-harness-master`
  try {
    accessSync(`${candidate}/apps/cli/src/bin.ts`)
    return candidate
  } catch {
    return undefined
  }
}
