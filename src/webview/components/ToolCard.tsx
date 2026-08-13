/** Collapsible tool invocation card (tool/call + tool/result). */

import { useState } from 'react'
import type { UiItem } from '../eventRenderer.ts'

export function ToolCard({ item }: { item: UiItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const name = item.toolName ?? 'tool'
  const args = item.argumentsJson
  const error = item.error

  return (
    <div className="tool-card">
      <button type="button" className="tool-card-header" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-icon ${error !== undefined ? 'error' : ''}`}>
          {error !== undefined ? '⚠' : '⚙'}
        </span>
        <span className="tool-name">{name}</span>
        {args !== undefined && <span className="tool-toggle">{open ? '▾' : '▸'}</span>}
      </button>
      {open && args !== undefined && (
        <pre className="tool-args">{pretty(args)}</pre>
      )}
      {error !== undefined && <div className="tool-error">{error}</div>}
    </div>
  )
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
