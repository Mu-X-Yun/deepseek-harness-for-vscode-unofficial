/**
 * Phase 1 chat backend: an iframe shell hosting dsh's own Web UI.
 *
 * VS Code forbids redirecting the webview itself to an external URL (the
 * parent frame's CSP is `frame-src 'self'`), but an iframe inside the
 * webview is a separate context and can load loopback HTTP freely — the
 * same pattern VS Code's Live Preview extension uses. The dsh server sets
 * no CSP / X-Frame-Options / frame-ancestors, so nothing blocks the embed.
 *
 * Security: the iframe and the dsh server are same-origin (127.0.0.1:<port>),
 * so /api RPC and the /api/events.* WebSockets pass the browser-trust
 * fence; external pages cannot forge that origin, so embedding does not
 * widen dsh's attack surface.
 *
 * Multiple webviews (primary + secondary sidebar) share this backend;
 * server state is broadcast to every live view.
 */

import * as vscode from 'vscode'
import type { ChatBackend } from './DshChatBackend.ts'
import type { DshServerManager, ServerState } from '../server/DshServerManager.ts'

interface ToWebviewMessage {
  kind: 'state'
  state: ServerState
}

interface Incoming {
  command?: string
}

export class DshEmbeddedBackend implements ChatBackend {
  private readonly views = new Set<vscode.Webview>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly server: DshServerManager) {
    // One subscription for all views; broadcasts to each live one.
    this.disposables.push(this.server.onDidChangeState((state) => this.post({ kind: 'state', state })))
  }

  attach(webview: vscode.Webview): void {
    this.views.add(webview)
  }

  renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const cspSource = webview.cspSource
    // frame-src must allow loopback dsh servers on any port (Live Preview
    // uses the same `http://localhost:*` / `http://127.0.0.1:*` pattern).
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${cspSource} data:`,
      `frame-src http://127.0.0.1:*`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    #dsh-frame { width: 100%; height: 100%; border: none; display: block; }
    #banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      padding: 8px 12px; font-size: 12px; box-sizing: border-box;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-widget-border, #ccc); display: none;
    }
    #banner.visible { display: flex; align-items: center; gap: 8px; }
    #banner button {
      border: none; cursor: pointer; padding: 2px 8px; border-radius: 2px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #overlay {
      position: fixed; inset: 0; z-index: 5; display: none;
      flex-direction: column; align-items: center; justify-content: center; gap: 10px;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      font-size: 12px; text-align: center; padding: 20px;
    }
    #overlay.visible { display: flex; }
    #overlay .spinner {
      width: 20px; height: 20px; border-radius: 50%;
      border: 2px solid var(--vscode-widget-border, #888); border-top-color: var(--vscode-button-background);
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="banner"><span id="banner-text"></span><button id="banner-btn" hidden></button></div>
  <div id="overlay"><div class="spinner"></div><span id="overlay-text">Loading…</span></div>
  <iframe id="dsh-frame" title="DeepSeek Harness"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const frame = document.getElementById('dsh-frame')
    const banner = document.getElementById('banner')
    const bannerText = document.getElementById('banner-text')
    const bannerBtn = document.getElementById('banner-btn')
    const overlay = document.getElementById('overlay')
    const overlayText = document.getElementById('overlay-text')
    let loadTimer = null
    let loaded = false
    bannerBtn.addEventListener('click', () => vscode.postMessage({ command: 'startOrRetry' }))
    function showBanner(text, buttonLabel) {
      bannerText.textContent = text
      if (buttonLabel) { bannerBtn.textContent = buttonLabel; bannerBtn.hidden = false }
      else { bannerBtn.hidden = true }
      banner.classList.add('visible')
    }
    function hideBanner() { banner.classList.remove('visible'); bannerBtn.hidden = true }
    function showOverlay(text) {
      overlayText.textContent = text
      overlay.classList.add('visible')
    }
    function hideOverlay() {
      overlay.classList.remove('visible')
      clearTimeout(loadTimer)
      loadTimer = null
    }
    // iframe finished loading the dsh UI — hide the loading overlay.
    frame.addEventListener('load', () => {
      loaded = true
      hideOverlay()
      hideBanner()
    })
    // Fallback: if the frame never reports load, surface a timeout with retry.
    function armLoadTimer() {
      clearTimeout(loadTimer)
      loadTimer = setTimeout(() => {
        if (overlay.classList.contains('visible')) {
          showOverlay('界面加载超时。请检查 DSH 日志（命令面板 → DSH: Show server logs）。')
        }
      }, 45_000)
    }
    window.addEventListener('message', (event) => {
      const msg = event.data
      if (!msg || msg.kind !== 'state') return
      const s = msg.state
      if (s.kind === 'running') {
        hideBanner()
        if (frame.getAttribute('src') !== s.url) {
          frame.setAttribute('src', s.url)
          loaded = false
          showOverlay('正在加载 DSH 界面…')
          armLoadTimer()
        } else if (!loaded) {
          // Same URL but never reported load (e.g. rebuilt shell): keep the
          // overlay armed so the user can tell loading is still in progress.
          showOverlay('正在加载 DSH 界面…')
          armLoadTimer()
        } else {
          // Already loaded; nothing to wait for.
          hideOverlay()
        }
      } else if (s.kind === 'starting') {
        frame.removeAttribute('src')
        showOverlay('正在启动 dsh 服务器…')
      } else if (s.kind === 'failed') {
        frame.removeAttribute('src')
        hideOverlay()
        showBanner('⚠ ' + s.reason, 'Retry')
      } else {
        frame.removeAttribute('src')
        hideOverlay()
        showBanner('dsh stopped.', 'Start')
      }
    })
    // Handshake: ask the host for the current state once the listener is
    // registered. Survives webview rebuilds (hide → show), where the state
    // push at attach time would otherwise arrive before this script ran.
    vscode.postMessage({ command: 'ready' })
    // Health poll: recovers from any missed broadcast (e.g. the running
    // push arrived while the shell was still initializing), so the sidebar
    // never stays blank for more than one poll interval.
    setInterval(() => vscode.postMessage({ command: 'poll' }), 15_000)
  </script>
</body>
</html>`
  }

  onMessage(message: unknown, webview: vscode.Webview): void {
    const msg = message as Incoming
    if (msg.command === 'ready' || msg.command === 'poll') {
      // 'ready': the shell's script is live — re-send current state (the
      // push at attach time may have arrived before the listener existed).
      // 'poll': periodic health poll — recovers from any lost broadcast, so
      // the sidebar never stays blank even if a state push was missed.
      this.postTo(webview, { kind: 'state', state: this.server.current })
    } else if (msg.command === 'startOrRetry') {
      void this.server.start().catch(() => { /* state change already surfaced the failure */ })
    }
  }

  onDidDispose(webview: vscode.Webview): void {
    this.views.delete(webview)
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose()
    this.views.clear()
  }

  private post(message: ToWebviewMessage): void {
    for (const view of this.views) {
      void view.postMessage(message)
    }
  }

  private postTo(webview: vscode.Webview, message: ToWebviewMessage): void {
    void webview.postMessage(message)
  }
}

function getNonce(): string {
  const text = `${Date.now()}-${Math.random()}`
  return Buffer.from(text).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
}
