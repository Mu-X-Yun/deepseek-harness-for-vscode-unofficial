/**
 * Pure rendering of session events into chat UI items (phase 2).
 *
 * The event set mirrors `SessionEventMap` from `@deepseek-ai/dsh-session`
 * (packages/core/session/src/types.ts). Wire events are envelopes:
 * `{ type, seq, time, data, surfaceOp? }` — the payload lives in `data`
 * (verified against live `session.event` notifications). The renderer uses
 * a structural event type rather than importing the host's types, so it
 * stays a pure, unit-testable function.
 */

export type UiRole = 'user' | 'assistant' | 'tool' | 'system' | 'meta'

export interface UiItem {
  /** Stable key for React reconciliation. */
  key: string
  role: UiRole
  /** Event type that produced this item. */
  eventType: string
  text?: string
  toolName?: string
  toolCallId?: string
  argumentsJson?: string
  error?: string
  turn?: number
  step?: number
}

/** The fields the renderer reads from an event (a structural subset of SessionEvent). */
export interface RenderableEvent {
  type: string
  seq?: number
  time?: number
  /** SessionEvent envelope payload (wire shape: `data` holds the payload). */
  data?: {
    turn?: number
    step?: number
    callId?: string
    name?: string
    arguments?: string
    content?: unknown
    message?: {
      role?: string
      content?: unknown
      usage?: { inputTokens?: number; outputTokens?: number }
    }
    error?: { name?: string; code?: string }
    text?: string
    [key: string]: unknown
  }
  /** Unknown event payload fields are tolerated (structural subset). */
  [key: string]: unknown
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // ContentBlock[] — join text blocks; skip reasoning/tool blocks.
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block) {
        const b = block as { type?: string; text?: string; content?: string }
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

/**
 * Maps one session event to a UI item, or undefined when the event has no
 * chat surface (log-only events like `request/header` are skipped).
 */
export function renderEvent(event: RenderableEvent, index: number): UiItem | undefined {
  const d = event.data
  const base = { eventType: event.type, turn: d?.turn, step: d?.step }
  switch (event.type) {
    case 'user/message': {
      // data holds the UserMessage itself: { content, source, role, id }.
      const text = textOf(d?.content)
      return { ...base, key: `${index}-${event.type}`, role: 'user', text }
    }
    case 'assistant/message': {
      // data = { turn, step, message: AssistantMessage, usage? }.
      const text = textOf(d?.message?.content)
      return { ...base, key: `${index}-${event.type}`, role: 'assistant', text }
    }
    case 'assistant/chunk': {
      // Token-level stream chunks are aggregated into the assistant item by
      // the UI layer; here they are logged as meta for the (rare) replay view.
      return { ...base, key: `${index}-${event.type}`, role: 'meta', text: d?.text }
    }
    case 'tool/call': {
      return {
        ...base,
        key: `${index}-${event.type}-${d?.callId ?? ''}`,
        role: 'tool',
        toolName: d?.name,
        toolCallId: d?.callId,
        argumentsJson: typeof d?.arguments === 'string' ? d.arguments : undefined,
      }
    }
    case 'tool/result': {
      const error = d?.error as { name?: string; code?: string } | undefined
      return {
        ...base,
        key: `${index}-${event.type}-${d?.callId ?? ''}`,
        role: 'tool',
        toolCallId: d?.callId,
        error: error ? `${error.name} (${error.code})` : undefined,
      }
    }
    case 'turn/start':
      return { ...base, key: `${index}-${event.type}`, role: 'meta', text: `turn ${d?.turn} starts` }
    case 'turn/end':
      return { ...base, key: `${index}-${event.type}`, role: 'meta', text: `turn ${d?.turn} ends` }
    default:
      // Log-only events (request/header, request/context, todo/write,
      // session/end-seed, step boundaries) have no chat surface.
      return undefined
  }
}

/**
 * Renders an ordered event sequence into UI items. Consecutive assistant
 * chunks are folded into their assembled message; `assistant/message`
 * supersedes the chunks of its step.
 */
export function renderEvents(events: RenderableEvent[]): UiItem[] {
  const items: UiItem[] = []
  events.forEach((event, index) => {
    const item = renderEvent(event, index)
    if (item === undefined) return
    if (item.role === 'assistant') {
      // Drop any chunk-meta items from the same step, then add the message.
      const last = items[items.length - 1]
      if (last?.role === 'meta' && last.eventType === 'assistant/chunk' && last.step === item.step) {
        items.pop()
      }
      items.push(item)
    } else {
      items.push(item)
    }
  })
  return items
}
