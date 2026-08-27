import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE,
  dshHomeOf,
  initProfileSkeleton,
  isValidProfileName,
  listProfiles,
  profileOfArgs,
  WEB_PROFILE_BUNDLES,
} from '../src/server/profileDetect.ts'

/** Creates `<home>/profiles/<name>/<marker>` like a real profile dir. */
function makeProfile(home: string, name: string, marker: 'cordis.patch.yml' | 'package.json' = 'package.json'): void {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, marker), marker === 'package.json' ? '{}' : '# patch\n', 'utf8')
}

describe('dshHomeOf', () => {
  it('prefers DSH_HOME when set', () => {
    expect(dshHomeOf({ DSH_HOME: 'C:/custom-dsh' })).toBe('C:/custom-dsh')
  })

  it('falls back to ~/.dsh', () => {
    expect(dshHomeOf({})).toBe(join(homedir(), '.dsh'))
  })

  it('ignores an empty DSH_HOME', () => {
    expect(dshHomeOf({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh'))
  })
})

describe('isValidProfileName', () => {
  it('accepts plain names', () => {
    expect(isValidProfileName('web')).toBe(true)
    expect(isValidProfileName('headless')).toBe(true)
    expect(isValidProfileName('my.profile-2')).toBe(true)
  })

  it('rejects traversal, separators, and empty names', () => {
    expect(isValidProfileName('')).toBe(false)
    expect(isValidProfileName('.')).toBe(false)
    expect(isValidProfileName('..')).toBe(false)
    expect(isValidProfileName('../x')).toBe(false)
    expect(isValidProfileName('a/b')).toBe(false)
    expect(isValidProfileName('a\\b')).toBe(false)
    expect(isValidProfileName('a b')).toBe(false)
    expect(isValidProfileName('a:b')).toBe(false)
  })
})

describe('listProfiles', () => {
  it('lists valid profiles sorted, ignoring node_modules and unmarked dirs', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
    try {
      makeProfile(home, 'web')
      makeProfile(home, 'desktop', 'cordis.patch.yml')
      makeProfile(home, 'zebra')
      // Shared module fallback and unmarked scratch dirs are not profiles.
      mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
      mkdirSync(join(home, 'profiles', 'scratch'), { recursive: true })
      expect(listProfiles(home)).toEqual(['desktop', 'web', 'zebra'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns [] when the profiles directory is missing', () => {
    expect(listProfiles(join(tmpdir(), 'dsh-none-' + Date.now()))).toEqual([])
  })

  it('returns [] when no directory carries a profile marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    try {
      mkdirSync(join(home, 'profiles', 'scratch'), { recursive: true })
      expect(listProfiles(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('DEFAULT_PROFILE', () => {
  it('is web (the launcher alias)', () => {
    expect(DEFAULT_PROFILE).toBe('web')
  })
})

describe('profileOfArgs', () => {
  it('extracts the --profile pair from launcher args', () => {
    expect(profileOfArgs(['bin.js', '--profile', 'desktop', '--port', '3080'])).toBe('desktop')
  })

  it('defaults to web when the pair is absent', () => {
    expect(profileOfArgs(['bin.js', '--port', '0'])).toBe('web')
    expect(profileOfArgs([])).toBe('web')
  })

  it('defaults to web when the pair has no value', () => {
    expect(profileOfArgs(['--profile'])).toBe('web')
  })
})

describe('WEB_PROFILE_BUNDLES', () => {
  it('is the shipped web template (base + web-app)', () => {
    expect(WEB_PROFILE_BUNDLES).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })
})

describe('initProfileSkeleton', () => {
  it('writes the three skeleton files with the web template bundles', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-skeleton-'))
    try {
      initProfileSkeleton(home, 'test')
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'test', 'package.json'), 'utf8')) as {
        name: string
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.name).toBe('dsh-profile-test')
      expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
      expect(listProfiles(home)).toContain('test')
      expect(readFileSync(join(home, 'profiles', 'test', 'cordis.patch.yml'), 'utf8')).toContain('[]')
      expect(readFileSync(join(home, 'profiles', 'test', 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is idempotent: existing files are never overwritten', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-skeleton-'))
    try {
      const dir = join(home, 'profiles', 'test')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{"custom":true}', 'utf8')
      initProfileSkeleton(home, 'test')
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{"custom":true}')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
