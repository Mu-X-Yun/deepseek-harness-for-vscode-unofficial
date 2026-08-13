/** Prompt composer: textarea + Send/Stop, VS Code themed. */

import { useState } from 'react'

export interface ComposerProps {
  disabled: boolean
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
}

export function Composer({ disabled, running, onSend, onStop }: ComposerProps): JSX.Element {
  const [text, setText] = useState('')

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        disabled={disabled}
        placeholder={disabled ? 'Waiting for dsh runtime…' : 'Ask the agent…'}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-actions">
        {running ? (
          <button type="button" className="stop" onClick={onStop}>Stop</button>
        ) : (
          <button type="button" className="send" disabled={disabled || text.trim().length === 0} onClick={submit}>Send</button>
        )}
      </div>
    </div>
  )
}
