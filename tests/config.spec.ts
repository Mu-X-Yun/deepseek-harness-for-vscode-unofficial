import { describe, expect, it } from 'vitest'
import { buildEnv } from '../src/config.ts'

describe('buildEnv', () => {
  it('inherits the base environment', () => {
    const env = buildEnv({ FOO: 'bar' }, { apiKey: undefined, baseUrl: undefined, permissionMode: 'workspace-write' })
    expect(env.FOO).toBe('bar')
  })

  it('injects DEEPSEEK_API_KEY when configured', () => {
    const env = buildEnv({}, { apiKey: 'sk-test', baseUrl: undefined, permissionMode: 'workspace-write' })
    expect(env.DEEPSEEK_API_KEY).toBe('sk-test')
  })

  it('keeps an inherited DEEPSEEK_API_KEY when not configured', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: 'sk-inherited' }, { apiKey: undefined, baseUrl: undefined, permissionMode: 'workspace-write' })
    expect(env.DEEPSEEK_API_KEY).toBe('sk-inherited')
  })

  it('settings override the inherited key', () => {
    const env = buildEnv({ DEEPSEEK_API_KEY: 'sk-inherited' }, { apiKey: 'sk-settings', baseUrl: undefined, permissionMode: 'workspace-write' })
    expect(env.DEEPSEEK_API_KEY).toBe('sk-settings')
  })

  it('injects DEEPSEEK_BASE_URL only when configured', () => {
    const env = buildEnv({}, { apiKey: undefined, baseUrl: 'https://api.deepseek.example', permissionMode: 'workspace-write' })
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.example')
    expect(buildEnv({}, { apiKey: undefined, baseUrl: undefined, permissionMode: 'workspace-write' }).DEEPSEEK_BASE_URL).toBeUndefined()
  })

  it('sets telemetry off and the permission mode', () => {
    const env = buildEnv({}, { apiKey: undefined, baseUrl: undefined, permissionMode: 'danger-full-access' })
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(env.DSH_PERMISSION_MODE).toBe('danger-full-access')
  })
})
