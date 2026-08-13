/** Virtualized message stream of rendered session events. */

import { useEffect, useRef } from 'react'
import type { UiItem } from '../eventRenderer.ts'
import { ToolCard } from './ToolCard.tsx'

export function MessageList({ items }: { items: UiItem[] }): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items.length])

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
    case 'assistant':
      return <div className="message assistant"><div className="bubble">{item.text ?? ''}</div></div>
    case 'tool':
      return <ToolCard item={item} />
    default:
      return <div className="message meta"><span className="meta-text">{item.text ?? ''}</span></div>
  }
}
