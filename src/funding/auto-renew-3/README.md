# funding-auto-renew-3

## 概要

依據最近一天的融資市場資料，自動計算建議利率並更新 Bitfinex 的 auto-renew 設定。

由 Cloudflare Workers 的 cron trigger 每 5 分鐘觸發一次，核心目標：

1. 用最近一天的成交量推估一個「符合目標分位（`rank`）」的利率。
2. 依 `rateMin` / `rateMax` 限制最終利率。
3. 依利率計算出借天數（`period`）。
4. 套用 auto-renew 設定。
5. 透過 Telegram 回報出借狀態。

這支程式移植自 [bitfinex-lending-bot](https://github.com/taichunmin/bitfinex-lending-bot) 的 `bin/funding-auto-renew-3.ts`，利率演算法完全相同，只改寫了執行環境相關的部分（見文末「與原專案的差異」）。

## 放貸績效實測

均民自 2025/03/21 開始，分別在 USD 以及 UST 放了約 1000 美元的本金來實測放貸績效，詳細報告在此：

- [綠葉放貸收益報告](https://lookerstudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e)

## 執行方式

排程定義在專案根目錄的 `wrangler.jsonc`：

```jsonc
"triggers": {
  "crons": [
    "*/5 * * * *"
  ]
}
```

`src/index.ts` 的 `scheduled` handler 依 `event.cron` 分派，`*/5 * * * *` 會呼叫本目錄的 `main(env)`。

### 本地端執行

```bash
yarn dev   # 等同 wrangler dev --test-scheduled
```

另開一個終端機手動觸發（`*/5 * * * *` 要做 URL encode，`/` 是 `%2F`）：

```bash
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

直接用瀏覽器開 <http://localhost:8787/> 也會印出可以複製的測試指令。

> 本地端執行會打到**正式的 Bitfinex API**，用的是 `.dev.vars` 裡的金鑰。若不想動到真實部位，請準備一組唯讀（`funding.write` 關閉）的 API key，或把 `INPUT_AUTO_RENEW_3` 留空。

## 需要的環境變數

必要：

- `BITFINEX_API_KEY`
- `BITFINEX_API_SECRET`
- `INPUT_AUTO_RENEW_3`：出借參數的設定（YAML）

選用：

- `BITFINEX_AFF_CODE`：Bitfinex 推薦碼，未設定時用套件內建值
- `TELEGRAM_TOKEN`
- `TELEGRAM_CHAT_ID`：回報出借狀態的 Telegram 聊天室 ID

`TELEGRAM_TOKEN` 與 `TELEGRAM_CHAT_ID` 只要有一個沒設定就會停用通知，掛單邏輯不受影響（log 會留下一則 warning）。

型別定義在 `src/env.d.ts`。本地端請把專案根目錄的 `.dev.vars.example` 複製為 `.dev.vars` 後修改，該檔已被 gitignore。

## Bitfinex API Key 最小權限需求

```json
{
  "account": { "read": false, "write": false },
  "history": { "read": true, "write": false },
  "orders": { "read": false, "write": false },
  "positions": { "read": false, "write": false },
  "funding": { "read": true, "write": true },
  "settings": { "read": true, "write": true },
  "wallets": { "read": true, "write": false },
  "withdraw": { "read": false, "write": false },
  "ui_withdraw": { "read": false, "write": false }
}
```

`settings` 需要讀寫權限，因為跨次執行的狀態（已送出的 Telegram 訊息 id）是存在 Bitfinex 帳號的 user settings，key 為 `api:taichunmin_funding-auto-renew-3`。

## INPUT_AUTO_RENEW_3 出借參數的設定

請將出借參數以 YAML 格式撰寫，並設定於環境變數 `INPUT_AUTO_RENEW_3` 中。

範例：

```yaml
USD:
  amount: 0
  rank: 0.8
  rateMax: 0.01
  rateMin: 0.0001
  period:
    3: 0.00027397
    7: 0.00041096
    21: 0.00068493
    30: 0.00082192
UST:
  amount: 0
  rank: 0.8
  rateMax: 0.01
  rateMin: 0.0001
  period:
    3: 0.00027397
    7: 0.00041096
    21: 0.00068493
    30: 0.00082192
```

欄位說明：

- `amount`: auto-renew 設定的金額，`>= 0`
- `rank`: 目標分位，範圍 `0 ~ 1`
- `rateMin`: 最低利率下限，最小值為 `0.0001`
- `rateMax`: 最高利率上限，最小值為 `0.0001`
- `period`: 天數對應利率的映射表，鍵值為 `2 ~ 120` 的整數天數

沒設定或設成空字串時會被當成空設定，程式不會對任何幣別動作。

## 部署

首次部署前先登入：

```bash
npx wrangler login
```

### 設定 secrets

這些值都是敏感資訊，**不要**寫進 `wrangler.jsonc` 的 `vars`。單筆設定：

```bash
npx wrangler secret put BITFINEX_API_KEY
npx wrangler secret put BITFINEX_API_SECRET
npx wrangler secret put BITFINEX_AFF_CODE
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

`INPUT_AUTO_RENEW_3` 是多行 YAML，用互動式輸入很不方便，建議改用 `secret bulk` 帶一個 JSON 檔：

```bash
# secrets.json（記得放在 repo 外，或確認已被 gitignore）
# { "INPUT_AUTO_RENEW_3": "USD:\n  amount: 0\n  rank: 0.8\n  ..." }
npx wrangler secret bulk secrets.json
```

`secret bulk` 也吃 stdin 和 `.env` 格式，一次最多 100 筆。設完可以用 `npx wrangler secret list` 確認。

### 部署與觀察

```bash
npx wrangler deploy   # 或 yarn deploy
npx wrangler tail     # 即時看 log
```

`wrangler.jsonc` 已開啟 `observability`，所以 log 也會保留在 Cloudflare dashboard 的 Workers → Logs，可用來回溯過去的執行結果。

程式在 cron handler 外層有 try/catch，會先把錯誤細節（含 `data`、`cause`）以 YAML 寫進 log 再往外丟，讓該次執行在 dashboard 標記為失敗。

## 程式流程

每個幣別（例如 `USD`, `UST`）會依序執行：

1. 檢查平台是否維護中
2. 從 Bitfinex 讀取之前留下的資料
3. 讀取 funding wallet
4. 讀取該幣別目前 auto-renew 設定
5. 讀取最近一天 `1m` K 線（`v2CandlesHist`）
6. 計算目標利率（見下一節）
7. 套用 `rateMin/rateMax` 並換算 `period`
8. 若設定有變更：
    - 關閉舊 auto-renew（若存在）
    - 取消該幣別所有 funding offers
    - 寫入新 auto-renew
    - 等待 1 秒讓掛單生效
9. 產生出借狀態報告（投資額、已借出、掛單中、利率、APR、天數、credits 明細）
10. 依條件決定編輯舊訊息或發新訊息至 Telegram 聊天室
11. 在 Bitfinex 儲存這次執行的資料以便下次使用

單一幣別出錯只會記錄下來並繼續處理下一個幣別；步驟 1～3 是共用前置，失敗會中止整次執行。

## 利率計算演算法

### 1) 建立利率區間與成交量

從每根 K 線取：

- `low = min(open, close, high, low)`
- `high = max(open, close, high, low)`
- `volume`

全部放大 `1e8` 後轉成 `BigInt`，避免浮點誤差。

然後把相同 `[low, high]` 的區間合併，累加 `volume`。

### 2) 目標 rank

總成交量 `totalVolume = sum(volume)`。

目標分位由設定 `rank` 決定。

### 3) 二分搜尋目標利率

在 `[lowestRate, highestRate]` 上做二分搜尋。對每個中點 `mid`，計算其對應累積成交量 `midVol`：

- 若 `mid >= high`，該區間量全計入
- 若 `mid < low`，該區間不計入
- 若落在中間，按比例線性切分

接著計算 `midRank = midVol / totalVolume`，與目標 `rank` 比較。

過程中會保留「目前最接近目標 rank 的 mid」作為 `targetRate`，即使沒精準命中也有最接近解。

### 4) 套用上下限

最終利率：

```text
targetRate = clamp(targetRate, rateMin, rateMax)
```

沒有任何有成交量的 K 線時 `calcTargetRate()` 回傳 `null`，該幣別這輪會跳過不改設定。

## `rateToPeriod` 邏輯

`rateToPeriod(periodMap, rateTarget)` 會從 `period` 映射中找出：

- `lower`: 利率小於等於目標利率時，最大的天數
- `upper`: 利率大於等於目標利率時，最小的天數

決策規則：

1. 若沒有 `lower`，回傳 `2`
2. 若沒有 `upper`，回傳 `lower`
3. 若 `lower === upper`，回傳該天數
4. 否則在 `lower` 與 `upper` 之間做線性插值，再無條件捨去
5. 最後再 `clamp` 到 `2 ~ 120`

## Telegram 訊息重用條件

程式會嘗試編輯舊訊息（避免重複洗版），只有以下條件同時成立才重用：

1. 先前有 `msgId`
2. funding wallet `balance` 未改變
3. 出借中的 `creditIds` 未改變

否則就發送新訊息，並更新 `db.notified[currency]`。

## 實務建議

1. `rank` 建議先從 `0.6 ~ 0.85` 區間測試，再依實際成交與收益調整。
2. `rateMin` 不宜設太高，避免在市場走低時長時間掛不出去。
3. `period` 映射建議維持單調（天數越長，利率門檻越高），可降低插值結果不直覺的情況。
4. 若要加新幣別，只要在 `INPUT_AUTO_RENEW_3` 增加同結構配置即可。
5. 原專案在 GitHub Actions 上是每 10 分鐘跑一次，這裡改成 5 分鐘，對 Bitfinex API 的呼叫量會變成 2 倍多。幣別設得多時請留意 rate limit，必要時把 `wrangler.jsonc` 的 cron 調長。

## 與原專案的差異

演算法（`calcTargetRate`、`rateToPeriod`）與 zod schema 完全相同，只改了執行環境相關的部分：

- **設定來源**：Workers 沒有 `process.env`，`getenv()` 全部換成 cron handler 傳入的 `env`。
- **`main()` 簽名**：改成 `main(env: Env)`，並移除原本結尾判斷是否為主模組的自我執行區塊。
- **Telegram**：`src/lib/telegram.ts` 從 module-level 函式改成 `Telegram` class，token / chat id 於建構時注入。
- **logger**：拿掉 `debug`、`node:path`、`node:url` 與 `Buffer`，直接寫 `console`，由 Cloudflare observability 收集。
- **等待**：`node:timers/promises` 的 `scheduler.wait()` 換成 `setTimeout`。
- **js-yaml**：本專案用 v5，改成具名匯入 `load` / `dump` / `JSON_SCHEMA`；v5 的 `load()` 遇到空來源會丟例外，所以 `parseYaml()` 對空字串直接回 `undefined`。
- **axios**：`@taichunmin/bitfinex` 透過 axios 發 request，在 Workers 上會挑 fetch adapter，而它預設帶的 `cache: 'default'` 是 workerd 不支援的值。`src/lib/bitfinex.ts` 在 `axios.defaults.fetchOptions` 先指定 `no-store` 蓋掉，所以**請一律從那裡取得 Bitfinex client**。

`DB_KEY` 維持 `api:taichunmin_funding-auto-renew-3`，原專案存在 Bitfinex user settings 的狀態可以直接接續使用。
