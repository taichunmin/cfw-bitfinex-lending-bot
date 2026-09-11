import { JSON_SCHEMA, load as yamlLoad } from 'js-yaml'
import _ from 'lodash'
import { dayjs } from './dayjs'

export function floatFormatDecimal (num: number, precision = 2): string {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'decimal',
  })
  return formater.format(num)
}

export function floatFormatPercent (rate: number, precision = 2): string {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'percent',
  })
  return formater.format(rate)
}

export function rateStringify (rate: number): string {
  return `${floatFormatPercent(rate, 6)} (APR: ${floatFormatPercent(rate * 365)})`
}

export function dateStringify (
  date?: string | number | Date | dayjs.Dayjs | null,
  format: string = 'YYYY-MM-DD HH:mm:ssZ',
): string {
  return dayjs(date).utcOffset(8).format(format)
}

/** 轉成 UTC 的 `YYYY-MM-DD HH:mm:ss` */
export function toUtcDateStr (date: Date): string {
  return dayjs.utc(date).format('YYYY-MM-DD HH:mm:ss')
}

export function floatIsEqual (float1: number, float2: number): boolean {
  return Math.abs(float1 - float2) < Number.EPSILON
}

export const floatFloor8 = (num: number): number => _.floor(num, 8)

export function progressPercent (cur: number, max: number, precision = 2): string {
  if (cur < 0 || max <= 0) return '?%'
  return floatFormatPercent(_.clamp(cur / max, 0, 1), precision)
}

export function parseYaml (str: string): unknown {
  try {
    // js-yaml v5 的 `load()` 遇到空來源會丟例外
    return yamlLoad(str, { json: true, schema: JSON_SCHEMA })
  } catch (err) {
    return undefined
  }
}

export async function sleep (ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}
