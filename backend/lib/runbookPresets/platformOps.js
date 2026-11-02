// SOP Runbook presets — SOMP 平台自身維運
const SEED_TIME = new Date().toISOString();

module.exports = [
    {
        id: 'sop-somp-health-restart',
        title: 'SOMP 服務健康檢查與重啟 SOP',
        component: 'Platform',
        tags: ['平台維運', '緊急應變', 'Windows'],
        content: `# SOMP 服務健康檢查與重啟 SOP

## 適用情境 / 觸發條件
- 使用者回報 SOMP 網頁無法開啟、API 回應逾時或畫面一直轉圈。
- 部署（Deploy_to_Prod.ps1）後服務未自動起來。
- 記憶體持續上升、疑似 Node.js 程序卡死。

## 影響與風險
重啟 \`somp-vanguard\` 服務會中斷所有使用者連線與背景排程（Scout 收集、備份、Workflow）數十秒。執行中的 Workflow 可能被中斷，重啟前請先確認沒有重要作業進行中。

## 處理步驟
1. 檢查 Windows 服務狀態（服務名稱 \`somp-vanguard\`，由 WinSW 管理）：
\`\`\`powershell
Get-Service somp-vanguard | Format-List Name,Status,StartType
\`\`\`
2. 檢查健康端點（預設連接埠 5000，若 backend\\.env 有設定 PORT 則以該值為準）：
\`\`\`powershell
Invoke-RestMethod http://localhost:5000/api/health
\`\`\`
正常會回傳版本號。無回應代表程序未啟動或卡死。
3. 確認連接埠是否有人監聽、是否被其他程序佔用：
\`\`\`powershell
Get-NetTCPConnection -LocalPort 5000 -State Listen | Select-Object LocalPort,OwningProcess
Get-Process -Id <OwningProcess>
\`\`\`
4. 檢視記憶體：服務以 \`node.exe --max-old-space-size=2048\` 啟動，堆積上限約 2GB。
\`\`\`powershell
Get-Process node | Select-Object Id,@{n='WS_MB';e={[int]($_.WorkingSet64/1MB)}},StartTime
\`\`\`
若長期接近上限，建議排程在離峰重啟並回報開發團隊。
5. 查看日誌：
   - 應用日誌（Web 與 Worker 全部輸出，格式 \`[時間] [Web|Worker] [INFO|WARN|ERROR] [模組] 訊息\`）：\`<DB_DATA_DIR>\\logs\\app_YYYY-MM-DD.log\`，每日一檔，隔天 06:00 壓縮移入 logs\\archive，保留 30 天。
   - 稽核日誌：\`<DB_DATA_DIR>\\logs\\auth_YYYY-MM-DD.log\`（DB_DATA_DIR 為 D:\\somp-vanguard，若無 D: 槽則為 C:\\ProgramData\\somp-vanguard）。
   - WinSW 日誌：位於 Program Files\\somp-vanguard 服務目錄（*.out.log / *.err.log / *.wrapper.log），只在程式還沒開始寫應用日誌前就失敗（啟動即崩潰）時需要看。
\`\`\`powershell
Get-ChildItem "<DB_DATA_DIR>\\logs" | Sort-Object LastWriteTime -Descending | Select-Object -First 3
Get-Content "<DB_DATA_DIR>\\logs\\app_$(Get-Date -Format yyyy-MM-dd).log" -Tail 50 -Wait
Select-String -Path "<DB_DATA_DIR>\\logs\\app_$(Get-Date -Format yyyy-MM-dd).log" -Pattern '\\[(WARN|ERROR)\\]' | Select-Object -Last 30
\`\`\`
6. ⚠️ 確認無關鍵作業後重啟（WinSW 設定失敗後 10 秒自動重啟，但手動重啟更可控）：
\`\`\`powershell
Restart-Service somp-vanguard
Start-Sleep 15
Get-Service somp-vanguard
\`\`\`

## 常見啟動失敗原因
| 現象 | 原因 | 處置 |
|---|---|---|
| 服務啟動後立即停止，日誌提示找不到 \`.system_key\` 或解密失敗 | 資料目錄錯誤，或金鑰檔遺失 | 確認 DB_DATA_DIR 正確；自備份還原 \`.system_key\`，詳見 sop-somp-secrets-key。不要隨意讓系統產生新金鑰，否則舊的 enc: 值全部無法解密 |
| EADDRINUSE（port in use） | 連接埠被舊 node 程序或其他軟體佔用 | 用步驟 3 找出 PID，確認非 SOMP 後再結束，或調整 PORT |
| Cannot find module '<套件名>' | 部署新版本但 prod 不會自動 npm install | 在 C:\\Program Files\\somp-vanguard\\backend 手動執行 \`npm install\`，再重啟服務 |
| 服務一直重啟循環 | 啟動即例外（設定錯誤、DB 檔被鎖） | 看 *.err.log 最後 50 行，依錯誤處理 |

## 驗證
- \`Get-Service\` 顯示 Running，\`/api/health\` 回傳預期版本。
- 瀏覽器登入 SOMP，Scout Monitor 有資料持續更新。
- 日誌無持續性 ERROR。

## 注意事項 / 升級處理
- 不要用工作管理員直接殺 node.exe 後放著不管，請透過 Restart-Service 讓 WinSW 管理。
- 重啟兩次仍失敗：保留 WinSW 日誌與 auth 日誌，聯絡平台維護者，不要重灌或刪除資料目錄。
- 遠端服務清單可用 Remote Command 的 p11（List Running Services）、p9（Disk Space Overview）輔助確認磁碟空間不足。

## 相關資源
- sop-somp-backup-restore、sop-somp-secrets-key、sop-somp-version-release-notes
- SOMP 選單：Remote Command、Audit log、System Settings
`,
        workflowId: null,
        commandIds: ['p11', 'p9'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-somp-backup-restore',
        title: 'SOMP 資料備份與還原 SOP',
        component: 'Platform',
        tags: ['平台維運', '備份還原', '例行維護'],
        content: `# SOMP 資料備份與還原 SOP

## 適用情境 / 觸發條件
- 例行備份檢查、變更前（版本升級、伺服器搬遷）手動備份。
- 資料毀損、誤刪設定、伺服器重建後需要還原。

## 需要備份的項目
資料目錄 DB_DATA_DIR（D:\somp-vanguard，若無 D: 槽則為 C:\ProgramData\somp-vanguard）：
- \`scout.sqlite\`：**最重要**。設定文件庫（RBAC、SOP Runbook、Workflow、各模組設定、Prometheus Target 等）以及 Scout 指標、告警、Windows 事件、Linux 日誌。
- \`database.sqlite\`：CMDB 主機表與早期文件資料。
- \`.system_key\`：主金鑰，**必備**；沒有它，.env 與 RBAC 內所有 enc: 值都無法解密。
- \`archives\\\`：冷日誌封存（.json.gz），可選。

應用目錄：
- \`C:\Program Files\somp-vanguard\backend\.env\`：系統設定（機密為 enc: 加密值）。

## 處理步驟
### A. 使用內建每日備份（優先）
1. 在 **System Settings** 的資料庫備份設定確認已啟用（\`DB_BACKUP_ENABLED\`）、執行時間（\`DB_BACKUP_SCAN_TIME\`，預設 03:00，伺服器本地時間）、備份路徑（\`DB_BACKUP_PATH\`，未設定時為 \`<DB_DATA_DIR>\config_backup\`）與保留天數（\`DB_BACKUP_RETENTION_DAYS\`，預設 30）。
   - 註：選單 **Backup & Restore** 是管理「外部資料庫」（DB Connection Hub 內的資料庫）的備份，與 SOMP 自身備份無關。
2. 內建備份每天產出以下檔案（日期為伺服器本地日期，另各有一份 \`*_latest\` 固定檔名）：
   - \`scout_backup_YYYY-MM-DD.sqlite\`、\`database_backup_YYYY-MM-DD.sqlite\`：以 SQLite 線上備份 API 產生（不需停機，包含尚在 WAL 中的最新資料），並經完整性檢查後才寫入。
   - \`system_key_backup.key\`、\`env_backup_YYYY-MM-DD.env\`。
   - 若使用外部資料庫引擎（PostgreSQL / MySQL / MSSQL），則改為 \`config_backup_YYYY-MM-DD.json\`（設定文件快照）。
3. 確認最近日期的檔案存在且大小合理：
\`\`\`powershell
Get-ChildItem "<備份路徑>" | Sort-Object LastWriteTime -Descending | Select-Object -First 8 Name,Length,LastWriteTime
\`\`\`
4. 到 **Audit log** 搜尋模組 \`Database Backup\`：成功為「Backup completed … scout.sqlite ✓ (xx MB) …」；任一項失敗會出現「Backup FAILED」並列出原因。
5. ⚠️ 備份資料夾同時含有金鑰與 .env，等同可解開所有機密：務必限制資料夾權限（僅 SYSTEM / Administrators / 服務帳號）；若備份路徑指向 NAS，NAS 端也要限制。建議另將 \`system_key_backup.key\` 存一份到公司密碼保險庫或離線媒體。
6. scout.sqlite 體積較大，請確認備份磁碟空間足夠（約 scout.sqlite 大小 × 保留天數），必要時調低保留天數。

### B. 手動備份（臨時、變更前）
⚠️ 不要在服務運行中直接複製 .sqlite 檔（WAL 模式下可能漏掉最近的資料）。請先停止服務：
\`\`\`powershell
Stop-Service somp-vanguard
$dst = "E:\backup\somp-$(Get-Date -Format yyyyMMdd)"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "<DB_DATA_DIR>\database.sqlite*","<DB_DATA_DIR>\scout.sqlite*","<DB_DATA_DIR>\.system_key" $dst
Copy-Item "C:\Program Files\somp-vanguard\backend\.env" $dst
Start-Service somp-vanguard
\`\`\`
（\`*.sqlite*\` 會一併複製 -wal / -shm 檔。）備份目的地請放在另一台主機或另一顆磁碟，並限制存取權限。

### C. 還原順序
1. 確認問題與還原範圍，先把現有（損壞）資料另存一份，不要直接覆蓋。
2. \`Stop-Service somp-vanguard\`。
3. 先還原 \`.system_key\`（\`system_key_backup.key\` 改名為 \`.system_key\`），再還原 \`.env\`，最後還原資料庫：\`scout_backup_*.sqlite\` → \`scout.sqlite\`、\`database_backup_*.sqlite\` → \`database.sqlite\`。還原資料庫前，先刪除（或移走）資料目錄中同名的 \`-wal\` 與 \`-shm\` 檔，避免舊的 WAL 套用到還原後的檔案。若 .system_key 與備份當時不同，enc: 值將無法解密。
4. \`Start-Service somp-vanguard\`，等待約 15 秒。

## 驗證
- \`Invoke-RestMethod http://localhost:5000/api/health\` 正常。
- 登入 SOMP，CMDB、Server List 資料筆數符合預期，System Settings 可正常載入。
- 到 Audit log 確認沒有解密失敗等錯誤。

## 注意事項 / 升級處理
- **定期還原演練**：至少每季在測試機還原一次並驗證，未驗證過的備份不算備份。
- 備份檔含加密金鑰與設定，視同機密，不可放在共用磁碟或寄送 email。
- 保留策略依容量自訂，可用 p9（Disk Space Overview）監控備份磁碟。
- 備份失敗或還原後資料異常：停止操作，保留現場並聯絡平台維護者。

## 相關資源
- sop-somp-secrets-key、sop-somp-health-restart
- SOMP 選單：Backup & Restore、System Settings、Audit log
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-somp-secrets-key',
        title: '.env 機密與系統金鑰管理 SOP',
        component: 'Platform',
        tags: ['平台維運', '資安審計', '備份還原'],
        content: `# .env 機密與系統金鑰管理 SOP

## 適用情境 / 觸發條件
- 需要修改密碼、API Key、Token 等機密設定。
- SOMP 搬遷到新伺服器、重建主機。
- 資安稽核詢問機密如何保護。
- 懷疑 \`.system_key\` 或 \`.env\` 外洩或遺失。

## 運作原理
- \`backend\\.env\` 中的敏感值以 \`enc:...\` 形式加密儲存；RBAC 設定檔 rbac.json 也是加密儲存。
- 解密用的主金鑰是資料目錄中的 \`.system_key\`（DB_DATA_DIR 為 D:\\somp-vanguard，若無 D: 槽則為 C:\\ProgramData\\somp-vanguard）。
- **遺失 \`.system_key\` 的後果**：所有 enc: 值（資料庫密碼、AD/SSH/API 憑證等）無法解密，需逐項重新輸入；rbac.json 解密失敗時系統會退回預設權限設定。
- 加密採 AES-CBC，**沒有完整性驗證**：被竄改的 enc: 值可能解出亂碼而不是報錯，所以不要手動編輯。

## 處理步驟
### 一、修改機密
1. 一律透過 SOMP 選單 **System Settings** 修改並儲存，系統會自動加密。
2. 不要用記事本直接改 .env 的 enc: 值，也不要自行貼入明文再期待系統處理。
3. 修改後檢查對應功能是否正常（例如測試連線按鈕）。

### 二、保護金鑰
1. 確認 \`.system_key\` 只有 SYSTEM、Administrators 與服務帳號可讀：
\`\`\`powershell
icacls "<DB_DATA_DIR>\\.system_key"
\`\`\`
2. 將 \`.system_key\` 備份到與資料備份**不同**的安全位置（例如公司密碼保險庫或離線媒體）。
3. 絕不把 .env、.system_key 貼到工單、聊天室、email 或 Git。

### 三、搬遷到新伺服器
1. 在舊機停止服務：\`Stop-Service somp-vanguard\`。
2. 複製 \`.system_key\`、\`database.sqlite\`、\`scout.sqlite\`、\`backend\\.env\` 到新機相同的資料目錄與應用目錄。
3. 新機務必**先放好 .system_key 再啟動服務**；若先啟動，系統可能產生新的金鑰，導致舊 enc: 值無法解密。
4. 啟動後依驗證步驟檢查。

### 四、懷疑外洩
1. 評估範圍（誰能存取過該檔案或備份）。
2. 逐項更換 System Settings 內的各種憑證與 API Key，並在對方系統端（AD、SSH 帳號、AI 服務等）撤銷舊值。
3. 如需更換金鑰本身，請聯絡平台維護者協助規劃，不要自行刪除 \`.system_key\`。

## 驗證
- \`Invoke-RestMethod http://localhost:5000/api/health\` 正常。
- System Settings 各分頁載入無錯誤，連線測試通過。
- 到 Audit log 確認設定變更紀錄，且沒有解密錯誤。

## 常見問題
- **Q：設定存檔後功能還是連不上？** 先用 System Settings 的測試按鈕確認；若出現解密相關錯誤，優先懷疑 \`.system_key\` 與 .env 不是同一組（例如只還原了其中一個）。
- **Q：能否把 .env 複製給同事做測試？** 不行。.env 內的 enc: 值只能被擁有相同 \`.system_key\` 的主機解密，且檔案本身仍屬機密，測試請在 System Settings 重新輸入測試用憑證。
- **Q：看到亂碼的設定值？** 可能是 enc: 值被竄改或金鑰不符（AES-CBC 無完整性驗證），請從備份還原 .env 與對應 \`.system_key\`。

## 例行稽核檢查表（每季）
- [ ] \`.system_key\` 已有離線備份，且上次還原演練成功。
- [ ] 資料目錄與備份目錄的 NTFS 權限僅限必要帳號。
- [ ] 離職或調動人員曾存取過伺服器時，評估是否需輪替 System Settings 內的憑證。
- [ ] RBAC 群組與 SuperAdmin 名單已複查，Audit log 無異常的設定變更。
- [ ] 沒有任何工單、聊天紀錄或文件含有 .env 內容或 API Key 明文。

## 注意事項 / 升級處理
- .env 絕對不分享；需要協助時只提供「去識別化」的設定項目名稱。
- 金鑰遺失且無備份：停止嘗試，聯絡平台維護者，準備逐項重設憑證。

## 相關資源
- sop-somp-backup-restore、sop-somp-health-restart
- SOMP 選單：System Settings、RBAC、Audit log
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-somp-version-release-notes',
        title: '版本號與 Release Notes 維護 SOP',
        component: 'Platform',
        tags: ['平台維運', '部署', '例行維護'],
        content: `# 版本號與 Release Notes 維護 SOP

## 適用情境 / 觸發條件
- 準備發佈新版 SOMP（功能、修補或文件更新）。
- 部署後發現畫面或 /api/health 顯示的版本號不一致。
- Release Notes 日期或內容需要核對。

## 處理步驟
### 一、在開發機更新版本號
1. 進入專案根目錄，使用 \`Update_Version\` 腳本並指定新版本號 x.y.z：
\`\`\`powershell
scripts\\Update_Version.bat 1.7.3
\`\`\`
2. 腳本會同步更新：backend 與 frontend 的 package.json、lock 檔、README、docs 的 html。系統執行時的版本號（\`/api/health\`、啟動通知、Open Scout API）一律讀取 \`backend/package.json\`，正式機 \`.env\` 裡的 VERSION 不再使用。
3. 只有次版本變更（例如 1.7 → 1.8）時，腳本才會把**今天的日期**寫入 docs 的 Release Notes 標題；修補版（1.7.x）保留原日期。不論哪種都**必須人工複查**：日期是否為實際發佈日、新增版本區塊的標題與說明是否完整，並補寫本次變更重點（新增、修正、已知問題、需手動 npm install 的套件）。

### 二、核對一致性
1. 搜尋舊版本號是否還有遺留：
\`\`\`powershell
Select-String -Path backend\\package.json,frontend\\package.json -Pattern '"version"'
\`\`\`
2. 確認 frontend 與 backend 版本號相同，README 與 docs 顯示的版本與日期正確。

### 三、測試與發佈
1. \`cd backend && npm test\`（全部通過）。
2. \`cd frontend && npm test && npm run build\`。
3. 執行 \`scripts\\SCP_to_Prod.bat\`，再於 prod 執行 \`scripts\\Deploy_to_Prod.ps1\`。測試失敗時不要用 \`-SkipTests\`，除非是緊急且已理解失敗原因。
4. 若本版新增 npm 套件，prod 不會自動安裝，需手動在 backend 執行 \`npm install\` 後重啟服務。

## 驗證
- 部署後檢查健康端點版本：
\`\`\`powershell
Invoke-RestMethod http://localhost:5000/api/health
\`\`\`
- 瀏覽器開啟 SOMP，確認介面版本與 Release Notes 相符；若仍顯示舊畫面，按 Ctrl+F5 一次。
- 後端程式有變更時，確認服務已重啟並為 Running。

## Release Notes 撰寫建議
- 每個版本至少包含：版本號、發佈日期、新增功能、修正項目、已知問題、升級注意事項。
- 升級注意事項要明確寫出：是否需要手動 npm install、是否需要重啟服務、是否需要使用者 Ctrl+F5。
- 僅前端變更時部署不需重啟服務（零停機），後端有變更時會重啟，請在 Release Notes 標註預期停機時間。
- 同一天多次發佈時，保持日期一致，並以版本號區分，避免日期被腳本覆寫後與實際不符。

## 回退（Rollback）提示
若新版上線後出現嚴重問題：先以備份確認可還原的版本，在 prod 以先前的 staging 內容重新執行 Deploy_to_Prod.ps1 或還原上一版程式檔，並記錄於 Release Notes 的已知問題；資料庫結構有變更時須搭配備份還原，請先評估再動手。

## 發佈前檢查表
- [ ] Update_Version 已執行，且各檔案版本號一致。
- [ ] docs Release Notes 日期、變更摘要已人工複查並補寫。
- [ ] backend npm test、frontend npm test 與 npm run build 全數通過。
- [ ] 本版是否新增 npm 套件？若是，已記錄於 Release Notes 並安排 prod 手動 npm install。
- [ ] 已先備份資料（database.sqlite、.env、.system_key）。
- [ ] 部署後以 /api/health 與瀏覽器雙重確認版本。

## 注意事項 / 升級處理
- 版本號只能透過 Update_Version 腳本修改，避免手動改漏檔案。
- 日期是腳本自動蓋上的，跨日或延後發佈時要手動修正。
- 版本不一致且無法判斷原因：先不要再次部署，保留現況並聯絡平台維護者。

## 相關資源
- sop-somp-health-restart、sop-somp-backup-restore
- 部署前建議先做備份，見 sop-somp-backup-restore
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
];
