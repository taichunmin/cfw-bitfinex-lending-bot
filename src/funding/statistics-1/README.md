# funding-statistics-1

計算 Bitfinex 放貸的 1/7/30/365 日年化與資金利用率，把結果寫成 CSV/JSON 放到 Cloudflare R2，並在結算出新的一天時發 Telegram 報告。

由 Cloudflare Workers 的 cron trigger 執行，接在 `export-credits-1` 之後——利用率要用它剛寫進 R2 的 credits CSV。

報告：[綠葉放貸收益報告](https://lookerstudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e)

## 產出

每個幣別一組 CSV 與 JSON，內容相同：

```
bitfinex-lending-bot/funding/statistics-1/{currency}.csv
bitfinex-lending-bot/funding/statistics-1/{currency}.json
```

公開網址是 bucket 的自訂網域加上這個 key。每個 UTC 日期一列：

| 欄位 | 說明 |
|------|------|
| `date` | UTC 日期 |
| `interest` | 當日利息 |
| `balance` | 當日最高餘額 |
| `investment` | 當日可投入本金（`balance - interest`） |
| `dpr` | 當日報酬率（%） |
| `apr1` | 當日年化（`dpr * 365`） |
| `apr7` / `apr30` / `apr365` | trailing 7/30/365 日的平均年化 |
| `lentRatio1` | 當日資金利用率（%） |
| `lentRatio7` / `lentRatio30` / `lentRatio365` | trailing 7/30/365 日的資金加權利用率 |

不拆檔：`apr365` 本來就得從完整序列重算，拆檔省不了計算。

## 設定

| 變數 | 位置 | 必要 | 說明 |
|------|------|------|------|
| `BITFINEX_API_KEY` | secret | ✅ | |
| `BITFINEX_API_SECRET` | secret | ✅ | |
| `STATISTICS_FUNDING` | vars | ✅ | `{ "currencys": [...] }`，與 `export-credits-1` 共用 |
| `R2` | r2_buckets | ✅ | 產出的 bucket |
| `TELEGRAM_TOKEN` | secret | | 通知用 |
| `TELEGRAM_CHAT_ID` | vars | | 回報狀態的聊天室 ID |

`TELEGRAM_TOKEN` 與 `TELEGRAM_CHAT_ID` 只要有一個沒設定就停用通知，統計與 R2 產出不受影響。

API key 需要 `history.read`（讀 ledgers）、`funding.read`（讀進行中的出借），以及 `settings` 讀寫（跨次執行的狀態存在 user settings，key `api:taichunmin_funding-statistics-1`）。

## 原理

### 時區

日期計算一律以 **UTC+0** 為準，`date` 欄位就是利息入帳的 UTC 日期。只有 Telegram 訊息裡的**時間戳**才轉 UTC+8；報告裡的「日期」是日期桶的標籤而非時刻，所以不轉換。

### 每日統計

1. 讀 ledgers 裡 `Margin Swap Interest Payment` 類別、`funding` 錢包的利息記錄
2. 依 UTC 日期分桶：`balance` 取當日最高，`interest` 累加，`investment = balance - interest`
3. `apr1 = interest / investment * 365 * 100`
4. `apr7` / `apr30` / `apr365` 把每天的 `apr1` 往後攤 7/30/365 天再平均
5. 沒有利息的日子沿用前一天的餘額

第 2 步要**全部彙總完**才能進第 3、4 步。同一天常有多筆利息記錄，邊累加邊攤的話中間值會被重複攤進 `apr7` / `apr30` / `apr365`。

trailing 平均固定除以 7 / 30 / 365 而非實際天數，所以序列最前面的日子會偏低。這是刻意保留的行為，改了會讓歷史數字跟既有報表對不起來。

### 資金利用率

每日「時間加權放出本金」：把每筆出借的金額依存續時間攤到每個 UTC 日期。

- **已結束**的出借讀自 `export-credits-1` 的今年與去年年度檔，更舊的對 365 日視窗沒有貢獻
- **進行中**的出借另外從 `v2AuthReadFundingCredits` 取，算到現在為止，否則執行當下還開著的單會讓昨天嚴重低估

`lentRatio1` 是當日放出金額 ÷ 當日可投入本金；trailing N 日是**資金加權**：`Σ(每日放出金額) / Σ(每日可投入本金)`。

### Telegram 報告與去重

只有 `dateMax`（最新一筆利息的日期）與上次記錄的不同才發報告，所以每天最多發一則。年化取 `dateMax`、利用率取 `dateMax - 1`，因為 `dateMax` 當天的利用率還不完整。

改動 DB key 會讓既有狀態對不上，當天會重發一則報告。

R2 的寫入**不受**去重影響，每次執行都會重算並寫回。

## 本地開發

```bash
yarn dev    # 開 http://localhost:8787/ 取得手動觸發 cron 的 curl 指令
yarn test
yarn type-check
```

> 本地執行會打到**正式的 Bitfinex API**，並寫入 user settings 與發送 Telegram（把 `TELEGRAM_TOKEN` 留空即可停用通知）。R2 是本機模擬的。
