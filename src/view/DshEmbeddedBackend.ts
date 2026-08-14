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

/** GitHub issues page for bug reports. */
export const ISSUES_URL = 'https://github.com/Mu-X-Yun/deepseek-harness-for-vscode-unofficial/issues'

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
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
    #dsh-frame { flex: 1; min-height: 0; width: 100%; border: none; display: block; }
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
    #install-note {
      max-width: 90%; white-space: pre-wrap; word-break: break-all;
      font-size: 11px; opacity: 0.85; display: none;
    }
    #install-note.visible { display: block; }
    #footer {
      flex: none; height: 28px; z-index: 9;
      display: flex; align-items: center; gap: 8px; padding: 0 10px;
      font-size: 11px; box-sizing: border-box;
      color: var(--vscode-foreground); background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-widget-border, #ccc);
    }

    #footer button {
      border: none; cursor: pointer; padding: 2px 8px; border-radius: 3px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #footer .port-btn { background: none; color: inherit; padding: 2px 4px; }
    #footer .port-btn:hover { background: var(--vscode-list-hoverBackground); }
    #footer .spacer { flex: 1; }
  </style>
</head>
<body>
  <div id="banner"><span id="banner-text"></span><button id="banner-btn" hidden></button><button id="issue-btn" hidden></button></div>
  <div id="overlay"><div class="spinner"></div><span id="overlay-text">Loading…</span><span id="install-note"></span></div>
  <iframe id="dsh-frame" title="DeepSeek Harness"></iframe>
  <div id="footer">
    <button id="add-ws-btn" title="将当前 VS Code 工作区加入 DeepSeek Harness 工作区">＋ 工作区</button>
    <span class="spacer"></span>
    <button class="port-btn" id="port-btn" title="在浏览器中打开"></button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const frame = document.getElementById('dsh-frame')
    const banner = document.getElementById('banner')
    const bannerText = document.getElementById('banner-text')
    const bannerBtn = document.getElementById('banner-btn')
    const issueBtn = document.getElementById('issue-btn')
    const overlay = document.getElementById('overlay')
    const overlayText = document.getElementById('overlay-text')
    const installNote = document.getElementById('install-note')
    const portBtn = document.getElementById('port-btn')
    const addWsBtn = document.getElementById('add-ws-btn')
    portBtn.addEventListener('click', () => vscode.postMessage({ command: 'openInBrowser' }))
    addWsBtn.addEventListener('click', () => vscode.postMessage({ command: 'addWorkspace' }))
    let loadTimer = null
    let loaded = false
    let installTimer = null
    let installStartedAt = null
    bannerBtn.addEventListener('click', () => vscode.postMessage({ command: 'startOrRetry' }))
    issueBtn.addEventListener('click', () => vscode.postMessage({ command: 'reportIssue' }))
    function showBanner(text, buttonLabel, showIssue) {
      bannerText.textContent = text
      if (buttonLabel) { bannerBtn.textContent = buttonLabel; bannerBtn.hidden = false }
      else { bannerBtn.hidden = true }
      issueBtn.textContent = '报告问题'
      issueBtn.hidden = !showIssue
      banner.classList.add('visible')
    }
    function hideBanner() { banner.classList.remove('visible'); bannerBtn.hidden = true; issueBtn.hidden = true }
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
    function updateFooter(s) {
      if (s.kind === 'running') {
        portBtn.textContent = '● DeepSeek Harness: ' + s.port
      } else if (s.kind === 'starting' || s.kind === 'installing') {
        portBtn.textContent = '◌ DeepSeek Harness: 启动中…'
      } else if (s.kind === 'failed') {
        portBtn.textContent = '✕ DeepSeek Harness: 失败'
      } else {
        portBtn.textContent = '○ DeepSeek Harness: 未运行'
      }
    }
    window.addEventListener('message', (event) => {
      const msg = event.data
      if (!msg || msg.kind !== 'state') return
      const s = msg.state
      updateFooter(s)
      if (s.kind === 'running') {
        clearInterval(installTimer)
        installStartedAt = null
        installNote.classList.remove('visible')
        hideBanner()
        if (frame.getAttribute('src') !== s.url) {
          frame.setAttribute('src', s.url)
          loaded = false
          showOverlay('正在加载 DeepSeek Harness 界面…')
          armLoadTimer()
        } else if (!loaded) {
          // Same URL but never reported load (e.g. rebuilt shell): keep the
          // overlay armed so the user can tell loading is still in progress.
          showOverlay('正在加载 DeepSeek Harness 界面…')
          armLoadTimer()
        } else {
          // Already loaded; nothing to wait for.
          hideOverlay()
        }
      } else if (s.kind === 'installing') {
        frame.removeAttribute('src')
        // Persist the start time across poll re-pushes (every 15s the host
        // re-sends the installing state; without this the timer resets).
        // Prefer the host-provided start time: a webview rebuild (switching
        // sidebar views) resets this script's local variable, but the real
        // installation time survives in the state.
        if (s.startedAt !== undefined) installStartedAt = s.startedAt
        else if (installStartedAt === null) installStartedAt = Date.now()
        showOverlay('正在安装 DeepSeek Harness…（首次需要下载，请耐心等待）')
        installNote.classList.toggle('visible', !!s.note)
        installNote.textContent = s.note || ''
        clearInterval(installTimer)
        installTimer = setInterval(() => {
          const elapsed = Date.now() - installStartedAt
          overlayText.textContent = '正在安装 DeepSeek Harness…（已等待 ' + Math.round(elapsed / 1000) + ' 秒）'
        }, 1000)
      } else if (s.kind === 'starting') {
        clearInterval(installTimer)
        installStartedAt = null
        installNote.classList.remove('visible')
        frame.removeAttribute('src')
        showOverlay('正在启动 DeepSeek Harness 服务器…')
      } else if (s.kind === 'failed') {
        frame.removeAttribute('src')
        hideOverlay()
        showBanner('⚠ ' + s.reason, 'Retry', true)
      } else {
        frame.removeAttribute('src')
        hideOverlay()
        showBanner('DeepSeek Harness 已停止。', '启动')
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
    } else if (msg.command === 'addWorkspace') {
      void vscode.commands.executeCommand('dsh.addWorkspace')
    } else if (msg.command === 'openInBrowser') {
      void vscode.commands.executeCommand('dsh.openInBrowser')
    } else if (msg.command === 'reportIssue') {
      void vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL))
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
