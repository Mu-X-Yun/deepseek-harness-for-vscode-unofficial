/**
 * Native-mode end-to-end chat: a real prompt through the same runtime
 * launch the extension uses (jsonrpc-agent + generated cordis.yml), with
 * event streaming, buffering, and rendering assertions.
 *
 * Requires DEEPSEEK_API_KEY (real API call); skipped without it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeepSeekHarness } from '../../deepseek-harness-master/packages/sdk/client/src/api.ts'
import { ensureRuntimeConfig } from '../src/sdk/runtime.ts'
import { renderEvents } from '../src/webview/eventRenderer.ts'

const repoPath = join(__dirname, '..', '..', 'deepseek-harness-master')
const apiKey = process.env.DEEPSEEK_API_KEY

describe.skipIf(apiKey === undefined || apiKey === '')('native chat e2e', () => {
  it('runs a real turn, streams events, and renders bubbles', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-vscode-chat-'))
    const configPath = ensureRuntimeConfig(storage, repoPath)
    const harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx/esm', join(repoPath, 'packages', 'examples', 'jsonrpc-demo', 'src', 'bin.ts'), configPath],
        cwd: repoPath,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: apiKey,
          DSH_SESSION_ROOT: join(storage, 'sessions'),
          DSH_CWD: storage,
        },
        requestTimeoutMs: undefined,
      },
      cwd: storage,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    try {
      const notifications: string[] = []
      const result = await harness.run('用一句话介绍你自己', {
        onNotification: (n) => notifications.push(n.method),
      })

      // Wire-level: session.event + status transitions arrived.
      expect(notifications).toContain('session.event')
      expect(notifications).toContain('session.status')

      // Turn completed with a real assistant answer.
      expect(result.finalResponse.length).toBeGreaterThan(0)
      expect(result.events.some((e) => e.type === 'user/message')).toBe(true)
      expect(result.events.some((e) => e.type === 'assistant/message')).toBe(true)

      // Rendering: the event sequence produces a user bubble and an
      // assistant bubble with non-empty text (what the sidebar would show).
      const items = renderEvents(result.events as Parameters<typeof renderEvents>[0])
      const userBubble = items.find((i) => i.role === 'user')
      const assistantBubble = items.find((i) => i.role === 'assistant')
      expect(userBubble?.text?.length ?? 0).toBeGreaterThan(0)
      expect(assistantBubble?.text?.length ?? 0).toBeGreaterThan(0)
    } finally {
      await harness.close()
      rmSync(storage, { recursive: true, force: true })
    }
  }, 180_000)
})
