/**
 * DSH VS Code extension entry point (phase 1: embedded Web UI).
 *
 * Assemblies: settings → dsh web server process → sidebar webview shell.
 * The server process is owned by the extension host (not the view), so the
 * chat survives hiding the view and is cleaned up on extension deactivate.
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { buildEnv, defaultRepoPath, loadConfig, type DshConfig } from './config.ts'
import {
  DshServerManager,
  dshBinIn,
  findInstalledDsh,
  hasDshBin,
  installedLaunch,
  repoInstalled,
  repoLaunch,
  webDistBuilt,
  type RuntimeLaunch,
} from './server/DshServerManager.ts'
import { DshChatViewProvider } from './view/DshChatViewProvider.ts'
import { DshEmbeddedBackend } from './view/DshEmbeddedBackend.ts'
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

  const resolveRuntime = (): { launch: RuntimeLaunch; preflight: () => string[]; ensureRuntime?: () => Promise<void> } => {
    const config = readConfig()
    switch (config.runtimeMode) {
      case 'installed': {
        const runtimePath = findInstalledDsh(config.runtimePath)
        if (runtimePath === undefined) {
          const hint = config.runtimePath === undefined
            ? 'No installed dsh found. Run `npm i -g @deepseek-ai/dsh` (or use `npx @deepseek-ai/dsh web` once), or set dsh.runtime.path.'
            : `No dsh at ${config.runtimePath} (expected ${dshBinIn(config.runtimePath)}).`
          return {
            launch: installedLaunch(config.runtimePath ?? '', config.nodePath),
            preflight: () => [hint],
          }
        }
        return {
          launch: installedLaunch(runtimePath, config.nodePath),
          preflight: () => [],
        }
      }
      case 'auto-install': {
        const runtimeRoot = join(context.globalStorageUri.fsPath, 'runtime')
        return {
          launch: installedLaunch(runtimeRoot, config.nodePath),
          ensureRuntime: async () => {
            if (hasDshBin(runtimeRoot)) return
            logChannel?.appendLine(`[info] installing @deepseek-ai/dsh into ${runtimeRoot}…`)
            await new Promise<void>((resolve, reject) => {
              // shell: true is required on Windows: .cmd shims (npm.cmd) cannot
              // be launched directly via CreateProcess and fail with EINVAL.
              // Shell mode concatenates args without escaping, so quote any
              // path that could contain spaces.
              execFile(npmCommand(), ['install', '--prefix', shellQuote(runtimeRoot), '@deepseek-ai/dsh'], { shell: true, windowsHide: true, timeout: 600_000 }, (err) => {
                if (err) reject(new Error(`npm install @deepseek-ai/dsh failed: ${err.message}`))
                else resolve()
              })
            })
          },
          preflight: () => hasDshBin(runtimeRoot) ? [] : ['dsh runtime is not installed yet (auto-install pending).'],
        }
      }
      case 'repo':
      default: {
        const repoPath = config.runtimePath ?? defaultRepoPath(extensionDir)
        if (repoPath === undefined) {
          return {
            launch: repoLaunch(extensionDir, config.nodePath),
            preflight: () => [
              'Could not locate the deepseek-harness-master checkout. ' +
              'Set dsh.runtime.path to the repo directory, or switch dsh.runtime.mode ' +
              'to "installed" (auto-detect global/npx dsh) or "auto-install" (install on first use).',
            ],
          }
        }
        return {
          launch: repoLaunch(repoPath, config.nodePath),
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
    log: (level, message) => logChannel?.appendLine(`[${level}] ${message}`),
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
        void vscode.window.showErrorMessage(`DSH failed to start: ${messageOf(err)}`)
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

  // Status bar: `DSH: running :53087` / `starting…` / `stopped` (embedded),
  // or a static badge in native mode (the SDK runtime has no port).
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  context.subscriptions.push(statusBar)

  // Status bar button: add the current VS Code workspace to dsh workspaces.
  // Only meaningful in embedded mode (native mode already uses the folder as
  // the agent cwd); the mode is fixed for the extension lifetime, so this is
  // a one-time visibility decision.
  const addWsButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  addWsButton.command = 'dsh.addWorkspace'
  addWsButton.text = '$(root-folder) Add workspace'
  addWsButton.tooltip = 'Add the current VS Code workspace to dsh workspaces'
  if (native) addWsButton.hide()
  else addWsButton.show()
  context.subscriptions.push(addWsButton)
  const updateStatusBar = (): void => {
    if (native) {
      statusBar!.text = '$(server-process) DSH: native'
      statusBar!.tooltip = 'dsh.ui.mode = native (SDK runtime)'
      statusBar!.show()
      return
    }
    const state = server!.current
    switch (state.kind) {
      case 'running':
        statusBar!.text = `$(server-process) DSH: ${state.port}`
        statusBar!.tooltip = state.url
        statusBar!.show()
        break
      case 'starting':
        statusBar!.text = '$(sync~spin) DSH: starting…'
        statusBar!.show()
        break
      case 'failed':
        statusBar!.text = '$(error) DSH: failed'
        statusBar!.tooltip = state.reason
        statusBar!.show()
        break
      default:
        statusBar!.text = '$(circle-slash) DSH: stopped'
        statusBar!.show()
    }
  }
  updateStatusBar()
  if (!native) {
    statusBar.command = 'dsh.openInBrowser'
    context.subscriptions.push(server.onDidChangeState(updateStatusBar))
    // Auto-start once, so opening the sidebar just works.
    void server.start().catch((err) => {
      void vscode.window.showErrorMessage(`DSH failed to start: ${messageOf(err)}`)
    })
  }
}

export function deactivate(): void {
  void sessions?.dispose()
  void server?.dispose()
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
