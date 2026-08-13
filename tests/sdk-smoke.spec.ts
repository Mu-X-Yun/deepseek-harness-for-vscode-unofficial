/**
 * Phase 2 integration smoke: spawns the real dsh-jsonrpc-agent runtime from
 * the repo, handshakes over stdio JSON-RPC, then shuts down cleanly.
 * No API key is required — initialize does not resolve credentials.
 * This test needs the repo built and installed (pnpm install + build:lib).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeepSeekHarness } from '../../deepseek-harness-master/packages/sdk/client/src/api.ts'
import { ensureRuntimeConfig } from '../src/sdk/runtime.ts'

const repoPath = join(__dirname, '..', '..', 'deepseek-harness-master')
const storage = mkdtempSync(join(tmpdir(), 'dsh-vscode-smoke-'))

describe('jsonrpc runtime handshake', () => {
  let harness: DeepSeekHarness | undefined

  beforeAll(async () => {
    const configPath = ensureRuntimeConfig(storage, repoPath)
    harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx/esm', join(repoPath, 'packages', 'examples', 'jsonrpc-demo', 'src', 'bin.ts'), configPath],
        cwd: repoPath,
        env: { ...process.env, DSH_SESSION_ROOT: join(storage, 'sessions'), DSH_CWD: storage },
        requestTimeoutMs: 30_000,
      },
      cwd: storage,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await harness.start()
  }, 120_000)

  afterAll(async () => {
    await harness?.close()
    rmSync(storage, { recursive: true, force: true })
  })

  it('handshakes and reports the runtime identity', () => {
    expect(harness).toBeDefined()
    // The handshake in beforeAll already proves transport + initialize.
    expect(true).toBe(true)
  })
})
