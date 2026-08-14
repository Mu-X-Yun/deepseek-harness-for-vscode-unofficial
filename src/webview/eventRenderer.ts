/**
 * Pure rendering of session events into chat UI items (phase 2).
 *
 * The event set mirrors `SessionEventMap` from `@deepseek-ai/dsh-session`
 * (packages/core/session/src/types.ts). Wire events are envelopes:
 * `{ type, seq, time, data, surfaceOp? }` — the payload lives in `data`
 * (verified against live `session.event` notifications). The renderer uses
 * a structural event type rather than importing the host's types, so it
 * stays a pure, unit-testable function.
 *
 * Wire payload shapes (as emitted by the host, not invented by tests):
 *  - `assistant/chunk`: `data = { turn, step, chunk: StreamChunk }` where
 *    StreamChunk is a discriminated union; bubble text lives at
 *    `data.chunk.text` for `text-delta`/`reasoning-delta`, and at
 *    `data.chunk.block.text` for `block-end`.
 *  - `tool/result`: `data = { turn, step, message, error?, meta? }` where
 *    `message.source = { kind: 'tool', callId }` — there is no top-level
 *    `callId` on the payload.
 *  - `surfaceOp` is mandatory on surface events (`user/message`,
 *    `assistant/message`, `tool/result`) and compaction emits
 *    `{ op: 'replace', start, end }` to supersede surface nodes.
 */

export type UiRole = 'user' | 'assistant' | 'tool' | 'system' | 'meta'

export interface UiItem {
  /** Stable key for React reconciliation. */
  key: string
  role: UiRole
  /** Event type that produced this item. */
  eventType: string
  /** Monotonic session seq of the source event (undefined for synthetic items). */
  seq?: number
  text?: string
  /** Reasoning blocks of an assistant reply, shown when `text` is absent. */
  reasoning?: string
  toolName?: string
  toolCallId?: string
  argumentsJson?: string
  error?: string
  turn?: number
  step?: number
  /** True for the in-progress item token chunks accumulate into. */
  streaming?: boolean
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
    chunk?: { type?: string; text?: string; block?: { text?: string } }
    message?: {
      role?: string
      content?: unknown
      source?: { kind?: string; callId?: string }
      usage?: { inputTokens?: number; outputTokens?: number }
    }
    error?: { name?: string; code?: string }
    text?: string
    [key: string]: unknown
  }
  /** How a surface event entered the surface; compaction emits `{op:'replace'}`. */
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  /** Unknown event payload fields are tolerated (structural subset). */
  [key: string]: unknown
}

/** Only surface events carry `surfaceOp` and count as surface nodes. */
function isSurfaceRole(role: UiRole): boolean {
  return role === 'user' || role === 'assistant' || role === 'tool'
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

/** Reasoning blocks of a content array (shown when no text blocks exist). */
function reasoningOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string }
      if (b.type === 'reasoning' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Bubble text of a StreamChunk (wire shape: `data.chunk`). */
function chunkTextOf(d: RenderableEvent['data']): string | undefined {
  const chunk = d?.chunk
  if (chunk === undefined || typeof chunk !== 'object') return undefined
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' ? chunk.text : undefined
    case 'block-end':
      return typeof chunk.block?.text === 'string' ? chunk.block.text : undefined
    default:
      // block-start / tool-call-delta / usage / finish carry no bubble text.
      return undefined
  }
}

/**
 * Stable key for React reconciliation: `seq` is monotonic within a session,
 * so the key survives incremental appends (one event per live call) and
 * replays alike. Events without a seq (tests, synthetic) fall back to the
 * batch-local index.
 */
function keyOf(type: string, seq: number | undefined, index: number): string {
  return seq === undefined ? `${index}-${type}` : `${seq}-${type}`
}

/**
 * Maps one session event to a UI item, or undefined when the event has no
 * chat surface (log-only events like `request/header` are skipped).
 */
export function renderEvent(event: RenderableEvent, index: number): UiItem | undefined {
  const d = event.data
  const base = { eventType: event.type, seq: event.seq, turn: d?.turn, step: d?.step }
  switch (event.type) {
    case 'user/message': {
      // data holds the UserMessage itself: { content, source, role, id }.
      const text = textOf(d?.content)
      return { ...base, key: keyOf(event.type, event.seq, index), role: 'user', text }
    }
    case 'assistant/message': {
      // data = { turn, step, message: AssistantMessage, usage? }.
      const content = d?.message?.content
      return {
        ...base,
        key: keyOf(event.type, event.seq, index),
        role: 'assistant',
        text: textOf(content),
        reasoning: reasoningOf(content),
      }
    }
    case 'assistant/chunk': {
      // data = { turn, step, chunk: StreamChunk } — text lives on the chunk.
      return { ...base, key: keyOf(event.type, event.seq, index), role: 'meta', text: chunkTextOf(d) }
    }
    case 'tool/call': {
      return {
        ...base,
        key: keyOf(event.type, event.seq, index),
        role: 'tool',
        toolName: d?.name,
        toolCallId: d?.callId,
        argumentsJson: typeof d?.arguments === 'string' ? d.arguments : undefined,
      }
    }
    case 'tool/result': {
      // data = { turn, step, message: ToolResultMessage, error?, meta? };
      // the call id lives at message.source.callId (ToolMessageSource).
      const source = d?.message?.source
      const callId =
        source !== undefined && typeof source === 'object' && typeof source.callId === 'string' ? source.callId : d?.callId
      const error = d?.error as { name?: string; code?: string } | undefined
      return {
        ...base,
        key: keyOf(event.type, event.seq, index),
        role: 'tool',
        toolCallId: callId,
        error: error ? `${error.name} (${error.code})` : undefined,
      }
    }
    case 'turn/start':
      return { ...base, key: keyOf(event.type, event.seq, index), role: 'meta', text: `turn ${d?.turn} starts` }
    case 'turn/end':
      return { ...base, key: keyOf(event.type, event.seq, index), role: 'meta', text: `turn ${d?.turn} ends` }
    default:
      // Log-only events (request/header, request/context, todo/write,
      // session/end-seed, step boundaries) have no chat surface.
      return undefined
  }
}

/**
 * Removes every item matching `pred` (in place); returns how many were removed.
 */
function removeWhere(items: UiItem[], pred: (item: UiItem) => boolean): number {
  let removed = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it !== undefined && pred(it)) {
      items.splice(i, 1)
      removed++
    }
  }
  return removed
}

/**
 * Accumulates a token-level `assistant/chunk` into the step's streaming
 * assistant item. The step's `assistant/message` supersedes that item, so
 * token chunks never surface as individual meta rows (live or replay).
 * Chunks without bubble text (usage/finish/tool-call-delta) are dropped.
 */
function foldChunk(items: UiItem[], event: RenderableEvent): void {
  const d = event.data
  const turn = d?.turn
  const step = d?.step
  const text = chunkTextOf(d)
  if (text === undefined) return
  const last = items[items.length - 1]
  if (last !== undefined && last.role === 'assistant' && last.streaming === true && last.turn === turn && last.step === step) {
    items[items.length - 1] = { ...last, text: `${last.text ?? ''}${text}` }
  } else {
    items.push({
      key: `${turn ?? 0}-${step ?? 0}-stream`,
      role: 'assistant',
      eventType: 'assistant/chunk',
      streaming: true,
      text,
      turn,
      step,
    })
  }
}

/**
 * Applies a compaction `surfaceOp: { op: 'replace', start, end }`: the
 * shadowed surface nodes (start..end, counted over user/assistant/tool
 * items only — meta rows are not surface nodes) are replaced by `item` in
 * place. Plain appends (or a replace outside the rendered range) just push.
 */
function applySurfaceOp(items: UiItem[], event: RenderableEvent, item: UiItem): void {
  const op = event.surfaceOp
  if (op === undefined || op === 'append') {
    items.push(item)
    return
  }
  const { start, end } = op
  let from = -1
  const toRemove: number[] = []
  let surfaceIndex = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it !== undefined && isSurfaceRole(it.role)) {
      if (surfaceIndex >= start && surfaceIndex <= end) {
        if (from === -1) from = i
        toRemove.push(i)
      }
      surfaceIndex++
    }
  }
  if (from === -1) {
    items.push(item)
    return
  }
  items.splice(from, toRemove.length, item)
}

/**
 * Renders an ordered event sequence into UI items, incrementally: pass the
 * previously rendered items (`prev`) so the live per-event path (one event
 * per `session.event` notification) folds exactly like a full replay.
 *
 * - Token-level `assistant/chunk` events accumulate into one streaming
 *   assistant item per turn/step; the step's `assistant/message` supersedes
 *   it (and any leftover chunk metas) before being appended.
 * - Items are deduped by key (seq-based), so replaying a snapshot over
 *   already-rendered events — e.g. re-selecting a session that streamed
 *   live — is a no-op instead of duplicating the transcript.
 * - Compaction `surfaceOp: { op: 'replace', start, end }` removes the
 *   shadowed surface nodes and inserts the replacement in their place.
 */
export function renderEvents(events: RenderableEvent[], prev: UiItem[] = []): UiItem[] {
  const items = [...prev]
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'assistant/chunk') {
      foldChunk(items, event)
      continue
    }
    const item = renderEvent(event, index)
    if (item === undefined) continue
    if (item.role === 'assistant') {
      // Supersede the step's streaming item and any leftover chunk metas —
      // before the seq dedup check, so a replay that rebuilt a streaming
      // item from the buffer still folds it away cleanly.
      removeWhere(
        items,
        (it) =>
          (it.role === 'assistant' && it.streaming === true) || (it.role === 'meta' && it.eventType === 'assistant/chunk')
            ? it.turn === item.turn && it.step === item.step
            : false,
      )
    }
    if (items.some((it) => it.key === item.key)) continue // already rendered (seq)
    applySurfaceOp(items, event, item)
  }
  return items
}
