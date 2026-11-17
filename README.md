# 停車進出統計

用手機拍車牌 → 上傳 → AI（Claude）辨識車牌 → 依照片的拍攝時間配對出每台車的進場和出場時間，算出進出車次、目前在場數量和停留時間。

## 啟動

需要 Node.js 22.13 以上。

```bash
npm install
copy .env.example .env      # 填入 ANTHROPIC_API_KEY
npm start                   # http://localhost:3000
```

不想花 AI 費用、只想試流程：`npm run mock`（車牌改從檔名讀，例如 `ABC-1234.jpg`）。

手機要連得到這台電腦：同一個 Wi-Fi 下用 `http://電腦IP:3000`。
**注意：手機瀏覽器只有在 https 或 localhost 下才會直接開相機**；用區網 IP 時「拍照」按鈕仍可用（會跳出系統相機），但要長期給現場人員用，建議部署到有 https 的主機（如 Render）。

## 使用方式

1. **拍照上傳**：車子進來按綠色「進場」、離開按橙色「出場」直接拍照；或用「相簿・進場」「相簿・出場」一次選多張。
2. **時間**：網站內拍照用當下時間，並印在照片右下角；相簿照片用照片裡的拍攝時間（EXIF，支援 iPhone HEIC），讀不到時會警告。可在「照片紀錄」手動修正。
3. **統計**：選日期範圍，看進場數、出場數、目前在場、平均停留、每小時進出圖、每台車的配對紀錄；可匯出 CSV 用 Excel 開。
4. **照片紀錄**：AI 認錯的車牌直接改，統計會自動重算。信心低的會標「請確認」。

## 運作方式

- 每張照片存成一筆「事件」（車牌、方向、拍攝時間、照片）。
- 統計時把同一車牌的事件依時間排序、兩兩配對成停車紀錄，所以照片不照順序上傳、事後改車牌都沒關係。
- 漏拍會顯示「缺出場紀錄」或「缺進場紀錄」。
- 資料存在 `data/parking.db`（SQLite），照片存在 `data/photos/日期/`。備份就是複製整個 `data` 資料夾。

## 上線（Render + Supabase）

- 網站跑在 Render（免費方案，閒置 15 分鐘會休眠，下次打開要等約 1 分鐘）。push 到 GitHub `main` 會自動重新部署。
- 資料（停車紀錄和照片）存在 Supabase 專案 `parking-plate-stats`（免費額度 500MB 資料庫，約可存數千張照片）。資料表定義在 [supabase/schema.sql](supabase/schema.sql)。
- Supabase 免費專案一週沒人使用會被暫停，要到 Supabase 後台按 Restore 恢復（資料不會不見）。
- Render 上要設的環境變數：`ANTHROPIC_API_KEY`、`APP_PASSWORD`、`SUPABASE_URL`、`SUPABASE_KEY`、`SUPABASE_APP_SECRET`。

## 設定（.env）

| 變數 | 說明 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 金鑰（必填） |
| `PORT` | 埠號，預設 3000 |
| `APP_PASSWORD` | 設了之後要輸入密碼才能使用 |
| `SUPABASE_URL` / `SUPABASE_KEY` / `SUPABASE_APP_SECRET` | 設了就把資料存 Supabase；不設就存本機 `data/` |

AI 模型用 `claude-opus-5-5`（effort: low），照片上傳前會縮到長邊 1600px 以節省費用。
