import { env } from 'cloudflare:test'
import _ from 'lodash'
import { describe, expect, test } from 'vitest'

import { r2GetCsv, r2GetText, r2PutCsv, r2PutJson } from '../../src/lib/r2'
import { z } from '../../src/lib/zod'

const ZodRow = z.object({
  id: z.coerce.number().int(),
  name: z.string(),
})

let seq = 0
function nextKey (ext: string): string {
  return `test/r2/${seq++}.${ext}`
}

describe('r2PutCsv() / r2GetCsv()', () => {
  test('壓縮寫入後仍能原樣讀回', async () => {
    const key = nextKey('csv')
    const rows = [{ id: 1, name: 'USD' }, { id: 2, name: 'UST' }]
    await r2PutCsv(env.R2, key, rows)

    expect(await r2GetCsv(env.R2, key, ZodRow)).toEqual(rows)
  })

  test('物件不存在時回傳空陣列，首次執行才能自然退回全量', async () => {
    expect(await r2GetCsv(env.R2, nextKey('csv'), ZodRow)).toEqual([])
  })

  test('欄位驗證失敗要往外丟，不能默默當成空的把既有資料蓋掉', async () => {
    const key = nextKey('csv')
    await env.R2.put(key, 'id,name\nnot-a-number,USD\n')

    await expect(r2GetCsv(env.R2, key, ZodRow)).rejects.toThrow()
  })

  test('CSV 格式壞掉時要丟錯，不能把殘缺的資料當成完整的讀進來', async () => {
    const key = nextKey('csv')
    // 引號沒有收尾，Papa 會記在 errors 裡但不會 throw
    await env.R2.put(key, 'id,name\n1,"USD\n2,UST\n')

    await expect(r2GetCsv(env.R2, key, ZodRow)).rejects.toThrow(/parse csv/)
  })

  test('沒壓縮過的物件也要讀得回來', async () => {
    const key = nextKey('csv')
    await env.R2.put(key, 'id,name\n1,USD\n')

    expect(await r2GetCsv(env.R2, key, ZodRow)).toEqual([{ id: 1, name: 'USD' }])
  })
})

describe('r2PutJson()', () => {
  test('壓縮寫入後仍能原樣讀回', async () => {
    const key = nextKey('json')
    const data = { currencys: ['USD', 'UST'], nested: { n: 1 } }
    await r2PutJson(env.R2, key, data)

    expect(JSON.parse((await r2GetText(env.R2, key)) as string)).toEqual(data)
  })
})

describe('R2 物件的 metadata', () => {
  test('帶 content-encoding、content-type 與 cache-control，且實際存的是壓縮後的位元組', async () => {
    const key = nextKey('csv')
    // 重複性高的資料，壓完一定比原文短
    const rows = _.times(200, i => ({ id: i, name: 'USD' }))
    const raw = `id,name\r\n${_.map(rows, r => `${r.id},USD`).join('\r\n')}\r\n`
    await r2PutCsv(env.R2, key, rows)

    const object = await env.R2.head(key)
    expect(object?.httpMetadata).toMatchObject({
      cacheControl: 'public, max-age=300',
      contentEncoding: 'gzip',
      contentType: 'text/csv; charset=utf-8',
    })
    expect(object?.size).toBeLessThan(raw.length / 2)
  })

  test('JSON 的 content-type 是 application/json', async () => {
    const key = nextKey('json')
    await r2PutJson(env.R2, key, { a: 1 })

    expect((await env.R2.head(key))?.httpMetadata).toMatchObject({
      contentEncoding: 'gzip',
      contentType: 'application/json; charset=utf-8',
    })
  })
})
