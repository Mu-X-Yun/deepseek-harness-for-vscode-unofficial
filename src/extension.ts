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
  repoInstalled,
  repoLaunch,
  SHARP_PIN,
  sharpVersion,
  webDistBuilt,
  type RuntimeLaunch,
  missingRuntimeFiles,
} from './server/DshServerManager.ts'
import { DshChatViewProvider } from './view/DshChatViewProvider.ts'
import { DshEmbeddedBackend, ISSUES_URL } from './view/DshEmbeddedBackend.ts'
import { DshNativeBackend } from './view/DshNativeBackend.ts'
import { SessionManager } from './sdk/SessionManager.ts'
import { addWorkspace } from './workspace.ts'

let server: DshServerManager | undefined
let sessions: SessionManager | undefined
let statusBar: vscode.StatusBarItem | undefined
let logChannel: vscode.OutputChannel | undefined

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
    ensureRuntime?: (force?: boolean) => Promise<void>
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
        // If the user already has a usable dsh (global install or npx
        // cache from `npx @deepseek-ai/dsh web`), reuse it instead of
        // downloading a fresh copy. Only adopt it when its sharp is the
        // pinned healthy version — an npx-cached install carries the broken
        // sharp 0.35.3 (no overrides there) and would fail to boot.
        const detectedRaw = findInstalledDsh(config.runtimePath)
        const detected = detectedRaw !== undefined && sharpVersion(detectedRaw) === SHARP_PIN ? detectedRaw : undefined
        if (detectedRaw !== undefined && detected === undefined) {
          logChannel?.appendLine(
            `[info] detected dsh at ${detectedRaw} has sharp ${String(sharpVersion(detectedRaw))} (broken); installing a healthy copy instead`,
          )
        }
        // A fresh cache dir for self-heal reinstalls: the user's global npm
        // cache can hold corrupt entries (flaky-network downloads), which
        // reproduce missing files on every reinstall.
        const freshCache = join(context.globalStorageUri.fsPath, 'npm-cache')
        const install = (extraArgs: string[] = []): Promise<void> => new Promise<void>((resolve, reject) => {
          const registry = readConfig().registry
          if (registry !== undefined) extraArgs = [...extraArgs, '--registry', shellQuote(registry)]
          // shell: true is required on Windows: .cmd shims (npm.cmd) cannot
          // be launched directly via CreateProcess and fail with EINVAL.
          // Shell mode concatenates args without escaping, so quote any
          // path that could contain spaces. Stream npm output into the DSH
          // log channel so the user can watch install progress.
          const child = execFile(
            npmCommand(),
            ['install', '--prefix', shellQuote(runtimeRoot), '@deepseek-ai/dsh', ...extraArgs],
            { shell: true, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
            (err) => {
              if (err) reject(new Error(`npm install @deepseek-ai/dsh failed: ${err.message}`))
              else resolve()
            },
          )
          child.stderr?.on('data', (chunk: Buffer) => {
            const line = chunk.toString().trim()
            if (line.length > 0) logChannel?.appendLine(`[npm] ${line}`)
          })
          child.stdout?.on('data', (chunk: Buffer) => {
            const line = chunk.toString().trim()
            if (line.length > 0) logChannel?.appendLine(`[npm] ${line}`)
          })
        })
        return {
          launch: installedLaunch(detected ?? runtimeRoot, config.nodePath, portOf(useRandomPort, config)),
          ensureRuntime: async (force = false) => {
            if (detected !== undefined && !force) return
            // npm sharp 0.35.3 (broken release) must be pinned away before
            // (re)installing; overrides force the whole tree to SHARP_PIN.
            ensureSharpPin(runtimeRoot)
            const version = sharpVersion(runtimeRoot)
            if (!force && hasDshBin(runtimeRoot) && version === SHARP_PIN) return
            if (force) logChannel?.appendLine(`[info] force-reinstalling @deepseek-ai/dsh into ${runtimeRoot}…`)
            else logChannel?.appendLine(`[info] installing @deepseek-ai/dsh into ${runtimeRoot}…`)
            // First install uses the user's global npm cache (fast when
            // packages are already downloaded); a corrupt-entry failure is
            // healed by onModuleMissing with a fresh dedicated cache.
            await install()
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
            // Flaky-network installs can leave partial packages; clear the
            // module tree (keeping the overrides package.json) and reinstall
            // from a FRESH npm cache — the user's global cache may itself
            // hold corrupt entries that reproduce the missing files.
            rmSync(join(runtimeRoot, 'node_modules'), { recursive: true, force: true })
            try {
              await install(['--cache', shellQuote(freshCache)])
            } catch {
              return false
            }
            // Verify the install actually produced the essential files.
            const missing = missingRuntimeFiles(runtimeRoot)
            if (missing.length > 0) {
              logChannel?.appendLine(`[error] reinstall still missing: ${missing.join(', ')}`)
              return false
            }
            return true
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
    ensureRuntime: async (force) => {
      await resolveRuntime().ensureRuntime?.(force)
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

  // Sidebar view: pick the backend by ui mode.
  const uiMode = readConfig().uiMode
  const native = uiMode === 'native'
  const backend: import('./view/DshChatBackend.ts').ChatBackend =
    native
      ? makeNativeBackend(context, extensionDir, server)
      : new DshEmbeddedBackend(server)
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

  // Status bar: only used in native mode (the SDK runtime has no port, so
  // the sidebar footer — embedded mode — cannot show one). In embedded mode
  // the port and workspace button live in the view's footer instead.
  if (native) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    statusBar.text = '$(server-process) DSH: native'
    statusBar.tooltip = 'dsh.ui.mode = native (SDK runtime)'
    statusBar.show()
    context.subscriptions.push(statusBar)
  }

  if (!native) {
    // Auto-start once, so opening the sidebar just works.
    void server.start().catch((err) => {
      showErrorWithReport(`DSH failed to start: ${messageOf(err)}`)
    })
  }
}

/**
 * Tears down the session plane only. The dsh server process is deliberately
 * left running and persisted: a window reload reuses it instantly (no
 * 1-minute cold start), and a stale process is detected by a health check on
 * the next activation. Use `DSH: Stop server` to stop it explicitly.
 */
export function deactivate(): Promise<void> {
  const tasks: Promise<void>[] = []
  if (sessions !== undefined) tasks.push(sessions.dispose())
  return Promise.all(tasks).then(() => {})
}


/** Error notification with a "report issue" action that opens GitHub issues. */
function showErrorWithReport(message: string): void {
  void vscode.window.showErrorMessage(message, '报告问题').then((choice) => {
    if (choice === '报告问题') void vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL))
  })
}

/** Effective web port: fixed default 3080, 0 once a conflict forced a random port. */
function portOf(useRandomPort: boolean, config: DshConfig): number {
  if (useRandomPort) return 0
  const configured = config.port
  return configured !== undefined && configured > 0 ? configured : 3080
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The npm executable: Node's spawn/execFile do not resolve `.cmd` shims on
 * Windows (npm ships as npm.cmd), so the plain `npm` name fails with ENOENT
 * inside the Extension Host.
 */
function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * Quotes a path for shell-mode command lines (shell concatenates args
 * without escaping; spaces would split the token).
 */
function shellQuote(path: string): string {
  return /[\s"']/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path
}

/** Handler for `dsh.addWorkspace`: adopt the current VS Code workspace folder. */
async function addWorkspaceCommand(config: DshConfig): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) {
    void vscode.window.showWarningMessage('DSH: open a workspace folder first.')
    return
  }
  if (config.uiMode === 'native') {
    // Native mode already runs the agent with the workspace folder as cwd;
    // the durable web-side workspace registry does not apply.
    void vscode.window.showInformationMessage(
      `DSH: native mode already uses "${folder.name}" as the agent working directory.`,
    )
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

function configRepoPath(extensionDir: string): string {
  const cfg = loadConfig(() => vscode.workspace.getConfiguration('dsh'))
  return cfg.runtimePath ?? defaultRepoPath(extensionDir) ?? extensionDir
}

/** Builds the phase 2 (native) backend and its session plane. */
function makeNativeBackend(
  context: vscode.ExtensionContext,
  extensionDir: string,
  _server: DshServerManager | undefined,
): import('./view/DshChatBackend.ts').ChatBackend {
  const config = loadConfig(() => vscode.workspace.getConfiguration('dsh'))
  let nativeBackend: DshNativeBackend
  sessions = new SessionManager({
    storagePath: context.globalStorageUri.fsPath,
    repoPath: configRepoPath(extensionDir),
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    env: buildEnv(process.env, config),
    model: config.model,
    nodePath: config.nodePath,
    onNotification: (n, sessionId) => nativeBackend.handleNotification(n.method, sessionId, n.params),
    onFailure: (error) => nativeBackend.handleFailure(error),
  })
  nativeBackend = new DshNativeBackend(context, sessions)
  return nativeBackend
}
