/**
 * Chat backend abstraction for the sidebar view: phase 1 embeds dsh's own
 * Web UI in an iframe; phase 2 renders the extension's React chat over the
 * JSON-RPC SDK. The provider shell delegates rendering and message handling.
 *
 * The same view can be opened in both the primary and the secondary sidebar
 * at once — VS Code creates one webview per location. Backends must treat
 * views as a set and broadcast state to all of them.
 */

import * as vscode from 'vscode'

export interface ChatBackend {
  /** Renders the webview HTML. */
  renderHtml(webview: vscode.Webview): string
  /** Handles one webview→host message; `webview` identifies the sender. */
  onMessage(message: unknown, webview: vscode.Webview): void
  /** Fires when one webview disposes (backend state cleanup, not the server). */
  onDidDispose(webview: vscode.Webview): void
  /** Optional: called once after render to wire host-side subscriptions. */
  attach?(webview: vscode.Webview): void
}
