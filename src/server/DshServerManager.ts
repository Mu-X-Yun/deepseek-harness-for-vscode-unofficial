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
import { createConnection } from 'node:net'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { findReadyUrl, hasDshBootManifest, type ReadyLine } from './portParser.ts'
import { DEFAULT_PROFILE, profileOfArgs } from './profileDetect.ts'
import type { DshConfig } from '../config.ts'
export { dshBinIn, ensureSharpPin, findInstalledDsh, globalNpmRoot, hasDshBin, installedLaunch, missingRuntimeFiles, npmCommand, npxCacheDsh, resolveInstallRoot, SHARP_BROKEN, SHARP_PIN, sharpVersion } from './runtimeDetect.ts'
export type { RuntimeLaunch } from './runtimeDetect.ts'
import type { RuntimeLaunch } from './runtimeDetect.ts'

export type ServerState =
  | { kind: 'stopped' }
  | { kind: 'installing'; note?: string; startedAt?: number }
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
  ensureRuntime?: () => Promise<void>
  /**
   * Optional user consent gate before {@link ensureRuntime} runs. The
   * callback decides whether an install is actually needed; when it returns
   * false the start fails with {@link INSTALL_DECLINED_MESSAGE} and no
   * install state is entered.
   */
  confirmEnsureRuntime?: () => Promise<boolean>
  /** Directory for the persisted dsh state file (reuse across reloads). */
  storagePath: string
  /**
   * The dsh profile the launch boots. Live-read (settings can change);
   * defaults to `web`. Reuse checks refuse instances of other profiles,
   * and the persisted state records it per instance.
   */
  profile?: () => string
  /**
   * The configured FIXED web port (0 = random). Live-read; the fixed-port
   * adoption probe uses THIS, not the launch args — after a port-conflict
   * fallback the launch carries `--port 0`, and probing that would never
   * find the foreign web the fallback was avoiding. Defaults to 3080.
   */
  fixedPort?: () => number
  /**
   * Port-free probe used before a cold start to decide whether the fixed
   * port (free again?) should replace a random-port launch. Injectable for
   * tests; defaults to a loopback connect probe.
   */
  probePort?: (port: number) => Promise<boolean>
  /**
   * Called when startup failed because of missing/corrupt installed modules
   * (flaky-network npm installs leave partial packages). The handler should
   * force a reinstall and restart; return true when a retry was scheduled.
   */
  onModuleMissing?: () => Promise<boolean>
  /** Called when the fixed port is already in use; switch to a random port. */
  onPortConflict?: () => Promise<boolean>
  /**
   * Restart backoff delays (ms) between auto-restarts after an unexpected
   * exit. Injectable for tests; defaults to {@link RESTART_BACKOFF_MS}.
   */
  restartBackoffMs?: readonly number[]
  /** Auto-restart budget after an unexpected exit. Injectable for tests. */
  maxRestarts?: number
  /**
   * How long a server must stay up after a ready line before the restart
   * budget is refilled. Injectable for tests; defaults to
   * {@link RESTART_STABILITY_MS}.
   */
  restartStabilityMs?: number
}

/** Persisted shape of a running dsh server (survives extension reloads). */
interface PersistedState {
  url: string
  port: number
  pid: number
  startedAt: number
  /** The profile this instance boots; absent on pre-profile state files (= web). */
  profile?: string
}

/** How many auto-restarts are attempted after an unexpected exit. */
const MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = [500, 1000, 2000, 4000] as const
/**
 * Uptime after a ready line that refills the restart budget. Without the
 * window, every successful boot resets the counter and a crash-looping
 * server restarts forever; with it, the budget bounds crashes within each
 * stability window while a long-lived server keeps a fresh budget.
 */
const RESTART_STABILITY_MS = 30_000
/** Installation considered "unusually long" after this many ms. */
const INSTALL_TIMEOUT_MS = 60_000
/** Lines of stderr kept for failure diagnostics. */
const STDERR_TAIL = 40

/** Failure reason when the user declines the auto-install confirmation. */
export const INSTALL_DECLINED_MESSAGE = '已取消 dsh 自动安装（点击 Retry 可重新选择）'

/** Failure reason when stop() lands during an in-flight start (suppressed toast). */
export const STOPPED_DURING_START_MESSAGE = 'dsh 服务器在启动/安装期间被停止'

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
  /** Refills {@link restartCount} after a stability window (see RESTART_STABILITY_MS). */
  private stabilityTimer: NodeJS.Timeout | undefined
  /** One-shot guard: a missing-module reinstall is attempted at most once. */
  private moduleRetryUsed = false
  /** One-shot guard: a port-conflict respawn happens at most once per start. */
  private portRetryUsed = false
  /** Fires when installation has been running unusually long. */
  private installTimer: NodeJS.Timeout | undefined
  /** Real installation start time (survives webview rebuilds via the state). */
  private installStartedAt: number | undefined
  /** Install cwd captured at installation start (for the 60s timeout note). */
  private installCwd: string | undefined
  /** Profile of the instance this manager spawned (see {@link runningProfile}). */
  private childProfile: string | undefined

  /** Emits on every state transition. */
  readonly onDidChangeState: vscode.Event<ServerState> = this.emitter.event

  constructor(opts: DshServerManagerOptions) {
    this.opts = opts
  }

  get current(): ServerState {
    return this.state
  }

  /**
   * The profile of the currently running instance, when it can be known:
   *  - own spawned child → its launch `--profile`;
   *  - adopted persisted instance → the recorded profile;
   *  - adopted fixed-port external service → `web` (the 3080 convention).
   * Undefined while not running. A profile switch compares against this to
   * decide whether an already-running target can be adopted as-is.
   */
  get runningProfile(): string | undefined {
    if (this.state.kind !== 'running') return undefined
    if (this.child !== undefined && this.childProfile !== undefined) return this.childProfile
    const persisted = this.readPersisted()
    if (persisted !== undefined) return persisted.profile ?? DEFAULT_PROFILE
    return DEFAULT_PROFILE
  }

  /** Full recent stderr, for diagnostics and the log channel. */
  get diagnostics(): string {
    return this.stderrTail.join('\n')
  }

  /**
   * Starts (or returns) the running server. Idempotent: when already
   * running, resolves with the existing URL. Concurrent calls — e.g. a
   * double-click on the footer Retry while the install confirmation is
   * visible — share ONE attempt, so the confirmation dialog and
   * ensureRuntime / install run exactly once.
   * @param options - `skipReuse` forces a cold start, bypassing both the
   * persisted-server and the fixed-port adoption checks (tests use this).
   * Normal starts only ever adopt instances of the configured profile.
   * @throws Error when preflight fails or the ready line never appears.
   */
  async start(options: { skipReuse?: boolean } = {}): Promise<string> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.doStart(options)
    try {
      return await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  /** The in-flight {@link start} attempt; concurrent callers join it. */
  private startPromise: Promise<string> | undefined
  /**
   * Generation token: every stop() bumps it, so an in-flight start whose
   * install crosses a stop can detect the abort (stop() resets `stopping`
   * synchronously in its no-child branch, making that flag unreliable).
   */
  private startEpoch = 0

  private async doStart(options: { skipReuse?: boolean }): Promise<string> {
    // Snapshot state into locals: TS narrowing does not survive the awaits
    // that mutate this.state through the event emitter.
    const current = this.state
    if (current.kind === 'running') return current.url
    // Snapshot the generation token BEFORE any await: a stop() landing
    // during reuse detection or while the confirmation dialog is open must
    // abort this attempt just like one during an install. (stop() resets
    // `stopping` synchronously in its no-child branch, so the token is the
    // only reliable signal.)
    const attemptEpoch = this.startEpoch
    if (current.kind === 'installing' || current.kind === 'starting') {
      // A previous start is in flight; wait for its resolution.
      await this.waitUntilSettled()
      const settled = this.state
      if (settled.kind === 'running') return settled.url
    }
    if (!options.skipReuse) {
      const expected = this.opts.profile?.() ?? DEFAULT_PROFILE
      // A dsh server persisted by a previous activation (window reload keeps
      // the process alive) can be reused instead of cold-starting (~1 min).
      // Instances of OTHER profiles are never adopted — that would keep the
      // wrong profile running.
      const reused = await this.tryReuse(expected)
      if (reused !== undefined) return reused
      // A dsh web already running on the fixed port (e.g. the user launched
      // `npx @deepseek-ai/dsh web` themselves) is reused as-is — the fixed
      // port belongs to the default `web` profile by convention.
      const external = await this.tryReuseWellKnownPort(expected)
      if (external !== undefined) return external
    }
    // Report installation progress distinctly from server startup. A failed
    // install must transition to 'failed' (banner + Retry) instead of leaving
    // the manager stuck in 'installing' with the timer armed forever — the
    // webview only renders the Retry affordance on 'failed'.
    if (this.opts.ensureRuntime !== undefined) {
      // Ask before anything installs: the user must consent to the download
      // before the state flips to 'installing' (the callback decides whether
      // an install is actually needed, so no prompt appears when a healthy
      // runtime already exists).
      if (this.opts.confirmEnsureRuntime !== undefined) {
        const confirmed = await this.opts.confirmEnsureRuntime()
        if (!confirmed) {
          this.setFailed(INSTALL_DECLINED_MESSAGE)
          throw new Error(INSTALL_DECLINED_MESSAGE)
        }
        // A stop() while the confirmation was open aborts the attempt.
        if (this.startAborted(attemptEpoch)) throw new Error(STOPPED_DURING_START_MESSAGE)
      }
      // Record the install cwd once (the 60s timeout note needs it); the
      // timeout later must not re-run the runtime resolution.
      try {
        this.installCwd = this.opts.launch().cwd
      } catch {
        this.installCwd = undefined
      }
      this.armInstallTimeout()
      this.installStartedAt = Date.now()
      this.setState({ kind: 'installing', startedAt: this.installStartedAt })
      try {
        await this.opts.ensureRuntime()
      } catch (err) {
        const message = messageOf(err)
        clearTimeout(this.installTimer)
        this.installTimer = undefined
        this.setFailed(message)
        throw err instanceof Error ? err : new Error(message)
      }
      clearTimeout(this.installTimer)
      this.installTimer = undefined
      // A stop() during a long install must not silently start the server
      // afterwards — the user explicitly asked to stop.
      if (this.startAborted(attemptEpoch)) throw new Error(STOPPED_DURING_START_MESSAGE)
    }
    // Final check before preflight/spawn: covers reuse/confirm windows on
    // attempts without ensureRuntime too.
    if (this.startAborted(attemptEpoch)) throw new Error(STOPPED_DURING_START_MESSAGE)
    const problems = this.opts.preflight()
    if (problems.length > 0) {
      this.setFailed(problems.join(' '))
      throw new Error(problems.join(' '))
    }
    this.restartCount = 0
    return this.spawnAndWait()
  }

  /**
   * True when a stop() landed since the attempt began; transitions to
   * 'stopped' once (idempotent) and clears install scratch state.
   */
  private startAborted(attemptEpoch: number): boolean {
    if (this.startEpoch === attemptEpoch) return false
    this.installCwd = undefined
    this.installStartedAt = undefined
    if (this.state.kind !== 'stopped') this.setState({ kind: 'stopped' })
    return true
  }

  /**
   * Stops the server (idempotent). Resolves once the child has exited.
   * @param options - `preserveProfile` keeps an adopted instance of that
   * profile alive (its persisted row is left in place so the next start
   * re-adopts it instead of cold-starting). Profile switches use this to
   * avoid killing the target instance they are about to take over.
   */
  async stop(options: { preserveProfile?: string } = {}): Promise<void> {
    this.stopping = true
    // Invalidate any in-flight start attempt (install-in-progress abort).
    this.startEpoch += 1
    clearTimeout(this.readyTimer)
    clearTimeout(this.stabilityTimer)
    this.stabilityTimer = undefined
    // A stop during an install must not leave the UI timer armed: the state
    // leaves 'installing', and the timer's own guard would no-op, but the
    // handle would still reference the closed-over state machine.
    clearTimeout(this.installTimer)
    this.installTimer = undefined
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      // No live child in this instance. A reused server (from a previous
      // activation) is owned by a foreign pid recorded in the persisted
      // state — kill it directly, unless it runs the profile to preserve.
      // Preservation does not require a 'running' state: after a window
      // reload the state is 'stopped' while the persisted instance may
      // still be alive and is exactly the target of an upcoming switch.
      const persisted = this.readPersisted()
      const preserved = persisted !== undefined
        && (persisted.profile ?? DEFAULT_PROFILE) === options.preserveProfile
      if (!preserved) this.clearPersisted()
      if (persisted !== undefined && this.state.kind === 'running' && !preserved) {
        await this.taskkill(persisted.pid)
      }
      this.stopping = false
      this.setState({ kind: 'stopped' })
      return
    }
    const exited = new Promise<void>((resolve) => {
      this.stopped = resolve
      // The exit watcher (attachExitWatch) is only attached after a ready
      // line; a child from a failed start would otherwise leave stop()
      // waiting for the full 10s fallback. Resolve on the child's own exit.
      child.once('exit', () => resolve())
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

  /**
   * Disposes the state emitter WITHOUT stopping the server — the dsh
   * process deliberately outlives the extension host (window reload reuses
   * it), so deactivate must not kill the child, only release host-side
   * listeners.
   */
  disposeEmitter(): void {
    this.emitter.dispose()
  }

  // ------------------------------------------------------------------ //

  private async spawnAndWait(): Promise<string> {
    let launch = this.opts.launch()
    // A port-conflict fallback (`--port 0`) is remembered for the whole
    // activation, but the fixed port may have become free since (e.g. the
    // foreign process was closed): probe it and prefer it when free, so the
    // server returns to the well-known port instead of a random one. Only a
    // launch that ACTUALLY carries `--port` participates: a bare `node -e`
    // command (tests, other consumers) must never get `--port` appended —
    // node itself rejects the unknown option (exit 9).
    const fixedPort = this.opts.fixedPort?.() ?? 3080
    if (
      fixedPort !== 0
      && launch.args.includes('--port')
      && portOfArgs(launch.args) === 0
      && await (this.opts.probePort ?? isPortFree)(fixedPort)
    ) {
      launch = { ...launch, args: withPortArg(launch.args, fixedPort) }
      this.log('info', `port ${fixedPort} is free again; using it instead of a random port`)
    }
    this.setStarting()
    this.stderrTail = []
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: this.opts.env(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.childProfile = profileOfArgs(launch.args)
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
          // 'close', not 'exit': close fires only after the stdio pipes have
          // drained, so the rejection's diagnostics carry the child's full
          // stderr. On 'exit' the pipe callbacks can still be pending, and
          // the EADDRINUSE / missing-module retry decisions would read an
          // empty diagnostics buffer (a real race on quick failures).
          child.once('close', (code, signal) => {
            if (this.readyTimer) clearTimeout(this.readyTimer)
            reject(new Error(`dsh exited before ready (code=${code}, signal=${signal}). Recent stderr:\n${this.diagnostics}`))
          })
        }),
      ])
      // Refill the restart budget only after the server has stayed up for a
      // stability window; resetting on every ready line would let a
      // crash-loop restart forever (the budget never drains).
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = setTimeout(() => {
        this.restartCount = 0
      }, this.opts.restartStabilityMs ?? RESTART_STABILITY_MS)
      this.setState({ kind: 'running', url: ready.url, port: ready.port })
      this.persist(child.pid ?? -1, this.childProfile ?? DEFAULT_PROFILE)
      this.attachExitWatch()
      return ready.url
    } catch (err) {
      this.setFailed(messageOf(err))
      // Flaky-network installs can leave partial packages (e.g. a missing
      // file inside typebox); surface a one-shot reinstall+retry instead of
      // failing permanently.
      const message = messageOf(err)
      // A fixed port already in use fails the boot; fall back to a random
      // port once (the caller flips its launch to --port 0).
      const stderrText = this.diagnostics
      if (
        !this.portRetryUsed &&
        this.opts.onPortConflict !== undefined &&
        /EADDRINUSE|address already in use|listen EADDRINUSE/.test(stderrText)
      ) {
        this.portRetryUsed = true
        this.log('warn', 'port conflict detected; retrying with a random port')
        try {
          if (await this.opts.onPortConflict()) {
            return this.spawnAndWait()
          }
        } catch {
          // fallback failed; the failed state above stands
        }
      }
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

  private persist(pid: number, profile: string): void {
    try {
      writeFileSync(this.stateFile(), JSON.stringify({
        url: this.state.kind === 'running' ? this.state.url : '',
        port: this.state.kind === 'running' ? this.state.port : 0,
        pid,
        startedAt: Date.now(),
        profile,
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

  /**
   * Reuses a dsh web already listening on the configured fixed port. This
   * covers a user-started `npx @deepseek-ai/dsh web`: adopting the running
   * instance avoids both a redundant install and a port/profile conflict.
   * Detection: the dsh index page embeds the `window.__DSH_BOOT__` manifest.
   * The fixed port belongs to the default `web` profile by convention —
   * targets of other profiles never adopt it (they would silently keep a
   * web instance running under the wrong profile name).
   */
  private async tryReuseWellKnownPort(expectedProfile: string): Promise<string | undefined> {
    if (expectedProfile !== DEFAULT_PROFILE) return undefined
    // The configured fixed port — NOT the launch's `--port`, which is 0
    // after a port-conflict fallback and would make this probe a no-op even
    // though the foreign web is exactly what the fallback avoided.
    const port = this.opts.fixedPort?.() ?? 3080
    if (port === 0) return undefined
    const url = `http://127.0.0.1:${port}`
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3_000) })
      if (!response.ok) return undefined
      const text = await response.text()
      // A structurally valid __DSH_BOOT__ manifest, not a mere substring:
      // any page containing the marker string must not be mistaken for dsh.
      if (!hasDshBootManifest(text)) return undefined
    } catch {
      return undefined
    }
    this.log('info', `reusing externally started dsh web at ${url}`)
    this.setState({ kind: 'running', url, port })
    return url
  }

  /** Reuses a persisted running server when its URL still responds. */
  private async tryReuse(expectedProfile: string): Promise<string | undefined> {
    const persisted = this.readPersisted()
    if (persisted === undefined) return undefined
    // A persisted instance of another profile must not be adopted — that
    // would keep the wrong profile running. Clear it and cold-start.
    if ((persisted.profile ?? DEFAULT_PROFILE) !== expectedProfile) {
      this.clearPersisted()
      return undefined
    }
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
    const backoff = this.opts.restartBackoffMs ?? RESTART_BACKOFF_MS
    const maxRestarts = this.opts.maxRestarts ?? MAX_RESTARTS
    child.once('exit', (code, signal) => {
      if (this.stopping) {
        if (this.stopped) this.stopped()
        return
      }
      this.log('error', `dsh exited unexpectedly (code=${code}, signal=${signal})`)
      if (this.restartCount < maxRestarts) {
        const delay = backoff[this.restartCount] ?? backoff[backoff.length - 1] ?? 4000
        this.restartCount += 1
        this.log('warn', `restarting in ${delay}ms (attempt ${this.restartCount}/${maxRestarts})`)
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
   * guidance; the npm process keeps running and completes on its own. Uses
   * the cwd captured at installation start — re-running the runtime
   * resolution inside the timer would spawn npm again and, on failure,
   * leave an unhandled rejection inside the timeout.
   */
  private armInstallTimeout(): void {
    clearTimeout(this.installTimer)
    this.installTimer = setTimeout(() => {
      if (this.state.kind !== 'installing') return
      const cwd = this.installCwd
      this.setState({
        kind: 'installing',
        startedAt: this.installStartedAt,
        note:
          '安装耗时较长。可自行安装后点击重试：\n' +
          (cwd === undefined ? 'npm install @deepseek-ai/dsh' : `npm install --prefix "${cwd}" @deepseek-ai/dsh`),
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

/** Error-to-string conversion shared by the host and the server manager. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Matches module-resolution failures (missing/corrupt installs). */
function looksLikeMissingModule(message: string): boolean {
  // Node 24 reports both "Cannot find module" and "Cannot find package";
  // ESM import failures surface either, depending on the resolve stage.
  return /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(message)
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

/**
 * Builds the repo-mode runtime launch for a source checkout. Boots the
 * chosen profile via the launcher flag (the `web` subcommand only aliases
 * `--profile web`, so the flag form is the one that names any profile).
 */
export function repoLaunch(repoPath: string, nodePath?: string, port = 0, profile = DEFAULT_PROFILE): RuntimeLaunch {
  return {
    command: nodeCommand(nodePath),
    args: ['--import', 'tsx/esm', join(repoPath, 'apps', 'cli', 'src', 'bin.ts'), '--profile', profile, '--port', String(port)],
    cwd: repoPath,
  }
}

/** The numeric value of the `--port` pair in launcher args (0 when absent). */
function portOfArgs(args: readonly string[]): number {
  const index = args.indexOf('--port')
  const value = index >= 0 ? args[index + 1] : undefined
  const port = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(port) ? port : 0
}

/** Returns the args with the `--port` value replaced (appended when absent). */
function withPortArg(args: readonly string[], port: number): string[] {
  const index = args.indexOf('--port')
  if (index < 0) return [...args, '--port', String(port)]
  const next = [...args]
  next[index + 1] = String(port)
  return next
}

/**
 * True when nothing is listening on the loopback port: a connect attempt is
 * refused (ECONNREFUSED). Anything else — accepted, reset, unreachable,
 * timeout — counts as occupied, so the probe never races into a used port.
 */
export function isPortFree(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const done = (free: boolean): void => {
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(false))
    socket.once('error', (err) => done((err as NodeJS.ErrnoException).code === 'ECONNREFUSED'))
    socket.once('timeout', () => done(false))
  })
}

