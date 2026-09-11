import _ from 'lodash'
import Papa from 'papaparse'
import { z } from './zod'

/** R2 讀寫薄層：統一設定 content-type、cache-control，並 gzip 後才存 */

const CACHE_CONTROL = 'public, max-age=300'

export interface R2Env {
  R2: R2Bucket
}

async function gzip (text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).arrayBuffer()
}

/** 讀回文字內容，不存在時回傳 `null`。`get()` 不會依 `content-encoding` 自動解壓，要自己解 */
export async function r2GetText (bucket: R2Bucket, key: string): Promise<string | null> {
  const trace: Record<string, any> = { key }
  try {
    const object = await bucket.get(key)
    if (_.isNil(object)) return null
    if (object.httpMetadata?.contentEncoding !== 'gzip') return await object.text()
    const stream = object.body.pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  } catch (err) {
    throw _.update(err as Error, 'data.r2GetText', old => old ?? trace)
  }
}

async function r2Put (bucket: R2Bucket, key: string, body: string, contentType: string): Promise<void> {
  await bucket.put(key, await gzip(body), {
    httpMetadata: { cacheControl: CACHE_CONTROL, contentEncoding: 'gzip', contentType },
  })
}

/** 讀回 CSV 並逐列驗證。不存在時回傳空陣列；解析或驗證失敗就丟錯，免得寫回時蓋掉既有資料 */
export async function r2GetCsv<T extends z.ZodType> (
  bucket: R2Bucket,
  key: string,
  schema: T,
): Promise<Array<z.output<T>>> {
  const trace: Record<string, any> = { key }
  try {
    const csv = await r2GetText(bucket, key)
    if (_.isNil(csv) || _.trim(csv) === '') return []
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
    // Papa 不會 throw，要自己檢查 errors
    if (parsed.errors.length > 0) {
      throw _.set(
        new Error(`failed to parse csv: ${parsed.errors[0].message}`),
        'data.papaErrors',
        parsed.errors,
      )
    }
    return _.map(parsed.data, (row, idx) => {
      try {
        return schema.parse(row) as z.output<T>
      } catch (err) {
        throw _.update(err as Error, 'data.r2GetCsvRow', old => old ?? { idx, row })
      }
    })
  } catch (err) {
    throw _.update(err as Error, 'data.r2GetCsv', old => old ?? trace)
  }
}

export async function r2PutCsv (bucket: R2Bucket, key: string, rows: unknown[]): Promise<void> {
  const trace: Record<string, any> = { key, rowsLen: rows.length }
  try {
    await r2Put(bucket, key, Papa.unparse(rows, { header: true }), 'text/csv; charset=utf-8')
  } catch (err) {
    throw _.update(err as Error, 'data.r2PutCsv', old => old ?? trace)
  }
}

export async function r2PutJson (bucket: R2Bucket, key: string, data: unknown): Promise<void> {
  const trace: Record<string, any> = { key }
  try {
    await r2Put(bucket, key, JSON.stringify(data, null, 2), 'application/json; charset=utf-8')
  } catch (err) {
    throw _.update(err as Error, 'data.r2PutJson', old => old ?? trace)
  }
}
