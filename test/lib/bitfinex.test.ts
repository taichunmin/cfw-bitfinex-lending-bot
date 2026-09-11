import { describe, expect, test } from 'vitest'

import { getBitfinex } from '../../src/lib/bitfinex'

describe('getBitfinex()', () => {
  test('每次都拿到同一個 client，nonce 才不會因為多個 instance 交錯而變小', () => {
    expect(getBitfinex()).toBe(getBitfinex())
  })
})
