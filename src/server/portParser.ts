/**
 * Parses the dsh web ready line from the child process stdout.
 *
 * `dsh web` prints `dsh web: http://127.0.0.1:<port>` on stdout once the
 * Cordis loader has settled and the HTTP server is listening — this is the
 * official readiness signal (see packages/bundle/web-app/src/index.ts).
 * With `--port 0` the port is OS-assigned, so this line is the only reliable
 * way to learn the URL.
 */

/** Matches the ready line, e.g. `dsh web: http://127.0.0.1:53087`. */
export const READY_LINE_RE = /dsh web: (https?:\/\/127\.0\.0\.1:(\d+))/

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
