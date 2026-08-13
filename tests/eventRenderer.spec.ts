import { describe, expect, it } from 'vitest'
import { renderEvent, renderEvents } from '../src/webview/eventRenderer.ts'

// Wire events are envelopes: { type, seq, time, data, surfaceOp? } — the
// payload lives in `data` (verified against live session.event payloads).

const userEvent = {
  type: 'user/message',
  seq: 4,
  time: 1,
  data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user', id: 'm1' },
  surfaceOp: 'append',
}

const assistantEvent = {
  type: 'assistant/message',
  seq: 84,
  time: 2,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think…' },
        { type: 'text', text: 'hello world' },
      ],
      source: { kind: 'model' },
    },
  },
  surfaceOp: 'append',
}

describe('renderEvent', () => {
  it('renders user messages from data.content (wire envelope shape)', () => {
    const item = renderEvent(userEvent, 0)
    expect(item?.role).toBe('user')
    expect(item?.text).toBe('hi')
  })

  it('extracts assistant text from data.message.content and skips reasoning blocks', () => {
    const item = renderEvent(assistantEvent, 1)
    expect(item?.role).toBe('assistant')
    expect(item?.text).toBe('hello world')
    expect(item?.turn).toBe(1)
    expect(item?.step).toBe(1)
  })

  it('renders tool calls with name and raw arguments from data', () => {
    const item = renderEvent({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } }, 2)
    expect(item?.role).toBe('tool')
    expect(item?.toolName).toBe('bash')
    expect(item?.toolCallId).toBe('c1')
    expect(item?.argumentsJson).toBe('{"cmd":"ls"}')
  })

  it('marks tool result errors', () => {
    const item = renderEvent({ type: 'tool/result', data: { callId: 'c1', error: { name: 'ExecError', code: 'E2' } } }, 3)
    expect(item?.role).toBe('tool')
    expect(item?.error).toBe('ExecError (E2)')
  })

  it('skips log-only events', () => {
    expect(renderEvent({ type: 'request/header', data: { header: {} } }, 4)).toBeUndefined()
    expect(renderEvent({ type: 'session/end-seed', data: {} }, 5)).toBeUndefined()
  })

  it('keeps turn boundaries as meta', () => {
    expect(renderEvent({ type: 'turn/start', data: { turn: 1 } }, 6)?.role).toBe('meta')
    expect(renderEvent({ type: 'turn/end', data: { turn: 1 } }, 7)?.role).toBe('meta')
  })
})

describe('renderEvents', () => {
  it('folds chunk metas superseded by their assembled message', () => {
    const items = renderEvents([
      { type: 'assistant/chunk', data: { step: 1, chunk: { text: 'par' } } },
      assistantEvent,
      { type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: '{}' } },
    ])
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool'])
    expect(items[0]?.text).toBe('hello world')
  })
})
