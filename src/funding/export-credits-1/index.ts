/*
把 Bitfinex 已結束的融資（放貸）記錄增量匯出成 CSV，存到 Cloudflare R2。

用法與原理見同目錄的 README.md。
*/

import _ from 'lodash'
import { v7 as uuidv7 } from 'uuid'
import { Bitfinex, PlatformStatus, getBitfinex } from '../../lib/bitfinex'
import { dayjs } from '../../lib/dayjs'
import { dateStringify, sleep, toUtcDateStr } from '../../lib/helper'
import { logger as rootLogger } from '../../lib/logger'
import { r2GetCsv, r2PutCsv } from '../../lib/r2'
import { parseEnvName, parseFundingCurrencys } from '../config'
import { MAX_PAGES, NAME, PAGE_LIMIT, R2_PREFIX, START_MARGIN_MS } from './const'
import { ZodCreditCsvRow, ZodDb } from './schema'
import type { CreditCsvRow, CreditsByYear, ExportCurrencyOpts, FetchNewCreditsOpts, FundingCredit, SaveCreditsOpts } from './type'

const logger = rootLogger.child({ namespace: NAME })

/** 增量水位存在 Bitfinex 帳號的 user settings，key 帶上環境名稱，本地執行才不會動到正式的水位 */
export function dbKey (): string {
  return `api:taichunmin_${parseEnvName()}_${NAME}`
}

/** 代表翻頁正常結束 */
class SkipError extends Error {}

export function creditsKey (currency: string, year: number): string {
  return `${R2_PREFIX}/${currency}/${year}.csv`
}

export function toCreditCsvRow (credit: FundingCredit): CreditCsvRow {
  try {
    return ZodCreditCsvRow.parse({
      ..._.pick(credit, ['id', 'amount', 'period', 'rate', 'side', 'status']),
      openedAt: toUtcDateStr(credit.mtsOpening),
      closedAt: toUtcDateStr(credit.mtsLastPayout),
      createdAt: toUtcDateStr(credit.mtsCreate),
      updatedAt: toUtcDateStr(credit.mtsUpdate),
    })
  } catch (err) {
    throw _.update(err as Error, 'data.toCreditCsvRow', old => old ?? { credit })
  }
}

/** 從 `YYYY-MM-DD HH:mm:ss` 取出年份 */
export function yearOfDateStr (dateStr: string): number {
  const year = _.toSafeInteger(dateStr.slice(0, 4))
  if (year < 2000) throw _.set(new Error(`invalid date string: ${dateStr}`), 'data.dateStr', dateStr)
  return year
}

/** 讀回 R2 上指定年度的 credits，不存在的年度視為空的 */
export async function loadExportedCredits (
  bucket: R2Bucket,
  currency: string,
  years: number[]
): Promise<CreditsByYear> {
  const trace: Record<string, any> = { currency, years }
  try {
    const creditsByYear: CreditsByYear = new Map()
    for (const year of years) {
      const rows = await r2GetCsv(bucket, creditsKey(currency, year), ZodCreditCsvRow)
      creditsByYear.set(year, new Map(_.map(rows, row => [row.id, row] as const)))
    }
    return creditsByYear
  } catch (err) {
    throw _.update(err as Error, 'data.loadExportedCredits', old => old ?? trace)
  }
}

/** 抓 mtsUpdate >= start 的 credits，每頁交給 `onPage`；翻到 `maxPages` 還沒抓完就丟錯 */
export async function fetchNewCredits (opts: FetchNewCreditsOpts): Promise<void> {
  const { bitfinex, currency, onPage, start } = opts
  const maxPages = opts.maxPages ?? MAX_PAGES
  const trace: Record<string, any> = { currency, maxPages, start }
  try {
    let end: Date | undefined
    for (let pages = 1; pages <= maxPages; pages++) {
      trace.pages = pages
      if (pages > 1) await sleep(60_000 / 90) // Ratelimit: 90 req/min
      const credits = await bitfinex.v2AuthReadFundingCreditsHist({
        currency,
        limit: PAGE_LIMIT,
        start,
        ...(_.isNil(end) ? {} : { end }),
      })

      const rows = _.map(credits, toCreditCsvRow)
      if (rows.length > 0) await onPage(rows)

      if (credits.length < PAGE_LIMIT) throw new SkipError('no more credits')
      const pageEnd = _.min(_.map(credits, 'mtsUpdate')) as Date
      // 整頁 mtsUpdate 相同，無法再往回翻
      if (!_.isNil(end) && pageEnd.getTime() >= end.getTime()) throw new SkipError('pagination stalled')
      end = trace.end = pageEnd
    }
    throw new Error(`${currency}: reached maxPages (${maxPages}) before finishing`)
  } catch (err) {
    if (err instanceof SkipError) return
    throw _.update(err as Error, 'data.fetchNewCredits', old => old ?? trace)
  }
}

/** 把 credits 依 createdAt 的年份合併進 R2 既有的年度檔，只寫回有變動的檔 */
export async function saveCredits (opts: SaveCreditsOpts): Promise<void> {
  const { bucket, credits, currency } = opts
  const trace: Record<string, any> = { currency, creditsLen: credits.length }
  try {
    const credits1 = _.map(credits, row => ({ ...row, year: yearOfDateStr(row.createdAt) }))
    // 先讀回既有年度檔再合併，否則會蓋掉既有資料
    const years = trace.years = _.uniq(_.map(credits1, 'year'))
    const creditsByYear = await loadExportedCredits(bucket, currency, years)

    const changed = new Set<number>()
    for (const row of credits1) {
      const rows = creditsByYear.get(row.year) as Map<number, CreditCsvRow>
      const existing = rows.get(row.id)
      // row 多了 year，用 isMatch 只比對既有欄位；existing 不存在時 isMatch 會回傳 true，要先排除
      if (!_.isNil(existing) && _.isMatch(row, existing)) continue
      rows.set(row.id, row)
      changed.add(row.year)
    }

    const writtenYears = trace.writtenYears = _.sortBy([...changed])
    for (const year of writtenYears) {
      const rows = _.sortBy([...(creditsByYear.get(year) as Map<number, CreditCsvRow>).values()], 'id')
      await r2PutCsv(bucket, creditsKey(currency, year), _.map(rows, row => _.omit(row, 'year')))
    }
  } catch (err) {
    throw _.update(err as Error, 'data.saveCredits', old => old ?? trace)
  }
}

export async function exportCurrency (opts: ExportCurrencyOpts): Promise<void> {
  const { bitfinex, bucket, currency, db, maxPages } = opts
  const trace: Record<string, any> = { currency }
  try {
    const lastUpdatedAt = trace.lastUpdatedAt = db.lastUpdatedAt?.[currency]
    // 沒有水位時從頭抓
    const start = trace.start = new Date(_.isNil(lastUpdatedAt) ? 1 : lastUpdatedAt - START_MARGIN_MS)
    let latest = lastUpdatedAt
    await fetchNewCredits({
      bitfinex,
      currency,
      maxPages,
      start,
      onPage: async credits => {
        await saveCredits({ bucket, credits, currency })
        latest = trace.latest = _.max([latest, ..._.map(credits, row => dayjs.utc(row.updatedAt, 'YYYY-MM-DD HH:mm:ss', true).valueOf())])
      },
    })

    // 整輪抓完才更新水位，否則會跳過還沒抓到的舊資料
    if (!_.isNil(latest)) _.set(db, ['lastUpdatedAt', currency], latest)
  } catch (err) {
    throw _.update(err as Error, 'data.exportCurrency', old => old ?? trace)
  }
}

export async function main (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const logger1 = logger.child({
    reqId: uuidv7(),
    scheduledTime: dateStringify(controller.scheduledTime),
  })
  const trace: Record<string, any> = {}
  try {
    if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
      logger1.info('Bitfinex API is in maintenance mode')
      return
    }

    const currencys = trace.currencys = parseFundingCurrencys(env)
    if (currencys.length === 0) {
      logger1.warn('STATISTICS_FUNDING.currencys is empty, nothing to export.')
      return
    }

    const bitfinex = getBitfinex()
    const key = trace.dbKey = dbKey()
    const db = trace.db = ZodDb.parse((await bitfinex.v2AuthReadSettings([key]))[key.slice(4)])
    logger1.info({ db, dbKey: key }, 'database loaded.')

    for (const currency of currencys) {
      const logger2 = logger1.child({ currency })
      try {
        await exportCurrency({ bitfinex, bucket: env.R2, currency, db })
      } catch (err) {
        logger2.error({ err, currency }, `${currency}: failed to export, msg = ${err?.message ?? ''}`)
      }
    }

    logger1.info({ db }, 'new database')
    await bitfinex.v2AuthWriteSettingsSet({ [key]: ZodDb.parse(db) as any })
  } catch (err) {
    throw _.update(err as Error, 'data.main', old => old ?? trace)
  }
}
