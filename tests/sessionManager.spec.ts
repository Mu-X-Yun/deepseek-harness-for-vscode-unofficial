import { describe, expect, it } from 'vitest'
// Import from the pure core module: this spec must load on a machine
// WITHOUT the harness repo checkout (SessionManager.ts pulls the SDK
// client + junction setup).
import { newSessionId, newSessionMeta, parseSessionEvent, parseSubagentStarted } from '../src/sdk/sessionCore.ts'

describe('parseSessionEvent', () => {
  it('extracts the event envelope from the wire shape { sessionId, event }', () => {
    const event = { type: 'assistant/message', turn: 1, message: { content: 'hi' } }
    const parsed = parseSessionEvent({ sessionId: 's1', event })
    expect(parsed?.sessionId).toBe('s1')
    expect(parsed?.event.type).toBe('assistant/message')
  })

  it('rejects params missing the event envelope (regression: raw params used as event)', () => {
    expect(parseSessionEvent({ sessionId: 's1', type: 'assistant/message' })).toBeUndefined()
  })

  it('rejects non-string session ids and non-object events', () => {
    expect(parseSessionEvent({ sessionId: 1, event: { type: 'x' } })).toBeUndefined()
    expect(parseSessionEvent({ sessionId: 's1', event: 'raw' })).toBeUndefined()
  })
})

describe('parseSubagentStarted', () => {
  it('extracts parent and child session ids (regression: childSessionId field)', () => {
    const parsed = parseSubagentStarted({ parentSessionId: 'root', childSessionId: 'child-1' })
    expect(parsed?.parentSessionId).toBe('root')
    expect(parsed?.childSessionId).toBe('child-1')
  })

  it('rejects params without the wire shape', () => {
    expect(parseSubagentStarted({ parentSessionId: 'root', sessionId: 'child-1' })).toBeUndefined()
  })
})

describe('session id minting', () => {
  it('mints host-owned ids with the session- prefix (pure, no runtime needed)', () => {
    expect(newSessionId()).toMatch(/^session-[0-9a-f]{24}$/)
    // New ids are unique per call (the webview must never mint its own).
    expect(newSessionId()).not.toBe(newSessionId())
  })

  it('builds a fresh-root-session meta', () => {
    const meta = newSessionMeta()
    expect(meta.title).toBe('New session')
    expect(meta.sessionId).toMatch(/^session-[0-9a-f]{24}$/)
    expect(meta.parentId).toBeUndefined()
    expect(meta.createdAt).toBeGreaterThan(0)
  })
})
