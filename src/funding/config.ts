import { z } from '../lib/zod'

/** `export-credits-1` 與 `statistics-1` 共用的設定，避免兩邊幣別不同步 */
export const ZodStatisticsFunding = z.object({
  currencys: z.array(z.string().trim().regex(/^[\w:]+$/).toUpperCase()).default([]),
}).default({ currencys: [] })

export function parseFundingCurrencys (env: Env): string[] {
  return ZodStatisticsFunding.parse(env.STATISTICS_FUNDING).currencys
}

/** 執行環境名稱，用來區分正式與本地的狀態。沒設定或不合法時當成 dev，免得本地執行動到正式狀態 */
export function parseEnvName (): string {
  return z.string().trim().regex(/^[\w-]+$/).catch('dev').parse(process.env.ENV_NAME)
}
