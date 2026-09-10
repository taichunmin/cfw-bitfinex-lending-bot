import { env } from 'cloudflare:test'
import _ from 'lodash'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  creditsKey,
  dbKey,
  exportCurrency,
  fetchNewCredits,
  loadExportedCredits,
  saveCredits,
  toCreditCsvRow,
  yearOfDateStr,
} from '../../../src/funding/export-credits-1'
import { ZodCreditCsvRow, ZodDb } from '../../../src/funding/export-credits-1/schema'
import type { CreditCsvRow, Db } from '../../../src/funding/export-credits-1/type'
import { r2GetCsv, r2GetText, r2PutCsv } from '../../../src/lib/r2'

const mocks = vi.hoisted(() => ({
  sleep: vi.fn(async () => {}),
}))

// 分頁之間會 sleep 讓出 rate limit，測試不需要真的等
vi.mock('../../../src/lib/helper', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/lib/helper')>(),
  sleep: mocks.sleep,
}))

const PAGE_LIMIT = 500
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

interface FakeCredit {
  amount: number
  id: number
  mtsCreate: Date
  mtsLastPayout: Date
  mtsOpening: Date
  mtsUpdate: Date
  period: number
  rate: number
  side: number
  status: string
}

/** 產生一筆融資記錄，`mtsUpdate` 用 id 推算，id 大的比較新 */
function credit (id: number, over: Partial<FakeCredit> = {}): FakeCredit {
  const mts = new Date(Date.UTC(2026, 8, 1) + id * 60_000)
  return {
    amount: 100 + id,
    id,
    mtsCreate: mts,
    mtsLastPayout: new Date(mts.getTime() + 2 * MS_PER_DAY),
    mtsOpening: mts,
    mtsUpdate: mts,
    period: 2,
    rate: 0.0003,
    side: 1,
    status: 'CLOSED',
    ...over,
  }
}

/** 模擬 `v2AuthReadFundingCreditsHist`：依 mtsUpdate 由新到舊，`start`、`end` 都依 mtsUpdate 過濾且包含邊界 */
function createFakeBitfinex (credits: FakeCredit[]) {
  const sorted = _.orderBy(credits, c => c.mtsUpdate.getTime(), 'desc')
  return {
    v2AuthReadFundingCreditsHist: vi.fn(async (opts: any) => {
      const start = opts?.start?.getTime() ?? -Infinity
      const end = opts?.end?.getTime() ?? Infinity
      const filtered = _.filter(sorted, c => c.mtsUpdate.getTime() >= start && c.mtsUpdate.getTime() <= end)
      return _.take(filtered, opts?.limit ?? 25) as any
    }),
  }
}

/** 包一層真的 R2，讓測試能檢查 put 有沒有被呼叫 */
function spyBucket () {
  const put = vi.fn(env.R2.put.bind(env.R2))
  const bucket = { get: env.R2.get.bind(env.R2), put } as unknown as R2Bucket
  return { bucket, put }
}

let seq = 0
/** 每個測試用不同幣別，避免共用同一個模擬 R2 時互相汙染 */
function nextCurrency (): string {
  return `TST${seq++}`
}

async function seedYear (currency: string, year: number, credits: FakeCredit[]): Promise<void> {
  await r2PutCsv(env.R2, creditsKey(currency, year), _.map(credits, toCreditCsvRow))
}

async function readYear (currency: string, year: number): Promise<CreditCsvRow[]> {
  return await r2GetCsv(env.R2, creditsKey(currency, year), ZodCreditCsvRow)
}

describe('dbKey()', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  test('key 帶上環境名稱，改動會讓既有水位對不上', () => {
    vi.stubEnv('ENV_NAME', 'prod')
    expect(dbKey()).toBe('api:taichunmin_prod_funding-export-credits-1')
    vi.stubEnv('ENV_NAME', 'dev')
    expect(dbKey()).toBe('api:taichunmin_dev_funding-export-credits-1')
  })
})

describe('yearOfDateStr()', () => {
  test('取出年份', () => {
    expect(yearOfDateStr('2025-03-27 00:50:47')).toBe(2025)
  })

  test('不合法的日期字串要丟錯，不能默默算成 0 而把資料寫到錯的年度檔', () => {
    expect(() => yearOfDateStr('')).toThrow()
    expect(() => yearOfDateStr('bad')).toThrow()
  })
})

describe('toCreditCsvRow()', () => {
  test('時間一律轉成 UTC 的 YYYY-MM-DD HH:mm:ss', () => {
    const row = toCreditCsvRow(credit(1, {
      mtsCreate: new Date('2026-03-27T00:50:47Z'),
      mtsOpening: new Date('2026-03-27T00:50:47Z'),
      mtsLastPayout: new Date('2026-03-31T00:51:03Z'),
      mtsUpdate: new Date('2026-03-30T19:28:55Z'),
    }))
    expect(_.pick(row, ['createdAt', 'openedAt', 'closedAt', 'updatedAt'])).toEqual({
      createdAt: '2026-03-27 00:50:47',
      openedAt: '2026-03-27 00:50:47',
      closedAt: '2026-03-31 00:51:03',
      updatedAt: '2026-03-30 19:28:55',
    })
  })

  test('資料不合法時附上原始 credit 再往外丟', () => {
    const err = (() => { try { toCreditCsvRow({ ...credit(1), id: 'bad' as any }) } catch (err) { return err } })() as any

    expect(err).toBeInstanceOf(Error)
    expect(err.data.toCreditCsvRow.credit.id).toBe('bad')
  })

  test('欄位順序就是 CSV 的欄位順序', () => {
    expect(_.keys(toCreditCsvRow(credit(1)))).toEqual([
      'id', 'amount', 'period', 'rate', 'side', 'status',
      'openedAt', 'closedAt', 'createdAt', 'updatedAt',
    ])
  })
})

describe('ZodDb', () => {
  test('沒有狀態時 parse 成空的，首次執行不能炸掉', () => {
    expect(ZodDb.parse(undefined)).toEqual({ schema: 1 })
  })

  test('壞掉的水位會被 catch 成 null，不會整份狀態失效', () => {
    const db = ZodDb.parse({ schema: 1, lastUpdatedAt: { USD: 123, UST: 'bad' } })
    expect(db.lastUpdatedAt).toEqual({ USD: 123, UST: null })
  })
})

describe('loadExportedCredits()', () => {
  test('讀回指定年度，不存在的年度視為空的', async () => {
    const currency = nextCurrency()
    await seedYear(currency, 2026, [credit(1), credit(2)])
    const creditsByYear = await loadExportedCredits(env.R2, currency, [2025, 2026])

    expect(creditsByYear.get(2025)?.size).toBe(0)
    expect([...(creditsByYear.get(2026)?.keys() ?? [])]).toEqual([1, 2])
  })

  test('發生錯誤時附上除錯資料再往外丟', async () => {
    const currency = nextCurrency()
    await env.R2.put(creditsKey(currency, 2026), 'id,amount\n1,"broken\n')
    const err = await loadExportedCredits(env.R2, currency, [2026]).catch(err => err)

    expect(err).toBeInstanceOf(Error)
    expect(err.data.loadExportedCredits).toMatchObject({ currency, years: [2026] })
  })
})

describe('fetchNewCredits()', () => {
  beforeEach(() => { mocks.sleep.mockClear() })

  function run (credits: FakeCredit[], start: Date, maxPages?: number) {
    const bitfinex = createFakeBitfinex(credits)
    const pages: CreditCsvRow[][] = []
    const promise = fetchNewCredits({
      bitfinex: bitfinex as any,
      currency: 'USD',
      maxPages,
      onPage: async rows => { pages.push(rows) },
      start,
    })
    return { bitfinex, pages, promise }
  }

  test('只抓 mtsUpdate >= start 的記錄，而且包含邊界', async () => {
    const { pages, promise } = run(_.times(5, i => credit(i + 1)), credit(3).mtsUpdate)
    await promise

    expect(_.sortBy(_.map(_.flatten(pages), 'id'))).toEqual([3, 4, 5])
  })

  test('超過一頁時每抓完一頁就交給 onPage，用 end 往回翻且每頁都帶同一個 start', async () => {
    const start = new Date(1)
    const { bitfinex, pages, promise } = run(_.times(PAGE_LIMIT + 100, i => credit(i + 1)), start)
    await promise

    expect(pages.length).toBe(2)
    // 分頁邊界那筆會同時出現在兩頁，去重後剛好是全部
    expect(_.uniqBy(_.flatten(pages), 'id').length).toBe(PAGE_LIMIT + 100)
    const calls = bitfinex.v2AuthReadFundingCreditsHist.mock.calls
    expect(_.map(calls, call => call[0].start)).toEqual([start, start])
  })

  test('第一頁不 sleep，之後每頁之間 sleep 一次', async () => {
    const { promise } = run(_.times(PAGE_LIMIT + 100, i => credit(i + 1)), new Date(1))
    await promise

    expect(mocks.sleep).toHaveBeenCalledTimes(1)
  })

  test('沒有記錄時不呼叫 onPage', async () => {
    const { pages, promise } = run([], new Date(1))
    await promise

    expect(pages).toEqual([])
  })

  test('翻到 maxPages 還沒抓完要丟錯並附上除錯資料，但已抓的頁已經交給 onPage', async () => {
    // 三頁份的資料，但只准翻兩頁
    const { pages, promise } = run(_.times(PAGE_LIMIT * 2 + 10, i => credit(i + 1)), new Date(1), 2)
    const err = await promise.catch(err => err)

    expect(err.message).toMatch(/maxPages/)
    expect(err.data.fetchNewCredits).toMatchObject({ currency: 'USD', maxPages: 2, pages: 2, start: new Date(1) })
    expect(pages.length).toBe(2)
  })

  test('剛好在 maxPages 那一頁抓完是正常結束', async () => {
    const { pages, promise } = run(_.times(PAGE_LIMIT + 10, i => credit(i + 1)), new Date(1), 2)
    await promise

    expect(_.uniqBy(_.flatten(pages), 'id').length).toBe(PAGE_LIMIT + 10)
  })
})

describe('saveCredits()', () => {
  let currency: string
  beforeEach(() => { currency = nextCurrency() })

  async function save (bucket: R2Bucket, credits: FakeCredit[]): Promise<void> {
    await saveCredits({ bucket, credits: _.map(credits, toCreditCsvRow), currency })
  }

  test('依 id 遞增寫入年度檔，並與既有資料合併', async () => {
    await seedYear(currency, 2026, [credit(2, { status: 'ACTIVE' })])
    await save(env.R2, [credit(3), credit(1), credit(2, { amount: 999 })])
    const rows = await readYear(currency, 2026)

    expect(_.map(rows, 'id')).toEqual([1, 2, 3])
    expect(_.find(rows, { id: 2 })).toMatchObject({ amount: 999, status: 'CLOSED' })
  })

  test('寫出的 CSV 不含 year 欄位', async () => {
    await save(env.R2, [credit(1)])
    const header = (await r2GetText(env.R2, creditsKey(currency, 2026)))?.split(/\r?\n/)[0]

    expect(header).toBe('id,amount,period,rate,side,status,openedAt,closedAt,createdAt,updatedAt')
  })

  test('依 createdAt 的年份分檔，不是依 updatedAt', async () => {
    // 2025-12-30 建立、2026-01-02 結束的跨年單，要落在 2025 的檔
    await save(env.R2, [credit(1, {
      mtsCreate: new Date('2025-12-30T00:00:00Z'),
      mtsOpening: new Date('2025-12-30T00:00:00Z'),
      mtsUpdate: new Date('2026-01-02T00:00:00Z'),
      mtsLastPayout: new Date('2026-01-02T00:00:00Z'),
    })])

    expect(_.map(await readYear(currency, 2025), 'id')).toEqual([1])
    expect(await readYear(currency, 2026)).toEqual([])
  })

  test('既有的年度檔會先讀回再合併，不會整份蓋掉', async () => {
    await seedYear(currency, 2025, [credit(1, { mtsCreate: new Date('2025-06-01T00:00:00Z') })])
    await save(env.R2, [credit(2, { mtsCreate: new Date('2025-07-01T00:00:00Z') })])

    expect(_.map(await readYear(currency, 2025), 'id')).toEqual([1, 2])
  })

  test('發生錯誤時附上除錯資料再往外丟', async () => {
    const put = vi.fn(async () => { throw new Error('put failed') })
    const bucket = { get: env.R2.get.bind(env.R2), put } as unknown as R2Bucket
    const err = await save(bucket, [credit(1)]).catch(err => err)

    expect(err).toBeInstanceOf(Error)
    expect(err.data.saveCredits).toMatchObject({ currency, creditsLen: 1, years: [2026], writtenYears: [2026] })
  })

  test('內容沒變的年度檔不寫回', async () => {
    await seedYear(currency, 2026, [credit(1), credit(2)])
    const { bucket, put } = spyBucket()
    await save(bucket, [credit(1), credit(2)])

    expect(put).not.toHaveBeenCalled()
  })
})

describe('exportCurrency()', () => {
  let currency: string
  beforeEach(() => { currency = nextCurrency() })

  function run (credits: FakeCredit[], db: Db, maxPages?: number) {
    const bitfinex = createFakeBitfinex(credits)
    const promise = exportCurrency({
      bitfinex: bitfinex as any,
      bucket: env.R2,
      currency,
      db,
      maxPages,
    })
    return { bitfinex, promise }
  }

  function dbWith (lastUpdatedAt?: number): Db {
    return ZodDb.parse(_.isNil(lastUpdatedAt) ? undefined : { schema: 1, lastUpdatedAt: { [currency]: lastUpdatedAt } })
  }

  test('第一次執行 start 帶 1，全量寫入並記下最後一筆的 updatedAt', async () => {
    const db = dbWith()
    const { bitfinex, promise } = run([credit(3), credit(1), credit(2)], db)
    await promise

    expect(bitfinex.v2AuthReadFundingCreditsHist.mock.calls[0][0].start).toEqual(new Date(1))
    expect(_.map(await readYear(currency, 2026), 'id')).toEqual([1, 2, 3])
    expect(db.lastUpdatedAt?.[currency]).toBe(credit(3).mtsUpdate.getTime())
  })

  test('有水位時 start 從水位往前推 3 天', async () => {
    const lastUpdatedAt = credit(5).mtsUpdate.getTime()
    const { bitfinex, promise } = run([credit(5)], dbWith(lastUpdatedAt))
    await promise

    expect(bitfinex.v2AuthReadFundingCreditsHist.mock.calls[0][0].start).toEqual(new Date(lastUpdatedAt - 3 * MS_PER_DAY))
  })

  test('比已匯出記錄晚結束、mtsUpdate 卻比較早的單，會在往前推的邊際內被補抓', async () => {
    const exported = credit(100)
    await seedYear(currency, 2026, [exported])
    // 上一輪匯出時還沒結束，所以不在 R2 裡；mtsUpdate 比水位早 13 小時
    const lateMts = new Date(exported.mtsUpdate.getTime() - 13 * MS_PER_HOUR)
    const late = credit(1, { mtsCreate: lateMts, mtsOpening: lateMts, mtsUpdate: lateMts })
    const db = dbWith(exported.mtsUpdate.getTime())
    const { promise } = run([exported, late], db)
    await promise

    expect(_.map(await readYear(currency, 2026), 'id')).toEqual([1, 100])
    // 水位不會因為補抓到比較舊的記錄而倒退
    expect(db.lastUpdatedAt?.[currency]).toBe(exported.mtsUpdate.getTime())
  })

  test('沒翻完就到 maxPages 時，已抓的頁會寫進 R2 但水位不更新，下一輪從舊水位補齊', async () => {
    const credits = _.times(PAGE_LIMIT * 2 + 10, i => credit(i + 1))
    const db = dbWith()

    const err = await run(credits, db, 2).promise.catch(err => err)
    expect(err.message).toMatch(/maxPages/)
    expect(err.data.exportCurrency).toMatchObject({ currency, start: new Date(1) })
    // end 是包含邊界，第二頁的第一筆就是第一頁的最後一筆
    expect((await readYear(currency, 2026)).length).toBe(PAGE_LIMIT * 2 - 1)
    expect(db.lastUpdatedAt?.[currency]).toBeUndefined()

    await run(credits, db).promise
    expect((await readYear(currency, 2026)).length).toBe(PAGE_LIMIT * 2 + 10)
    expect(db.lastUpdatedAt?.[currency]).toBe(_.last(credits)?.mtsUpdate.getTime())
  })
})
