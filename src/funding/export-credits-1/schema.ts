import { z } from '../../lib/zod'

export const ZodDb = z.object({
  schema: z.literal(1), // 用來辨識資料結構版本，方便未來升級
  /** currency -> 最後一筆已匯出記錄的 mtsUpdate（毫秒） */
  lastUpdatedAt: z.record(z.string(), z.int().nullish().catch(null)).nullish().catch(null),
}).catch({ schema: 1 })

/** CSV 的欄位、順序與型別；讀回與抓到的列都經過它，比對時型別才一致 */
export const ZodCreditCsvRow = z.object({
  id: z.coerce.number().int(),
  amount: z.coerce.number(),
  period: z.coerce.number().int(),
  rate: z.coerce.number(),
  side: z.coerce.number().int(),
  status: z.string(),
  openedAt: z.string(),
  closedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
