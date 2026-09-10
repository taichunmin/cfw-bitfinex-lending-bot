/*
Bitfinex 自動出借（auto-renew）機器人，由 Cloudflare Workers 的 cron trigger 定期執行。

程式決定借出利率的邏輯：
1. 取得過去一天內的每分鐘 K 線圖
2. 把成交量加總 totalVolume
3. 利用二分搜尋法，找出最接近 totalVolume * rank 的利率

使用方式、設定格式與部署步驟見同目錄的 README.md。
*/

import _ from 'lodash'
import { Bitfinex, BitfinexSort, PlatformStatus, createBitfinex } from '../../lib/bitfinex'
import { dayjs } from '../../lib/dayjs'
import { dateStringify, floatFloor8, floatFormatDecimal, floatFormatPercent, floatIsEqual, progressPercent, rateStringify, sleep } from '../../lib/helper'
import { logger as rootLogger, ymlStringify } from '../../lib/logger'
import { Telegram, tgMdDate, tgMdEscape } from '../../lib/telegram'
import { z } from '../../lib/zod'
import { v7 as uuidv7 } from 'uuid'

const NAME = 'funding-auto-renew-3'
const logger = rootLogger.child({ namespace: NAME })
const DB_KEY = `api:taichunmin_${NAME}`
const RATE_MIN = 0.0001 // APR 3.65%

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

const ZodConfigPeriod = z.record(
  z.number().int().min(2).max(120),
  z.number().positive(),
).default({})

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodConfigPeriod,
})

export const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

export const ZodDb = z.object({
  schema: z.literal(1), // 用來辨識資料結構版本，方便未來升級
  notified: z.record(
    z.string(),
    z.object({
      balance: z.number().transform(floatFloor8),
      creditIds: z.array(z.int()),
      msgId: z.int(),
    }).nullish().catch(null),
  ).nullish().catch(null),
}).catch({ schema: 1 })

class SkipError extends Error {}

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

  const bitfinex = createBitfinex(env)
  const telegram = Telegram.fromEnv(env)
  if (_.isNil(telegram)) logger1.warn('TELEGRAM_TOKEN or TELEGRAM_CHAT_ID is not set, notification is disabled.')

  // 讀取並驗證設定
  const cfg = ZodConfig.parse(env.INPUT_AUTO_RENEW_3)

  const db = ZodDb.parse((await bitfinex.v2AuthReadSettings([DB_KEY]))[DB_KEY.slice(4)])
  const wallets = _.mapKeys(await bitfinex.v2AuthReadWallets(), ({ type, currency }) => `${type}:${currency}`)
  logger1.info({ db, wallets }, 'wallets and database loaded.')

  for (const [currency, cfg1] of _.entries(cfg)) {
    const trace: Record<string, any> = { currency, cfg1 }
    const logger2 = logger1.child({ currency })
    try {
      logger2.info({
        currency,
        cfg: {
          ...cfg1,
          rateMinStr: rateStringify(cfg1.rateMin),
          rateMaxStr: rateStringify(cfg1.rateMax),
        },
      }, `${currency}: config`)

      // 取得該貨幣最新一筆融資統計
      const fundingStats = (await Bitfinex.v2FundingStatsHist({ currency, limit: 1 }))[0]
      logger2.info({
        currency,
        fundingStats: {
          date: dateStringify(fundingStats.mts),
          frrStr: rateStringify(fundingStats.frr),
        },
      }, `${currency}: date = ${dateStringify(fundingStats.mts, 'MM/DD HH:mm')}, frr = ${rateStringify(fundingStats.frr)}`)

      // 修改 autoRenew 的參數
      try {
        // 取得該貨幣自動出借的設定
        const prevAutoRenew = await bitfinex.v2AuthReadFundingAutoStatus({ currency })
        logger2.info(_.isNil(prevAutoRenew) ? {
          msg: `${currency}: prevAutoRenew is disabled`,
          currency,
          prevAutoRenew: { status: false },
        } : {
          msg: `${currency}: prevAutoRenew, amount = ${prevAutoRenew.amount}, period = ${prevAutoRenew.period}, rate = ${rateStringify(prevAutoRenew.rate)}`,
          currency,
          prevAutoRenew: {
            ...prevAutoRenew,
            rateStr: rateStringify(prevAutoRenew.rate),
          },
        })

        // get candles
        const yesterday = dayjs().add(-1, 'day').add(-1, 'second').toDate()
        const candles = await Bitfinex.v2CandlesHist({
          aggregation: 30,
          currency,
          limit: 10000,
          periodEnd: 30,
          periodStart: 2,
          sort: BitfinexSort.DESC,
          start: yesterday,
          timeframe: '1m',
        })

        // target
        const targetRate = calcTargetRate(candles, _.pick(cfg1, ['rank', 'rateMin', 'rateMax']))
        if (_.isNil(targetRate)) throw new SkipError('Skip to change autoRenew because no candles.')
        const newAutoRenew = trace.newAutoRenew = {
          amount: cfg1.amount,
          currency,
          period: rateToPeriod(cfg1.period, targetRate),
          rate: targetRate,
        }
        logger2.info({
          currency,
          newAutoRenew: {
            ...newAutoRenew,
            rateStr: rateStringify(newAutoRenew.rate)
          }
        }, `${currency}: newAutoRenew, amount = ${newAutoRenew.amount}, period = ${newAutoRenew.period}, rate = ${rateStringify(newAutoRenew.rate)}`)

        if (_.isMatch(prevAutoRenew ?? {}, newAutoRenew)) throw new SkipError('Setting of auto-renew no change.')
        else {
          if (!_.isNil(prevAutoRenew)) await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
          await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency })
          await bitfinex.v2AuthWriteFundingAuto({
            ...newAutoRenew,
            rate: newAutoRenew.rate * 100, // percentage of rate
            status: 1,
          }).catch(err => { throw _.set(err, 'data.newAutoRenew', newAutoRenew) })
          await sleep(1000) // 等待 1 秒鐘，讓掛單生效
        }
      } catch (err) {
        if (!(err instanceof SkipError)) throw err
        logger2.info({ currency }, `${currency}: skiped, reason = ${err.message}`)
      }

      const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
      if (wallet.balance >= Number.EPSILON && !_.isNil(trace.newAutoRenew) && !_.isNil(telegram)) {
        const db1: Record<string, any> = db.notified?.[currency] ?? {}
        const autoRenew = _.pickBy(trace.newAutoRenew, _.isNumber)
        let reuseMsgId = _.isNumber(db1.msgId)

        // 取得錢包資料
        reuseMsgId &&= floatIsEqual(db1.balance, wallet.balance)

        // 取得出借中的融資
        const credits = _.chain(await bitfinex.v2AuthReadFundingCredits({ currency }))
          .filter(({ side }) => side === 1)
          .map(credit => _.pick(credit, ['id', 'amount', 'rate', 'period', 'mtsOpening']))
          .map(credit => ({
            ...credit,
            mtsOpening: dayjs(credit.mtsOpening).utcOffset(8).format('M/D HH:mm'),
            rate: floatFormatPercent(credit.rate, 6),
            apr: floatFormatPercent(credit.rate * 365),
          }))
          .value()
        const creditsAmountSum = _.sumBy(credits, 'amount')
        const creditIds = _.sortBy(_.map(credits, 'id'))
        reuseMsgId &&= _.isEqual(db1.creditIds, creditIds)

        // 取得掛單並計算掛單中的總金額
        const orders = await bitfinex.v2AuthReadFundingOffers({ currency })
        const ordersAmountSum = _.sumBy(orders, 'amount')

        const nowts = dayjs().utcOffset(8)
        const msgText = [
          tgMdEscape(`# ${NAME}: ${currency} 狀態

投資額: ${floatFormatDecimal(wallet.balance, 3)}
已借出: ${floatFormatDecimal(creditsAmountSum, 3)} (${progressPercent(creditsAmountSum, wallet.balance)})
掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, wallet.balance)})
自動掛單設定:
    利率: ${floatFormatPercent(autoRenew.rate, 6)}
    APR: ${floatFormatPercent(autoRenew.rate * 365)}
    天數: ${autoRenew.period}`),
          `更新: ${tgMdEscape(nowts.format('M/D HH:mm'))} \\(${tgMdDate({ text: '?', date: nowts.toDate(), format: 'r' })}\\)\n`,
          '**>```',
          ymlStringify({ credits }),
          '```||',
        ].join('\n')

        if (reuseMsgId) {
          await telegram.editMessageText({
            message_id: db1.msgId,
            parse_mode: 'MarkdownV2',
            text: msgText,
          })
        } else {
          const res1 = await telegram.sendMessage({
            parse_mode: 'MarkdownV2',
            text: msgText,
          })
          _.set(db, `notified.${currency}`, {
            msgId: res1.message_id,
            balance: wallet.balance,
            creditIds,
          })
        }
      }
    } catch (err) {
      _.update(err as Error, `data.main.${currency}`, old => old ?? trace)
      logger2.error({ err, currency }, 'failed to process currency')
    }
  }

  logger1.info({ db }, 'new database')
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any })
}

interface RateCandle {
  open: number
  close: number
  high: number
  low: number
  volume: number
}

/**
 * 依過去一天的 K 線成交量分布，用二分搜尋找出成交量累積比例最接近 `rank` 分位的利率，
 * 再用 `rateMin`／`rateMax` 夾住。當沒有任何有成交量的 K 線時回傳 `null`。
 */
export function calcTargetRate (candles: RateCandle[], opts: { rank: number, rateMin: number, rateMax: number }): number | null {
  // ranges: 每根 K 線換算成 [利率下界, 利率上界, 成交量]（皆 * 1e8 後轉 BigInt），依序排序
  const ranges = _.chain(candles)
    .map(({ open, close, high, low, volume }) => _.map([
      _.min([open, close, high, low]), // min * 1e8
      _.max([open, close, high, low]), // high * 1e8
      volume, // volume * 1e8
    ], (num: number) => BigInt(_.round(num * 1e8))))
    .filter(([low, high, volume]) => volume > 0n)
    .sortBy([0, 1, 2])
    .value()
  // sum duplicate ranges
  for (let i = 1; i < ranges.length; i++) {
    const [low, high, volume] = ranges[i]
    if (low !== ranges[i - 1][0] || high !== ranges[i - 1][1]) continue
    ranges[i - 1][2] += volume
    ranges.splice(i, 1)
    i--
  }
  if (ranges.length === 0) return null

  // for lowest rate and highest rate
  let [lowestRate, highestRate, totalVolume] = [ranges[0][0], ranges[0][1], 0n]
  for (const [low, high, volume] of ranges) {
    if (high > highestRate) highestRate = high
    if (low < lowestRate) lowestRate = low
    totalVolume += volume
  }

  // binary search target rate by rank
  const ctxBs: Record<string, any> = {
    rank: BigInt(_.round(opts.rank * 1e8)),
    cnt: 0n,
    start: lowestRate,
    end: highestRate,
  }
  while (ctxBs.start <= ctxBs.end) {
    ctxBs.mid = (ctxBs.start + ctxBs.end) / 2n

    // calculate volume for mid
    ctxBs.midVol = 0n
    for (const [low, high, volume] of ranges) {
      if (ctxBs.mid < low) break // because ranges is sorted
      ctxBs.midVol += ctxBs.mid >= high ? volume : (volume * (ctxBs.mid - low + 1n) / (high - low + 1n))
    }
    ctxBs.midRank = ctxBs.midVol * BigInt(1e8) / totalVolume

    // save target rate
    const targetRankDiff = bigintAbs((ctxBs.midRank - ctxBs.rank) as any)
    if (_.isNil(ctxBs.targetRate)) {
      ctxBs.targetRate = ctxBs.mid
      ctxBs.targetRankDiff = targetRankDiff
    } else if (targetRankDiff < ctxBs.targetRankDiff) {
      ctxBs.targetRate = ctxBs.mid
      ctxBs.targetRankDiff = targetRankDiff
    }

    if (ctxBs.midRank === ctxBs.rank) break // found
    if (ctxBs.rank < ctxBs.midRank) ctxBs.end = ctxBs.mid - 1n
    else ctxBs.start = ctxBs.mid + 1n
    ctxBs.cnt++
  }

  return _.clamp(Number(ctxBs.targetRate) / 1e8, opts.rateMin, opts.rateMax)
}

export function rateToPeriod (periodMap: z.output<typeof ZodConfigPeriod>, rateTarget: number): number {
  const ctxPeriod: Record<string, number | null> = { lower: null, target: null, upper: null }
  for (const entry of _.entries(periodMap)) {
    const [period, rate] = [_.toSafeInteger(entry[0]), _.toFinite(entry[1])]
    if (rateTarget >= rate) ctxPeriod.lower = _.max([ctxPeriod.lower ?? period, period]) as number
    if (rateTarget <= rate) ctxPeriod.upper = _.min([ctxPeriod.upper ?? period, period]) as number
  }

  if (_.isNil(ctxPeriod.lower)) ctxPeriod.target = 2
  else if (_.isNil(ctxPeriod.upper)) ctxPeriod.target = ctxPeriod.lower
  else if (ctxPeriod.lower === ctxPeriod.upper) ctxPeriod.target = ctxPeriod.lower
  else ctxPeriod.target = Math.trunc(ctxPeriod.lower + (ctxPeriod.upper - ctxPeriod.lower) * (rateTarget - periodMap[ctxPeriod.lower]) / (periodMap[ctxPeriod.upper] - periodMap[ctxPeriod.lower]))

  return _.clamp(ctxPeriod.target as number, 2, 120)
}
