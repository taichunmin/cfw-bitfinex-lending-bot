import type { Logger } from 'pino'
import type { Bitfinex } from '../../lib/bitfinex'
import type { Telegram } from '../../lib/telegram'
import type { z } from '../../lib/zod'
import type { ZodDb } from './schema'

export type Db = z.output<typeof ZodDb>

export interface DailyStat {
  date: string
  interest: number
  apr1: number
  apr7: number
  apr30: number
  apr365: number
  balance: number | null
  dpr: number
  investment: number | null
  lentRatio1: number
  lentRatio7: number
  lentRatio30: number
  lentRatio365: number
}

export interface InterestPayment {
  amount: number
  balance: number
  mts: Date
}

export interface ActiveFundingCredit {
  amount: number
  mtsOpening: Date
  side: number
}

export interface ProcessCurrencyOpts {
  activeCredits: ActiveFundingCredit[]
  bitfinex: Pick<Bitfinex, 'v2AuthReadLedgersHist'>
  bucket: R2Bucket
  currency: string
  db: Db
  logger: Logger
  now?: Date
  telegram: Telegram | null
}
