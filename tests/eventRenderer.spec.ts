import { describe, expect, it } from 'vitest'
import { renderEvent, renderEvents, type RenderableEvent } from '../src/webview/eventRenderer.ts'

// Wire events are envelopes: { type, seq, time, data, surfaceOp? } — the
// payload lives in `data` (verified against live session.event payloads and
// the host's SessionEventMap in packages/core/session/src/types.ts).

/** Helper: an envelope with the wire shape, seq mandatory for replay tests. */
function ev(seq: number, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): RenderableEvent {
  return { type, seq, data, ...extra }
}

const userEvent = ev(4, 'user/message', {
  content: [{ type: 'text', text: 'hi' }],
  source: { kind: 'user' },
  role: 'user',
  id: 'm1',
})

const assistantEvent = ev(84, 'assistant/message', {
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
})

/** Wire shape of a text-delta chunk: { turn, step, chunk: StreamChunk }. */
function chunk(seq: number, turn: number, step: number, text: string): RenderableEvent {
  return ev(seq, 'assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text } })
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
    expect(item?.reasoning).toBe('think…')
    expect(item?.turn).toBe(1)
    expect(item?.step).toBe(1)
  })

  it('carries reasoning-only replies as visible reasoning text', () => {
    const item = renderEvent(ev(85, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking…' }] } }), 0)
    expect(item?.text).toBeUndefined()
    expect(item?.reasoning).toBe('thinking…')
  })

  it('renders tool calls with name and raw arguments from data', () => {
    const item = renderEvent(ev(3, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }), 2)
    expect(item?.role).toBe('tool')
    expect(item?.toolName).toBe('bash')
    expect(item?.toolCallId).toBe('c1')
    expect(item?.argumentsJson).toBe('{"cmd":"ls"}')
  })

  it('marks tool result errors and reads callId from data.message.source (wire shape)', () => {
    // Wire tool/result: { turn, step, message: { role, source: { kind:'tool', callId }, content }, error }.
    const item = renderEvent(
      ev(7, 'tool/result', {
        turn: 1,
        step: 3,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }],
        },
        error: { name: 'ExecError', code: 'E2' },
      }),
      3,
    )
    expect(item?.role).toBe('tool')
    expect(item?.toolCallId).toBe('c1')
    expect(item?.error).toBe('ExecError (E2)')
  })

  it('extracts chunk text from data.chunk.text (text-delta wire shape)', () => {
    const item = renderEvent(chunk(6, 1, 1, 'hello'), 0)
    expect(item?.role).toBe('meta')
    expect(item?.text).toBe('hello')
  })

  it('skips log-only events', () => {
    expect(renderEvent(ev(1, 'request/header', { header: {} }), 4)).toBeUndefined()
    expect(renderEvent(ev(2, 'session/end-seed', {}), 5)).toBeUndefined()
  })

  it('keeps turn boundaries as meta', () => {
    expect(renderEvent(ev(8, 'turn/start', { turn: 1 }), 6)?.role).toBe('meta')
    expect(renderEvent(ev(9, 'turn/end', { turn: 1 }), 7)?.role).toBe('meta')
  })
})

describe('renderEvents', () => {
  it('folds a step\'s chunks into a streaming item, superseded by its message', () => {
    const items = renderEvents([
      chunk(80, 1, 1, 'hel'),
      chunk(81, 1, 1, 'lo'),
      chunk(82, 1, 1, ' world'),
      assistantEvent,
      { type: 'tool/call', seq: 83, data: { callId: 'c2', name: 'read', arguments: '{}' } },
    ])
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool'])
    expect(items[0]?.text).toBe('hello world')
  })

  it('folds chunk streams incrementally across calls (the live per-event path)', () => {
    let items: ReturnType<typeof renderEvents> = []
    items = renderEvents([chunk(80, 1, 1, 'hel')], items)
    items = renderEvents([chunk(81, 1, 1, 'lo')], items)
    expect(items).toHaveLength(1)
    expect(items[0]?.role).toBe('assistant')
    expect(items[0]?.streaming).toBe(true)
    expect(items[0]?.text).toBe('hello')
    // The step's assembled message supersedes the streaming item.
    items = renderEvents([assistantEvent], items)
    expect(items).toHaveLength(1)
    expect(items[0]?.role).toBe('assistant')
    expect(items[0]?.streaming).toBeUndefined()
    expect(items[0]?.text).toBe('hello world')
  })

  it('keeps a multi-step turn streaming separately per step', () => {
    let items: ReturnType<typeof renderEvents> = []
    items = renderEvents([chunk(80, 1, 1, 'first ')], items)
    items = renderEvents([chunk(81, 1, 2, 'second')], items)
    expect(items.map((i) => i.text)).toEqual(['first ', 'second'])
  })

  it('dedups by seq so replaying a snapshot over live items is a no-op', () => {
    let items: ReturnType<typeof renderEvents> = []
    items = renderEvents([userEvent, assistantEvent], items)
    const replay = renderEvents([userEvent, assistantEvent], items)
    expect(replay).toHaveLength(items.length)
    expect(replay).toEqual(items)
  })

  it('re-selecting an already-streamed session adds nothing (full-buffer replay)', () => {
    // Live path streamed user + chunks + message one event at a time.
    let items: ReturnType<typeof renderEvents> = []
    for (const e of [userEvent, chunk(80, 1, 1, 'hel'), chunk(81, 1, 1, 'lo'), assistantEvent]) {
      items = renderEvents([e], items)
    }
    // selectSession replays the whole buffer: the same events in one call.
    const replay = renderEvents([userEvent, chunk(80, 1, 1, 'hel'), chunk(81, 1, 1, 'lo'), assistantEvent], items)
    expect(replay).toHaveLength(items.length)
    expect(replay).toEqual(items)
  })

  it('applies compaction surfaceOp replace by removing shadowed surface nodes', () => {
    const items = renderEvents([
      userEvent,
      assistantEvent,
      // Compaction emits a new assistant/message replacing surface nodes 0..1.
      ev(90, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'compacted summary' }] } }, { surfaceOp: { op: 'replace', start: 0, end: 1 } }),
    ])
    expect(items.map((i) => i.role)).toEqual(['assistant'])
    expect(items[0]?.text).toBe('compacted summary')
  })

  it('skips replacement when surfaceOp replace points outside the rendered range', () => {
    const items = renderEvents([
      userEvent,
      ev(90, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }, { surfaceOp: { op: 'replace', start: 5, end: 6 } }),
    ])
    expect(items.map((i) => i.role)).toEqual(['user', 'assistant'])
  })
})
