import { dump as yamlDump } from 'js-yaml'
import _ from 'lodash'
import type { JsonValue } from './zod'

const ERROR_KEYS = [
  'address',
  'args',
  'code',
  'data',
  'dest',
  'errno',
  'extensions',
  'info',
  'locations',
  'message',
  'name',
  'path',
  'port',
  'positions',
  'reason',
  'response.data',
  'response.headers',
  'response.status',
  'source',
  'stack',
  'status',
  'statusCode',
  'statusMessage',
  'syscall',
]

export function errToJson (err: Error & { cause?: any }): Record<string, any> {
  return _.omitBy({
    ..._.pick(err, ERROR_KEYS),
    cause: (err.cause instanceof Error) ? errToJson(err.cause) : err.cause,
  }, _.isUndefined)
}

export function stringifyClone (obj: Record<string, any>): Record<string, any> {
  const preventCircular = new Set()
  return _.cloneDeepWith(obj, val1 => {
    if (_.isObject(val1) && !_.isEmpty(val1)) {
      if (preventCircular.has(val1)) return '[Circular]'
      preventCircular.add(val1)
    }
    if (typeof val1 === 'bigint') return val1.toString()
    if (val1 instanceof Error) return errToJson(val1)
    if (_.isFunction((val1 as any)?.toJSON)) return (val1 as any).toJSON()
    if (val1 instanceof Map) return _.fromPairs([...val1.entries()])
    if (val1 instanceof Set) return [...val1.values()]
  })
}

export function stringifyReplacer (this: any, key: string, val: unknown): any {
  if (key.length > 1 && key.startsWith('_')) return undefined
  const censored = this?._censored ?? []
  for (const key1 of censored) {
    if (!_.hasIn(this, key1)) continue
    _.set(this, key1, '[Censored]')
  }
  delete this?._censored
  return this[key]
}

export function jsonStringify (obj: Record<string, any>): string {
  return JSON.stringify(stringifyClone(obj), stringifyReplacer)
}

export function ymlStringify (obj: Record<string, any>): string {
  try {
    return yamlDump(JSON.parse(jsonStringify(obj))).slice(0, -1)
  } catch (err: any) {
    throw _.set(new Error(err.message), 'cause', err)
  }
}

type LoggerFunction = (message?: any) => void

/**
 * Workers 沒有 `debug` 套件那套 namespace 開關，所以直接寫到 console，
 * 由 Cloudflare 的 observability（wrangler.jsonc 已開啟）收集。
 */
export function createLogger (logType: string, logName: string): LoggerFunction {
  const logger: (...args: any[]) => void = (console as any)[logType] ?? console.log
  return (msg: JsonValue) => { logger(`[${logName}]`, _.isObject(msg) ? ymlStringify(msg) : msg) }
}

export function createLoggers (logName: string): Record<string, LoggerFunction> {
  return _.chain(['debug', 'error', 'info', 'log', 'warn'])
    .map(logType => [logType, createLogger(logType, logName)])
    .fromPairs()
    .value()
}
