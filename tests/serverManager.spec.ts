/**
 * DshServerManager state-machine tests: real child processes (node -e)
 * print the ready line / fail like dsh would, with the retry hooks
 * (onPortConflict / onModuleMissing) and persistence exercised through a
 * temp storage dir. `vscode` is mocked — only the EventEmitter value is
 * used at runtime.
 *
 * launch() is invoked exactly once per real spawn: the fixed-port adoption
 * probe uses the CONFIGURED port (no launch call), so tests select scripts
 * by spawn order only (call 1 = first spawn). `fetch` is stubbed to refuse
 * by default so the suite is hermetic even when a real dsh runs on 3080;
 * cases that exercise adoption override the stub.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DshServerManager,
  INSTALL_DECLINED_MESSAGE,
  isPortFree,
  STOPPED_DURING_START_MESSAGE,
  type DshServerManagerOptions,
  type ServerState,
} from '../src/server/DshServerManager.ts'

vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    private listeners: Array<(value: T) => void> = []
    readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.push(listener)
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener)
        },
      }
    }
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value)
    }
    dispose(): void {
      this.listeners = []
    }
  },
}))

/** node -e script that prints the ready line and stays alive. */
function readyScript(port: number): string[] {
  return ['-e', `console.log('dsh web: http://127.0.0.1:${port}'); setTimeout(() => {}, 60_000)`]
}

/** node -e script that prints the ready line and exits after a delay. */
function readyThenExitScript(port: number, exitMs: number): string[] {
  return ['-e', `console.log('dsh web: http://127.0.0.1:${port}'); setTimeout(() => process.exit(1), ${exitMs})`]
}

/** node -e script that prints one stderr line and exits 1. */
function failScript(stderrLine: string): string[] {
  return ['-e', `console.error(${JSON.stringify(stderrLine)}); process.exit(1)`]
}

/** node -e script that never prints a ready line and stays alive. */
function silentScript(): string[] {
  return ['-e', 'setTimeout(() => {}, 60_000)']
}

let fileScriptCounter = 0
const tempFiles: string[] = []

/**
 * A launch whose args carry `--port <n>` like the real installed launch —
 * but spawned via a temp script FILE: `node -e <code> --port` makes node
 * itself reject the unknown option (exit 9), while `node file.cjs --port`
 * passes it through to the script.
 */
function readyFileLaunch(port: number): { command: string; args: string[]; cwd: string } {
  const scriptPath = join(tmpdir(), `dsh-mgr-ready-${process.pid}-${fileScriptCounter++}.cjs`)
  tempFiles.push(scriptPath)
  writeFileSync(
    scriptPath,
    `console.log('dsh web: http://127.0.0.1:${port}'); setTimeout(() => {}, 60_000)\n`,
    'utf8',
  )
  return { command: process.execPath, args: [scriptPath, '--port', '3080'], cwd: process.cwd() }
}

/** A temp script that echoes the --port value it received into the ready URL. */
function echoPortFileLaunch(initialPort: string): { command: string; args: string[]; cwd: string } {
  const scriptPath = join(tmpdir(), `dsh-mgr-echo-${process.pid}-${fileScriptCounter++}.cjs`)
  tempFiles.push(scriptPath)
  writeFileSync(
    scriptPath,
    "const i = process.argv.indexOf('--port'); console.log('dsh web: http://127.0.0.1:' + process.argv[i + 1]); setTimeout(() => {}, 60_000)\n",
    'utf8',
  )
  return { command: process.execPath, args: [scriptPath, '--port', initialPort], cwd: process.cwd() }
}

const managers: DshServerManager[] = []
const tempDirs: string[] = []

function makeManager(overrides: Partial<DshServerManagerOptions> = {}): DshServerManager {
  const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-'))
  tempDirs.push(storage)
  const manager = new DshServerManager({
    launch: () => ({ command: process.execPath, args: readyScript(53123), cwd: process.cwd() }),
    env: () => ({ ...process.env }),
    preflight: () => [],
    log: () => {},
    storagePath: storage,
    // Hermetic default: never touch a real loopback port even for launches
    // that DO carry --port 0 (the port-recovery cases override this).
    probePort: async () => false,
    ...overrides,
  })
  managers.push(manager)
  return manager
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  // Hermetic by default: no dsh on the fixed port. The fixed-port adoption
  // probe must not dip into a real service running on this machine's 3080,
  // which would short-circuit every cold-start case below.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('ECONNREFUSED')
  }))
})

afterEach(async () => {
  // Kill any surviving child so tests never leak node -e processes.
  for (const manager of managers) {
    await manager.stop().catch(() => {})
  }
  managers.length = 0
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
  for (const file of tempFiles) {
    rmSync(file, { force: true })
  }
  tempFiles.length = 0
  vi.unstubAllGlobals()
})

describe('DshServerManager start', () => {
  it('spawns, parses the ready line, and reports running', async () => {
    const manager = makeManager()
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:53123')
    expect(manager.current).toEqual({ kind: 'running', url, port: 53123 })
    await manager.stop()
    expect(manager.current.kind).toBe('stopped')
  })

  it('is idempotent while running', async () => {
    const manager = makeManager()
    const url1 = await manager.start()
    const url2 = await manager.start()
    expect(url2).toBe(url1)
    await manager.stop()
  })

  it('fails loudly on preflight problems', async () => {
    const manager = makeManager({ preflight: () => ['missing runtime'] })
    await expect(manager.start()).rejects.toThrow('missing runtime')
    expect(manager.current).toEqual({ kind: 'failed', reason: 'missing runtime' })
  })

  it('fails with the diagnostics on a ready timeout', async () => {
    // A child that NEVER prints the ready line makes the timeout
    // deterministic (a fast child printing the line could beat 50ms on a
    // hot machine and flip the assertion).
    const manager = makeManager({
      readyTimeoutMs: 50,
      launch: () => ({ command: process.execPath, args: silentScript(), cwd: process.cwd() }),
    })
    await expect(manager.start()).rejects.toThrow(/did not report a ready URL/)
    expect(manager.current.kind).toBe('failed')
    // The still-running child is killed by stop(); it must settle promptly.
    await manager.stop()
    expect(manager.current.kind).toBe('stopped')
  })

  it('runs ensureRuntime first and exposes the installing state', async () => {
    let ensured = false
    const states: ServerState[] = []
    const manager = makeManager({ ensureRuntime: async () => { ensured = true } })
    manager.onDidChangeState((state) => states.push(state))
    await manager.start()
    expect(ensured).toBe(true)
    expect(states.some((s) => s.kind === 'installing')).toBe(true)
    await manager.stop()
  })

  it('declines the install when the confirmation is refused', async () => {
    let ensured = false
    const manager = makeManager({
      ensureRuntime: async () => { ensured = true },
      confirmEnsureRuntime: async () => false,
    })
    await expect(manager.start()).rejects.toThrow(INSTALL_DECLINED_MESSAGE)
    expect(manager.current).toEqual({ kind: 'failed', reason: INSTALL_DECLINED_MESSAGE })
    // The install never started, so the state never entered 'installing'.
    expect(ensured).toBe(false)
  })

  it('proceeds with the install when the confirmation is accepted', async () => {
    let ensured = false
    const manager = makeManager({
      ensureRuntime: async () => { ensured = true },
      confirmEnsureRuntime: async () => true,
    })
    expect(await manager.start()).toBe('http://127.0.0.1:53123')
    expect(ensured).toBe(true)
    await manager.stop()
  })

  it('shares one attempt across concurrent starts (single-flight confirmation)', async () => {
    // Regression: a double-click on Retry while the install confirmation is
    // visible must not show two dialogs or run ensureRuntime twice.
    let confirmed = 0
    let ensured = 0
    let release = (): void => {}
    const manager = makeManager({
      confirmEnsureRuntime: async () => {
        confirmed += 1
        return true
      },
      ensureRuntime: () => {
        ensured += 1
        return new Promise<void>((resolve) => { release = resolve })
      },
    })
    const first = manager.start()
    const second = manager.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([first, second])
    expect(confirmed).toBe(1)
    expect(ensured).toBe(1)
    await manager.stop()
  })

  it('does not start after stop() lands during an install', async () => {
    // Regression: stop() resets `stopping` synchronously in its no-child
    // branch, so an in-flight install must be aborted via the generation
    // token — the server must never boot after the user asked to stop.
    let release = (): void => {}
    let preflighted = false
    const manager = makeManager({
      confirmEnsureRuntime: async () => true,
      ensureRuntime: () => new Promise<void>((resolve) => { release = resolve }),
      preflight: () => {
        preflighted = true
        return []
      },
      launch: () => ({ command: process.execPath, args: readyScript(53139), cwd: process.cwd() }),
    })
    const startPromise = manager.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await manager.stop()
    release()
    await expect(startPromise).rejects.toThrow(STOPPED_DURING_START_MESSAGE)
    expect(manager.current.kind).toBe('stopped')
    // The server never reached preflight / spawn.
    expect(preflighted).toBe(false)
  })

  it('aborts when stop() lands while the confirmation is open', async () => {
    // Regression: the generation token is captured BEFORE any await, so a
    // stop during the confirmation window (or reuse detection) aborts too.
    let releaseConfirm: ((confirmed: boolean) => void) | undefined
    let ensured = false
    const manager = makeManager({
      confirmEnsureRuntime: () => new Promise<boolean>((resolve) => { releaseConfirm = resolve }),
      ensureRuntime: async () => { ensured = true },
    })
    const startPromise = manager.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await manager.stop()
    releaseConfirm?.(true)
    await expect(startPromise).rejects.toThrow(STOPPED_DURING_START_MESSAGE)
    expect(manager.current.kind).toBe('stopped')
    expect(ensured).toBe(false)
  })

  it('starts cleanly again after an aborted install', async () => {
    // The abort must not poison the manager: a later start() succeeds.
    let ensured = 0
    let release: (() => void) | undefined
    const manager = makeManager({
      confirmEnsureRuntime: async () => true,
      ensureRuntime: () => {
        ensured += 1
        if (ensured === 1) return new Promise<void>((resolve) => { release = resolve })
        return Promise.resolve()
      },
    })
    const first = manager.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await manager.stop()
    release?.()
    await expect(first).rejects.toThrow(STOPPED_DURING_START_MESSAGE)
    expect(manager.current.kind).toBe('stopped')
    // Second attempt: fresh generation, resolves normally.
    expect(await manager.start()).toBe('http://127.0.0.1:53123')
    expect(ensured).toBe(2)
    await manager.stop()
  })
})

describe('DshServerManager restart and retries', () => {
  it('restarts after an unexpected exit with backoff', async () => {
    let calls = 0
    const manager = makeManager({
      restartBackoffMs: [1, 1, 1, 1],
      maxRestarts: 2,
      launch: () => {
        calls += 1
        // Call 1 is the first real spawn (no --port probe calls launch).
        if (calls === 1) {
          return { command: process.execPath, args: readyThenExitScript(53123, 60), cwd: process.cwd() }
        }
        return { command: process.execPath, args: readyScript(53124), cwd: process.cwd() }
      },
    })
    expect(await manager.start()).toBe('http://127.0.0.1:53123')
    await waitFor(() => {
      const state = manager.current
      return state.kind === 'running' && state.port === 53124
    })
    // First real spawn + restart spawn.
    expect(calls).toBe(2)
    await manager.stop()
  })

  it('reaches failed when the restart budget is exhausted', async () => {
    // A server that boots and crashes within the stability window drains
    // the budget: each crash counts against maxRestarts.
    let calls = 0
    const manager = makeManager({
      restartBackoffMs: [1, 1, 1, 1],
      maxRestarts: 1,
      launch: () => {
        calls += 1
        return { command: process.execPath, args: readyThenExitScript(53123, 60), cwd: process.cwd() }
      },
    })
    expect(await manager.start()).toBe('http://127.0.0.1:53123')
    await waitFor(() => manager.current.kind === 'failed')
    // Two real spawns (initial + one restart).
    expect(calls).toBe(2)
  })

  it('respawns on a port conflict via onPortConflict', async () => {
    let calls = 0
    let conflict = false
    const manager = makeManager({
      launch: () => {
        calls += 1
        if (calls === 1) {
          return { command: process.execPath, args: failScript('listen EADDRINUSE'), cwd: process.cwd() }
        }
        return { command: process.execPath, args: readyScript(53125), cwd: process.cwd() }
      },
      onPortConflict: async () => {
        conflict = true
        return true
      },
    })
    const url = await manager.start()
    expect(conflict).toBe(true)
    // Failed spawn + respawn.
    expect(calls).toBe(2)
    expect(url).toBe('http://127.0.0.1:53125')
    await manager.stop()
  })

  it('self-heals a missing module via onModuleMissing', async () => {
    let calls = 0
    let reinstalled = false
    const manager = makeManager({
      launch: () => {
        calls += 1
        if (calls === 1) {
          return { command: process.execPath, args: failScript("Error: Cannot find module 'typebox'"), cwd: process.cwd() }
        }
        return { command: process.execPath, args: readyScript(53126), cwd: process.cwd() }
      },
      onModuleMissing: async () => {
        reinstalled = true
        return true
      },
    })
    const url = await manager.start()
    expect(reinstalled).toBe(true)
    // Failed spawn + respawn.
    expect(calls).toBe(2)
    expect(url).toBe('http://127.0.0.1:53126')
    await manager.stop()
  })

  it('keeps the port-conflict and missing-module retries independent', async () => {
    // Regression: the two one-shot flags were shared, so a port conflict
    // consumed the missing-module self-heal opportunity.
    let calls = 0
    let portConflict = false
    let moduleMissing = false
    const manager = makeManager({
      launch: () => {
        calls += 1
        if (calls === 1) {
          return { command: process.execPath, args: failScript('EADDRINUSE'), cwd: process.cwd() }
        }
        if (calls === 2) {
          return { command: process.execPath, args: failScript("Cannot find package 'js-yaml'"), cwd: process.cwd() }
        }
        return { command: process.execPath, args: readyScript(53127), cwd: process.cwd() }
      },
      onPortConflict: async () => {
        portConflict = true
        return true
      },
      onModuleMissing: async () => {
        moduleMissing = true
        return true
      },
    })
    const url = await manager.start()
    expect(portConflict).toBe(true)
    expect(moduleMissing).toBe(true)
    // EADDRINUSE spawn + missing-module spawn + final respawn.
    expect(calls).toBe(3)
    expect(url).toBe('http://127.0.0.1:53127')
    await manager.stop()
  })
})

describe('DshServerManager reuse', () => {
  it('reuses a persisted running server when its URL responds', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-reuse-'))
    tempDirs.push(storage)
    writeFileSync(
      join(storage, 'dsh-state.json'),
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now() }),
      'utf8',
    )
    let calls = 0
    const manager = makeManager({
      storagePath: storage,
      launch: () => {
        calls += 1
        return { command: process.execPath, args: readyScript(53128), cwd: process.cwd() }
      },
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:54321')
    // tryReuse succeeds before the --port probe, so launch() never runs.
    expect(calls).toBe(0)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('adopts a persisted instance whose recorded profile matches', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-pf-match-'))
    tempDirs.push(storage)
    writeFileSync(
      join(storage, 'dsh-state.json'),
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now(), profile: 'desktop' }),
      'utf8',
    )
    let calls = 0
    const manager = makeManager({
      storagePath: storage,
      profile: () => 'desktop',
      launch: () => {
        calls += 1
        return { command: process.execPath, args: readyScript(53133), cwd: process.cwd() }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:54321')
    expect(calls).toBe(0)
    expect(manager.runningProfile).toBe('desktop')
  })

  it('refuses a persisted instance of another profile and cold-starts', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-pf-mismatch-'))
    tempDirs.push(storage)
    const stateFile = join(storage, 'dsh-state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now(), profile: 'web' }),
      'utf8',
    )
    let calls = 0
    const manager = makeManager({
      storagePath: storage,
      profile: () => 'desktop',
      launch: () => {
        calls += 1
        return { command: process.execPath, args: readyScript(53134), cwd: process.cwd() }
      },
    })
    // The foreign instance responds, but it is the wrong profile.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:53134')
    // No probe: a non-web target never touches the fixed port. The stale
    // row was cleared, then the cold start persisted the NEW server.
    expect(calls).toBe(1)
    const persisted = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(stateFile, 'utf8'))) as { url: string }
    expect(persisted.url).toBe('http://127.0.0.1:53134')
    await manager.stop()
  })

  it('does not adopt the fixed port for a non-web target', async () => {
    const html = `<html><script>window.__DSH_BOOT__ = ${JSON.stringify({
      rev: 'r1',
      entries: [{ id: '@deepseek-ai/dsh-ui-app', url: '/plugins/ui/client.js?rev=r1', rev: 'r1' }],
    })}</script></html>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    let calls = 0
    const manager = makeManager({
      profile: () => 'desktop',
      launch: () => {
        calls += 1
        return readyFileLaunch(53135)
      },
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:53135')
    // The 3080 web is NOT adopted for a desktop target — one cold start.
    expect(calls).toBe(1)
    await manager.stop()
  })

  it('reports the fixed-port external service as the web profile', async () => {
    const html = `<html><script>window.__DSH_BOOT__ = ${JSON.stringify({
      rev: 'r1',
      entries: [{ id: '@deepseek-ai/dsh-ui-app', url: '/plugins/ui/client.js?rev=r1', rev: 'r1' }],
    })}</script></html>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    const manager = makeManager({
      launch: () => readyFileLaunch(3080),
    })
    expect(await manager.start()).toBe('http://127.0.0.1:3080')
    expect(manager.runningProfile).toBe('web')
  })

  it('adopts the fixed port even when the launch carries --port 0', async () => {
    // Regression: after a port-conflict fallback the launch uses `--port 0`
    // (useRandomPort), which made the fixed-port probe a no-op — switching
    // to web cold-started on a random port instead of adopting the foreign
    // web. The probe must use the CONFIGURED fixed port, not launch args.
    const html = `<html><script>window.__DSH_BOOT__ = ${JSON.stringify({
      rev: 'r1',
      entries: [{ id: '@deepseek-ai/dsh-ui-app', url: '/plugins/ui/client.js?rev=r1', rev: 'r1' }],
    })}</script></html>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    let calls = 0
    const manager = makeManager({
      fixedPort: () => 3080,
      launch: () => {
        calls += 1
        return { command: process.execPath, args: ['-e', `console.log('dsh web: http://127.0.0.1:${53138}'); setTimeout(() => {}, 60_000)`, '--port', '0'], cwd: process.cwd() }
      },
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:3080')
    // No spawn: the fixed-port probe adopted the external service (it does
    // not call launch()).
    expect(calls).toBe(0)
  })

  it('stop preserves an adopted instance of the target profile', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-preserve-'))
    tempDirs.push(storage)
    const stateFile = join(storage, 'dsh-state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now(), profile: 'web' }),
      'utf8',
    )
    const manager = makeManager({
      storagePath: storage,
      launch: () => ({ command: process.execPath, args: readyScript(53136), cwd: process.cwd() }),
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    expect(await manager.start()).toBe('http://127.0.0.1:54321')
    // Adopted instance (no child); preserving its profile keeps the row so
    // the next start re-adopts it instead of cold-starting.
    await manager.stop({ preserveProfile: 'web' })
    expect(await import('node:fs').then((fs) => fs.promises.readFile(stateFile, 'utf8'))).not.toBe('')
  })

  it('stop clears and kills an adopted instance of another profile', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-kill-'))
    tempDirs.push(storage)
    const stateFile = join(storage, 'dsh-state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now(), profile: 'web' }),
      'utf8',
    )
    const manager = makeManager({
      storagePath: storage,
      launch: () => ({ command: process.execPath, args: readyScript(53137), cwd: process.cwd() }),
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    expect(await manager.start()).toBe('http://127.0.0.1:54321')
    await manager.stop({ preserveProfile: 'desktop' })
    expect(await import('node:fs').then((fs) => fs.promises.readFile(stateFile, 'utf8'))).toBe('')
  })

  it('falls through to a cold start when the persisted URL is dead', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-dead-'))
    tempDirs.push(storage)
    const stateFile = join(storage, 'dsh-state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now() }),
      'utf8',
    )
    let calls = 0
    const manager = makeManager({
      storagePath: storage,
      launch: () => {
        calls += 1
        return { command: process.execPath, args: readyScript(53129), cwd: process.cwd() }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:53129')
    // Cold-start spawn only (no --port probe).
    expect(calls).toBe(1)
    // The dead state was cleared, then the successful cold start persisted
    // the NEW server (so the next reload reuses it, not the dead URL).
    const persisted = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(stateFile, 'utf8'))) as { url: string }
    expect(persisted.url).toBe('http://127.0.0.1:53129')
    await manager.stop()
  })

  it('adopts an external server whose page carries a valid boot manifest', async () => {
    const html = `<html><script>window.__DSH_BOOT__ = ${JSON.stringify({
      rev: 'r1',
      entries: [{ id: '@deepseek-ai/dsh-ui-app', url: '/plugins/ui/client.js?rev=r1', rev: 'r1' }],
    })}</script></html>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    let calls = 0
    const manager = makeManager({
      launch: () => {
        calls += 1
        return readyFileLaunch(3080)
      },
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:3080')
    // Adopted via the fixed-port probe; launch() never ran.
    expect(calls).toBe(0)
  })

  it('skipReuse cold-starts even when a foreign dsh occupies the fixed port', async () => {
    // Regression: a profile switch must never re-adopt a foreign dsh on the
    // fixed port (it has no process handle, so stop() cannot kill it) —
    // that would silently keep the OLD profile running.
    const html = `<html><script>window.__DSH_BOOT__ = ${JSON.stringify({
      rev: 'r1',
      entries: [{ id: '@deepseek-ai/dsh-ui-app', url: '/plugins/ui/client.js?rev=r1', rev: 'r1' }],
    })}</script></html>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
    let calls = 0
    const manager = makeManager({
      launch: () => {
        calls += 1
        return readyFileLaunch(53131)
      },
    })
    const url = await manager.start({ skipReuse: true })
    expect(url).toBe('http://127.0.0.1:53131')
    // skipReuse bypasses the reuse checks entirely (no --port probe): the
    // foreign server was NOT adopted and exactly one spawn happened.
    expect(calls).toBe(1)
    await manager.stop()
  })

  it('skipReuse ignores a persisted running server', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'dsh-mgr-skip-'))
    tempDirs.push(storage)
    writeFileSync(
      join(storage, 'dsh-state.json'),
      JSON.stringify({ url: 'http://127.0.0.1:54321', port: 54321, pid: 12345, startedAt: Date.now() }),
      'utf8',
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    let calls = 0
    const manager = makeManager({
      storagePath: storage,
      launch: () => {
        calls += 1
        return { command: process.execPath, args: readyScript(53132), cwd: process.cwd() }
      },
    })
    const url = await manager.start({ skipReuse: true })
    expect(url).toBe('http://127.0.0.1:53132')
    // No persisted reuse, no probe — one cold-start spawn.
    expect(calls).toBe(1)
    await manager.stop()
  })

  it('rejects an external server without a valid manifest and cold-starts', async () => {
    // The marker string alone (any page could contain it) must not be
    // mistaken for dsh web.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>__DSH_BOOT__</html>', { status: 200 })))
    let calls = 0
    const manager = makeManager({
      launch: () => {
        calls += 1
        return readyFileLaunch(53130)
      },
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:53130')
    // One cold-start spawn (no probe).
    expect(calls).toBe(1)
    await manager.stop()
  })
})

describe('DshServerManager port fallback recovery', () => {
  it('returns to the fixed port when it becomes free again', async () => {
    // Regression: the port-conflict fallback (`--port 0`) is remembered for
    // the activation; once the foreign process is gone, the fixed port must
    // be used again instead of a random one.
    let probes = 0
    const manager = makeManager({
      fixedPort: () => 3080,
      probePort: async () => {
        probes += 1
        return true // free
      },
      launch: () => echoPortFileLaunch('0'),
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:3080')
    expect(probes).toBe(1)
    await manager.stop()
  })

  it('keeps the random port while the fixed port is still occupied', async () => {
    const manager = makeManager({
      fixedPort: () => 3080,
      probePort: async () => false, // occupied
      launch: () => echoPortFileLaunch('0'),
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:0') // launch args untouched
    await manager.stop()
  })

  it('does not probe when the launch already uses the fixed port', async () => {
    let probes = 0
    const manager = makeManager({
      fixedPort: () => 3080,
      probePort: async () => {
        probes += 1
        return true
      },
      launch: () => echoPortFileLaunch('3080'),
    })
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:3080')
    expect(probes).toBe(0)
    await manager.stop()
  })

  it('does not probe when the launch carries no --port token', async () => {
    // Regression: portOfArgs() treats "no --port" like "--port 0". A bare
    // `node -e` command must NEVER get --port appended — node rejects the
    // unknown option (exit 9). The probe is skipped entirely.
    let probes = 0
    const manager = makeManager({
      fixedPort: () => 3080,
      probePort: async () => {
        probes += 1
        return true
      },
      // default launch: ['-e', readyScript] — no --port
    })
    expect(await manager.start()).toBe('http://127.0.0.1:53123')
    expect(probes).toBe(0)
    await manager.stop()
  })
})

describe('isPortFree', () => {
  it('returns false when a service is listening', async () => {
    const srv = createServer()
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as AddressInfo).port
    try {
      expect(await isPortFree(port)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })

  it('returns true only on ECONNREFUSED (a freshly released port)', async () => {
    // A listening socket closes without TIME_WAIT, so an immediate connect
    // to the freed random port is refused — the semantic the port fallback
    // recovery relies on.
    const srv = createServer()
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as AddressInfo).port
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    expect(await isPortFree(port)).toBe(true)
  })
})
