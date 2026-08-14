/** Virtualized message stream of rendered session events. */

import { useEffect, useRef } from 'react'
import type { UiItem } from '../eventRenderer.ts'
import { ToolCard } from './ToolCard.tsx'

export function MessageList({ items }: { items: UiItem[] }): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Track `items`, not `items.length`: streamed chunks grow the text of one
  // item in place, so the length does not change while the bubble grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items])

  return (
    <div className="message-list">
      {items.length === 0 && <div className="message-empty">Start a conversation — dsh agent responses appear here.</div>}
      {items.map((item) => <MessageItem key={item.key} item={item} />)}
      <div ref={bottomRef} />
    </div>
  )
}

function MessageItem({ item }: { item: UiItem }): JSX.Element {
  switch (item.role) {
    case 'user':
      return <div className="message user"><div className="bubble">{item.text ?? ''}</div></div>
    case 'assistant': {
      // Reasoning-only replies (interrupted/max-token steps) fall back to the
      // reasoning text so the row is never blank.
      const text = item.text ?? item.reasoning
      const reasoningOnly = item.text === undefined && item.reasoning !== undefined
      return <div className="message assistant"><div className={`bubble${reasoningOnly ? ' reasoning' : ''}`}>{text ?? ''}</div></div>
    }
    case 'tool':
      return <ToolCard item={item} />
    default:
      return <div className="message meta"><span className="meta-text">{item.text ?? ''}</span></div>
  }
}
