import { describe, expect, it } from 'vitest'
import { findReadyUrl, READY_LINE_RE } from '../src/server/portParser.ts'

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
