/**
 * Manages the `dsh web` child process lifecycle: spawn, ready-line port
 * parsing, restart with backoff, teardown, and crash diagnostics.
 *
 * Readiness: `dsh web --port 0` prints `dsh web: http://127.0.0.1:<port>`
 * on stdout once the Cordis loader has settled (packages/bundle/web-app
 * src/index.ts) — that line, not port polling, is the official signal.
 *
 * Teardown: SIGTERM first (dsh handles it gracefully on POSIX), then a
 * 3s grace period, then taskkill /T /F on Windows (kills the process tree,
 * preventing bash child leaks) or SIGKILL elsewhere.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { findReadyUrl, type ReadyLine } from './portParser.ts'
import type { DshConfig } from '../config.ts'
export { dshBinIn, ensureSharpPin, findInstalledDsh, globalNpmRoot, hasDshBin, installedLaunch, missingRuntimeFiles, npxCacheDsh, SHARP_PIN, sharpVersion } from './runtimeDetect.ts'
export type { RuntimeLaunch } from './runtimeDetect.ts'
import type { RuntimeLaunch } from './runtimeDetect.ts'

export type ServerState =
  | { kind: 'stopped' }
  | { kind: 'installing'; note?: string }
  | { kind: 'starting' }
  | { kind: 'running'; url: string; port: number }
  | { kind: 'failed'; reason: string }

export type StateChangeHandler = (state: ServerState) => void

export interface DshServerManagerOptions {
  /** Resolved runtime info (command/args/cwd) to spawn. */
  launch: () => RuntimeLaunch
  /** Synthesized child environment, re-read per spawn (settings may change). */
  env: () => NodeJS.ProcessEnv
  /** Pre-flight diagnostics; non-empty stops start(). */
  preflight: () => string[]
  /** Log sink (OutputChannel etc.). */
  log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
  /** Ready-line timeout in ms (first boot of a fresh profile is slow on Windows). */
  readyTimeoutMs?: number
  /** Optional async preparation (e.g. auto-installing the runtime) before preflight/spawn. */
  ensureRuntime?: (force?: boolean) => Promise<void>
  /** Directory for the persisted dsh state file (reuse across reloads). */
  storagePath: string
  /**
   * Called when startup failed because of missing/corrupt installed modules
   * (flaky-network npm installs leave partial packages). The handler should
   * force a reinstall and restart; return true when a retry was scheduled.
   */
  onModuleMissing?: () => Promise<boolean>
}

/** Persisted shape of a running dsh server (survives extension reloads). */
interface PersistedState {
  url: string
  port: number
  pid: number
  startedAt: number
}

/** How many auto-restarts are attempted after an unexpected exit. */
const MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = [500, 1000, 2000, 4000] as const
/** Installation considered "unusually long" after this many ms. */
const INSTALL_TIMEOUT_MS = 180_000
/** Lines of stderr kept for failure diagnostics. */
const STDERR_TAIL = 40

export class DshServerManager implements vscode.Disposable {
  private readonly opts: DshServerManagerOptions
  private readonly emitter = new vscode.EventEmitter<ServerState>()
  private child: ChildProcess | undefined
  private state: ServerState = { kind: 'stopped' }
  private stderrTail: string[] = []
  private restartCount = 0
  private stopping = false
  private stopped: (() => void) | undefined
  private readyTimer: NodeJS.Timeout | undefined
  /** One-shot guard: a missing-module reinstall is attempted at most once. */
  private moduleRetryUsed = false
  /** Fires when installation has been running unusually long. */
  private installTimer: NodeJS.Timeout | undefined

  /** Emits on every state transition. */
  readonly onDidChangeState: vscode.Event<ServerState> = this.emitter.event

  constructor(opts: DshServerManagerOptions) {
    this.opts = opts
  }

  get current(): ServerState {
    return this.state
  }

  /** Full recent stderr, for diagnostics and the log channel. */
  get diagnostics(): string {
    return this.stderrTail.join('\n')
  }

  /**
   * Starts (or returns) the running server. Idempotent: when already
   * running, resolves with the existing URL.
   * @throws Error when preflight fails or the ready line never appears.
   */
  async start(): Promise<string> {
    // Snapshot state into locals: TS narrowing does not survive the awaits
    // that mutate this.state through the event emitter.
    const current = this.state
    if (current.kind === 'running') return current.url
    if (current.kind === 'installing' || current.kind === 'starting') {
      // A previous start is in flight; wait for its resolution.
      await this.waitUntilSettled()
      const settled = this.state
      if (settled.kind === 'running') return settled.url
    }
    // A dsh server persisted by a previous activation (window reload keeps
    // the process alive) can be reused instead of cold-starting (~1 min).
    const reused = await this.tryReuse()
    if (reused !== undefined) return reused
    // Report installation progress distinctly from server startup.
    if (this.opts.ensureRuntime !== undefined) {
      this.armInstallTimeout()
      this.setState({ kind: 'installing' })
      await this.opts.ensureRuntime()
      clearTimeout(this.installTimer)
      this.installTimer = undefined
    }
    const problems = this.opts.preflight()
    if (problems.length > 0) {
      this.setFailed(problems.join(' '))
      throw new Error(problems.join(' '))
    }
    this.restartCount = 0
    return this.spawnAndWait()
  }

  /** Stops the server (idempotent). Resolves once the child has exited. */
  async stop(): Promise<void> {
    this.stopping = true
    clearTimeout(this.readyTimer)
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      // No live child in this instance. A reused server (from a previous
      // activation) is owned by a foreign pid recorded in the persisted
      // state — kill it directly.
      const persisted = this.readPersisted()
      this.clearPersisted()
      if (persisted !== undefined && this.state.kind === 'running') {
        await this.taskkill(persisted.pid)
      }
      this.stopping = false
      this.setState({ kind: 'stopped' })
      return
    }
    const exited = new Promise<void>((resolve) => {
      this.stopped = resolve
    })
    this.log('info', 'stopping dsh server')
    child.kill('SIGTERM')
    const grace = setTimeout(async () => {
      if (this.child !== child) return
      this.log('warn', `grace period elapsed; force-killing pid ${child.pid}`)
      if (process.platform === 'win32') {
        await this.taskkill(child.pid ?? -1)
      } else {
        child.kill('SIGKILL')
      }
    }, 3000)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
    clearTimeout(grace)
    this.stopping = false
    this.stopped = undefined
    this.child = undefined
    this.setState({ kind: 'stopped' })
  }

  /**
   * Stops the server and settles when the child has exited. Returning a
   * promise matters on window reload: VS Code awaits `deactivate`, and if
   * the dsh child is still running here it would collide with the next
   * activation's spawn (concurrent writes to $DSH_HOME, stuck startup).
   */
  dispose(): Promise<void> {
    const stopped = this.stop()
    this.emitter.dispose()
    return stopped
  }

  // ------------------------------------------------------------------ //

  private async spawnAndWait(): Promise<string> {
    const launch = this.opts.launch()
    this.setStarting()
    this.stderrTail = []
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: this.opts.env(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.log('info', `spawned dsh: ${launch.command} ${launch.args.join(' ')} (pid ${child.pid})`)

    const readyPromise = new Promise<ReadyLine>((resolve, reject) => {
      const timeout = this.opts.readyTimeoutMs ?? 120_000
      this.readyTimer = setTimeout(() => {
        reject(new Error(`dsh did not report a ready URL within ${timeout}ms. Recent stderr:\n${this.diagnostics}`))
      }, timeout)
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        this.log('debug', text.trimEnd())
        const ready = findReadyUrl(text)
        if (ready !== undefined) {
          clearTimeout(this.readyTimer)
          this.readyTimer = undefined
          resolve(ready)
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        this.pushStderr(text)
        this.log('error', text.trimEnd())
      })
      child.on('error', (err) => {
        clearTimeout(this.readyTimer)
        this.readyTimer = undefined
        reject(err)
      })
    })

    try {
      const ready = await Promise.race([
        readyPromise,
        new Promise<never>((_, reject) => {
          child.once('exit', (code, signal) => {
            if (this.readyTimer) clearTimeout(this.readyTimer)
            reject(new Error(`dsh exited before ready (code=${code}, signal=${signal}). Recent stderr:\n${this.diagnostics}`))
          })
        }),
      ])
      this.restartCount = 0
      this.setState({ kind: 'running', url: ready.url, port: ready.port })
      this.persist(child.pid ?? -1)
      this.attachExitWatch()
      return ready.url
    } catch (err) {
      this.setFailed(err instanceof Error ? err.message : String(err))
      // Flaky-network installs can leave partial packages (e.g. a missing
      // file inside typebox); surface a one-shot reinstall+retry instead of
      // failing permanently.
      const message = err instanceof Error ? err.message : String(err)
      if (!this.moduleRetryUsed && this.opts.onModuleMissing !== undefined && looksLikeMissingModule(message)) {
        this.moduleRetryUsed = true
        this.log('warn', 'startup failed with a missing-module error; reinstalling the runtime once')
        try {
          if (await this.opts.onModuleMissing()) {
            return this.spawnAndWait()
          }
        } catch {
          // reinstall failed; the failed state above stands
        }
      }
      throw err
    }
  }

  // ------------------------------------------------------------------ //
  // Persisted-state reuse: a dsh server started by a previous activation
  // survives window reloads (deactivate leaves it running); a fresh
  // activation reuses it instead of cold-starting.

  private stateFile(): string {
    return join(this.opts.storagePath, 'dsh-state.json')
  }

  private persist(pid: number): void {
    try {
      writeFileSync(this.stateFile(), JSON.stringify({
        url: this.state.kind === 'running' ? this.state.url : '',
        port: this.state.kind === 'running' ? this.state.port : 0,
        pid,
        startedAt: Date.now(),
      } satisfies PersistedState), 'utf8')
    } catch {
      // Persistence is best-effort; a failed write just means no reuse.
    }
  }

  private readPersisted(): PersistedState | undefined {
    try {
      const raw = readFileSync(this.stateFile(), 'utf8')
      const state = JSON.parse(raw) as Partial<PersistedState>
      if (typeof state.url === 'string' && typeof state.port === 'number' && typeof state.pid === 'number') {
        return state as PersistedState
      }
    } catch {
      // no state file yet
    }
    return undefined
  }

  private clearPersisted(): void {
    try {
      writeFileSync(this.stateFile(), '', 'utf8')
    } catch {
      // best-effort
    }
  }

  /** Reuses a persisted running server when its URL still responds. */
  private async tryReuse(): Promise<string | undefined> {
    const persisted = this.readPersisted()
    if (persisted === undefined) return undefined
    try {
      const response = await fetch(persisted.url, { method: 'GET', signal: AbortSignal.timeout(3_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      // Not reachable anymore; fall through to a cold start.
      this.clearPersisted()
      return undefined
    }
    this.log('info', `reusing dsh server at ${persisted.url} (pid ${persisted.pid})`)
    this.setState({ kind: 'running', url: persisted.url, port: persisted.port })
    return persisted.url
  }

  private attachExitWatch(): void {
    const child = this.child
    if (child === undefined) return
    child.once('exit', (code, signal) => {
      if (this.stopping) {
        if (this.stopped) this.stopped()
        return
      }
      this.log('error', `dsh exited unexpectedly (code=${code}, signal=${signal})`)
      if (this.restartCount < MAX_RESTARTS) {
        const delay = RESTART_BACKOFF_MS[this.restartCount] ?? 4000
        this.restartCount += 1
        this.log('warn', `restarting in ${delay}ms (attempt ${this.restartCount}/${MAX_RESTARTS})`)
        setTimeout(() => {
          void this.spawnAndWait().catch(() => this.log('error', 'restart attempt failed'))
        }, delay)
      } else {
        this.setFailed(`dsh exited unexpectedly (code=${code}, signal=${signal}) and restart limit reached`)
      }
    })
  }

  private waitUntilSettled(): Promise<void> {
    return new Promise((resolve) => {
      const sub = this.onDidChangeState((state) => {
        if (state.kind !== 'starting') {
          sub.dispose()
          resolve()
        }
      })
    })
  }

  private setStarting(): void {
    this.setState({ kind: 'starting' })
  }

  /**
   * After INSTALL_TIMEOUT_MS the overlay switches to "install manually"
   * guidance; the npm process keeps running and completes on its own.
   */
  private armInstallTimeout(): void {
    clearTimeout(this.installTimer)
    this.installTimer = setTimeout(() => {
      if (this.state.kind !== 'installing') return
      const cwd = this.opts.launch().cwd
      this.setState({
        kind: 'installing',
        note:
          '安装耗时较长。可自行安装后点击重试：\n' +
          `npm install --prefix "${cwd}" @deepseek-ai/dsh`,
      })
    }, INSTALL_TIMEOUT_MS)
  }

  private setFailed(reason: string): void {
    this.setState({ kind: 'failed', reason })
  }

  private setState(state: ServerState): void {
    this.state = state
    this.emitter.fire(state)
  }

  private pushStderr(text: string): void {
    this.stderrTail.push(...text.split(/\r?\n/).filter((l) => l.length > 0))
    if (this.stderrTail.length > STDERR_TAIL) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL)
    }
  }

  private taskkill(pid: number): Promise<void> {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
        if (err) this.log('warn', `taskkill failed: ${err.message}`)
        resolve()
      })
    })
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    this.opts.log(level, message)
  }
}

/** Matches module-resolution failures (missing/corrupt installs). */
function looksLikeMissingModule(message: string): boolean {
  return /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(message)
}

/** True when the repo checkout exists and has a Node module graph installed. */
export function repoInstalled(repoPath: string): boolean {
  try {
    accessSync(join(repoPath, 'node_modules'))
    return true
  } catch {
    return false
  }
}

/** True when the web frontend dist is built (apps/web/dist). */
export function webDistBuilt(repoPath: string): boolean {
  try {
    accessSync(join(repoPath, 'apps', 'web', 'dist', 'index.html'))
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the node executable used to spawn dsh.
 *
 * Do NOT use `process.execPath`: inside VS Code's Extension Host that is
 * Code.exe, whose embedded node (v24.18) breaks tsx's tsconfig-paths
 * resolution when dsh runs from source. The system node from PATH (or an
 * explicit `dsh.runtime.nodePath`) works reliably.
 */
export function nodeCommand(configuredPath: string | undefined): string {
  return configuredPath ?? 'node'
}

/** Builds the repo-mode runtime launch for a source checkout. */
export function repoLaunch(repoPath: string, nodePath?: string): RuntimeLaunch {
  return {
    command: nodeCommand(nodePath),
    args: ['--import', 'tsx/esm', join(repoPath, 'apps', 'cli', 'src', 'bin.ts'), 'web', '--port', '0'],
    cwd: repoPath,
  }
}

