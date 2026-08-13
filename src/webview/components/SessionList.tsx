/** Session list with subagent tree nesting (parentId edges) and New session. */

import type { SessionMeta } from '../protocol.ts'

export interface SessionListProps {
  sessions: SessionMeta[]
  activeSessionId: string | undefined
  onSelect: (sessionId: string) => void
  onNew: () => void
}

export function SessionList({ sessions, activeSessionId, onSelect, onNew }: SessionListProps): JSX.Element {
  const roots = sessions.filter((s) => s.parentId === undefined)
  const childrenOf = (id: string): SessionMeta[] => sessions.filter((s) => s.parentId === id)

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span>Sessions</span>
        <button type="button" className="new-session" onClick={onNew} title="New session">＋</button>
      </div>
      {roots.map((root) => (
        <SessionNode key={root.sessionId} session={root} childrenOf={childrenOf} activeSessionId={activeSessionId} onSelect={onSelect} depth={0} />
      ))}
      {sessions.length === 0 && <div className="session-empty">No sessions yet.</div>}
    </div>
  )
}

function SessionNode({ session, childrenOf, activeSessionId, onSelect, depth }: {
  session: SessionMeta
  childrenOf: (id: string) => SessionMeta[]
  activeSessionId: string | undefined
  onSelect: (id: string) => void
  depth: number
}): JSX.Element {
  const children = childrenOf(session.sessionId)
  return (
    <div>
      <button
        type="button"
        className={`session-node${session.sessionId === activeSessionId ? ' active' : ''}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(session.sessionId)}
        title={session.sessionId}
      >
        <span className="session-title">{session.title || 'Untitled'}</span>
        {children.length > 0 && <span className="session-subcount">{children.length}▸</span>}
      </button>
      {children.map((child) => (
        <SessionNode key={child.sessionId} session={child} childrenOf={childrenOf} activeSessionId={activeSessionId} onSelect={onSelect} depth={depth + 1} />
      ))}
    </div>
  )
}
