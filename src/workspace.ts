/**
 * dsh workspace RPC client (embedded mode): adopts the current VS Code
 * workspace folder as a dsh workspace via the web server's /api carrier.
 *
 * Wire format (packages/host/apiproxy): POST /api/<method> with a
 * `client-request` body; the response body is a `server-response` whose
 * `result` is `{ ok: true, value } | { ok: false, error }`. HTTP status
 * expresses only the carrier (400/404/415/500); business errors are 200.
 *
 * The browser-trust fence accepts this call: the request Host is a
 * loopback authority and Node's fetch sends no Origin / sec-fetch-site
 * markers, so no CSRF-style refusal applies.
 */

import { randomUUID } from 'node:crypto'

export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface AddWorkspaceResult {
  workspace: WorkspaceView
  /** False when the directory was already a dsh workspace. */
  created: boolean
}

/** Sends the `workspace.create` RPC; throws on carrier or business failure. */
export async function addWorkspace(serverUrl: string, folderPath: string): Promise<AddWorkspaceResult> {
  const body = {
    type: 'client-request',
    rpcId: `ext-${randomUUID()}`,
    method: 'workspace.create',
    payload: { path: folderPath },
  }
  let response: Response
  try {
    response = await fetch(`${serverUrl}/api/workspace.create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`dsh server unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!response.ok) {
    throw new Error(`dsh server rejected the request (HTTP ${response.status})`)
  }
  const message = await response.json() as {
    result?: { ok: true; value: AddWorkspaceResult } | { ok: false; error: { code?: string; message?: string } }
  }
  const result = message.result
  if (result === undefined) {
    throw new Error('dsh server returned an unexpected response')
  }
  if (!result.ok) {
    throw new Error(`dsh workspace.create failed (${result.error.code ?? 'unknown'}): ${result.error.message ?? ''}`)
  }
  return result.value
}
