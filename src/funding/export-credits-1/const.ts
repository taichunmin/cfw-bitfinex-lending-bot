export const NAME = 'funding-export-credits-1'

/** bucket 是通用的，key 要自己包一層專案名 */
export const R2_PREFIX = 'bitfinex-lending-bot/funding/export-credits-1'

/** `v2AuthReadFundingCreditsHist` 的分頁上限 */
export const PAGE_LIMIT = 500

/** mtsUpdate 不是結束時間，晚結束的單 mtsUpdate 可能早於水位，start 要往前推才不會漏抓 */
export const START_MARGIN_MS = 3 * 24 * 60 * 60 * 1000

/** 單次執行最多翻幾頁 */
export const MAX_PAGES = 1000
