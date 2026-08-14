/**
 * DSH VS Code extension entry point (phase 1: embedded Web UI).
 *
 * Assemblies: settings → dsh web server process → sidebar webview shell.
 * The server process is owned by the extension host (not the view), so the
 * chat survives hiding the view and is cleaned up on extension deactivate.
 */

import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { buildEnv, defaultRepoPath, loadConfig, type DshConfig } from './config.ts'
import {
  DshServerManager,
  dshBinIn,
  ensureSharpPin,
  findInstalledDsh,
  hasDshBin,
  installedLaunch,
  messageOf,
  missingRuntimeFiles,
  npmCommand,
  repoInstalled,
  repoLaunch,
  SHARP_PIN,
  sharpVersion,
  webDistBuilt,
  type RuntimeLaunch,
} from './server/DshServerManager.ts'
import { DshChatViewProvider } from './view/DshChatViewProvider.ts'
import { DshEmbeddedBackend, ISSUES_URL } from './view/DshEmbeddedBackend.ts'
import { addWorkspace } from './workspace.ts'

let server: DshServerManager | undefined
let logChannel: vscode.OutputChannel | undefined

/**
 * Detected dsh copies that failed to boot (missing-module self-heal) and
 * were abandoned: the extension's own runtime copy is used instead. Mutating
 * npm-owned trees (global root / npx cache) would be unsafe, so a failed
 * detected copy is never repaired in place.
 */
const badInstalls = new Set<string>()

/** Cached auto-install detection for the activation; invalidated on install/abandon changes. */
let detectionCache: { detected: string | undefined; detectedRaw: string | undefined } | undefined
function invalidateDetection(): void {
  detectionCache = undefined
}

/** npm installs are killed after this long; npm's own retries are capped below. */
const NPM_TIMEOUT_MS = 600_000

export function activate(context: vscode.ExtensionContext): void {
  logChannel = vscode.window.createOutputChannel('DSH')

  // The extension's own directory — parent of the sibling repo checkout.
  const extensionDir = context.extensionUri.fsPath

  // Settings are re-read on every start, so editing configuration does not
  // require restarting the extension.
  const readConfig = (): DshConfig => loadConfig(() => vscode.workspace.getConfiguration('dsh'))

  let useRandomPort = false
  const resolveRuntime = (): {
    launch: RuntimeLaunch
    preflight: () => string[]
    ensureRuntime?: () => Promise<void>
    onModuleMissing?: () => Promise<boolean>
  } => {
    const config = readConfig()
    switch (config.runtimeMode) {
      case 'installed': {
        const runtimePath = findInstalledDsh(config.runtimePath)
        if (runtimePath === undefined) {
          const hint = config.runtimePath === undefined
            ? 'No installed dsh found. Run `npm i -g @deepseek-ai/dsh` (or use `npx @deepseek-ai/dsh web` once), or set dsh.runtime.path.'
            : `No dsh at ${config.runtimePath} (expected ${dshBinIn(config.runtimePath)}).`
          return {
            launch: installedLaunch(config.runtimePath ?? '', config.nodePath, portOf(useRandomPort, config)),
            preflight: () => [hint],
          }
        }
        return {
          launch: installedLaunch(runtimePath, config.nodePath, portOf(useRandomPort, config)),
          preflight: () => {
            // npm sharp 0.35.3 is a broken release (binary fails to load);
            // detect and point at a fix without touching the user's install.
            const version = sharpVersion(runtimePath)
            if (version !== undefined && version !== SHARP_PIN) {
              return [
                `The installed dsh uses sharp ${version}, a broken npm release. ` +
                `Run \`npm i -g sharp@${SHARP_PIN}\` (or switch dsh.runtime.mode to "auto-install").`,
              ]
            }
            return []
          },
        }
      }
      case 'auto-install': {
        const runtimeRoot = join(context.globalStorageUri.fsPath, 'runtime')
        // A fresh cache dir for self-heal reinstalls: the user's global npm
        // cache can hold corrupt entries (flaky-network downloads), which
        // reproduce missing files on every reinstall.
        const freshCache = join(context.globalStorageUri.fsPath, 'npm-cache')
        // If the user already has a usable dsh (global install or npx
        // cache from `npx @deepseek-ai/dsh web`), reuse it instead of
        // downloading a fresh copy. Only adopt it when its sharp is the
        // pinned healthy version — an npx-cached install carries the broken
        // sharp 0.35.3 (no overrides there) and would fail to boot — and it
        // has not been abandoned after a boot failure (badInstalls). The
        // detection result is cached per activation: `npm root -g` spawns a
        // child process and is too expensive to re-run on every launch()/
        // preflight()/ensureRuntime() call.
        if (detectionCache === undefined) {
          const detectedRaw = findInstalledDsh(config.runtimePath)
          const detected =
            detectedRaw !== undefined && !badInstalls.has(detectedRaw) && sharpVersion(detectedRaw) === SHARP_PIN
              ? detectedRaw
              : undefined
          detectionCache = { detected, detectedRaw }
        }
        const { detected, detectedRaw } = detectionCache
        // The configured registry failed once this activation; skip it for
        // the rest of the session instead of paying its timeout again.
        let registryFailed = false
        const runNpm = (args: string[]): Promise<void> => new Promise<void>((resolve, reject) => {
          // shell: true is required on Windows: .cmd shims (npm.cmd) cannot
          // be launched directly via CreateProcess and fail with EINVAL.
          // Shell mode concatenates args without escaping, so quote any
          // path that could contain spaces. Stream npm output into the DSH
          // log channel so the user can watch install progress.
          let child: ReturnType<typeof execFile> | undefined
          const done = (err: Error | null): void => {
            clearTimeout(boom)
            if (err) reject(new Error(`npm ${args[0]} failed: ${err.message}`))
            else resolve()
          }
          // execFile's own timeout only kills the shell wrapper (cmd.exe);
          // the npm grandchild would keep writing node_modules. Kill the
          // whole process tree instead.
          const boom = setTimeout(() => {
            logChannel?.appendLine(`[error] npm ${args[0]} timed out after ${NPM_TIMEOUT_MS / 1000}s; killing it`)
            if (child?.pid !== undefined) {
              if (process.platform === 'win32') {
                execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
              } else {
                child.kill('SIGKILL')
              }
            }
            done(new Error(`timed out after ${NPM_TIMEOUT_MS / 1000}s (install was killed)`))
          }, NPM_TIMEOUT_MS)
          child = execFile(npmCommand(), args, { shell: true, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, done)
          child.stderr?.on('data', (chunk: Buffer) => {
            const line = chunk.toString().trim()
            if (line.length > 0) logChannel?.appendLine(`[npm] ${line}`)
          })
          child.stdout?.on('data', (chunk: Buffer) => {
            const line = chunk.toString().trim()
            if (line.length > 0) logChannel?.appendLine(`[npm] ${line}`)
          })
        })
        const install = async (prefix: string, extraArgs: string[] = [], skipRegistry = false): Promise<void> => {
          // Cap npm's own network retries so a slow-but-alive mirror cannot
          // burn the whole 600s install timeout before the fallback runs.
          const base = [
            'install',
            '--prefix',
            shellQuote(prefix),
            '@deepseek-ai/dsh',
            '--fetch-timeout', '60000',
            '--fetch-retries', '1',
            ...extraArgs,
          ]
          const registry = !skipRegistry && !registryFailed ? readConfig().registry : undefined
          if (registry !== undefined) {
            logChannel?.appendLine(`[info] installing via registry ${registry}…`)
            try {
              await runNpm([...base, '--registry', shellQuote(registry)])
              return
            } catch (err) {
              // A misconfigured/unreachable mirror must not brick the install;
              // fall back to the official registry (and remember it for this
              // activation — a dead mirror costs 60s per attempt otherwise).
              registryFailed = true
              logChannel?.appendLine(
                `[warn] registry ${registry} failed (${messageOf(err).slice(0, 120)}); falling back to the official registry for the rest of this session`,
              )
            }
          }
          await runNpm(base)
        }
        /** Installs into `prefix` and returns the still-missing essential files. */
        const installVerified = async (
          prefix: string,
          opts: { freshCache?: boolean; skipRegistry?: boolean } = {},
        ): Promise<string[]> => {
          const args = opts.freshCache === true ? ['--cache', shellQuote(freshCache)] : []
          await install(prefix, args, opts.skipRegistry)
          return missingRuntimeFiles(prefix)
        }
        return {
          launch: installedLaunch(detected ?? runtimeRoot, config.nodePath, portOf(useRandomPort, config)),
          ensureRuntime: async () => {
            if (detected !== undefined) return // a healthy user install is reused
            if (detectedRaw !== undefined) {
              // The detected copy exists but is unusable (broken sharp, or
              // abandoned after a boot failure). Never mutate npm-owned
              // trees (a `--prefix <node_modules root>` install would nest a
              // second node_modules and rewrite the user's manifests); the
              // extension's own runtime dir is used instead.
              logChannel?.appendLine(
                `[info] detected dsh at ${detectedRaw} is unusable; installing the extension runtime at ${runtimeRoot}`,
              )
            }
            // npm sharp 0.35.3 (broken release) must be pinned away before
            // (re)installing; overrides force the whole tree to SHARP_PIN.
            ensureSharpPin(runtimeRoot)
            if (hasDshBin(runtimeRoot) && sharpVersion(runtimeRoot) === SHARP_PIN) return
            logChannel?.appendLine(`[info] installing @deepseek-ai/dsh into ${runtimeRoot}…`)
            // First install uses the user's global npm cache (fast when
            // packages are already downloaded). Verify essential files right
            // after; a corrupt-entry install is immediately redone from a
            // fresh dedicated cache AND the official registry (the mirror
            // that served the corruption would serve it again), without
            // waiting for a boot failure.
            const missing = await installVerified(runtimeRoot)
            if (missing.length > 0) {
              logChannel?.appendLine(`[warn] install incomplete (${missing.join(', ')}); reinstalling from a fresh cache`)
              rmSync(join(runtimeRoot, 'node_modules'), { recursive: true, force: true })
              const stillMissing = await installVerified(runtimeRoot, { freshCache: true, skipRegistry: true })
              if (stillMissing.length > 0) {
                // Surface the failure loudly instead of booting into an
                // endless spawn-fail-reinstall loop. DshServerManager.start()
                // turns this into a 'failed' state (banner + Retry).
                throw new Error(
                  `dsh 安装不完整（缺少 ${stillMissing.join(', ')}）。可手动执行 npm install --prefix "${runtimeRoot}" @deepseek-ai/dsh 后重试，或配置 dsh.runtime.registry 镜像源加速。`,
                )
              }
            }
          },
          preflight: () => {
            // Check the path actually used for launch (the detected npx/global
            // install, not the extension's own runtime dir).
            const activePath = detected ?? runtimeRoot
            if (!hasDshBin(activePath)) return ['dsh runtime is not installed yet (auto-install pending).']
            const version = sharpVersion(activePath)
            return version !== undefined && version !== SHARP_PIN
              ? [`sharp ${version} (broken release) still present after install; retry may be needed.`]
              : []
          },
          onModuleMissing: async () => {
            // The boot failed on the path actually launched. When that is a
            // user-owned detected copy (global root / npx cache), abandon it
            // — never mutate npm-owned trees — and reinstall the extension's
            // own runtime from a fresh cache + official registry, so the
            // relaunch resolves to a healthy copy.
            if (detected !== undefined) {
              logChannel?.appendLine(
                `[warn] detected dsh at ${detected} failed to boot; abandoning it and using the extension runtime`,
              )
              badInstalls.add(detected)
              invalidateDetection()
            }
            rmSync(join(runtimeRoot, 'node_modules'), { recursive: true, force: true })
            try {
              // The user's global cache may itself hold corrupt entries that
              // reproduce the missing files; the fresh cache + official
              // registry path is the one that escapes a corrupt mirror.
              const missing = await installVerified(runtimeRoot, { freshCache: true, skipRegistry: true })
              if (missing.length > 0) {
                logChannel?.appendLine(`[error] reinstall still missing: ${missing.join(', ')}`)
                return false
              }
              return true
            } catch {
              return false
            }
          },
        }
      }
      case 'repo':
      default: {
        const repoPath = config.runtimePath ?? defaultRepoPath(extensionDir)
        if (repoPath === undefined) {
          return {
            launch: repoLaunch(extensionDir, config.nodePath, portOf(useRandomPort, config)),
            preflight: () => [
              'Could not locate the deepseek-harness-master checkout. ' +
              'Set dsh.runtime.path to the repo directory, or switch dsh.runtime.mode ' +
              'to "installed" (auto-detect global/npx dsh) or "auto-install" (install on first use).',
            ],
          }
        }
        return {
          launch: repoLaunch(repoPath, config.nodePath, portOf(useRandomPort, config)),
          preflight: () => {
            const problems: string[] = []
            if (!repoInstalled(repoPath)) {
              problems.push('The dsh repo has no node_modules — run `pnpm install` in it first.')
            }
            if (!webDistBuilt(repoPath)) {
              problems.push('The dsh web frontend is not built — run `pnpm run build:web` in the repo first.')
            }
            return problems
          },
        }
      }
    }
  }

  server = new DshServerManager({
    launch: () => resolveRuntime().launch,
    env: () => buildEnv(process.env, readConfig()),
    preflight: () => resolveRuntime().preflight(),
    ensureRuntime: async () => {
      await resolveRuntime().ensureRuntime?.()
    },
    onModuleMissing: async () => (await resolveRuntime().onModuleMissing?.()) ?? false,
    onPortConflict: async () => {
      useRandomPort = true
      logChannel?.appendLine('[info] port 3080 in use; falling back to a random port')
      return true
    },
    log: (level, message) => logChannel?.appendLine(`[${level}] ${message}`),
    storagePath: context.globalStorageUri.fsPath,
  })

  // Sidebar view: embedded only (the native chat UI is temporarily
  // disabled — feature-incomplete; its sources and tests are kept).
  const backend: import('./view/DshChatBackend.ts').ChatBackend = new DshEmbeddedBackend(server)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DshChatViewProvider.viewType,
      new DshChatViewProvider(context, backend),
    ),
  )

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.startServer', async () => {
      try {
        await server!.start()
      } catch (err) {
        showErrorWithReport(`DSH failed to start: ${messageOf(err)}`)
      }
    }),
    vscode.commands.registerCommand('dsh.stopServer', async () => {
      await server!.stop()
    }),
    vscode.commands.registerCommand('dsh.openInBrowser', async () => {
      const state = server!.current
      if (state.kind !== 'running') {
        void vscode.window.showWarningMessage('DSH server is not running. Start it first.')
        return
      }
      await vscode.env.openExternal(vscode.Uri.parse(state.url))
    }),
    vscode.commands.registerCommand('dsh.showLogs', () => {
      logChannel?.show()
    }),
    vscode.commands.registerCommand('dsh.openInSecondarySidebar', async () => {
      // Opens the dsh chat view in the secondary sidebar (right side). The
      // same view can then live in both sidebars; the backend broadcasts to
      // every instance.
      await vscode.commands.executeCommand('workbench.view.extension.dsh')
      await vscode.commands.executeCommand('workbench.action.moveViewToSecondarySidebar', DshChatViewProvider.viewType)
      await vscode.commands.executeCommand('workbench.action.focusView', DshChatViewProvider.viewType)
    }),
    vscode.commands.registerCommand('dsh.addWorkspace', async () => {
      await addWorkspaceCommand(readConfig())
    }),
  )

  // Auto-start once, so opening the sidebar just works.
  void server.start().catch((err) => {
    showErrorWithReport(`DSH failed to start: ${messageOf(err)}`)
  })
}

/**
 * The dsh server process is deliberately left running and persisted: a
 * window reload reuses it instantly (no 1-minute cold start), and a stale
 * process is detected by a health check on the next activation. Use
 * `DSH: Stop server` to stop it explicitly.
 */
export function deactivate(): void {
  // Nothing to tear down: the server process outlives the extension host by
  // design (see above); DshServerManager.dispose() would stop it.
}

/** Error notification with a "report issue" action that opens GitHub issues. */
function showErrorWithReport(message: string): void {
  void vscode.window.showErrorMessage(message, '报告问题').then((choice) => {
    if (choice === '报告问题') void vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL))
  })
}

/**
 * Effective web port: 0 once a conflict forced a random port; otherwise the
 * configured value (vscode injects the package.json default of 3080).
 */
function portOf(useRandomPort: boolean, config: DshConfig): number {
  return useRandomPort ? 0 : config.port
}

/**
 * Quotes a path for shell-mode command lines (shell concatenates args
 * without escaping; spaces would split the token). cmd.exe metacharacters
 * that survive quoting — `&`/`|`/`^` split a command line even inside
 * quotes (verified empirically), and `%VAR%` expands inside quotes — are
 * refused outright: no quoting scheme passes them safely.
 */
function shellQuote(value: string): string {
  if (/[&|^<>%!"]/.test(value)) {
    throw new Error(
      `refusing to pass ${value} to cmd.exe: contains metacharacters (& | ^ < > % ! ") that cannot be quoted safely`,
    )
  }
  return /[\s'()]/.test(value) ? `"${value}"` : value
}

/** Handler for `dsh.addWorkspace`: adopt the current VS Code workspace folder. */
async function addWorkspaceCommand(config: DshConfig): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) {
    void vscode.window.showWarningMessage('DSH: open a workspace folder first.')
    return
  }
  const state = server?.current
  if (state?.kind !== 'running') {
    void vscode.window.showWarningMessage('DSH: server is not running. Start it first (DSH: Start server).')
    return
  }
  try {
    const result = await addWorkspace(state.url, folder.uri.fsPath)
    void vscode.window.showInformationMessage(
      result.created
        ? `DSH: added "${result.workspace.title}" to dsh workspaces.`
        : `DSH: "${result.workspace.title}" is already a dsh workspace.`,
    )
  } catch (err) {
    void vscode.window.showErrorMessage(`DSH: failed to add workspace — ${messageOf(err)}`)
  }
}

