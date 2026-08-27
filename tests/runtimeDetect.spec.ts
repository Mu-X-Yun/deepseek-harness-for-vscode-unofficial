import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findInstalledDsh,
  hasDshBin,
  installedLaunch,
  npxCacheDsh,
  resolveInstallRoot,
  SHARP_BROKEN,
  SHARP_PIN,
  sharpVersion,
} from '../src/server/runtimeDetect.ts'

// `npm root -g` reflects the REAL machine's global installs. Stub the
// child-process spawn (not the module export — findInstalledDsh calls
// globalNpmRoot through an internal binding, so a module-level mock would
// be bypassed) so the findInstalledDsh tests are environment-independent: a
// developer with a global dsh must not flip the npx-fallback expectations.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('npm not available in unit tests')
    }),
  }
})

const ORIG_LOCALAPPDATA = process.env.LOCALAPPDATA

/** Builds `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js` like npm would. */
function fakeDshInstall(root: string): void {
  const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'bin.js'), '#!/usr/bin/env node\n')
}

describe('hasDshBin', () => {
  it('detects a present dsh bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-detect-'))
    fakeDshInstall(root)
    expect(hasDshBin(root)).toBe(true)
    expect(hasDshBin(join(tmpdir(), 'definitely-missing'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('resolveInstallRoot', () => {
  it('accepts a root that contains node_modules (extension runtime / npx layout)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-root-'))
    fakeDshInstall(root)
    expect(resolveInstallRoot(root)).toBe(root)
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts the node_modules directory itself (npm root -g layout)', () => {
    // Regression: `npm root -g` prints the node_modules dir; the old check
    // appended another node_modules segment and never found global installs.
    const root = mkdtempSync(join(tmpdir(), 'dsh-global-'))
    fakeDshInstall(root)
    expect(resolveInstallRoot(join(root, 'node_modules'))).toBe(root)
    rmSync(root, { recursive: true, force: true })
  })

  it('returns undefined when neither layout carries a dsh bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    expect(resolveInstallRoot(root)).toBeUndefined()
    expect(resolveInstallRoot(join(root, 'node_modules'))).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('findInstalledDsh', () => {
  it('prefers the explicitly configured path (both layouts)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cfg-'))
    fakeDshInstall(root)
    expect(findInstalledDsh(root)).toBe(root)
    // A configured path pointing AT the node_modules dir also resolves.
    expect(findInstalledDsh(join(root, 'node_modules'))).toBe(root)
    rmSync(root, { recursive: true, force: true })
  })

  it('falls through to the npx cache when no path is configured', () => {
    const la = mkdtempSync(join(tmpdir(), 'dsh-fallthrough-'))
    vi.stubEnv('LOCALAPPDATA', la)
    const npx = join(la, 'npm-cache', '_npx', 'hash-fff')
    fakeDshInstall(npx)
    expect(findInstalledDsh(undefined)).toBe(npx)
    if (ORIG_LOCALAPPDATA === undefined) vi.unstubAllEnvs()
    else vi.stubEnv('LOCALAPPDATA', ORIG_LOCALAPPDATA)
    rmSync(la, { recursive: true, force: true })
  })
})

describe('sharpVersion', () => {
  it('reads the installed sharp version', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sharp-'))
    mkdirSync(join(root, 'node_modules', 'sharp'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'sharp', 'package.json'), JSON.stringify({ version: '0.35.3' }), 'utf8')
    expect(sharpVersion(root)).toBe('0.35.3')
    rmSync(root, { recursive: true, force: true })
  })

  it('returns undefined when sharp is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-nosharp-'))
    expect(sharpVersion(root)).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  it('distinguishes the broken release from the pin', () => {
    // Only 0.35.3 is the broken release; the pin is the version the
    // extension installs via npm overrides.
    expect(SHARP_BROKEN).toBe('0.35.3')
    expect(SHARP_PIN).toBe('0.35.2')
    expect(SHARP_BROKEN).not.toBe(SHARP_PIN)
  })
})

describe('npxCacheDsh', () => {
  let la: string
  beforeEach(() => {
    la = mkdtempSync(join(tmpdir(), 'dsh-lappdata-'))
    vi.stubEnv('LOCALAPPDATA', la)
  })
  afterEach(() => {
    // Delete the temp dir BEFORE restoring the env, so rmSync never touches
    // the real LOCALAPPDATA path.
    rmSync(la, { recursive: true, force: true })
    if (ORIG_LOCALAPPDATA === undefined) vi.unstubAllEnvs()
    else vi.stubEnv('LOCALAPPDATA', ORIG_LOCALAPPDATA)
  })

  it('finds the newest npx cache entry containing dsh', () => {
    const old = join(la, 'npm-cache', '_npx', 'hash-aaa')
    const fresh = join(la, 'npm-cache', '_npx', 'hash-bbb')
    fakeDshInstall(old)
    fakeDshInstall(fresh)
    // Fresh entry: touch bin.js so its mtime is newer.
    const freshBin = join(fresh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const future = new Date(Date.now() + 5_000)
    const { utimesSync } = require('node:fs') as typeof import('node:fs')
    utimesSync(freshBin, future, future)

    const found = npxCacheDsh()
    expect(found).toBe(fresh)
  })

  it('ignores npx entries without a dsh install', () => {
    mkdirSync(join(la, 'npm-cache', '_npx', 'hash-ccc'), { recursive: true })
    expect(npxCacheDsh()).toBeUndefined()
  })
})

describe('installedLaunch', () => {
  it('produces a valid node invocation (bin first, launcher flags after)', () => {
    const launch = installedLaunch('C:/rt', undefined)
    expect(launch.command).toBe('node')
    expect(launch.args[0]).toBe(join('C:/rt', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    expect(launch.args).toContain('--profile')
    expect(launch.args).toContain('web')
    expect(launch.args).not.toContain('--patch')
  })

  it('boots a named profile via --profile', () => {
    const launch = installedLaunch('C:/rt', undefined, 0, 'headless')
    expect(launch.args).toContain('--profile')
    expect(launch.args).toContain('headless')
  })
})
