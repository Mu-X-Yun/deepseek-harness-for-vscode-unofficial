import { afterEach, describe, expect, it, vi } from 'vitest'
import { addWorkspace } from '../src/workspace.ts'

/** One WorkspaceView as the dsh host returns it. */
function workspaceOf(path: string): {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
} {
  return {
    workspaceId: 'ws-1',
    path,
    title: path,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function serverResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('addWorkspace', () => {
  it('posts the workspace.create RPC and returns the value', async () => {
    const value = { workspace: workspaceOf('C:/proj'), created: true }
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      serverResponse({ result: { ok: true, value } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await addWorkspace('http://127.0.0.1:3080', 'C:/proj')

    expect(result).toEqual(value)
    // Carrier: POST /api/workspace.create with a client-request body.
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('http://127.0.0.1:3080/api/workspace.create')
    const body = JSON.parse(String((init as RequestInit).body)) as { type: string; method: string; payload: { path: string } }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('workspace.create')
    expect(body.payload.path).toBe('C:/proj')
  })

  it('reports an already-adopted directory as created: false', async () => {
    const value = { workspace: workspaceOf('C:/proj'), created: false }
    vi.stubGlobal('fetch', vi.fn(async () => serverResponse({ result: { ok: true, value } })))
    const result = await addWorkspace('http://127.0.0.1:3080', 'C:/proj')
    expect(result.created).toBe(false)
  })

  it('throws on a business error (HTTP 200, ok: false)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => serverResponse({ result: { ok: false, error: { code: 'E_PERM', message: 'denied' } } })),
    )
    await expect(addWorkspace('http://127.0.0.1:3080', 'C:/proj')).rejects.toThrow(
      'dsh workspace.create failed (E_PERM): denied',
    )
  })

  it('throws on a carrier error (non-200 HTTP)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => serverResponse({}, 404)))
    await expect(addWorkspace('http://127.0.0.1:3080', 'C:/proj')).rejects.toThrow(
      'dsh server rejected the request (HTTP 404)',
    )
  })

  it('throws when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    await expect(addWorkspace('http://127.0.0.1:3080', 'C:/proj')).rejects.toThrow('dsh server unreachable')
  })

  it('throws on a response without the expected result envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => serverResponse({ nope: true })))
    await expect(addWorkspace('http://127.0.0.1:3080', 'C:/proj')).rejects.toThrow(
      'dsh server returned an unexpected response',
    )
  })
})
