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
import { accessSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { findReadyUrl, type ReadyLine } from './portParser.ts'
import type { DshConfig } from '../config.ts'

export type ServerState =
  | { kind: 'stopped' }
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
}

export interface RuntimeLaunch {
  command: string
  args: string[]
  /** Working directory for the child (also anchors module resolution). */
  cwd: string
}

/** How many auto-restarts are attempted after an unexpected exit. */
const MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = [500, 1000, 2000, 4000] as const
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
    if (current.kind === 'starting') {
      // A previous start is in flight; wait for its resolution.
      await this.waitUntilSettled()
      const settled = this.state
      if (settled.kind === 'running') return settled.url
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

  dispose(): void {
    void this.stop()
    this.emitter.dispose()
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
      this.attachExitWatch()
      return ready.url
    } catch (err) {
      this.setFailed(err instanceof Error ? err.message : String(err))
      throw err
    }
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

/** Builds the installed-mode runtime launch for an npm-installed dsh. */
export function installedLaunch(runtimePath: string, nodePath?: string): RuntimeLaunch {
  const bin = join(runtimePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return {
    command: nodeCommand(nodePath),
    args: [bin, 'web', '--port', '0'],
    cwd: runtimePath,
  }
}
