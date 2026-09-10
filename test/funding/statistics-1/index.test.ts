import _ from 'lodash'
import { describe, expect, test } from 'vitest'

import { toCreditCsvRow } from '../../../src/funding/export-credits-1'
import {
  buildReportText,
  calcLentAmountByDate,
  calcStats,
  creditYears,
  statisticsKey,
} from '../../../src/funding/statistics-1'
import { DB_KEY } from '../../../src/funding/statistics-1/const'
import { ZodDb } from '../../../src/funding/statistics-1/schema'

const MS_PER_DAY = 86400_000

function creditRow (id: number, openedAt: string, closedAt: string, amount: number, side = 1) {
  return toCreditCsvRow({
    amount,
    id,
    mtsCreate: new Date(openedAt),
    mtsLastPayout: new Date(closedAt),
    mtsOpening: new Date(openedAt),
    mtsUpdate: new Date(closedAt),
    period: 2,
    rate: 0.0003,
    side,
    status: 'CLOSED',
  })
}

describe('DB_KEY', () => {
  test('改動會讓既有狀態對不上，當天會重發報告', () => {
    expect(DB_KEY).toBe('api:taichunmin_funding-statistics-1')
  })
})

describe('ZodDb', () => {
  test('空物件也要能 parse，首次執行沒有狀態時不能炸掉', () => {
    expect(ZodDb.parse({})).toMatchObject({ schema: 2 })
  })

  test('壞掉的日期會被 catch 成 null，不會整份狀態失效', () => {
    const db = ZodDb.parse({ schema: 2, latestDate2: { USD: '2026-09-09', UST: 'not-a-date' } })
    expect(db.latestDate2).toEqual({ USD: '2026-09-09', UST: null })
  })
})

describe('statisticsKey()', () => {
  test('key 帶專案名前綴，通用 bucket 才不會撞名', () => {
    expect(statisticsKey('USD', 'csv')).toBe('bitfinex-lending-bot/funding/statistics-1/USD.csv')
    expect(statisticsKey('USD', 'json')).toBe('bitfinex-lending-bot/funding/statistics-1/USD.json')
  })
})

describe('creditYears()', () => {
  test('365 天視窗最多涵蓋今年與去年兩個年度檔', () => {
    expect(creditYears(new Date('2026-09-10T00:45:00Z'))).toEqual([2025, 2026])
  })

  test('用 UTC 判斷年份', () => {
    // UTC 還是 2025-12-31，UTC+8 已經跨年
    expect(creditYears(new Date('2025-12-31T16:30:00Z'))).toEqual([2024, 2025])
  })
})

describe('calcLentAmountByDate()', () => {
  const now = new Date('2026-09-10T12:00:00Z')

  test('跨日的出借依存續時間攤到每一天', () => {
    const actual = calcLentAmountByDate(
      [creditRow(1, '2026-09-01T12:00:00Z', '2026-09-02T12:00:00Z', 100)],
      [],
      now,
    )
    expect(actual).toEqual({ '2026-09-01': 50, '2026-09-02': 50 })
  })

  test('同一天內的出借只算該日的比例', () => {
    const actual = calcLentAmountByDate(
      [creditRow(1, '2026-09-01T00:00:00Z', '2026-09-01T06:00:00Z', 240)],
      [],
      now,
    )
    expect(actual).toEqual({ '2026-09-01': 60 })
  })

  test('side 不是 1（不是貸方）的記錄不計入', () => {
    const actual = calcLentAmountByDate(
      [creditRow(1, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 100, -1)],
      [],
      now,
    )
    expect(actual).toEqual({})
  })

  test('重複的 id 只算一次', () => {
    const row = creditRow(1, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 100)
    expect(calcLentAmountByDate([row, row], [], now)).toEqual({ '2026-09-01': 100 })
  })

  test('進行中的出借以 [mtsOpening, 現在] 併入，否則昨天的放出量會嚴重低估', () => {
    const actual = calcLentAmountByDate([], [
      { amount: 200, mtsOpening: new Date('2026-09-10T00:00:00Z'), side: 1 },
    ], now)
    // 00:00 到 12:00 = 半天
    expect(actual).toEqual({ '2026-09-10': 100 })
  })

  test('進行中但 side 不是 1 的不計入', () => {
    const actual = calcLentAmountByDate([], [
      { amount: 200, mtsOpening: new Date('2026-09-10T00:00:00Z'), side: -1 },
    ], now)
    expect(actual).toEqual({})
  })

  test('已結束與進行中的出借會疊加在同一天', () => {
    const actual = calcLentAmountByDate(
      [creditRow(1, '2026-09-10T00:00:00Z', '2026-09-10T12:00:00Z', 100)],
      [{ amount: 200, mtsOpening: new Date('2026-09-10T00:00:00Z'), side: 1 }],
      now,
    )
    expect(actual['2026-09-10']).toBe(50 + 100)
  })
})

describe('calcStats()', () => {
  const now = new Date('2026-09-10T00:45:00Z')

  test('沒有任何利息記錄時回傳 null，呼叫端要據此跳過而不是丟錯', () => {
    expect(calcStats([], {}, now)).toEqual({ stats: [], dateMax: null, statsByDate: {} })
  })

  test('算出每日年化，dateMax 是最新一筆利息的日期', () => {
    const { stats, dateMax, statsByDate } = calcStats(
      [{ amount: 1, balance: 1001, mts: new Date('2026-09-09T01:30:00Z') }],
      {},
      now,
    )

    expect(dateMax).toBe('2026-09-09')
    // 從 dateMin 補到今天
    expect(_.map(stats, 'date')).toEqual(['2026-09-09', '2026-09-10'])
    const stat = statsByDate['2026-09-09']
    expect(stat.interest).toBe(1)
    expect(stat.balance).toBe(1001)
    expect(stat.investment).toBe(1000)
    expect(stat.apr1).toBeCloseTo(36.5, 8)
  })

  test('日期一律用 UTC 分桶，不受本機時區影響', () => {
    // UTC 是 09-09 23:30，UTC+8 已經是 09-10
    const { dateMax } = calcStats(
      [{ amount: 1, balance: 1001, mts: new Date('2026-09-09T23:30:00Z') }],
      {},
      now,
    )
    expect(dateMax).toBe('2026-09-09')
  })

  test('利用率用當日放出金額除以當日可投入本金', () => {
    const { statsByDate } = calcStats(
      [{ amount: 1, balance: 1001, mts: new Date('2026-09-09T01:30:00Z') }],
      { '2026-09-09': 500 },
      now,
    )
    // investment = 1000，放出 500 -> 50%
    expect(statsByDate['2026-09-09'].lentRatio1).toBe(50)
  })

  test('本金為 0 的日子利用率算 0，不會變成 Infinity 或 NaN', () => {
    const { statsByDate } = calcStats(
      [{ amount: 0, balance: 0, mts: new Date('2026-09-09T01:30:00Z') }],
      { '2026-09-09': 500 },
      now,
    )
    expect(statsByDate['2026-09-09'].lentRatio1).toBe(0)
    expect(statsByDate['2026-09-09'].dpr).toBe(0)
  })

  test('沒有利息的日子沿用前一天的餘額，不會斷掉', () => {
    const { statsByDate } = calcStats(
      [{ amount: 1, balance: 1001, mts: new Date('2026-09-08T01:30:00Z') }],
      {},
      now,
    )
    expect(statsByDate['2026-09-09'].balance).toBe(1001)
    expect(statsByDate['2026-09-10'].balance).toBe(1001)
  })

  test('同一天多筆利息不會把 trailing 年化灌大', () => {
    const split = calcStats([
      { amount: 1, balance: 1001, mts: new Date('2026-09-09T01:00:00Z') },
      { amount: 1, balance: 1002, mts: new Date('2026-09-09T02:00:00Z') },
    ], {}, now)
    const merged = calcStats([
      { amount: 2, balance: 1002, mts: new Date('2026-09-09T01:00:00Z') },
    ], {}, now)

    // 拆成兩筆與併成一筆，總利息與最終餘額相同，每一項都該一致
    expect(split.statsByDate['2026-09-09']).toEqual(merged.statsByDate['2026-09-09'])
  })

  test('同一天的彙總與 ledger 回傳順序無關', () => {
    const asc = calcStats([
      { amount: 1, balance: 1001, mts: new Date('2026-09-09T01:00:00Z') },
      { amount: 1, balance: 1002, mts: new Date('2026-09-09T02:00:00Z') },
    ], {}, now)
    const desc = calcStats([
      { amount: 1, balance: 1002, mts: new Date('2026-09-09T02:00:00Z') },
      { amount: 1, balance: 1001, mts: new Date('2026-09-09T01:00:00Z') },
    ], {}, now)

    expect(asc.statsByDate).toEqual(desc.statsByDate)
  })

  test('trailing 視窗的利用率是資金加權：Σ放出 / Σ本金', () => {
    const payments = _.times(3, i => ({
      amount: 1,
      balance: 1001,
      mts: new Date(Date.UTC(2026, 8, 8) + i * MS_PER_DAY + 5400_000),
    }))
    const { statsByDate } = calcStats(payments, {
      '2026-09-08': 1000,
      '2026-09-09': 500,
      '2026-09-10': 0,
    }, now)
    // 三天各 investment = 1000，放出 1000/500/0 -> 1500/3000 = 50%
    expect(statsByDate['2026-09-10'].lentRatio7).toBe(50)
  })
})

describe('buildReportText()', () => {
  const now = new Date('2026-09-10T00:45:00Z')

  test('年化取 dateMax，利用率取前一天', () => {
    const { statsByDate, dateMax } = calcStats(
      [
        { amount: 1, balance: 1001, mts: new Date('2026-09-08T01:30:00Z') },
        { amount: 1, balance: 1002, mts: new Date('2026-09-09T01:30:00Z') },
      ],
      { '2026-09-08': 1000, '2026-09-09': 250 },
      now,
    )
    const text = buildReportText('USD', statsByDate, dateMax as string)

    expect(text).toContain('USD 放貸收益報告')
    // MarkdownV2 的 `-` 要跳脫
    expect(text).toContain('日期: 2026\\-09\\-09')
    expect(text).toContain('利息: 1.00000000 USD')
    for (const days of [1, 7, 30, 365]) expect(text).toContain(`${days}日年化:`)
    // 利用率取 dateMax-1 = 09-08，當天放出 1000 / 本金 1000 = 100%
    expect(text).toContain('(利用率 100.00%)')
  })

  test('幣別含 MarkdownV2 特殊字元時要跳脫，否則 Telegram 會拒收整則訊息', () => {
    const { statsByDate, dateMax } = calcStats(
      [{ amount: 1, balance: 1001, mts: new Date('2026-09-09T01:30:00Z') }],
      {},
      now,
    )
    expect(buildReportText('TEST_A', statsByDate, dateMax as string)).toContain('TEST\\_A 放貸收益報告')
  })

  test('前一天沒有資料時利用率顯示 0，不會丟錯', () => {
    const { statsByDate, dateMax } = calcStats(
      [{ amount: 1, balance: 1001, mts: new Date('2026-09-09T01:30:00Z') }],
      {},
      now,
    )
    expect(() => buildReportText('UST', statsByDate, dateMax as string)).not.toThrow()
  })
})
