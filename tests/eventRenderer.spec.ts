import { describe, expect, it } from 'vitest'
import { renderEvent, renderEvents } from '../src/webview/eventRenderer.ts'

describe('renderEvent', () => {
  it('renders user messages as user bubbles', () => {
    const item = renderEvent({ type: 'user/message', message: { role: 'user', content: 'hi' } }, 0)
    expect(item?.role).toBe('user')
    expect(item?.text).toBe('hi')
  })

  it('extracts text from content block arrays', () => {
    const item = renderEvent({
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
    }, 1)
    expect(item?.role).toBe('assistant')
    expect(item?.text).toBe('hello\n world')
  })

  it('renders tool calls with name and raw arguments', () => {
    const item = renderEvent({ type: 'tool/call', callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }, 2)
    expect(item?.role).toBe('tool')
    expect(item?.toolName).toBe('bash')
    expect(item?.toolCallId).toBe('c1')
    expect(item?.argumentsJson).toBe('{"cmd":"ls"}')
  })

  it('marks tool result errors', () => {
    const item = renderEvent({ type: 'tool/result', callId: 'c1', error: { name: 'ExecError', code: 'E2' } }, 3)
    expect(item?.role).toBe('tool')
    expect(item?.error).toBe('ExecError (E2)')
  })

  it('skips log-only events', () => {
    expect(renderEvent({ type: 'request/header', header: {} }, 4)).toBeUndefined()
    expect(renderEvent({ type: 'session/end-seed' }, 5)).toBeUndefined()
  })

  it('keeps turn boundaries as meta', () => {
    expect(renderEvent({ type: 'turn/start', turn: 1 }, 6)?.role).toBe('meta')
    expect(renderEvent({ type: 'turn/end', turn: 1 }, 7)?.role).toBe('meta')
  })
})

describe('renderEvents', () => {
  it('folds chunk metas superseded by their assembled message', () => {
    const items = renderEvents([
      { type: 'assistant/chunk', step: 1, text: 'par' },
      { type: 'assistant/message', step: 1, message: { content: 'part one' } },
      { type: 'tool/call', callId: 'c2', name: 'read', arguments: '{}' },
    ])
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool'])
    expect(items[0]?.text).toBe('part one')
  })
})
