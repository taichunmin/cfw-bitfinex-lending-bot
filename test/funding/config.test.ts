import { afterEach, describe, expect, test, vi } from 'vitest'

import { parseEnvName } from '../../src/funding/config'

describe('parseEnvName()', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  test('回傳 process.env 裡設定的環境名稱', () => {
    vi.stubEnv('ENV_NAME', 'prod')
    expect(parseEnvName()).toBe('prod')
  })

  test('沒設定或不合法時當成 dev，免得本地執行動到正式狀態', () => {
    vi.stubEnv('ENV_NAME', undefined)
    expect(parseEnvName()).toBe('dev')
    vi.stubEnv('ENV_NAME', '')
    expect(parseEnvName()).toBe('dev')
    vi.stubEnv('ENV_NAME', 'a b')
    expect(parseEnvName()).toBe('dev')
  })
})
