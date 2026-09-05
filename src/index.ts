/**
 * Bitfinex 融資（放貸）自動化機器人的 Cloudflare Worker 進入點。
 *
 * cron 排程定義在 wrangler.jsonc 的 `triggers.crons`，見下方的 CRON_* 常數：
 * 每 3 分鐘執行 funding-auto-renew-3（重新計算並調整自動出借的利率與天數）。
 *
 * 本機測試：
 * - `yarn dev` 啟動開發伺服器（已帶 `--test-scheduled`）
 * - `curl "http://localhost:8787/"` 會印出可直接複製的 __scheduled 測試指令
 */

import { main as fundingAutoRenew3 } from './funding/auto-renew-3'
import { createLoggers } from './lib/logger'

const loggers = createLoggers('index')

export default {
  async fetch (req) {
    const url = new URL(req.url)
    url.pathname = '/__scheduled'
    url.searchParams.set('cron', '*/5 * * * *')
    return new Response(`To test the scheduled handler, ensure you have used the "--test-scheduled" then try running "curl ${url.href}".`)
  },

  // The scheduled handler is invoked at the interval set in our wrangler.jsonc's
  // [[triggers]] configuration.
  async scheduled (
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    try {
      switch (controller.cron) {
        case '*/5 * * * *':
          await fundingAutoRenew3(env)
          break

        case '*/30 * * * *':
          break
      }
      loggers.log(`cron ${JSON.stringify(controller.cron)} processed`)
    } catch (err) {
      // 先把錯誤細節（含 data、cause）寫進 log 再往外丟，讓這次 cron 在 dashboard 標記為失敗
      loggers.error([err])
      throw err
    }
  },
} satisfies ExportedHandler<Env>
