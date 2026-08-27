/**
 * dsh profile discovery. A profile is `$DSH_HOME/profiles/<name>/` — an
 * ordered stack of bundle patch layers plus the user layer (see
 * packages/bundle + apps/cli in the harness repo). The extension scans the
 * directory to offer a switch target; `web` is the default profile the
 * launcher aliases.
 */

import { accessSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default profile booted by `dsh web` / `--profile web`. */
export const DEFAULT_PROFILE = 'web'

/**
 * The shipped web template's bundle layers (PROFILE_TEMPLATES.web in the
 * harness). A skeleton profile with exactly these boots the full Web UI —
 * the bundles resolve from the dsh INSTALLATION (resolveBundleDir's
 * installation-first contract), so no download is needed.
 */
export const WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** The empty user patch layer every profile starts with. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** The pnpm settings dsh's out-of-tree plugin layout expects. */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Writes a functional profile skeleton — the same three files dsh's
 * `initProfile` writes (manifest, empty patch layer, pnpm workspace) — so
 * a new name boots immediately: bundle layers resolve from the dsh
 * installation, not from a profile-local download. Existing files are never
 * touched (re-running is a no-op), matching dsh's own init behavior.
 * @param home - the dsh home directory (see {@link dshHomeOf}).
 * @param name - the profile name (already validated).
 * @param bundles - the initial `dsh.profile.bundles` layer list (web template).
 * @returns the manifest path.
 */
export function initProfileSkeleton(
  home: string,
  name: string,
  bundles: readonly string[] = WEB_PROFILE_BUNDLES,
): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }, undefined, 2) + '\n', 'utf8')
  }
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE, 'utf8')
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE, 'utf8')
  return manifestPath
}

/**
 * Extracts the profile from dsh launcher args (`--profile <name>`);
 * defaults to {@link DEFAULT_PROFILE} when the pair is absent.
 * @param args - the launch argument list.
 */
export function profileOfArgs(args: readonly string[]): string {
  const index = args.indexOf('--profile')
  const value = index >= 0 ? args[index + 1] : undefined
  return value !== undefined && value.length > 0 ? value : DEFAULT_PROFILE
}

/**
 * The dsh home directory: `DSH_HOME` when set, otherwise `~/.dsh`.
 * @param env - the process environment (injectable for tests).
 */
export function dshHomeOf(env: NodeJS.ProcessEnv): string {
  const home = env.DSH_HOME
  if (home !== undefined && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/**
 * Valid profile names: the launcher resolves the name as a directory under
 * `profiles/`, so separators and traversal must be refused outright.
 */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..'
}

/** A profile directory must carry one of these files to count as a profile. */
const PROFILE_MARKERS = ['cordis.patch.yml', 'package.json'] as const

/**
 * Scans `$DSH_HOME/profiles` for valid profile names (sorted). Directories
 * without a profile marker — `node_modules` (the shared module fallback)
 * and other scratch dirs — are ignored. A missing profiles dir yields [].
 * @param home - the dsh home directory (see {@link dshHomeOf}).
 */
export function listProfiles(home: string): string[] {
  const profilesDir = join(home, 'profiles')
  let entries: string[]
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  return entries
    .filter((name) => isValidProfileName(name) && PROFILE_MARKERS.some((marker) => {
      try {
        accessSync(join(profilesDir, name, marker))
        return true
      } catch {
        return false
      }
    }))
    .sort()
}
