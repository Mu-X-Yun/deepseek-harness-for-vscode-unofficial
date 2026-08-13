/**
 * Builds two bundles:
 *  - out/extension.js        — the extension host half (Node)
 *  - out/webview/main.js     — the webview UI (browser), used by phase 2's React app
 */
import * as esbuild from 'esbuild'
import { accessSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
}

const extension = {
  ...common,
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(root, 'out/extension.js'),
  format: 'cjs',
}

const webview = {
  ...common,
  entryPoints: [join(root, 'src/webview/main.tsx')],
  outfile: join(root, 'out/webview/main.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  external: [],
}

function exists(p) {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}

async function build() {
  // The webview bundle is only built once phase 2 lands; the entry may not
  // exist yet. Skip it silently when absent so phase 1 needs no stub.
  mkdirSync(join(root, 'out'), { recursive: true })
  const errors = []
  for (const opts of [extension, webview]) {
    if (opts === webview && !exists(join(root, 'src/webview/main.tsx'))) continue
    try {
      if (watch) {
        const ctx = await esbuild.context(opts)
        await ctx.watch()
        console.log(`[esbuild] watching ${opts.entryPoints}`)
      } else {
        await esbuild.build(opts)
      }
    } catch (e) {
      errors.push(e)
    }
  }
  if (!watch && errors.length) process.exitCode = 1
}

build()
