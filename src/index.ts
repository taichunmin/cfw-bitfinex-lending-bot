/**
 * Bitfinex 融資（放貸）自動化機器人的 Cloudflare Worker 進入點。
 *
 * cron 排程定義在 wrangler.jsonc 的 `triggers.crons`，scheduled handler 依 `controller.cron` 分派。
 *
 * 本機測試：`yarn dev` 之後開 http://localhost:8787/ ，會印出可直接複製的 __scheduled 測試指令。
 */

import JSON5 from 'json5'
import wranglerJsonc from '../wrangler.jsonc'
import { main as fundingAutoRenew3 } from './funding/auto-renew-3'
import { main as fundingExportCredits1 } from './funding/export-credits-1'
import { main as fundingStatistics1 } from './funding/statistics-1'
import { logger as rootLogger } from './lib/logger'

const logger = rootLogger.child({ namespace: 'index' })
/** 直接讀 wrangler.jsonc，排程改了測試頁面就跟著改，不必兩邊同步 */
const CRONS = JSON5.parse<{ triggers?: { crons?: string[] } }>(wranglerJsonc).triggers?.crons ?? []

function escapeHtml (str: string): string {
  return str.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

export default {
  async fetch (req) {
    const url = new URL(req.url)
    url.pathname = '/__scheduled'
    const body = CRONS.length === 0
      ? '<p>wrangler.jsonc 的 <code>triggers.crons</code> 是空的，沒有排程可以測試。</p>'
      : [
          '<p>To test the scheduled handler, ensure you have used the <code>--test-scheduled</code> flag, then run:</p>',
          ...CRONS.map(cron => {
            url.searchParams.set('cron', cron)
            return `<pre>curl "${escapeHtml(url.href)}"</pre>`
          }),
        ].join('\n')
    return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },

  async scheduled (
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    try {
      switch (controller.cron) {
        case '*/5 * * * *':
          await fundingAutoRenew3(controller, env, ctx)
          break

        case '2,32 * * * *':
          // statistics-1 會讀 export-credits-1 剛寫進 R2 的 CSV，順序不能反
          await fundingExportCredits1(controller, env, ctx)
          await fundingStatistics1(controller, env, ctx)
          break
      }
      logger.info({ cron: controller.cron }, 'cron processed')
    } catch (err) {
      // 先把錯誤細節（含 data、cause）寫進 log 再往外丟，讓這次 cron 在 dashboard 標記為失敗
      logger.error({ err, cron: controller.cron }, 'cron failed')
      throw err
    }
  },
} satisfies ExportedHandler<Env>
