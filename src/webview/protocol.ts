/**
 * postMessage protocol between the webview (phase 2 React UI) and the
 * extension host. Shared verbatim by both sides.
 *
 * Handshake mirrors the Claude Code extension pattern:
 *   webview: ready → host: extensionReady { … }
 */

/** One server notification as received off the wire (SDK HarnessNotification). */
export interface WireNotification {
  method: string
  params: Record<string, unknown>
}

/** A session event as rendered by the host (see eventRenderer). */
export interface RenderedEvent {
  /** Event type, e.g. `assistant/message`. */
  type: string
  /** Event payload fields of interest, copied verbatim. */
  [key: string]: unknown
}

export interface SessionMeta {
  sessionId: string
  title: string
  createdAt: number
  parentId?: string
}

/** webview → extension */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'prompt'; text: string; sessionId?: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'stopAgent' }

/** extension → webview */
export type HostToWebviewMessage =
  | { type: 'extensionReady'; serverState: 'idle' | 'starting' | 'running' | 'failed' | 'stopped'; sessions: SessionMeta[] }
  | { type: 'status'; state: 'idle' | 'running' }
  | { type: 'notification'; n: WireNotification }
  | { type: 'sessionSnapshot'; sessionId: string; events: RenderedEvent[] }
  | { type: 'sessionsUpdated'; sessions: SessionMeta[] }
  | { type: 'error'; message: string }
