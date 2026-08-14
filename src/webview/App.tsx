/**
 * Phase 2 chat UI root: handshake with the extension host, session state,
 * message stream rendering. Styling uses VS Code CSS variables throughout.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'
import type {
  HostToWebviewMessage,
  SessionMeta,
  WebviewToHostMessage,
} from './protocol.ts'
import { renderEvents, type RenderableEvent, type UiItem } from './eventRenderer.ts'
import { MessageList } from './components/MessageList.tsx'
import { Composer } from './components/Composer.tsx'
import { SessionList } from './components/SessionList.tsx'
import { StatusBar } from './components/StatusBar.tsx'

export type ServerState = 'idle' | 'starting' | 'running' | 'failed' | 'stopped'

interface ChatState {
  serverState: ServerState
  status: 'idle' | 'running'
  sessions: SessionMeta[]
  activeSessionId: string | undefined
  /** Rendered chat items per session id. */
  itemsBySession: Map<string, UiItem[]>
  error: string | undefined
}

type Action =
  | { type: 'ready'; sessions: SessionMeta[]; serverState: ServerState }
  | { type: 'status'; state: 'idle' | 'running' }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'active'; sessionId: string }
  | { type: 'items'; sessionId: string; items: UiItem[] }
  | { type: 'error'; message: string }

function reduce(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'ready':
      return { ...state, serverState: action.serverState, sessions: action.sessions, activeSessionId: action.sessions[0]?.sessionId }
    case 'status':
      return { ...state, status: action.state }
    case 'sessions':
      return { ...state, sessions: action.sessions }
    case 'active':
      return { ...state, activeSessionId: action.sessionId }
    case 'items': {
      // renderEvents is incremental and seq-deduping, so the full (possibly
      // replayed) item list replaces the session's previous one.
      const next = new Map(state.itemsBySession)
      next.set(action.sessionId, action.items)
      return { ...state, itemsBySession: next }
    }
    case 'error':
      return { ...state, error: action.message }
  }
}

const initialState: ChatState = {
  serverState: 'idle',
  status: 'idle',
  sessions: [],
  activeSessionId: undefined,
  itemsBySession: new Map(),
  error: undefined,
}

/** VS Code webview API, injected by the harness. */
declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void
  getState(): unknown
  setState(state: unknown): void
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialState)
  const vscodeRef = useRef<ReturnType<typeof acquireVsCodeApi>>()
  // Rendered items per session, mirrored outside React state so the message
  // listener (registered once) can feed renderEvents incrementally.
  const itemsRef = useRef<Map<string, UiItem[]>>(new Map())

  const applyEvents = useCallback((sessionId: string, events: RenderableEvent[]): void => {
    const prev = itemsRef.current.get(sessionId) ?? []
    const items = renderEvents(events, prev)
    if (items.length === prev.length) return // nothing new (seq-deduped)
    itemsRef.current = new Map(itemsRef.current).set(sessionId, items)
    dispatch({ type: 'items', sessionId, items })
  }, [])

  useEffect(() => {
    vscodeRef.current = acquireVsCodeApi()
    vscodeRef.current.postMessage({ type: 'ready' })
    const onMessage = (event: MessageEvent<HostToWebviewMessage>): void => {
      const msg = event.data
      switch (msg.type) {
        case 'extensionReady':
          dispatch({ type: 'ready', sessions: msg.sessions, serverState: msg.serverState })
          break
        case 'status':
          dispatch({ type: 'status', state: msg.state })
          break
        case 'sessionsUpdated':
          dispatch({ type: 'sessions', sessions: msg.sessions })
          break
        case 'sessionEvent':
          // One wire event (the live path): fold it into the session's items.
          applyEvents(msg.sessionId, [msg.event])
          break
        case 'sessionSnapshot':
          // Full replay (selectSession): renderEvents dedups by seq, so
          // re-selecting an already-streamed session adds nothing.
          applyEvents(msg.sessionId, msg.events)
          break
        case 'notification':
          // Other wire notifications are handled host-side; nothing to do.
          break
        case 'error':
          dispatch({ type: 'error', message: msg.message })
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [applyEvents])

  const send = useCallback(
    (text: string) => {
      vscodeRef.current?.postMessage({ type: 'prompt', text, sessionId: state.activeSessionId })
    },
    [state.activeSessionId],
  )

  const stop = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'stopAgent' })
  }, [])

  const selectSession = useCallback(
    (sessionId: string) => {
      vscodeRef.current?.postMessage({ type: 'selectSession', sessionId })
      dispatch({ type: 'active', sessionId })
    },
    [],
  )

  const newSession = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'newSession' })
    dispatch({ type: 'active', sessionId: `session-${Date.now()}` })
  }, [])

  const activeItems = state.activeSessionId !== undefined ? (state.itemsBySession.get(state.activeSessionId) ?? []) : []

  return (
    <div className="app">
      <StatusBar state={state.status} serverState={state.serverState} />
      {state.error !== undefined && <div className="error-banner">{state.error}</div>}
      <div className="app-body">
        <SessionList
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          onSelect={selectSession}
          onNew={newSession}
        />
        <div className="chat-pane">
          <MessageList items={activeItems} />
          <Composer disabled={state.serverState !== 'running' || state.status === 'running'} onSend={send} onStop={stop} running={state.status === 'running'} />
        </div>
      </div>
    </div>
  )
}
