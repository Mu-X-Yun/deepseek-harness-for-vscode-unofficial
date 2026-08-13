/** Top status strip: agent idle/running + dsh runtime state. */

import type { ServerState } from '../App.tsx'

export function StatusBar({ state, serverState }: { state: 'idle' | 'running'; serverState: ServerState }): JSX.Element {
  const dot = state === 'running' ? '●' : '○'
  return (
    <div className="status-bar">
      <span className={`status-dot ${state}`}>{dot}</span>
      <span>{state === 'running' ? 'Agent running' : 'Idle'}</span>
      <span className="status-server">{serverStateLabel(serverState)}</span>
    </div>
  )
}

function serverStateLabel(serverState: ServerState): string {
  switch (serverState) {
    case 'running':
      return 'dsh runtime connected'
    case 'starting':
      return 'dsh runtime starting…'
    case 'failed':
      return 'dsh runtime failed'
    case 'stopped':
      return 'dsh runtime stopped'
    default:
      return ''
  }
}
