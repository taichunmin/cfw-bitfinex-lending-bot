import { z } from '../../lib/zod'

export const ZodDb = z.object({
  schema: z.int().min(1).default(2), // 用來辨識資料結構版本，方便未來升級
  latestDate2: z.record(
    z.string(),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().catch(null),
  ).nullish().catch(null),
})
