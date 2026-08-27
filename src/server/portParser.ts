/**
 * Parses the dsh web ready line from the child process stdout, and
 * recognizes the injected `window.__DSH_BOOT__` manifest in a served index
 * page (the external-server adoption fingerprint).
 *
 * `dsh web` prints `dsh web: http://127.0.0.1:<port>` on stdout once the
 * Cordis loader has settled and the HTTP server is listening — this is the
 * official readiness signal (see packages/bundle/web-app/src/index.ts).
 * With `--port 0` the port is OS-assigned, so this line is the only reliable
 * way to learn the URL.
 */

/** Matches the ready line, e.g. `dsh web: http://127.0.0.1:53087`. */
export const READY_LINE_RE = /dsh web: (https?:\/\/127\.0\.0\.1:(\d+))/

/** Matches the injected `window.__DSH_BOOT__ = {...}` JSON manifest. */
const BOOT_MANIFEST_RE = /window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/

export interface ReadyLine {
  /** The full URL, e.g. `http://127.0.0.1:53087`. */
  url: string
  /** The numeric port. */
  port: number
}

/**
 * Extracts the ready URL from an arbitrary chunk of stdout text.
 * Returns undefined when no ready line is present yet.
 */
export function findReadyUrl(chunk: string): ReadyLine | undefined {
  const match = READY_LINE_RE.exec(chunk)
  const url = match?.[1]
  const port = match?.[2]
  if (url !== undefined && port !== undefined) {
    return { url, port: Number(port) }
  }
  return undefined
}

/**
 * True when the HTML carries a structurally valid dsh web boot manifest:
 * `{ rev: string, entries: [{ id, url, rev }] }` (the wire shape from
 * packages/client/modules/src/client/manifest.ts). A plain substring match
 * would let any page containing the marker string be mistaken for dsh web.
 */
export function hasDshBootManifest(html: string): boolean {
  const match = BOOT_MANIFEST_RE.exec(html)
  if (match?.[1] === undefined) return false
  let wire: unknown
  try {
    wire = JSON.parse(match[1])
  } catch {
    return false
  }
  if (typeof wire !== 'object' || wire === null) return false
  const graph = wire as Record<string, unknown>
  if (typeof graph.rev !== 'string' || !Array.isArray(graph.entries)) return false
  return graph.entries.every((row) => {
    if (typeof row !== 'object' || row === null) return false
    const entry = row as Record<string, unknown>
    return typeof entry.id === 'string' && typeof entry.url === 'string' && typeof entry.rev === 'string'
  })
}
