import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findInstalledDsh, hasDshBin, installedLaunch, npxCacheDsh } from '../src/server/runtimeDetect.ts'

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

describe('findInstalledDsh', () => {
  it('prefers the explicitly configured path', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cfg-'))
    fakeDshInstall(root)
    expect(findInstalledDsh(root)).toBe(root)
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

describe('installedLaunch', () => {
  it('produces a valid node invocation (bin first, launcher flags after)', () => {
    const launch = installedLaunch('C:/rt', undefined)
    expect(launch.command).toBe('node')
    expect(launch.args[0]).toBe(join('C:/rt', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    expect(launch.args).toContain('--profile')
    expect(launch.args).toContain('web')
    expect(launch.args).not.toContain('--patch')
  })
})
