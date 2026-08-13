/**
 * Phase 2 chat backend: React UI over the JSON-RPC SDK runtime.
 *
 * Message flow:
 *   webview ready → extensionReady {sessions}
 *   webview prompt → SessionManager.prompt (lazy runtime start + handshake)
 *   SessionManager notifications → forwarded to every live webview
 *   webview selectSession → sessionSnapshot (buffered events replayed)
 *
 * Multiple webviews (primary + secondary sidebar) share this backend;
 * replies are broadcast to all live views.
 */

import * as vscode from 'vscode'
import type { ChatBackend } from './DshChatBackend.ts'
import type { SessionManager } from '../sdk/SessionManager.ts'
import type { HostToWebviewMessage } from '../webview/protocol.ts'

interface Incoming {
  type?: string
  text?: string
  sessionId?: string
}

export class DshNativeBackend implements ChatBackend {
  private readonly views = new Set<vscode.Webview>()

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessions: SessionManager,
  ) {}

  renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const cspSource = webview.cspSource
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'main.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'))
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${cspSource} data:`,
      `connect-src http://127.0.0.1:*`,
      `font-src ${cspSource}`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>DSH</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }

  onMessage(message: unknown, webview: vscode.Webview): void {
    const msg = message as Incoming
    switch (msg.type) {
      case 'ready':
        // The sender joins the broadcast set; greet it with current state.
        this.views.add(webview)
        this.post(webview, { type: 'extensionReady', serverState: 'running', sessions: this.sessions.listSessions() })
        break
      case 'prompt': {
        const text = typeof msg.text === 'string' ? msg.text : ''
        if (text.trim().length === 0) return
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : this.sessions.newSessionId()
        void this.sessions.prompt(sessionId, text).catch((err) => this.handleFailure(err))
        this.broadcast({ type: 'status', state: 'running' })
        break
      }
      case 'selectSession': {
        if (typeof msg.sessionId === 'string') {
          this.post(webview, { type: 'sessionSnapshot', sessionId: msg.sessionId, events: this.sessions.snapshot(msg.sessionId) })
        }
        break
      }
      case 'stopAgent':
        void this.sessions.stopAgent()
        this.broadcast({ type: 'status', state: 'idle' })
        break
      case 'newSession': {
        const id = this.sessions.newSessionId()
        this.broadcast({ type: 'sessionsUpdated', sessions: [...this.sessions.listSessions(), { sessionId: id, title: 'New session', createdAt: Date.now() }] })
        break
      }
    }
  }

  onDidDispose(webview: vscode.Webview): void {
    this.views.delete(webview)
  }

  /** Pushes a live wire notification to every webview. */
  handleNotification(method: string, sessionId: string, params: Record<string, unknown>): void {
    if (method === 'session.status') {
      const status = params.status
      if (status === 'running' || status === 'idle') this.handleStatus(status)
      return
    }
    if (method === 'session.event') {
      // Send the individual event so the UI can stream; full snapshots are
      // replayed on selectSession.
      const buffer = this.sessions.snapshot(sessionId)
      this.broadcast({ type: 'sessionSnapshot', sessionId, events: buffer.slice(-1) })
      return
    }
    this.broadcast({ type: 'notification', n: { method, params } })
  }

  handleFailure(error: Error): void {
    this.broadcast({ type: 'error', message: error.message })
  }

  handleStatus(state: 'idle' | 'running'): void {
    this.broadcast({ type: 'status', state })
  }

  private post(webview: vscode.Webview, message: HostToWebviewMessage): void {
    void webview.postMessage(message)
  }

  private broadcast(message: HostToWebviewMessage): void {
    for (const view of this.views) {
      void view.postMessage(message)
    }
  }
}

function getNonce(): string {
  const text = `${Date.now()}-${Math.random()}`
  return Buffer.from(text).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
}
