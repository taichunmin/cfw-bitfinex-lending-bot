/*
計算 1/7/30/365 日年化與資金利用率，把結果寫成 CSV/JSON 放到 Cloudflare R2，並在有新的一天
結算出來時發 Telegram 報告。用法與原理見同目錄的 README.md。

日期計算一律以 UTC+0 為準，只有 Telegram 訊息裡的時間戳才轉 UTC+8。
*/

import _ from 'lodash'
import type { Logger } from 'pino'
import { v7 as uuidv7 } from 'uuid'
import { Bitfinex, LedgersHistCategory, PlatformStatus, getBitfinex } from '../../lib/bitfinex'
import { dayjs } from '../../lib/dayjs'
import { dateStringify, floatFormatDecimal } from '../../lib/helper'
import { logger as rootLogger } from '../../lib/logger'
import { r2GetCsv, r2PutCsv, r2PutJson } from '../../lib/r2'
import { Telegram, tgMdEscape } from '../../lib/telegram'
import { parseFundingCurrencys } from '../config'
import { creditsKey } from '../export-credits-1'
import { ZodCreditCsvRow } from '../export-credits-1/schema'
import type { CreditCsvRow } from '../export-credits-1/type'
import { DB_KEY, LEDGERS_LIMIT, MS_PER_DAY, NAME, R2_PREFIX } from './const'
import { ZodDb } from './schema'
import type { ActiveFundingCredit, DailyStat, Db, InterestPayment, ProcessCurrencyOpts } from './type'

const logger = rootLogger.child({ namespace: NAME })

export function statisticsKey (currency: string, ext: 'csv' | 'json'): string {
  return `${R2_PREFIX}/${currency}.${ext}`
}

/** credits 要涵蓋利息記錄的日期範圍；前後各多讀一年，才涵蓋跨年的出借 */
export function creditYears (payments: InterestPayment[]): number[] {
  const mtses = _.map(payments, 'mts')
  const [mtsMin, mtsMax] = [_.min(mtses), _.max(mtses)]
  if (_.isNil(mtsMin) || _.isNil(mtsMax)) return []
  return _.range(dayjs.utc(mtsMin).year() - 1, dayjs.utc(mtsMax).year() + 2)
}

function tplStat (date: string): DailyStat {
  return { date, interest: 0, apr1: 0, apr7: 0, apr30: 0, apr365: 0, balance: null, dpr: 0, investment: null, lentRatio1: 0, lentRatio7: 0, lentRatio30: 0, lentRatio365: 0 }
}

/** 每日「時間加權放出本金」：把每筆出借的金額依存續時間攤到每個 UTC 日期，進行中的出借算到現在 */
export function calcLentAmountByDate (
  creditRows: CreditCsvRow[],
  activeCredits: ActiveFundingCredit[],
  now: Date,
): Record<string, number> {
  const results: Record<string, number> = {}

  const addSpan = (amount: number, openedAt: dayjs.Dayjs, closedAt: dayjs.Dayjs): void => {
    if (!(amount > 0) || !openedAt.isValid() || !closedAt.isValid() || !closedAt.isAfter(openedAt)) return

    for (let dayStart = openedAt.startOf('day'); dayStart.isBefore(closedAt); dayStart = dayStart.add(1, 'day')) {
      const dayEnd = dayStart.add(1, 'day')
      const overlapStart = Math.max(dayStart.valueOf(), openedAt.valueOf())
      const overlapEnd = Math.min(dayEnd.valueOf(), closedAt.valueOf())
      if (overlapEnd <= overlapStart) continue

      const date = dayStart.format('YYYY-MM-DD')
      const amountByDay = amount * (overlapEnd - overlapStart) / MS_PER_DAY
      results[date] = _.round((results[date] ?? 0) + amountByDay, 8)
    }
  }

  const seenIds = new Set<number>()
  for (const row of creditRows) {
    if (row.side !== 1) continue
    if (seenIds.has(row.id)) continue
    seenIds.add(row.id)
    addSpan(
      row.amount,
      dayjs.utc(row.openedAt, 'YYYY-MM-DD HH:mm:ss', true),
      dayjs.utc(row.closedAt, 'YYYY-MM-DD HH:mm:ss', true),
    )
  }

  const nowUtc = dayjs.utc(now)
  for (const credit of activeCredits) {
    if (credit.side !== 1) continue
    addSpan(_.toFinite(credit.amount), dayjs.utc(credit.mtsOpening), nowUtc)
  }

  return results
}

/** 把利息記錄與每日放出金額算成每日統計，`stats` 依日期倒序。`dateMax` 是最新一筆利息的日期，沒有利息記錄時為 `null` */
export function calcStats (
  payments: InterestPayment[],
  lentAmountByDate: Record<string, number>,
  now: Date,
): { stats: DailyStat[], dateMax: string | null, statsByDate: Record<string, DailyStat> } {
  const tsToday = dayjs.utc(now).startOf('day')
  const stats: Record<string, DailyStat> = {}
  let [dateMax, dateMin]: Array<string | null> = [null, null]

  // 先把同一天的利息彙總完（順序無關：balance 取 max、interest 累加）
  for (const payment of payments) {
    const date1 = dayjs.utc(payment.mts).format('YYYY-MM-DD')
    dateMax = _.max([dateMax ?? date1, date1]) as string
    dateMin = _.min([dateMin ?? date1, date1]) as string

    const stat = stats[date1] ??= tplStat(date1)
    stat.balance = Math.max(stat.balance ?? 0, payment.balance)
    stat.interest += payment.amount
  }

  // 彙總完才算 apr1 並往後攤，否則同一天多筆時中間值會被重複攤進 apr7/apr30/apr365
  for (const date1 of _.keys(stats).sort()) {
    const stat = stats[date1]
    stat.investment = _.round((stat.balance as number) - stat.interest, 8)
    stat.dpr = stat.investment <= 0 ? 0 : stat.interest * 100 / stat.investment
    stat.apr1 = stat.dpr * 365

    for (let i = 0; i < 365; i++) {
      const ts2 = dayjs.utc(date1).add(i, 'day')
      if (ts2 > tsToday) break
      const date2 = ts2.format('YYYY-MM-DD')
      if (i < 7) (stats[date2] ??= tplStat(date2)).apr7 += stat.apr1
      if (i < 30) (stats[date2] ??= tplStat(date2)).apr30 += stat.apr1
      ;(stats[date2] ??= tplStat(date2)).apr365 += stat.apr1
    }
  }

  if (_.isNil(dateMin) || _.isNil(dateMax)) return { stats: [], dateMax: null, statsByDate: {} }

  let prevBalance = 0
  const orderedDates: string[] = []
  for (let ts2 = dayjs.utc(dateMin); ts2 <= tsToday; ts2 = ts2.add(1, 'day')) {
    const date2 = ts2.format('YYYY-MM-DD')
    orderedDates.push(date2)
    const stat = stats[date2] ??= tplStat(date2)
    stat.investment ??= prevBalance
    stat.balance ??= prevBalance
    prevBalance = stat.balance
    const lentAmountByDay = lentAmountByDate[date2] ?? 0
    stat.lentRatio1 = stat.investment <= 0 ? 0 : _.round(100 * lentAmountByDay / stat.investment, 8)
    stat.apr7 /= 7
    stat.apr30 /= 30
    stat.apr365 /= 365
  }

  // trailing N 日的資金加權利用率：Σ(每日放出金額) / Σ(每日可投入本金)，用前綴和加速
  let cumLent = 0
  let cumInvestment = 0
  const prefixLent = [0]
  const prefixInvestment = [0]
  for (const date2 of orderedDates) {
    cumLent += lentAmountByDate[date2] ?? 0
    cumInvestment += stats[date2].investment ?? 0
    prefixLent.push(cumLent)
    prefixInvestment.push(cumInvestment)
  }
  for (let i = 0; i < orderedDates.length; i++) {
    const stat = stats[orderedDates[i]]
    for (const n of [7, 30, 365] as const) {
      const lo = Math.max(0, i + 1 - n)
      const sumLent = prefixLent[i + 1] - prefixLent[lo]
      const sumInvestment = prefixInvestment[i + 1] - prefixInvestment[lo]
      ;(stat as any)[`lentRatio${n}`] = sumInvestment <= 0 ? 0 : _.round(100 * sumLent / sumInvestment, 8)
    }
  }

  return { stats: _.orderBy(_.values(stats), 'date', 'desc'), dateMax, statsByDate: stats }
}

/** 組出 Telegram 報告。年化取 `dateMax`，利用率取 `dateMax - 1`，因為 `dateMax` 當天的利用率還不完整 */
export function buildReportText (currency: string, statsByDate: Record<string, DailyStat>, dateMax: string): string {
  const stat2 = statsByDate[dateMax]
  const statLent = statsByDate[dayjs.utc(dateMax).subtract(1, 'day').format('YYYY-MM-DD')] ?? tplStat('')
  // 例：`  7日年化: 10.85% (利用率 99.50%)`
  const aprLine = (days: number): string =>
    `${String(days).padStart(3)}日年化: ${floatFormatDecimal((stat2 as any)[`apr${days}`], 2).padStart(6)}% (利用率 ${floatFormatDecimal((statLent as any)[`lentRatio${days}`], 2).padStart(6)}%)`
  return `\\# ${tgMdEscape(currency)} 放貸收益報告
\`
日期: ${dateMax.replaceAll('-', '\\-')}
利息: ${floatFormatDecimal(stat2.interest, 8)} ${currency}
${[1, 7, 30, 365].map(aprLine).join('\n')}
\``
}

export async function processCurrency (opts: ProcessCurrencyOpts): Promise<void> {
  const { activeCredits, bitfinex, bucket, currency, db, logger: logger1, telegram } = opts
  const now = opts.now ?? new Date()

  const payments = _.filter(
    await bitfinex.v2AuthReadLedgersHist({
      category: LedgersHistCategory.MarginSwapInterestPayment,
      currency,
      limit: LEDGERS_LIMIT,
    }),
    row => row.wallet === 'funding',
  )

  const creditRows: CreditCsvRow[] = []
  for (const year of creditYears(payments)) {
    creditRows.push(...await r2GetCsv(bucket, creditsKey(currency, year), ZodCreditCsvRow))
  }
  const lentAmountByDate = calcLentAmountByDate(creditRows, activeCredits, now)

  const { stats, dateMax, statsByDate } = calcStats(payments, lentAmountByDate, now)
  if (_.isNil(dateMax)) {
    // 剛加進設定、或還沒有任何一筆放款結算
    logger1.info({ currency, creditRowsLen: creditRows.length }, `${currency}: no interest payment, skipped`)
    return
  }
  logger1.info(
    { currency, dateMax, statsLen: stats.length, creditRowsLen: creditRows.length },
    `${currency}: dateMax = ${dateMax}, ${stats.length} daily stats`,
  )

  // 只有結算出新的一天才發報告
  if (dateMax !== db.latestDate2?.[currency]) {
    _.set(db, `latestDate2.${currency}`, dateMax)
    if (_.isNil(telegram)) logger1.info({ currency }, `${currency}: telegram is disabled, report not sent`)
    else {
      await telegram.sendMessage({
        parse_mode: 'MarkdownV2',
        text: buildReportText(currency, statsByDate, dateMax),
      })
    }
  }

  await r2PutJson(bucket, statisticsKey(currency, 'json'), stats)
  await r2PutCsv(bucket, statisticsKey(currency, 'csv'), stats)
}

export async function fetchDb (bitfinex: Pick<Bitfinex, 'v2AuthReadSettings'>, logger1: Logger): Promise<Db> {
  try {
    const db = (await bitfinex.v2AuthReadSettings([DB_KEY]))[DB_KEY.slice(4)]
    return ZodDb.parse(db ?? {})
  } catch (err) {
    if ((err as any)?.status !== 404) logger1.error({ err }, 'failed to read db, fallback to empty')
    return ZodDb.parse({})
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
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    logger1.info('Bitfinex API is in maintenance mode')
    return
  }

  const currencys = parseFundingCurrencys(env)
  if (currencys.length === 0) {
    logger1.warn('STATISTICS_FUNDING.currencys is empty, nothing to do.')
    return
  }

  const bitfinex = getBitfinex()
  const telegram = Telegram.fromEnv(env)
  if (_.isNil(telegram)) logger1.warn('TELEGRAM_TOKEN or TELEGRAM_CHAT_ID is not set, notification is disabled.')

  const db = await fetchDb(bitfinex, logger1)
  const activeByCurr = _.groupBy(await bitfinex.v2AuthReadFundingCredits(), 'currency')
  logger1.info({ db, currencys }, 'database loaded.')

  for (const currency of currencys) {
    const logger2 = logger1.child({ currency })
    try {
      await processCurrency({
        activeCredits: activeByCurr[currency] ?? [],
        bitfinex,
        bucket: env.R2,
        currency,
        db,
        logger: logger2,
        telegram,
      })
    } catch (err) {
      logger2.error({ err, currency }, 'failed to process currency')
    }
  }

  logger1.info({ db }, 'new database')
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any })
}
