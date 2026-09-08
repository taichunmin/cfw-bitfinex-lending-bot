# funding-auto-renew-3

Bitfinex 融資（放貸）的自動掛單機器人。

依據最近一天的融資市場成交量，推算出一個「符合目標分位」的利率，換算成出借天數後套用到 Bitfinex 的 auto-renew 設定，並把出借狀態回報到 Telegram。由 Cloudflare Workers 的 cron trigger 定期執行，排程定義在 `wrangler.jsonc` 的 `triggers.crons`。

## 放貸績效

均民自 2025/03/21 開始，分別在 USD 與 UST 各放約 1000 美元的本金實測，詳細報告：

- [綠葉放貸收益報告](https://lookerstudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e)

## 使用方式

### 出借參數

出借參數寫在 `wrangler.jsonc` 的 `vars.INPUT_AUTO_RENEW_3`，是一個「幣別 → 設定」的物件。以下示範結構，實際值以 `wrangler.jsonc` 為準：

```jsonc
"vars": {
  "INPUT_AUTO_RENEW_3": {
    "USD": {
      "amount": 0,
      "rank": 0.8,
      "rateMax": 0.01,
      "rateMin": 0.0001,
      "period": {
        "3": 0.00027397,
        "7": 0.00041096,
        "21": 0.00068493,
        "30": 0.00082192
      }
    }
  }
}
```

| 欄位 | 說明 |
|------|------|
| `amount` | auto-renew 的金額，`>= 0`（`0` 表示不限制） |
| `rank` | 目標分位，`0 ~ 1` |
| `rateMin` | 利率下限，最小值 `0.0001` |
| `rateMax` | 利率上限，最小值 `0.0001` |
| `period` | 天數對應利率的映射表，鍵為 `2 ~ 120` 的整數天數 |

沒設定或設成空物件時，程式不會對任何幣別動作。要加新幣別就多加一組同結構的設定。

調參建議：

- `rank` 先從 `0.6 ~ 0.85` 試，再依實際成交與收益調整。
- `rateMin` 不宜設太高，否則市場走低時會長時間掛不出去。
- `period` 建議維持單調遞增（天數越長、利率門檻越高），插值結果才直覺。
- 幣別設得多時留意 Bitfinex 的 rate limit，必要時把 cron 調長。

### 環境變數

敏感資訊用 secrets，其餘放在 `wrangler.jsonc` 的 `vars`：

| 變數 | 位置 | 必要 | 說明 |
|------|------|------|------|
| `BITFINEX_API_KEY` | secret | ✅ | |
| `BITFINEX_API_SECRET` | secret | ✅ | |
| `INPUT_AUTO_RENEW_3` | vars | ✅ | 出借參數 |
| `TELEGRAM_TOKEN` | secret | | 通知用 |
| `TELEGRAM_CHAT_ID` | vars | | 回報狀態的聊天室 ID |
| `BITFINEX_AFF_CODE` | vars | | 推薦碼，未設定時用套件內建值 |

`TELEGRAM_TOKEN` 與 `TELEGRAM_CHAT_ID` 只要有一個沒設定就會停用通知，掛單邏輯不受影響（log 會留一則 warning）。

型別由 `npx wrangler types` 產生到 `worker-configuration.d.ts`。

### API key 最小權限

```json
{
  "account":     { "read": false, "write": false },
  "history":     { "read": true,  "write": false },
  "orders":      { "read": false, "write": false },
  "positions":   { "read": false, "write": false },
  "funding":     { "read": true,  "write": true  },
  "settings":    { "read": true,  "write": true  },
  "wallets":     { "read": true,  "write": false },
  "withdraw":    { "read": false, "write": false },
  "ui_withdraw": { "read": false, "write": false }
}
```

`settings` 需要讀寫，因為跨次執行的狀態（已送出的 Telegram 訊息 id）存在 Bitfinex 帳號的 user settings，key 為 `api:taichunmin_funding-auto-renew-3`。

### 部署

```bash
npx wrangler login                        # 首次
npx wrangler secret put BITFINEX_API_KEY  # 逐一設定 secrets
npx wrangler deploy                       # 或 yarn deploy
npx wrangler tail                         # 即時看 log
```

`wrangler.jsonc` 已開啟 `observability`，log 會保留在 Cloudflare dashboard 的 Workers → Logs。log 是 pino 產生的結構化 JSON，Workers Logs 會自動索引欄位，可以直接在 dashboard 上依欄位過濾。

cron handler 外層有 try/catch，會先把錯誤細節（含 `data`、`cause`）寫進 log 再往外丟，讓該次執行在 dashboard 標記為失敗。

## 原理

### 程式流程

前置（失敗會中止整次執行）：

1. 檢查平台是否維護中
2. 讀取上次執行留下的狀態與 funding wallet

接著每個幣別依序執行，單一幣別出錯只記錄下來並繼續處理下一個：

1. 讀取該幣別目前的 auto-renew 設定
2. 讀取最近一天的 `1m` K 線
3. 計算目標利率，套用 `rateMin` / `rateMax`，換算 `period`
4. 若設定有變更：關閉舊 auto-renew → 取消該幣別所有掛單 → 寫入新設定 → 等 1 秒讓掛單生效
5. 產生出借狀態報告，編輯舊訊息或發新訊息到 Telegram

最後把這次的狀態寫回 Bitfinex user settings。

### 利率計算

**1. 建立利率區間**　每根 K 線取 `low = min(open, close, high, low)`、`high = max(...)` 與 `volume`，全部放大 `1e8` 後轉成 `BigInt` 避免浮點誤差，再把相同 `[low, high]` 的區間合併、累加成交量。

**2. 二分搜尋**　在 `[lowestRate, highestRate]` 上二分搜尋。對每個中點 `mid` 計算累積成交量：

- `mid >= high`：該區間全部計入
- `mid < low`：該區間不計入
- 落在中間：按比例線性切分

得到 `midRank = midVol / totalVolume` 後與目標 `rank` 比較。過程中會保留「目前最接近目標 rank 的 mid」，所以即使沒精準命中也有最接近解。

**3. 套用上下限**　`targetRate = clamp(targetRate, rateMin, rateMax)`。

沒有任何有成交量的 K 線時回傳 `null`，該幣別這輪跳過不改設定。

### 天數計算

`rateToPeriod()` 從 `period` 映射中找出：

- `lower`：利率 `<=` 目標利率時，最大的天數
- `upper`：利率 `>=` 目標利率時，最小的天數

然後：沒有 `lower` 回傳 `2`；沒有 `upper` 回傳 `lower`；兩者相同就回傳該天數；否則在兩者之間線性插值後無條件捨去。最後 clamp 到 `2 ~ 120`。

### Telegram 訊息重用

為了避免洗版，以下條件同時成立時會編輯舊訊息，否則發新訊息：

1. 先前有 `msgId`
2. funding wallet 的 `balance` 未改變
3. 出借中的 `creditIds` 未改變

## 本地開發

把 `.env.example` 複製成 `.env` 後填入金鑰（`.env` 已被 gitignore），然後：

```bash
yarn dev
yarn test
yarn type-check
```

`yarn dev` 起來後，用瀏覽器開 <http://localhost:8787/>，它會印出可以直接複製的 curl 指令來手動觸發 cron。

> 本地執行會打到**正式的 Bitfinex API**。不想動到真實部位的話，請準備一組關閉 `funding.write` 的唯讀 API key，或把 `INPUT_AUTO_RENEW_3` 設成空物件。
