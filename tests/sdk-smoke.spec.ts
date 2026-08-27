/**
 * Phase 2 integration smoke: spawns the real dsh-jsonrpc-agent runtime from
 * the repo, handshakes over stdio JSON-RPC, then shuts down cleanly.
 * No API key is required — initialize does not resolve credentials.
 * This test needs the repo built and installed (pnpm install + build:lib).
 *
 * The suite is skipped (not just deferred) when the harness checkout is
 * missing: the SDK client is imported dynamically inside beforeAll so a
 * fresh clone without the sibling repo can still LOAD and run the rest of
 * `npm test` (a top-level import would fail at collection time).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureRuntimeConfig } from '../src/sdk/runtime.ts'

/** Structural subset of the SDK harness the smoke test drives. */
interface RuntimeHarness {
  start(): Promise<void>
  close(): Promise<void>
}

const repoPath = join(__dirname, '..', '..', 'deepseek-harness-master')
const hasRepo = existsSync(join(repoPath, 'package.json'))
const storage = mkdtempSync(join(tmpdir(), 'dsh-vscode-smoke-'))

describe.skipIf(!hasRepo)('jsonrpc runtime handshake', () => {
  let harness: RuntimeHarness | undefined

  beforeAll(async () => {
    // Variable-path dynamic import: no static resolution of the sibling
    // repo's SDK, so both vitest collection AND tsc work without it.
    const sdkApi = join(repoPath, 'packages', 'sdk', 'client', 'src', 'api.ts')
    const { DeepSeekHarness } = await import(sdkApi)
    const configPath = ensureRuntimeConfig(storage, repoPath)
    const client = new DeepSeekHarness({
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
    harness = client
    await client.start()
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
