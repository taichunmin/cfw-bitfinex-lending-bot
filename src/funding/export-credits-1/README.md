# funding-export-credits-1

把 Bitfinex 已結束的融資（放貸）記錄**增量**匯出成 CSV，存到 Cloudflare R2。產出是 `funding-statistics-1` 計算資金利用率的原料。

由 Cloudflare Workers 的 cron trigger 執行，排程定義在 `wrangler.jsonc` 的 `triggers.crons`，同一次執行會接著跑 `statistics-1`。

## 產出

每個幣別、每個年份一個 CSV：

```
bitfinex-lending-bot/funding/export-credits-1/{currency}/{year}.csv
```

公開網址是 bucket 的自訂網域加上這個 key。

| 欄位 | 說明 |
|------|------|
| `id` | 融資記錄 ID |
| `amount` | 融資金額 |
| `period` | 融資天數 |
| `rate` | 融資利率（日利率，`0.01` = 1%） |
| `side` | `1` 為貸方，`0` 同時為貸方與借款人，`-1` 為借款人 |
| `status` | 融資狀態 |
| `openedAt` | 融資開始時間（`mtsOpening`） |
| `closedAt` | 最後一次支付時間（`mtsLastPayout`） |
| `createdAt` | 建立時間（`mtsCreate`），**決定這列寫進哪個年度檔** |
| `updatedAt` | 最後更新時間（`mtsUpdate`），**API 過濾、排序與增量水位的軸** |

時間一律是 UTC+0 的 `YYYY-MM-DD HH:mm:ss`。

## 設定

| 變數 | 位置 | 必要 | 說明 |
|------|------|------|------|
| `BITFINEX_API_KEY` | secret | ✅ | |
| `BITFINEX_API_SECRET` | secret | ✅ | |
| `STATISTICS_FUNDING` | vars | ✅ | `{ "currencys": [...] }`，與 `statistics-1` 共用 |
| `R2` | r2_buckets | ✅ | 產出的 bucket |
| `BITFINEX_AFF_CODE` | vars | | 推薦碼，未設定時用套件內建值 |
| `ENV_NAME` | vars | | 環境名稱，正式為 `prod`，本地由 `.env` 覆寫成 `dev`；沒設定時當成 `dev` |

API key 需要 `funding.read`，以及 `settings` 讀寫（增量水位存在 user settings）。

`STATISTICS_FUNDING` 與 `statistics-1` 共用，避免兩邊幣別不同步。Cloudflare Dashboard 的 JSON 變數只接受 object，所以幣別清單包在 `currencys` 裡。

物件一律 **gzip 後才存**以節省儲存空間。走公開網址讀取時會透明解壓，但 `curl` 與 `wrangler r2 object get` 拿到的是壓縮檔。

## 原理

### 增量水位

每個幣別最後一筆已匯出記錄的 `mtsUpdate` 存在 Bitfinex 帳號的 user settings（key `api:taichunmin_{ENV_NAME}_funding-export-credits-1`）。每次執行：

1. `start` = 水位往前推 `START_MARGIN_MS`；沒有水位時帶 `1`，等於全量回補
2. 呼叫 `v2AuthReadFundingCreditsHist({ currency, start, end })`，用 `end` 往回翻頁直到抓完
3. 每抓完一頁就合併寫回 R2
4. 全部抓完後，把水位更新成抓到的最新 `mtsUpdate`

API 的 `start`、`end` 都依 `mtsUpdate` 過濾且包含邊界，排序是 `mtsUpdate` 由新到舊。前後頁會重疊一筆，重複寫回時內容沒變不會重寫。

**為什麼要往前推**：API 只回傳已結束的單，但 `mtsUpdate` 不是結束時間。比已匯出記錄晚結束的單，`mtsUpdate` 可能早於水位，直接帶水位會漏抓。

想重新全量回補時要清掉 user settings 裡的水位；只刪 R2 的年度檔不會觸發回補。

### 年度拆檔

依 **`createdAt` 的年份**切分，跨年後舊年度的檔幾乎不再變動。寫回前會先讀回既有年度檔再合併，否則會蓋掉既有資料。合併以 `id` upsert，輸出依 **id 遞增**排序，內容沒變的檔不寫回。

### 寫入時機

每抓完一頁就寫回 R2，但**整輪抓完才更新水位**。抓取範圍只由水位決定，所以 R2 寫到一半失敗、或翻到 `MAX_PAGES` 還沒抓完（會丟錯），水位都不動，下一輪會從舊水位重抓補齊。

超過 `MAX_PAGES` 頁的回補無法跨輪接續，要調高 `MAX_PAGES` 後重跑。

## 本地開發

```bash
yarn dev    # 開 http://localhost:8787/ 取得手動觸發 cron 的 curl 指令
yarn test
yarn type-check
```

> 本地執行會打到**正式的 Bitfinex API**，R2 則是本機模擬的。水位的 key 帶有 `ENV_NAME`，`.env` 要設 `ENV_NAME="dev"`，本地的水位才不會跟正式環境共用。
