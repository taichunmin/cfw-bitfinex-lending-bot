import _ from 'lodash'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ZodConfig, ZodDb, calcTargetRate, main, rateToPeriod } from '../../../src/funding/auto-renew-3'
import { dateStringify } from '../../../src/lib/helper'
import { Telegram } from '../../../src/lib/telegram'

/** 與 src/funding/auto-renew-3/index.ts 的 DB_KEY 相同，改動會讓既有的狀態對不上 */
const DB_KEY = 'api:taichunmin_funding-auto-renew-3'

const mocks = vi.hoisted(() => ({
  // static methods of Bitfinex
  v2CandlesHist: vi.fn(),
  v2FundingStatsHist: vi.fn(),
  v2PlatformStatus: vi.fn(),
  // instance methods of Bitfinex
  v2AuthReadFundingAutoStatus: vi.fn(),
  v2AuthReadFundingCredits: vi.fn(),
  v2AuthReadFundingOffers: vi.fn(),
  v2AuthReadSettings: vi.fn(),
  v2AuthReadWallets: vi.fn(),
  v2AuthWriteFundingAuto: vi.fn(),
  v2AuthWriteFundingOfferCancelAll: vi.fn(),
  v2AuthWriteSettingsSet: vi.fn(),
  // helper
  sleep: vi.fn(async () => {}),
}))

vi.mock('../../../src/lib/bitfinex', () => ({
  Bitfinex: {
    v2CandlesHist: mocks.v2CandlesHist,
    v2FundingStatsHist: mocks.v2FundingStatsHist,
    v2PlatformStatus: mocks.v2PlatformStatus,
  },
  BitfinexSort: { ASC: '+1', DESC: '-1' },
  PlatformStatus: { MAINTENANCE: 0, OPERATIVE: 1 },
  getBitfinex: vi.fn(() => _.pick(mocks, [
    'v2AuthReadFundingAutoStatus',
    'v2AuthReadFundingCredits',
    'v2AuthReadFundingOffers',
    'v2AuthReadSettings',
    'v2AuthReadWallets',
    'v2AuthWriteFundingAuto',
    'v2AuthWriteFundingOfferCancelAll',
    'v2AuthWriteSettingsSet',
  ])),
}))

// `main()` 在改完 auto-renew 後會 sleep(1000)，測試不需要真的等
vi.mock('../../../src/lib/helper', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/lib/helper')>(),
  sleep: mocks.sleep,
}))

describe('calcTargetRate()', () => {
  const opts = { rank: 0.5, rateMin: 0.0001, rateMax: 0.01 }
  const candle = (low: number, high: number, volume: number) => ({ open: low, close: high, high, low, volume })

  test('沒有 K 線時回傳 null', () => {
    expect(calcTargetRate([], opts)).toBeNull()
  })

  test('所有 K 線都沒有成交量時回傳 null', () => {
    expect(calcTargetRate([candle(0.001, 0.002, 0), candle(0.003, 0.004, 0)], opts)).toBeNull()
  })

  test('只有一根沒有波動的 K 線時，回傳該利率', () => {
    expect(calcTargetRate([candle(0.001, 0.001, 100)], opts)).toBeCloseTo(0.001, 8)
  })

  test.each([
    { rank: 0.25, expected: 0.00125 },
    { rank: 0.5, expected: 0.0015 },
    { rank: 0.75, expected: 0.00175 },
  ])('單一區間內依 rank=$rank 線性內插出 $expected', ({ rank, expected }) => {
    // 成交量在 [0.001, 0.002] 之間均勻分布，rank 分位即為線性內插的結果
    const actual = calcTargetRate([candle(0.001, 0.002, 100)], { ...opts, rank })
    expect(actual).toBeCloseTo(expected, 7)
  })

  test('成交量大的區間會把目標利率拉過去', () => {
    const candles = [candle(0.001, 0.002, 900), candle(0.008, 0.009, 100)]
    // 90% 的成交量都在 [0.001, 0.002]，rank=0.5 的目標利率必落在該區間
    const actual = calcTargetRate(candles, opts) as number
    expect(actual).toBeGreaterThan(0.001)
    expect(actual).toBeLessThan(0.002)
  })

  test('相同區間的成交量會被合併計算', () => {
    const merged = calcTargetRate([candle(0.001, 0.002, 100)], opts)
    const splitted = calcTargetRate([candle(0.001, 0.002, 40), candle(0.001, 0.002, 60)], opts)
    expect(splitted).toBe(merged)
  })

  test('沒有成交量的 K 線不影響結果', () => {
    const expected = calcTargetRate([candle(0.001, 0.002, 100)], opts)
    const actual = calcTargetRate([candle(0.001, 0.002, 100), candle(0.05, 0.06, 0)], opts)
    expect(actual).toBe(expected)
  })

  test('K 線的 open/close/high/low 順序不影響結果', () => {
    const expected = calcTargetRate([candle(0.001, 0.002, 100)], opts)
    const shuffled = { open: 0.002, close: 0.001, high: 0.0015, low: 0.0015, volume: 100 }
    expect(calcTargetRate([shuffled], opts)).toBe(expected)
  })

  test('目標利率低於 rateMin 時會被夾住', () => {
    expect(calcTargetRate([candle(0.0001, 0.0001, 100)], { ...opts, rateMin: 0.0005 })).toBe(0.0005)
  })

  test('目標利率高於 rateMax 時會被夾住', () => {
    expect(calcTargetRate([candle(0.05, 0.05, 100)], { ...opts, rateMax: 0.01 })).toBe(0.01)
  })
})

describe('rateToPeriod()', () => {
  const periodMap = { 3: 0.00027397, 7: 0.00041096, 21: 0.00068493, 30: 0.00082192 }

  test('沒有設定 period 時回傳最短的 2 天', () => {
    expect(rateToPeriod({}, 0.001)).toBe(2)
  })

  test('利率低於所有門檻時回傳最短的 2 天', () => {
    expect(rateToPeriod(periodMap, 0.0001)).toBe(2)
  })

  test('利率高於所有門檻時回傳最長的天數', () => {
    expect(rateToPeriod(periodMap, 0.001)).toBe(30)
  })

  test.each([
    { rate: 0.00027397, expected: 3 },
    { rate: 0.00041096, expected: 7 },
    { rate: 0.00068493, expected: 21 },
    { rate: 0.00082192, expected: 30 },
  ])('利率剛好等於門檻 $rate 時回傳 $expected 天', ({ rate, expected }) => {
    expect(rateToPeriod(periodMap, rate)).toBe(expected)
  })

  test('利率落在兩個門檻之間時做線性內插後無條件捨去', () => {
    // 0.00054795 約為 7 天(0.00041096)與 21 天(0.00068493)的中點，內插後為 14.0002 天
    expect(rateToPeriod(periodMap, 0.00054795)).toBe(14)
  })

  test('內插結果會無條件捨去而非四捨五入', () => {
    // 剛好落在 2 天與 4 天的正中間，內插值 3.0 之後的小數會被捨去
    expect(rateToPeriod({ 2: 0.0002, 4: 0.0004 }, 0.00039)).toBe(3)
  })

  test('回傳值會被夾在 2 ~ 120 天之間', () => {
    expect(rateToPeriod({ 150: 0.0005 }, 0.001)).toBe(120)
    expect(rateToPeriod({ 1: 0.0005 }, 0.001)).toBe(2)
  })
})

describe('ZodConfig', () => {
  test('未設定時為空設定', () => {
    expect(ZodConfig.parse(undefined)).toEqual({})
  })

  test('未指定的欄位會套用預設值', () => {
    expect(ZodConfig.parse({ USD: {} })).toEqual({
      USD: { amount: 0, period: {}, rank: 0.5, rateMax: 0.01, rateMin: 0.0002 },
    })
  })

  test('字串型別的數值會被轉型', () => {
    expect(ZodConfig.parse({ USD: { amount: '100', rank: '0.8', rateMax: '0.01', rateMin: '0.0001' } })).toMatchObject({
      USD: { amount: 100, rank: 0.8, rateMax: 0.01, rateMin: 0.0001 },
    })
  })

  test.each([
    { name: 'rank 大於 1', cfg: { USD: { rank: 1.5 } } },
    { name: 'rank 小於 0', cfg: { USD: { rank: -0.1 } } },
    { name: 'amount 小於 0', cfg: { USD: { amount: -1 } } },
    { name: 'rateMin 小於 RATE_MIN', cfg: { USD: { rateMin: 0.00005 } } },
    { name: 'rateMax 小於 RATE_MIN', cfg: { USD: { rateMax: 0.00005 } } },
    { name: 'period 的天數小於 2', cfg: { USD: { period: { 1: 0.0002 } } } },
    { name: 'period 的天數大於 120', cfg: { USD: { period: { 121: 0.0002 } } } },
    { name: 'period 的利率不是正數', cfg: { USD: { period: { 3: 0 } } } },
  ])('$name 時解析失敗', ({ cfg }) => {
    expect(() => ZodConfig.parse(cfg)).toThrow()
  })
})

describe('ZodDb', () => {
  test('未設定時回傳空的 schema 1', () => {
    expect(ZodDb.parse(undefined)).toEqual({ schema: 1 })
  })

  test.each([
    { name: '不是物件', db: 'not an object' },
    { name: 'schema 版本不同', db: { schema: 2 } },
  ])('$name 時退回空的 schema 1', ({ db }) => {
    expect(ZodDb.parse(db)).toEqual({ schema: 1 })
  })

  test('保留合法的 notified', () => {
    const db = { schema: 1, notified: { USD: { balance: 1000.5, creditIds: [2, 1], msgId: 123 } } }
    expect(ZodDb.parse(db)).toEqual(db)
  })

  test('notified 的 balance 會無條件捨去到小數點後 8 位', () => {
    const db = { schema: 1, notified: { USD: { balance: 1.234567891234, creditIds: [], msgId: 1 } } }
    expect(ZodDb.parse(db).notified?.USD?.balance).toBe(1.23456789)
  })

  test('不合法的 notified 會變成 null 而不是整包壞掉', () => {
    const db = { schema: 1, notified: { USD: { balance: 'oops' }, UST: { balance: 1, creditIds: [1], msgId: 2 } } }
    expect(ZodDb.parse(db).notified).toEqual({ USD: null, UST: { balance: 1, creditIds: [1], msgId: 2 } })
  })
})

describe('main()', () => {
  const CANDLES = [{ open: 0.001, close: 0.002, high: 0.002, low: 0.001, volume: 100 }]
  const PERIOD = { 3: 0.00027397, 7: 0.00041096 }
  /** 用同一套演算法算出 CANDLES 對應的目標利率，避免測試寫死浮點數 */
  const TARGET_RATE = calcTargetRate(CANDLES, { rank: 0.5, rateMin: 0.0001, rateMax: 0.01 }) as number
  const TARGET_PERIOD = rateToPeriod(PERIOD, TARGET_RATE)

  const telegram = { editMessageText: vi.fn(), sendMessage: vi.fn() }

  const SCHEDULED_TIME = new Date('2025-09-07T00:05:00Z').getTime()

  function createController (overrides: Record<string, any> = {}): ScheduledController {
    return { cron: '*/5 * * * *', scheduledTime: SCHEDULED_TIME, noRetry: () => {}, ...overrides }
  }

  function createCtx (): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  }

  function createEnv (overrides: Record<string, any> = {}): Env {
    return {
      BITFINEX_API_KEY: 'api-key',
      BITFINEX_API_SECRET: 'api-secret',
      TELEGRAM_CHAT_ID: '-100',
      TELEGRAM_TOKEN: 'tg-token',
      INPUT_AUTO_RENEW_3: {
        USD: { amount: 0, period: PERIOD, rank: 0.5, rateMax: 0.01, rateMin: 0.0001 },
      },
      ...overrides,
    } as unknown as Env
  }

  beforeEach(() => {
    vi.clearAllMocks()
    for (const logType of ['debug', 'error', 'info', 'log', 'warn']) {
      vi.spyOn(console, logType as 'log').mockImplementation(() => {})
    }
    vi.spyOn(Telegram, 'fromEnv').mockReturnValue(telegram as unknown as Telegram)

    mocks.v2PlatformStatus.mockResolvedValue({ status: 1 })
    mocks.v2FundingStatsHist.mockResolvedValue([{ mts: new Date('2025-09-07T00:00:00Z'), frr: 0.0003 }])
    mocks.v2CandlesHist.mockResolvedValue(CANDLES)
    mocks.v2AuthReadSettings.mockResolvedValue({ [DB_KEY.slice(4)]: { schema: 1, notified: {} } })
    mocks.v2AuthReadWallets.mockResolvedValue([{ type: 'funding', currency: 'USD', balance: 1000 }])
    mocks.v2AuthReadFundingAutoStatus.mockResolvedValue({ currency: 'USD', amount: 0, period: 2, rate: 0.0009 })
    mocks.v2AuthWriteFundingAuto.mockResolvedValue({})
    mocks.v2AuthWriteFundingOfferCancelAll.mockResolvedValue({})
    mocks.v2AuthReadFundingCredits.mockResolvedValue([
      { id: 1, side: 1, amount: 500, rate: 0.0012, period: 2, mtsOpening: new Date('2025-09-06T10:00:00Z') },
      { id: 2, side: 0, amount: 300, rate: 0.0012, period: 2, mtsOpening: new Date('2025-09-06T10:00:00Z') },
    ])
    mocks.v2AuthReadFundingOffers.mockResolvedValue([{ id: 3, amount: 200 }])
    mocks.v2AuthWriteSettingsSet.mockResolvedValue({})
    telegram.sendMessage.mockResolvedValue({ message_id: 999 })
    telegram.editMessageText.mockResolvedValue(true)
  })

  afterEach(() => { vi.restoreAllMocks() })

  test('傳入 controller 時，每則 log 都帶著 reqId 與 scheduledTime', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    await main(createController(), createEnv(), createCtx())

    expect(infoSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [logged] of infoSpy.mock.calls) {
      expect(logged).toMatchObject({
        namespace: 'funding-auto-renew-3',
        reqId: expect.any(String),
        scheduledTime: dateStringify(SCHEDULED_TIME),
      })
    }
    // 同一次執行的所有 log 共用同一個 reqId
    const reqIds = new Set(infoSpy.mock.calls.map(([logged]: any) => logged.reqId))
    expect(reqIds.size).toBe(1)
  })

  test('平台維護中時直接結束，不做任何 API 呼叫', async () => {
    mocks.v2PlatformStatus.mockResolvedValue({ status: 0 })
    await main(createController(), createEnv(), createCtx())
    expect(mocks.v2AuthReadSettings).not.toHaveBeenCalled()
    expect(mocks.v2AuthWriteSettingsSet).not.toHaveBeenCalled()
  })

  test('設定為空時不對任何幣別動作，但仍會寫回 db', async () => {
    await main(createController(), createEnv({ INPUT_AUTO_RENEW_3: {} }), createCtx())
    expect(mocks.v2CandlesHist).not.toHaveBeenCalled()
    expect(mocks.v2AuthWriteFundingAuto).not.toHaveBeenCalled()
    expect(mocks.v2AuthWriteSettingsSet).toHaveBeenCalledWith({ [DB_KEY]: { schema: 1, notified: {} } })
  })

  test('設定有變更時，關閉舊 auto-renew、取消掛單、再寫入新設定', async () => {
    await main(createController(), createEnv(), createCtx())

    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenCalledTimes(2)
    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenNthCalledWith(1, { currency: 'USD', status: 0 })
    expect(mocks.v2AuthWriteFundingOfferCancelAll).toHaveBeenCalledWith({ currency: 'USD' })
    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenNthCalledWith(2, {
      amount: 0,
      currency: 'USD',
      period: TARGET_PERIOD,
      rate: TARGET_RATE * 100, // Bitfinex 的 rate 是百分比
      status: 1,
    })
    expect(mocks.sleep).toHaveBeenCalledWith(1000)
  })

  test('原本沒有 auto-renew 時不會多送一次關閉的請求', async () => {
    mocks.v2AuthReadFundingAutoStatus.mockResolvedValue(null)
    await main(createController(), createEnv(), createCtx())

    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenCalledTimes(1)
    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenCalledWith(expect.objectContaining({ status: 1 }))
  })

  test('設定沒變更時不改 auto-renew，但仍會回報狀態', async () => {
    mocks.v2AuthReadFundingAutoStatus.mockResolvedValue({
      amount: 0,
      currency: 'USD',
      period: TARGET_PERIOD,
      rate: TARGET_RATE,
    })
    await main(createController(), createEnv(), createCtx())

    expect(mocks.v2AuthWriteFundingAuto).not.toHaveBeenCalled()
    expect(mocks.v2AuthWriteFundingOfferCancelAll).not.toHaveBeenCalled()
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('沒有 K 線時跳過該幣別，不改設定也不回報', async () => {
    mocks.v2CandlesHist.mockResolvedValue([])
    await main(createController(), createEnv(), createCtx())

    expect(mocks.v2AuthWriteFundingAuto).not.toHaveBeenCalled()
    expect(telegram.sendMessage).not.toHaveBeenCalled()
    expect(telegram.editMessageText).not.toHaveBeenCalled()
  })

  test('funding 錢包沒有餘額時不回報狀態', async () => {
    mocks.v2AuthReadWallets.mockResolvedValue([{ type: 'funding', currency: 'UST', balance: 1000 }])
    await main(createController(), createEnv(), createCtx())

    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenCalled()
    expect(telegram.sendMessage).not.toHaveBeenCalled()
  })

  test('沒有設定 Telegram 時不影響掛單邏輯', async () => {
    vi.mocked(Telegram.fromEnv).mockReturnValue(null)
    await main(createController(), createEnv(), createCtx())

    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenCalledTimes(2)
    expect(mocks.v2AuthWriteSettingsSet).toHaveBeenCalled()
  })

  test('第一次回報時發送新訊息，並把 msgId 記錄到 db', async () => {
    await main(createController(), createEnv(), createCtx())

    expect(telegram.editMessageText).not.toHaveBeenCalled()
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1)
    const { text } = telegram.sendMessage.mock.calls[0][0]
    expect(text).toContain('funding\\-auto\\-renew\\-3: USD 狀態')
    expect(text).toContain('投資額: 1,000\\.000')
    expect(text).toContain('已借出: 500\\.000 \\(50\\.00%\\)') // side === 1 的 credit 才算
    expect(text).toContain('掛單中: 200\\.000 \\(20\\.00%\\)')
    expect(text).toContain(`天數: ${TARGET_PERIOD}`)

    expect(mocks.v2AuthWriteSettingsSet).toHaveBeenCalledWith({
      [DB_KEY]: { schema: 1, notified: { USD: { balance: 1000, creditIds: [1], msgId: 999 } } },
    })
  })

  test('餘額與出借中的 credit 都沒變時，改成編輯既有訊息', async () => {
    mocks.v2AuthReadSettings.mockResolvedValue({
      [DB_KEY.slice(4)]: { schema: 1, notified: { USD: { balance: 1000, creditIds: [1], msgId: 999 } } },
    })
    await main(createController(), createEnv(), createCtx())

    expect(telegram.sendMessage).not.toHaveBeenCalled()
    expect(telegram.editMessageText).toHaveBeenCalledTimes(1)
    expect(telegram.editMessageText.mock.calls[0][0]).toMatchObject({ message_id: 999, parse_mode: 'MarkdownV2' })
  })

  test.each([
    { name: '餘額改變', notified: { balance: 900, creditIds: [1], msgId: 999 } },
    { name: 'credit 改變', notified: { balance: 1000, creditIds: [1, 2], msgId: 999 } },
    { name: '沒有 msgId', notified: { balance: 1000, creditIds: [1] } },
  ])('$name 時改發新訊息', async ({ notified }) => {
    mocks.v2AuthReadSettings.mockResolvedValue({ [DB_KEY.slice(4)]: { schema: 1, notified: { USD: notified } } })
    await main(createController(), createEnv(), createCtx())

    expect(telegram.editMessageText).not.toHaveBeenCalled()
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('單一幣別出錯時不影響其他幣別，也不影響 db 的寫回', async () => {
    mocks.v2FundingStatsHist.mockImplementation(async ({ currency }: { currency: string }) => {
      if (currency === 'USD') throw new Error('bitfinex is angry')
      return [{ mts: new Date('2025-09-07T00:00:00Z'), frr: 0.0003 }]
    })
    mocks.v2AuthReadWallets.mockResolvedValue([{ type: 'funding', currency: 'UST', balance: 1000 }])
    const env = createEnv({
      INPUT_AUTO_RENEW_3: {
        USD: { amount: 0, period: PERIOD, rank: 0.5, rateMax: 0.01, rateMin: 0.0001 },
        UST: { amount: 0, period: PERIOD, rank: 0.5, rateMax: 0.01, rateMin: 0.0001 },
      },
    })

    await expect(main(createController(), env, createCtx())).resolves.toBeUndefined()
    expect(mocks.v2AuthWriteFundingAuto).toHaveBeenCalledWith(expect.objectContaining({ currency: 'UST', status: 1 }))
    expect(mocks.v2AuthWriteFundingAuto).not.toHaveBeenCalledWith(expect.objectContaining({ currency: 'USD', status: 1 }))
    expect(mocks.v2AuthWriteSettingsSet).toHaveBeenCalledTimes(1)
  })

  test('db 壞掉時退回預設值，不會讓整次執行失敗', async () => {
    mocks.v2AuthReadSettings.mockResolvedValue({ [DB_KEY.slice(4)]: 'garbage' })
    await main(createController(), createEnv(), createCtx())

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.v2AuthWriteSettingsSet).toHaveBeenCalledWith({
      [DB_KEY]: { schema: 1, notified: { USD: { balance: 1000, creditIds: [1], msgId: 999 } } },
    })
  })

  test('讀取 db 用的是與原專案相同的 key', async () => {
    await main(createController(), createEnv(), createCtx())
    expect(mocks.v2AuthReadSettings).toHaveBeenCalledWith([DB_KEY])
  })
})
