import type { Bitfinex } from '../../lib/bitfinex'
import type { z } from '../../lib/zod'
import type { ZodCreditCsvRow, ZodDb } from './schema'

export type Db = z.output<typeof ZodDb>

export type CreditCsvRow = z.output<typeof ZodCreditCsvRow>

/** year -> (id -> row) */
export type CreditsByYear = Map<number, Map<number, CreditCsvRow>>

export interface FundingCredit {
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

export interface FetchNewCreditsOpts {
  bitfinex: Pick<Bitfinex, 'v2AuthReadFundingCreditsHist'>
  currency: string
  maxPages?: number
  /** 每抓完一頁就呼叫一次，拿到的是這一頁的記錄 */
  onPage: (credits: CreditCsvRow[]) => Promise<void>
  /** 只抓 mtsUpdate >= start 的記錄（包含邊界） */
  start: Date
}

export interface SaveCreditsOpts {
  bucket: R2Bucket
  credits: CreditCsvRow[]
  currency: string
}

export interface ExportCurrencyOpts {
  bitfinex: Pick<Bitfinex, 'v2AuthReadFundingCreditsHist'>
  bucket: R2Bucket
  currency: string
  /** 讀寫 `lastUpdatedAt[currency]`，整輪抓完才會更新 */
  db: Db
  maxPages?: number
}
