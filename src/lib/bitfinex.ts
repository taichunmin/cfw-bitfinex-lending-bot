import { Bitfinex } from '@taichunmin/bitfinex'
import axios from 'axios'

/**
 * `@taichunmin/bitfinex` 透過 axios 發 request，在 Workers 上 axios 會挑 fetch adapter，
 * 而它預設帶的 `cache: 'default'` 是 workerd 不支援的值（會丟 `Unsupported cache mode: default`）。
 *
 * axios 只會用 DEFAULT_REQUEST_OPTIONS 補 undefined 的欄位，所以在 defaults 先指定 `no-store` 即可蓋掉。
 * 這個 module 被 import 時就會生效，因此請一律從這裡取得 Bitfinex client。
 */
axios.defaults.fetchOptions = { ...axios.defaults.fetchOptions, cache: 'no-store' }

let bitfinex: Bitfinex | null = null

/** 共用同一個 client：nonce 記在 instance 上，多個 instance 交錯發 request 容易出現 nonce 太小的錯誤 */
export function getBitfinex (): Bitfinex {
  return bitfinex ??= new Bitfinex({
    apiKey: process.env.BITFINEX_API_KEY,
    apiSecret: process.env.BITFINEX_API_SECRET,
    affCode: process.env.BITFINEX_AFF_CODE,
  })
}

export { Bitfinex, BitfinexSort, LedgersHistCategory, PlatformStatus } from '@taichunmin/bitfinex'
