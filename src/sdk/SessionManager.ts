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

export interface SessionMeta {
  sessionId: string
  title: string
  createdAt: number
  parentId?: string
}

/** Structural subset of a session event as buffered for the UI. */
export type SessionEventLike = { type: string; [key: string]: unknown }

/**
 * Parses a `session.event` notification params object into its event.
 * Wire shape: `{ sessionId, event }` (packages/sdk/protocol types.ts).
 * @returns the event and its session, or undefined when the params do not
 * have the wire shape.
 */
export function parseSessionEvent(params: Record<string, unknown>): { sessionId: string; event: SessionEventLike } | undefined {
  const sessionId = params.sessionId
  const event = params.event
  if (typeof sessionId !== 'string' || !isEventLike(event)) return undefined
  return { sessionId, event }
}

/**
 * Parses a `subagent.started` notification params object.
 * Wire shape: `{ parentSessionId, childSessionId }`.
 */
export function parseSubagentStarted(params: Record<string, unknown>): { parentSessionId: string; childSessionId: string } | undefined {
  const parentSessionId = params.parentSessionId
  const childSessionId = params.childSessionId
  if (typeof parentSessionId !== 'string' || typeof childSessionId !== 'string') return undefined
  return { parentSessionId, childSessionId }
}

function isEventLike(value: unknown): value is SessionEventLike {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

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
        // Handshake failed; tear down and rebuild below.
        this.harness = undefined
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
    await this.harness.start()
    this.attachSubscription()
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
    const messageId = await harness.client.prompt(sessionId, [{ type: 'text', text }])
    this.log('debug', `prompt enqueued (${messageId})`)
  }

  /** Kills the runtime (v1 stop semantics: progress is lost). */
  async stopAgent(): Promise<void> {
    const harness = this.harness
    this.harness = undefined
    this.rootId = undefined
    this.eventBuffers.clear()
    if (harness !== undefined) await harness.close()
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
    return `session-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
  }

  dispose(): void {
    void this.stopAgent()
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
    void (async () => {
      try {
        for await (const notification of sub) {
          this.handleNotification(notification)
        }
      } catch (err) {
        this.opts.onFailure(err instanceof Error ? err : new Error(String(err)))
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

  private log(level: 'info' | 'debug', message: string): void {
    void level
  }
}

