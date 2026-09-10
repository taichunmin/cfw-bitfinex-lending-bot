# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

`wrangler types` 也會把 `.env` 的變數寫進 `worker-configuration.d.ts` 的 `Env`。新增 `.env` 變數時要同步把 key 加進 `.env.example`（值留空），否則 CI 沒有 `.env`（CI 是 `cp .env.example .env`）會產出不同的型別，讓 `wrangler types --check` 失敗。

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## R2

bucket `taichunmin` 是**通用**的（不只這個專案），所以所有 key 都要帶 `bitfinex-lending-bot/` 前綴。它掛在公開的自訂網域 `r2.taichunmin.idv.tw` 上，讀寫一律經由 `src/lib/r2.ts`。

物件一律 gzip 後才存。注意 R2 的 `get()` 回傳的是**儲存的原始位元組**，不會依 `content-encoding` 自動解壓（跟走 HTTP 的公開網址不同），`r2GetText` 會依 metadata 判斷後自己解。
