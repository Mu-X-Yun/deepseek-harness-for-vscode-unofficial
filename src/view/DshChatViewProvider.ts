/**
 * Sidebar webview shell, backend-agnostic. The actual chat surface is a
 * {@link ChatBackend}: phase 1 embeds dsh's Web UI in an iframe, phase 2
 * renders the extension's React chat over the JSON-RPC SDK.
 *
 * The provider can resolve several webviews for the same view id (primary
 * and secondary sidebar locations); each is wired to the shared backend.
 */

import * as vscode from 'vscode'
import type { ChatBackend } from './DshChatBackend.ts'

export class DshChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'dsh.chat'

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: ChatBackend,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'out'),
      ],
    }
    webviewView.webview.html = this.backend.renderHtml(webviewView.webview)
    webviewView.webview.onDidReceiveMessage((message) => this.backend.onMessage(message, webviewView.webview))
    webviewView.onDidDispose(() => this.backend.onDidDispose(webviewView.webview))
    this.backend.attach?.(webviewView.webview)
  }
}
