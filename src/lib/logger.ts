import { dump as yamlDump } from 'js-yaml'
import _ from 'lodash'
import pino from 'pino'

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

/** `preventCircular` 要跨 `cloneDeep` 共用，否則 `data` / `cause` 成環時會無限遞迴 */
export function errToJson (
  err: Error & { cause?: any },
  preventCircular = new Set()
): Record<string, any> {
  const name = err.constructor?.name ?? err.name ?? 'Error'
  if (preventCircular.has(err)) return { name, message: `[Circular] ${err.message}` }
  preventCircular.add(err)
  const result = cloneDeep({
    name,
    ..._.pick(err, ERROR_KEYS),
  }, preventCircular)
  if (err.cause instanceof Error) result.cause = errToJson(err.cause, preventCircular)
  else if (!_.isNil(err.cause)) result.cause = cloneDeep(err.cause, preventCircular)
  return result
}

export function cloneDeep <T extends unknown> (
  obj: T,
  preventCircular = new Set()
): Partial<T> {
  return _.cloneDeepWith(obj, (val1, key1) => {
    // axios 的 `_header` 這類內部欄位
    if (_.isString(key1) && key1.length > 1 && key1.startsWith('_')) return '[Redact]'
    if (typeof val1 === 'bigint') return val1.toString()
    // 要排在登記前，Error 的登記由 errToJson 負責
    if (val1 instanceof Error) return errToJson(val1, preventCircular)
    if (_.isFunction((val1 as any)?.toJSON)) return (val1 as any).toJSON()
    // 只登記物件：基本型別重複出現不算環，空物件也構不成環
    if (_.isObject(val1) && !_.isEmpty(val1)) {
      if (preventCircular.has(val1)) return '[Circular]'
      preventCircular.add(val1)
    }
    if (val1 instanceof Map) return cloneDeep(_.fromPairs([...val1.entries()]), preventCircular)
    if (val1 instanceof Set) return cloneDeep([...val1.values()], preventCircular)
  })
}

export function ymlStringify (obj: Record<string, any>): string {
  try {
    return yamlDump(cloneDeep(obj)).slice(0, -1)
  } catch (err: any) {
    throw _.set(new Error(err.message), 'cause', err)
  }
}

/** Cloudflare 依呼叫的 console 方法決定 Workers Logs 的 severity，不能一律用 console.log */
const CONSOLE_METHODS: Record<string, string> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
}

export const pinoWriteFns = _.mapValues(CONSOLE_METHODS, (fnName, level) => {
  return (obj: unknown) => {
    try {
      const consoleFn = (console as any)[fnName] ?? console.log
      consoleFn.call(console, cloneDeep(obj as any))
    } catch (err) {
      err = _.update(
        new Error(err.message ?? 'Unexpected error', { cause: err }),
        'data.pinoWriteFns',
        orig => orig ?? { level, namespace: (obj as any)?.namespace }
      )
      console.error(errToJson(err))
    }
  }
})

/** Workers 不能用 pino 的 Node transport，改用 browser build 寫進 console，由 Cloudflare observability 收集 */
export const logger = pino({
  level: 'debug',
  timestamp: pino.stdTimeFunctions.isoTime,
  browser: {
    asObject: true,
    formatters: { level: label => ({ level: label }) },
    write: pinoWriteFns,
  },
})
