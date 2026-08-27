/**
 * Phase 2 session plane: owns the SDK runtime subprocess (DeepSeekHarness)
 * and maps wire notifications to per-session event buffers.
 *
 * The JSON-RPC protocol has no mid-turn cancel or session-list/resume
 * methods; `stopAgent` therefore closes the harness and rebuilds it (v1
 * semantics: progress is lost, documented in the README).
 */

import * as vscode from 'vscode'
import { DeepSeekHarness, HarnessClient, type HarnessNotification } from '../../../deepseek-harness-master/packages/sdk/client/src/index.ts'
import { jsonrpcAgentCommand, ensureRuntimeConfig } from './runtime.ts'
import {
  newSessionId,
  newSessionMeta,
  parseSessionEvent,
  parseSubagentStarted,
  type SessionEventLike,
  type SessionMeta,
} from './sessionCore.ts'

export type { SessionEventLike, SessionMeta }
export { newSessionId, newSessionMeta, parseSessionEvent, parseSubagentStarted }

export interface NotificationListener {
  (notification: HarnessNotification, sessionId: string): void
}

export interface SessionManagerOptions {
  storagePath: string
  repoPath: string
  workspaceFolder: string
  env: NodeJS.ProcessEnv
  model: string
  /** Node executable for the runtime subprocess (default `node`). */
  nodePath?: string
  /** Called with every wire notification for a known session. */
  onNotification: NotificationListener
  /** Called on transport-level failures (crash, handshake failure). */
  onFailure: (error: Error) => void
}

export class SessionManager implements vscode.Disposable {
  private readonly opts: SessionManagerOptions
  private harness: DeepSeekHarness | undefined
  private configPath: string
  private readonly sessions = new Map<string, SessionMeta>()
  private readonly eventBuffers = new Map<string, SessionEventLike[]>()
  private readonly parentBySession = new Map<string, string>()
  private rootId: string | undefined
  /**
   * Runtime generation: bumped whenever the harness is torn down and
   * rebuilt, so a stale notification-subscription iterator (draining the
   * previous client) stops forwarding and stops reporting failures.
   */
  private epoch = 0

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
    this.configPath = ensureRuntimeConfig(opts.storagePath, opts.repoPath)
  }

  /** Ensure the runtime subprocess is up and handshaken. */
  async ensureStarted(): Promise<void> {
    if (this.harness !== undefined) {
      try {
        await this.harness.start()
        return
      } catch {
        // Handshake failed; close the stale runtime (its child process
        // would otherwise leak) and rebuild below.
        await this.tearDownHarness()
      }
    }
    const { command, args } = jsonrpcAgentCommand(this.opts.repoPath, this.opts.nodePath)
    // The spawn cwd must be the repo: `--import tsx/esm` resolves tsx from
    // the process cwd. The agent's working directory travels separately via
    // DSH_CWD (bash/fs rows read it), and plugins resolve through the
    // config directory's junction into examples/node_modules.
    const env = { ...this.opts.env, DSH_CWD: this.opts.workspaceFolder }
    this.harness = new DeepSeekHarness({
      launch: {
        command,
        args: [...args, this.configPath],
        cwd: this.opts.repoPath,
        env,
        requestTimeoutMs: undefined, // a turn can legitimately run long
      },
      cwd: this.opts.workspaceFolder,
      provider: 'deepseek-official',
      model: this.opts.model,
    })
    try {
      await this.harness.start()
    } catch (err) {
      // Spawn or handshake failed: dispose the half-started runtime before
      // rethrowing, so a retry does not leak the child process.
      await this.tearDownHarness()
      throw err
    }
    this.attachSubscription()
  }

  /** Closes the current runtime (if any) and bumps the generation. */
  private async tearDownHarness(): Promise<void> {
    this.epoch += 1
    const harness = this.harness
    this.harness = undefined
    if (harness !== undefined) await harness.close().catch(() => {})
  }

  /**
   * Sends a prompt on the given session (or the root session). Sessions are
   * created lazily by the runtime on first prompt.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    await this.ensureStarted()
    const harness = this.harness
    if (harness === undefined) throw new Error('runtime not started')
    if (this.rootId === undefined) this.rootId = sessionId
    this.touchSession(sessionId)
    await harness.client.prompt(sessionId, [{ type: 'text', text }])
  }

  /** Kills the runtime (v1 stop semantics: progress is lost). */
  async stopAgent(): Promise<void> {
    this.rootId = undefined
    this.eventBuffers.clear()
    await this.tearDownHarness()
  }

  /** Snapshots the buffered events of a session (for view rebuilds). */
  snapshot(sessionId: string): SessionEventLike[] {
    return [...(this.eventBuffers.get(sessionId) ?? [])]
  }

  listSessions(): SessionMeta[] {
    return [...this.sessions.values()]
  }

  /**
   * Session id for a new conversation. After a runtime restart the old ids
   * are gone server-side; the UI shows the buffered history read-only and
   * starts fresh with this id.
   */
  newSessionId(): string {
    return newSessionId()
  }

  /**
   * Registers and returns a brand-new root session. The host owns session
   * ids: the webview must never mint its own, or the id it holds would not
   * match the one events arrive under.
   */
  newSession(): SessionMeta {
    const meta = newSessionMeta()
    this.sessions.set(meta.sessionId, meta)
    return meta
  }

  /** Closes the runtime; settles when the child has exited (awaited on reload). */
  dispose(): Promise<void> {
    return this.stopAgent()
  }

  // ------------------------------------------------------------------ //

  private attachSubscription(): void {
    const harness = this.harness
    if (harness === undefined) return
    // Drain the notification stream with an async iterator; the subscription
    // keeps the runtime's events flowing into the per-session buffers.
    this.listen(harness.client)
  }

  private listen(client: HarnessClient): void {
    // HarnessClient.subscribe returns a NotificationSubscription; we drain
    // it with an async iterator to avoid missing backpressure signals.
    const sub = client.subscribe()
    const myEpoch = this.epoch
    void (async () => {
      try {
        for await (const notification of sub) {
          // A rebuilt runtime has its own subscription; events from the
          // previous client must not reach the UI (or the failure channel).
          if (this.epoch !== myEpoch) return
          this.handleNotification(notification)
        }
      } catch (err) {
        if (this.epoch === myEpoch) {
          this.opts.onFailure(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()
  }

  private handleNotification(notification: HarnessNotification): void {
    const { method, params } = notification
    switch (method) {
      case 'session.event': {
        const parsed = parseSessionEvent(params)
        if (parsed === undefined) return
        this.touchSession(parsed.sessionId)
        const buffer = this.eventBuffers.get(parsed.sessionId) ?? []
        buffer.push(parsed.event)
        this.eventBuffers.set(parsed.sessionId, buffer)
        this.opts.onNotification(notification, parsed.sessionId)
        return
      }
      case 'subagent.started': {
        const parsed = parseSubagentStarted(params)
        if (parsed === undefined) return
        this.parentBySession.set(parsed.childSessionId, parsed.parentSessionId)
        this.touchSession(parsed.childSessionId, parsed.parentSessionId)
        return
      }
      case 'subagent.finished':
        return
      case 'session.status': {
        // Wire shape: { sessionId, status: 'idle' | 'running' }.
        const sessionId = params.sessionId as string | undefined
        if (sessionId !== undefined) this.touchSession(sessionId)
        return
      }
      default:
        return
    }
  }

  private touchSession(sessionId: string, parentId?: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        title: parentId === undefined ? `Session ${this.sessions.size + 1}` : 'Subagent',
        createdAt: Date.now(),
        parentId: parentId ?? this.parentBySession.get(sessionId),
      })
    }
  }
}

