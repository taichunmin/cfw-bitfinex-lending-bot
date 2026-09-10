export const NAME = 'funding-statistics-1'

/** 每個幣別最後一次發過報告的日期，存在 Bitfinex 帳號的 user settings。改 key 會讓既有狀態對不上 */
export const DB_KEY = `api:taichunmin_${NAME}`

export const R2_PREFIX = 'bitfinex-lending-bot/funding/statistics-1'

export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** `v2AuthReadLedgersHist` 的分頁上限 */
export const LEDGERS_LIMIT = 2500
