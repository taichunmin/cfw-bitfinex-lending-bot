import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { cloneDeep, errToJson, logger, pinoWriteFns, ymlStringify } from '../../src/lib/logger'

/** axios 打 Bitfinex 失敗時的 error，`config.headers` 會帶著金鑰 */
function createAxiosError (): Error & Record<string, any> {
  return Object.assign(new Error('Request failed with status code 500'), {
    name: 'AxiosError',
    code: 'ERR_BAD_RESPONSE',
    status: 500,
    config: {
      url: 'https://api.bitfinex.com/v2/auth/w/funding/auto',
      headers: { 'bfx-apikey': 'SUPER_SECRET_KEY', 'bfx-signature': 'deadbeef' },
    },
    request: { _header: 'POST /v2/auth/w/funding/auto HTTP/1.1' },
    response: {
      status: 500,
      data: ['error', 10001, 'nonce: small'],
      headers: { 'cf-ray': 'abc123' },
      config: { headers: { 'bfx-apikey': 'SUPER_SECRET_KEY' } },
    },
  })
}

/** 與 auto-renew-3 的 SkipError 一樣沒有覆寫 `name` */
class SkipError extends Error {}

describe('errToJson()', () => {
  test('只保留白名單欄位，不把 axios 的 config 與 request 寫進 log', () => {
    const actual = errToJson(createAxiosError())

    expect(actual).not.toHaveProperty('config')
    expect(actual).not.toHaveProperty('request')
    expect(JSON.stringify(actual)).not.toContain('SUPER_SECRET_KEY')
    expect(JSON.stringify(actual)).not.toContain('deadbeef')
  })

  test('保留除錯需要的欄位，response 只取 data / headers / status', () => {
    expect(errToJson(createAxiosError())).toEqual({
      name: 'Error',
      code: 'ERR_BAD_RESPONSE',
      message: 'Request failed with status code 500',
      stack: expect.any(String),
      status: 500,
      response: {
        data: ['error', 10001, 'nonce: small'],
        headers: { 'cf-ray': 'abc123' },
        status: 500,
      },
    })
  })

  test('用 constructor.name 才分得出沒有覆寫 name 的子類別', () => {
    expect(new SkipError('skip').name).toBe('Error')
    expect(errToJson(new SkipError('skip')).name).toBe('SkipError')
  })

  test('cause 是 Error 時會遞迴展開', () => {
    const err = new Error('outer', { cause: new SkipError('inner') })

    expect(errToJson(err).cause).toEqual({
      name: 'SkipError',
      message: 'inner',
      stack: expect.any(String),
    })
  })

  test('cause 是 Error 時同樣套用白名單，不會從 cause 洩漏金鑰', () => {
    const err = new Error('outer', { cause: createAxiosError() })

    expect(JSON.stringify(errToJson(err))).not.toContain('SUPER_SECRET_KEY')
  })

  test('cause 不是 Error 時也會經過 cloneDeep 處理', () => {
    const err = Object.assign(new Error('outer'), {
      cause: { big: 10n, _hidden: 'x', nested: new Error('deep') },
    })

    expect(errToJson(err).cause).toEqual({
      big: '10',
      _hidden: '[Redact]',
      nested: { name: 'Error', message: 'deep', stack: expect.any(String) },
    })
  })

  test('cause 是字串時原樣保留', () => {
    expect(errToJson(Object.assign(new Error('outer'), { cause: 'why' })).cause).toBe('why')
  })

  test.each([
    ['沒有 cause', new Error('x')],
    ['cause 是 undefined', Object.assign(new Error('x'), { cause: undefined })],
    ['cause 是 null', Object.assign(new Error('x'), { cause: null })],
  ])('%s 時不會多出一個空的 cause 欄位', (_label, err) => {
    expect(errToJson(err)).not.toHaveProperty('cause')
  })

  test.each([
    ['error 透過 data 指回自己', () => {
      const err: any = new Error('self')
      err.data = { self: err }
      return err
    }],
    ['兩個 error 透過 data 互指', () => {
      const a: any = new Error('a')
      const b: any = new Error('b')
      a.data = { b }
      b.data = { a }
      return a
    }],
    ['兩個 error 的 cause 互指', () => {
      const a: any = new Error('a')
      const b: any = new Error('b')
      a.cause = b
      b.cause = a
      return a
    }],
  ])('%s 時不會無限遞迴', (_label, createErr) => {
    expect(() => errToJson(createErr())).not.toThrow()
  })

  test('循環的那一層會標記成 [Circular] 並帶上原本的 message', () => {
    const err: any = new SkipError('self')
    err.data = { self: err }

    expect(errToJson(err).data.self).toEqual({ name: 'SkipError', message: '[Circular] self' })
  })
})

describe('cloneDeep()', () => {
  test('bigint 在各層都轉成字串', () => {
    expect(cloneDeep({ top: 10n, nested: { deep: [20n] } })).toEqual({
      top: '10',
      nested: { deep: ['20'] },
    })
  })

  test('底線開頭的隱藏欄位會被遮蔽', () => {
    expect(cloneDeep({ _top: 'x', nested: { _hidden: 'x', keep: 1 } })).toEqual({
      _top: '[Redact]',
      nested: { _hidden: '[Redact]', keep: 1 },
    })
  })

  test('單字元的底線欄位不算隱藏欄位', () => {
    expect(cloneDeep({ _: 'keep me' })).toEqual({ _: 'keep me' })
  })

  test('Map 轉成物件、Set 轉成陣列', () => {
    expect(cloneDeep({ m: new Map([['k', 'v']]), s: new Set([1, 2]) })).toEqual({
      m: { k: 'v' },
      s: [1, 2],
    })
  })

  test('Map 與 Set 的內容也會繼續處理', () => {
    const actual: any = cloneDeep({
      m: new Map<string, any>([['big', 10n], ['err', createAxiosError()]]),
      s: new Set<any>([createAxiosError()]),
    })

    expect(actual.m.big).toBe('10')
    expect(actual.m.err).not.toHaveProperty('config')
    expect(actual.s[0]).not.toHaveProperty('config')
    expect(JSON.stringify(actual)).not.toContain('SUPER_SECRET_KEY')
  })

  test('有 toJSON 的物件會用 toJSON 的結果', () => {
    expect(cloneDeep({ d: new Date('2026-09-08T00:00:00Z') })).toEqual({
      d: '2026-09-08T00:00:00.000Z',
    })
  })

  test('陣列裡的 Error 也會套用白名單', () => {
    const actual: any = cloneDeep({ list: [createAxiosError()] })

    expect(actual.list).toHaveLength(1)
    expect(actual.list[0]).not.toHaveProperty('config')
  })

  test('陣列複製後仍是陣列', () => {
    expect(Array.isArray((cloneDeep({ arr: [1, 2] }) as any).arr)).toBe(true)
  })

  test('循環參照標記成 [Circular]', () => {
    const obj: any = { x: 1 }
    obj.self = obj

    expect(cloneDeep(obj)).toEqual({ x: 1, self: '[Circular]' })
  })

  test('自我參照的 Map 不會無限遞迴', () => {
    const m = new Map<string, any>()
    m.set('self', m)

    expect(cloneDeep({ m })).toEqual({ m: { self: '[Circular]' } })
  })

  test('重複出現的基本型別不會被誤判成循環', () => {
    expect(cloneDeep({ a: 1, b: 1, c: 'USD', d: 'USD', e: null, f: null, g: true, h: true })).toEqual({
      a: 1, b: 1, c: 'USD', d: 'USD', e: null, f: null, g: true, h: true,
    })
  })

  test('陣列中重複的值不會被誤判成循環', () => {
    expect((cloneDeep({ arr: [0, 0, 1, 1] }) as any).arr).toEqual([0, 0, 1, 1])
  })

  test('每次 cron 都會 log 的 wallets 結構不會被誤判', () => {
    const wallets = {
      'funding:USD': { type: 'funding', currency: 'USD', balance: 1000, available: 1000 },
      'funding:UST': { type: 'funding', currency: 'UST', balance: 500, available: 500 },
    }

    expect(cloneDeep(wallets)).toEqual(wallets)
  })

  test('同一個 Date 出現兩次不會被誤判成循環', () => {
    const date = new Date('2026-09-08T00:00:00Z')

    expect(cloneDeep({ p: date, q: date })).toEqual({
      p: '2026-09-08T00:00:00.000Z',
      q: '2026-09-08T00:00:00.000Z',
    })
  })

  test('結果可以直接 JSON.stringify，不會因為 bigint 或循環而失敗', () => {
    const circular: any = { x: 1 }
    circular.self = circular

    expect(() => JSON.stringify(cloneDeep({
      big: 10n,
      circular,
      err: createAxiosError(),
      m: new Map([['k', 'v']]),
    }))).not.toThrow()
  })
})

describe('ymlStringify()', () => {
  test('輸出 YAML 且不含結尾換行', () => {
    const actual = ymlStringify({ a: 1, b: 'x' })

    expect(actual).toBe('a: 1\nb: x')
    expect(actual.endsWith('\n')).toBe(false)
  })

  test('Telegram 訊息用的 credits 結構', () => {
    const credits = [{ id: 1, amount: 100.5, rate: '0.012345%', period: 2 }]

    expect(ymlStringify({ credits })).toBe([
      'credits:',
      '  - id: 1',
      '    amount: 100.5',
      "    rate: 0.012345%",
      '    period: 2',
    ].join('\n'))
  })

  test('bigint 與 Error 先被 cloneDeep 處理過，不會讓 yamlDump 失敗', () => {
    expect(() => ymlStringify({ big: 10n, err: createAxiosError() })).not.toThrow()
  })
})

describe('pinoWriteFns', () => {
  const spies: Record<string, ReturnType<typeof vi.spyOn>> = {}

  beforeEach(() => {
    for (const fnName of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      spies[fnName] = vi.spyOn(console, fnName).mockImplementation(() => {})
    }
  })

  afterEach(() => { vi.restoreAllMocks() })

  test.each([
    ['trace', 'debug'],
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['fatal', 'error'],
  ])('%s 寫到 console.%s', (level, fnName) => {
    pinoWriteFns[level]({ msg: 'hi' })

    expect(spies[fnName]).toHaveBeenCalledTimes(1)
    expect(spies[fnName]).toHaveBeenCalledWith({ msg: 'hi' })
  })

  test('傳給 console 的是物件，Workers Logs 才能索引欄位', () => {
    pinoWriteFns.info({ level: 'info', namespace: 'x', msg: 'hi', currency: 'USD' })

    expect(spies.info).toHaveBeenCalledWith(expect.any(Object))
  })

  test('序列化失敗時不往外拋，避免一則 log 弄掛整個 cron', () => {
    const exploding = {
      namespace: 'my-ns',
      get boom (): never { throw new Error('cannot clone') },
    }

    expect(() => pinoWriteFns.error(exploding)).not.toThrow()
  })

  test('序列化失敗時仍留下 level 與 namespace，才找得到是哪則 log', () => {
    const exploding = {
      namespace: 'my-ns',
      get boom (): never { throw new Error('cannot clone') },
    }
    pinoWriteFns.error(exploding)

    expect(spies.error).toHaveBeenCalledWith(expect.objectContaining({
      data: { pinoWriteFns: { level: 'error', namespace: 'my-ns' } },
      cause: expect.objectContaining({ message: 'cannot clone' }),
    }))
  })
})

describe('logger', () => {
  const spies: Record<string, ReturnType<typeof vi.spyOn>> = {}

  beforeEach(() => {
    for (const fnName of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      spies[fnName] = vi.spyOn(console, fnName).mockImplementation(() => {})
    }
  })

  afterEach(() => { vi.restoreAllMocks() })

  test('輸出帶有 namespace、level 標籤、ISO 時間與 msg', () => {
    logger.child({ namespace: 'funding-auto-renew-3' }).info({ currency: 'USD' }, 'newAutoRenew')

    expect(spies.info).toHaveBeenCalledWith({
      namespace: 'funding-auto-renew-3',
      level: 'info',
      msg: 'newAutoRenew',
      currency: 'USD',
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    })
  })

  test('level 是字串標籤而不是數字，dashboard 才好過濾', () => {
    logger.child({ namespace: 'x' }).warn('careful')

    expect(spies.warn).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  test('error 會走 console.error，Workers Logs 才標記成 error severity', () => {
    logger.child({ namespace: 'x' }).error({ err: createAxiosError() }, 'failed')

    expect(spies.error).toHaveBeenCalledTimes(1)
    expect(spies.info).not.toHaveBeenCalled()
  })

  test('把 Error 包在物件裡時會套用白名單，不會洩漏金鑰', () => {
    logger.child({ namespace: 'x' }).error({ err: createAxiosError() }, 'failed')

    const logged = JSON.stringify(spies.error.mock.calls[0][0])
    expect(logged).not.toContain('SUPER_SECRET_KEY')
    expect(logged).not.toContain('deadbeef')
    expect(logged).toContain('nonce: small')
  })

  test('debug 有開啟，trace 則被 level 濾掉', () => {
    const log = logger.child({ namespace: 'x' })
    log.debug('shown')
    log.trace('hidden')

    expect(spies.debug).toHaveBeenCalledTimes(1)
    expect(spies.debug).toHaveBeenCalledWith(expect.objectContaining({ level: 'debug', msg: 'shown' }))
  })
})
