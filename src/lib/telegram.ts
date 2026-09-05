import _ from 'lodash'
import { z, type JsonValue } from './zod'

const ZodUnixtimeToDate = z.codec(z.int().min(0), z.date(), {
  decode: unixtime => new Date(unixtime * 1000),
  encode: date => Math.trunc(date.getTime() / 1000),
})

export const ZodTelegramPostResp = z.looseObject({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  migrate_to_chat_id: z.number().optional(),
  retry_after: z.number().optional(),
})
export type TelegramPostResp = z.output<typeof ZodTelegramPostResp>

export const ZodTelegramUser = z.looseObject({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.boolean().optional(),
})
export type TelegramUser = z.output<typeof ZodTelegramUser>

export const ZodTelegramChat = z.looseObject({
  id: z.number(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  is_forum: z.boolean().optional(),
})

export const ZodTelegramMessage = z.looseObject({
  message_id: z.number(),
  message_thread_id: z.number().optional(),
  from: ZodTelegramUser.optional(),
  sender_chat: ZodTelegramChat.optional(),
  date: ZodUnixtimeToDate,
  edit_date: ZodUnixtimeToDate.optional(),
  chat: ZodTelegramChat,
  text: z.string().optional(),
})
export type TelegramMessage = z.output<typeof ZodTelegramMessage>

export const ZodTelegramMessageEntity = z.looseObject({
  type: z.string(),
  offset: z.number(),
  length: z.number(),
})

export const ZodTelegramLinkPreviewOptions = z.looseObject({
  is_disabled: z.boolean().optional(),
  url: z.string().optional(),
  prefer_small_media: z.boolean().optional(),
  prefer_large_media: z.boolean().optional(),
  show_above_text: z.boolean().optional(),
})

export const ZodEditMessageTextReq = z.object({
  business_connection_id: z.string().optional(),
  chat_id: z.union([z.int(), z.string()]).optional(),
  message_id: z.int().optional(),
  inline_message_id: z.string().optional(),
  text: z.string(),
  parse_mode: z.enum(['MarkdownV2', 'HTML', 'Markdown']).optional(),
  entities: z.array(ZodTelegramMessageEntity).optional(),
  link_preview_options: ZodTelegramLinkPreviewOptions.optional(),
  reply_markup: z.any().optional(),
})
export type EditMessageTextReq = z.input<typeof ZodEditMessageTextReq>

export const ZodEditMessageTextRes = z.union([z.boolean(), ZodTelegramMessage])
export type EditMessageTextRes = z.output<typeof ZodEditMessageTextRes>

export interface TelegramOpts {
  token: string
  chatId: string
}

/**
 * Telegram Bot API 的薄層。
 *
 * Worker 沒有 `process.env`，token 與 chat id 改由 `Env` 於建構時注入，
 * 所以這裡是 class 而非原本專案的 module-level 函式。
 */
export class Telegram {
  readonly #token: string
  readonly #chatId: string

  constructor (opts: TelegramOpts) {
    this.#token = opts.token
    this.#chatId = opts.chatId
  }

  /** 由 `Env` 建立實例，缺少 token 或 chat id 時回傳 `null`（代表停用通知） */
  static fromEnv (env: Env): Telegram | null {
    const [token, chatId] = [env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID]
    if (_.isNil(token) || _.isNil(chatId)) return null
    return new Telegram({ token, chatId })
  }

  async #post<TRes extends TelegramPostResp = TelegramPostResp> (path: string, body: Record<string, JsonValue>): Promise<TRes> {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${this.#token}/${path}`, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const respJson = await resp.json().catch(() => null) as TelegramPostResp | null // catch all error
      if (!resp.ok || respJson?.ok === false) {
        const errMsg = _.isNil(respJson) ? `HTTP ${resp.status}: ${resp.statusText}` : `Telegram API ${respJson.error_code}: ${respJson.description}`
        throw _.update(new Error(errMsg), 'data.telegramPost', orig => ({ ...orig, respJson }))
      }
      return respJson as TRes
    } catch (err) {
      throw _.update(err as Error, 'data.telegramPost', orig => ({ ...orig, method: 'POST', path, body }))
    }
  }

  async sendMessage (body: Record<string, JsonValue>): Promise<TelegramMessage> {
    const trace: Record<string, any> = { body }
    try {
      const resp = await this.#post('sendMessage', { chat_id: this.#chatId, ...body })
      return ZodTelegramMessage.parse((resp as any).result)
    } catch (err) {
      throw _.update(err as Error, 'data.sendMessage', old => old ?? trace)
    }
  }

  async editMessageText (req: EditMessageTextReq): Promise<EditMessageTextRes> {
    const trace: Record<string, any> = { req }
    try {
      const req1 = trace.req = ZodEditMessageTextReq.parse(req)
      const res = await this.#post('editMessageText', { chat_id: this.#chatId, ...req1 } as any)
      return ZodEditMessageTextRes.parse((res as any).result)
    } catch (err) {
      throw _.update(err as Error, 'data.editMessageText', old => old ?? trace)
    }
  }
}

export function tgMdEscape (text: string): string {
  return text.replaceAll(/[_*[\]()~`>#+=|{}.!-]/g, c => `\\${c}`)
}

export const ZodTgMdDateOpts = z.object({
  text: z.string().default('').catch(''),
  date: z.date(),
  format: z.string().optional(),
})

export function tgMdDate (opts: z.input<typeof ZodTgMdDateOpts>): string {
  const url = new URL('tg://time')
  url.searchParams.set('unix', `${Math.trunc(opts.date.getTime() / 1e3)}`)
  if (_.isString(opts.format)) url.searchParams.set('format', opts.format)
  return `![${tgMdEscape(opts.text ?? '')}](${url.href})`
}
