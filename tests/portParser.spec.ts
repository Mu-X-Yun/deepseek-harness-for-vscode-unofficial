import { describe, expect, it } from 'vitest'
import { findReadyUrl, hasDshBootManifest, READY_LINE_RE } from '../src/server/portParser.ts'

describe('findReadyUrl', () => {
  it('extracts the url and port from the ready line', () => {
    const result = findReadyUrl('dsh web: http://127.0.0.1:53087')
    expect(result).toEqual({ url: 'http://127.0.0.1:53087', port: 53087 })
  })

  it('matches the ready line inside a larger chunk', () => {
    const chunk = 'something\ndsh web: http://127.0.0.1:3080 (LAN: ...)\nmore'
    expect(findReadyUrl(chunk)).toEqual({ url: 'http://127.0.0.1:3080', port: 3080 })
  })

  it('handles the (LAN: ...) suffix noted in the web-app source', () => {
    const line = 'dsh web: http://127.0.0.1:3080 (LAN: 192.168.1.5:3080)'
    expect(findReadyUrl(line)?.port).toBe(3080)
  })

  it('returns undefined for unrelated output', () => {
    expect(findReadyUrl('loading plugins…')).toBeUndefined()
    expect(findReadyUrl('')).toBeUndefined()
  })

  it('returns undefined before the port appears', () => {
    expect(findReadyUrl('dsh web: http://127.0.0.1:')).toBeUndefined()
  })

  it('uses a regex that anchors on the official message shape', () => {
    expect(READY_LINE_RE.test('dsh web: http://127.0.0.1:12345')).toBe(true)
    expect(READY_LINE_RE.test('other web: http://127.0.0.1:12345')).toBe(false)
  })
})

/** Renders an index page like the dsh host serves it. */
function pageWith(graph: unknown): string {
  return `<html><head></head><body><script>window.__DSH_BOOT__ = ${JSON.stringify(graph)}</script></body></html>`
}

describe('hasDshBootManifest', () => {
  it('accepts the wire shape { rev, entries: [{ id, url, rev }] }', () => {
    const html = pageWith({
      rev: 'r1',
      entries: [
        { id: '@deepseek-ai/dsh-ui-app', url: '/plugins/ui/client.js?rev=r1', rev: 'r1', immediately: true },
      ],
    })
    expect(hasDshBootManifest(html)).toBe(true)
  })

  it('accepts an empty entry list', () => {
    expect(hasDshBootManifest(pageWith({ rev: 'r1', entries: [] }))).toBe(true)
  })

  it('rejects a page carrying only the marker string', () => {
    // Regression: the old check was a substring test; any page containing
    // the marker would have been adopted as a running dsh.
    expect(hasDshBootManifest('<html>__DSH_BOOT__</html>')).toBe(false)
    expect(hasDshBootManifest('<html><script>window.__DSH_BOOT__ = undefined</script></html>')).toBe(false)
  })

  it('rejects invalid JSON and malformed graphs', () => {
    expect(hasDshBootManifest('<html><script>window.__DSH_BOOT__ = {oops</script></html>')).toBe(false)
    expect(hasDshBootManifest(pageWith({ entries: [] }))).toBe(false) // rev missing
    expect(hasDshBootManifest(pageWith({ rev: 1, entries: [] }))).toBe(false) // rev not a string
    expect(hasDshBootManifest(pageWith({ rev: 'r1' }))).toBe(false) // entries missing
    expect(hasDshBootManifest(pageWith({ rev: 'r1', entries: 'nope' }))).toBe(false)
  })

  it('rejects entries missing required string fields', () => {
    expect(hasDshBootManifest(pageWith({ rev: 'r1', entries: [{ id: 'x', rev: 'r1' }] }))).toBe(false) // url missing
    expect(hasDshBootManifest(pageWith({ rev: 'r1', entries: [{ id: 'x', url: '/u', rev: 1 }] }))).toBe(false)
    expect(hasDshBootManifest(pageWith({ rev: 'r1', entries: ['not-an-object'] }))).toBe(false)
  })
})
