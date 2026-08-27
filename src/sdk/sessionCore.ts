/**
 * Pure session-plane primitives — EVERYTHING here is dependency-free so it
 * can be unit-tested on a machine without the harness repo checkout (the
 * SDK client import must live only in SessionManager.ts, which owns the
 * runtime subprocess).
 */

import { randomUUID } from 'node:crypto'

export interface SessionMeta {
  sessionId: string
  title: string
  createdAt: number
  parentId?: string
}

/** Structural subset of a session event as buffered for the UI. */
export type SessionEventLike = { type: string; [key: string]: unknown }

/**
 * Pure: mints a host-owned session id (the webview must never mint its own,
 * or the id it holds would not match the one events arrive under).
 */
export function newSessionId(): string {
  return `session-${randomUUID().replaceAll('-', '').slice(0, 24)}`
}

/**
 * Pure: builds the meta for a brand-new root session. Testing this needs
 * no runtime (no junction, no repo checkout).
 */
export function newSessionMeta(id: string = newSessionId()): SessionMeta {
  return { sessionId: id, title: 'New session', createdAt: Date.now() }
}

/**
 * Parses a `session.event` notification params object into its event.
 * Wire shape: `{ sessionId, event }` (packages/sdk/protocol types.ts).
 * @returns the event and its session, or undefined when the params do not
 * have the wire shape.
 */
export function parseSessionEvent(params: Record<string, unknown>): { sessionId: string; event: SessionEventLike } | undefined {
  const sessionId = params.sessionId
  const event = params.event
  if (typeof sessionId !== 'string' || !isEventLike(event)) return undefined
  return { sessionId, event }
}

/**
 * Parses a `subagent.started` notification params object.
 * Wire shape: `{ parentSessionId, childSessionId }`.
 */
export function parseSubagentStarted(params: Record<string, unknown>): { parentSessionId: string; childSessionId: string } | undefined {
  const parentSessionId = params.parentSessionId
  const childSessionId = params.childSessionId
  if (typeof parentSessionId !== 'string' || typeof childSessionId !== 'string') return undefined
  return { parentSessionId, childSessionId }
}

function isEventLike(value: unknown): value is SessionEventLike {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}
