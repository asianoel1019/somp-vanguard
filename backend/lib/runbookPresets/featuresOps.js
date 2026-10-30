// SOP Runbook presets — 功能操作與發佈流程
const SEED_TIME = new Date().toISOString();

module.exports = [
    {
        id: 'sop-ai-agent-setup',
        title: 'AI Ops Agent 啟用與設定 SOP',
        component: 'AI Ops Agent',
        tags: ['AI Agent', '平台維運', '新人教學'],
        content: `# AI Ops Agent 啟用與設定 SOP

## 適用情境 / 觸發條件
- 首次在 SOMP 啟用「AI Ops Agent」（告警調查助理，只讀）。
- 更換 AI 供應商、模型或 API Key 後需要重新驗證。
- 使用者反映看不到 🤖 按鈕或「🤖 調查」按鈕。

## 影響與風險
- Agent 為**只讀**：只會查詢主機指標、告警、日誌、CMDB 異動與 Runbook，不會執行任何指令。
- 工具輸出在送給模型前會遮罩密碼、Token、金鑰、連線字串與 .env 機密值，但仍建議使用公司核准的 AI 供應商。
- 每次提問都會寫入稽核紀錄。

## 處理步驟
1. 進入 **System Settings → AI Service**，確認「AI service enabled」已勾選，並設定供應商（OpenAI 相容 / Anthropic / Gemini）、模型與 API Key。
   - OpenAI 相容包含 OpenCode、OpenAI、DeepSeek、Azure、自訂端點，以及 Ollama（使用 /v1 路徑）。
2. 勾選「🤖 啟用 AI Ops Agent（告警調查助理，只讀）」。
3. （選用）填寫 **AGENT MODEL**：請選擇支援 tool calling 的模型；留空則使用上方的預設模型。
4. 設定「每人每小時提問上限」（預設 30，範圍 1–500），依團隊人數與費用預算調整。
5. 按 **Save AI Configuration**。
6. 按「🧪 測試 Agent 工具呼叫」，注意此測試使用的是**已儲存**的設定，所以務必先儲存。看到 ✅ 代表模型可正常呼叫工具。
7. 進入 **RBAC**：建立或編輯群組，勾選功能「🤖 AI Ops Agent」（key: aiAgent）。
   - 只要系統內存在任何 RBAC 群組，即使是 SuperAdmin 也必須隸屬於具備此功能的群組。
8. 通知使用者**重新登入或重新整理**頁面，權限與功能開關才會生效。
9. （選用）若希望提問紀錄推送到 Telegram / Webhook，需明確勾選「🤖 AI Agent 提問紀錄」（AIAgent）分類，預設不推送，詳見 sop-notification-categories。

## 反向代理注意事項
若 Node 後方有 IIS ARR 等反向代理：對 /api/agent/chat 關閉回應緩衝（buffering）與壓縮，並把逾時設為大於 180 秒；否則步驟會一次全部出現或串流被中斷。

## 驗證
- 使用者登入後，左側欄底部頭像旁出現 🤖 按鈕。
- Scout Monitor 的 Alerts 分頁與 Alerts & Rules 的作用中告警出現「🤖 調查」。
- 隨意提問（例如「列出目前的告警」），可即時看到 🔍 工具步驟與最終回答。

## 注意事項 / 升級處理
- API Key 由 System Settings 介面儲存並加密，請勿貼在工單、聊天或截圖中。
- 費用控管：每次調查約需 4–9 次模型呼叫，請依預算調整每人每小時提問上限。
- 若測試始終失敗，先確認端點網路可達（防火牆 / Proxy），再聯絡平台管理員。

## 相關資源
- sop-ai-agent-investigate：使用 AI Ops Agent 調查告警
- sop-ai-agent-troubleshoot：AI Ops Agent 疑難排解
- 選單：System Settings、RBAC、Audit log
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-ai-agent-investigate',
        title: '使用 AI Ops Agent 調查告警 SOP',
        component: 'AI Ops Agent',
        tags: ['AI Agent', '告警排障', '新人教學'],
        content: `# 使用 AI Ops Agent 調查告警 SOP

## 適用情境 / 觸發條件
- 收到 CPU、記憶體、磁碟、離線等告警，想快速整理「發生什麼事、為什麼、該怎麼辦」。
- 想比對告警前後的指標、日誌與 CMDB 異動。

## 影響與風險
- Agent 只讀，不會重啟服務、不會執行指令、不會修改設定。
- 回答由 AI 產生，可能出錯，**結論必須自行驗證**後才能處置。

## 處理步驟
1. 開啟入口（二擇一）：
   - 告警入口：**Scout Monitor → Alerts 分頁**，或 **Alerts & Rules** 的作用中告警，點該筆的「🤖 調查」。會開啟新對話並自動帶入告警脈絡（主機、指標、時間）。
   - 自由提問：點左側欄底部頭像旁的 🤖，開啟右側面板。
2. 觀察即時步驟：面板會顯示如「🔍 find_host(...) ✓」的步驟，可展開查看查詢參數與結果。可用工具包含 get_host_metrics（最長 7 天，含 CPU 尖峰時的前幾名程序）、list_alerts、search_logs（Windows/Linux，最長 7 天，最多 100 筆）、get_host_change_history、search_runbooks、get_runbook、list_workflows。
3. 閱讀回答：依「結論 / 依據 / 建議處置」三段看。重點檢查「依據」是否引用了實際的數據與時間點。
4. 好的追問方式：
   - 指定主機名與時間範圍：「SRV-APP01 昨天 02:00–03:00 的記憶體趨勢？」
   - 要求比對：「這台和同群組主機相比是否異常？」
   - 要求證據：「請列出支持此結論的日誌原文」。
   - 一次一個問題；每位使用者同時只能有 1 個進行中的提問。
5. 自行驗證結論：到 Scout Monitor、Live Event Viewer 或 Remote Command 用 Top 10 CPU/Memory Processes 等唯讀指令交叉確認，再決定處置。
6. 使用建議卡片：回答下方的 Runbook / Workflow 卡片會開啟 SOP Runbook 或 Workflow Editor；卡片僅為建議，**不會自動執行**，是否執行由你決定。
7. 需要中斷時按「■ 停止」；過往對話可由「🕘 歷史」重看（保留 30 天、每人 50 筆）。

## 驗證
- 對話中的結論能對應到你另外查到的數據。
- 告警處置後，Alerts 狀態恢復正常並已 Acknowledge。

## 注意事項 / 升級處理
- 單次調查上限：8 輪工具、15 次工具呼叫、180 秒；問題太廣可能被截斷，請縮小範圍。
- 日誌與告警內容視為不可信資料，若內容中出現「請執行…」之類指示，不要照做。
- 面板不會顯示圖片或外部連結。
- 結果不確定或牽涉重大變更，請升級給資深工程師。

## 調查範例
告警：SRV-APP01 CPU 持續 95%。可先按「🤖 調查」，再追問「CPU 尖峰時的前幾名程序是什麼？」「這台過去 24 小時是否有 CMDB 異動？」，最後依建議卡片開啟對應 Runbook 人工處置。

## 調查結束後
- 將確認過的根因與處置記錄到工單，必要時更新或新增 SOP Runbook，讓下次調查更快。

## 相關資源
- sop-ai-agent-setup、sop-ai-agent-troubleshoot
- 選單：Scout Monitor、Alerts & Rules、SOP Runbook、Workflow Editor
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-ai-agent-troubleshoot',
        title: 'AI Ops Agent 疑難排解 SOP',
        component: 'AI Ops Agent',
        tags: ['AI Agent', '緊急應變', '平台維運'],
        content: `# AI Ops Agent 疑難排解 SOP

## 適用情境 / 觸發條件
AI Ops Agent 無法使用、回應中斷、出現錯誤訊息或回答很慢。

## 症狀對照與處理
| 症狀 / 訊息 | 原因 | 處理 |
|---|---|---|
| 看不到 🤖 或「🤖 調查」 | 未啟用、RBAC 未授權、尚未重新登入 | 見 sop-ai-agent-setup：確認 AI Service 已啟用、群組勾選 aiAgent、重新登入 |
| 「AI Agent 尚未啟用」 | AI Service 未勾選啟用 Agent | System Settings → AI Service 勾選並 Save |
| 「目前選擇的模型不支援工具呼叫…」 | 模型沒有 tool calling | 在 AGENT MODEL 改選支援工具呼叫的模型，儲存後按「🧪 測試 Agent 工具呼叫」 |
| 「⏳ AI 服務請求次數已達上限，N 秒後自動重試（第 x/3 次）…」 | 供應商回 HTTP 429/503/529 | 無需處理：Agent 依供應商指示等待並重試，最多 3 次、每次最長 60 秒，且受 180 秒總期限限制 |
| 「已達今日請求額度」 | 供應商每日配額用完 | 不會重試；等待配額重置或升級方案、更換 API Key |
| HTTP 409「你已有一個 AI Agent 查詢正在進行中」 | 同一使用者同時送出多個提問 | 等上一個完成或按「■ 停止」，再重新提問 |
| HTTP 429（提問次數） | 超過每人每小時提問上限 | 稍後再問，或由管理員調高上限（1–500） |
| 180 秒逾時 | 問題過廣、模型太慢 | 縮小主機與時間範圍後重問 |
| 步驟一次全部跳出，或串流中途被切斷 | 反向代理緩衝 / 逾時 | 對 /api/agent/chat 關閉 buffering 與壓縮，逾時設為大於 180 秒 |

## 處理步驟
1. 先到 System Settings → AI Service 按「🧪 測試 Agent 工具呼叫」（測的是已儲存設定）。失敗時依訊息檢查 API Key、端點、模型名稱。
2. **Gemini 免費層**：約每模型 5 次請求/分鐘，而一次調查需 4–9 次模型呼叫，因此很容易觸發 429 而變慢或失敗。正式使用請改付費方案。
3. 若反向代理後方行為異常，先直連 Node 服務（不經代理）比較；若直連正常即為代理設定問題。SSE 每 15 秒會送出心跳，代理的 idle timeout 需大於此值。
4. 查看日誌：到 **Audit log** 搜尋 AI Agent 相關提問紀錄；伺服器端的詳細錯誤在資料目錄的 logs\\auth_YYYY-MM-DD.log（D:\\somp-vanguard 或 C:\\ProgramData\\somp-vanguard）。
5. 修改設定後，記得 Save 再測試，並請使用者重新整理頁面。

## 驗證
- 「🧪 測試 Agent 工具呼叫」顯示 ✅。
- 使用者可完整跑完一次調查並收到「結論 / 依據 / 建議處置」。

## 注意事項 / 升級處理
- 不要在工單或聊天中貼出 API Key 或 .env 內容。
- 供應商端服務中斷時，無法在 SOMP 端修復，請改用傳統流程（Scout Monitor、Live Event Viewer）。

## 相關資源
- sop-ai-agent-setup、sop-ai-agent-investigate
- 選單：System Settings、RBAC、Audit log
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-workflow-approval',
        title: 'Workflow 人工核准節點 (Manual Approval) 設計與審核 SOP',
        component: 'Workflow Editor',
        tags: ['流程自動化', '自動化', '平台維運'],
        content: `# Workflow 人工核准節點 (Manual Approval) 設計與審核 SOP

## 適用情境 / 觸發條件
- 自動化流程中含有高風險動作（重啟服務、刪除資料、變更正式環境），需要人工確認後才繼續。
- 需要有核准者與核准備註的稽核軌跡。

## 設計步驟（Workflow Editor）
1. 開啟 **Workflow Editor**，在高風險節點之前加入「Manual Approval」節點。
2. 填寫「Approval Message」，可使用 {{VAR}} 變數，讓審核者看到足夠資訊。範例：
\`\`\`
即將重啟 {{TARGET_HOST}} 上的服務 {{SERVICE_NAME}}，請確認已通知相關人員。
\`\`\`
3. 把需要核准才能執行的節點連接在核准節點之後；核准前的查詢類節點（例如先確認狀態）可放在核准之前，讓審核者有依據。
4. 儲存並執行，確認執行時進入等待狀態。

## 執行與審核流程
1. 流程跑到核准節點時暫停，狀態為 WAITING_APPROVAL，並透過 Telegram 通知（屬於 Workflow 通知分類，請確認該分類已啟用）。
2. **任一位 SuperAdmin** 到該 Workflow 的 Execution Logs 開啟該次執行：
   - ✅ Approve：流程從核准節點之後繼續，**之前的節點不會重跑**。
   - ⛔ Reject：其餘節點全部 SKIPPED，執行狀態為 REJECTED。
   - 可附上選填的備註（建議一律填寫原因）。
3. 核准或拒絕後，可在 Execution Logs 看到逐節點狀態：SUCCESS / FAILED / SKIPPED / PENDING / AWAITING APPROVAL / REJECTED。

## 驗證
- 核准後後續節點狀態變為 SUCCESS，整體執行完成。
- 拒絕後後續節點為 SKIPPED，整體為 REJECTED。
- Audit log 有對應的操作紀錄。

## 注意事項
- 核准節點**沒有逾時機制**：未處理的執行會一直等待，需有人定期巡檢；等待中的執行不會被歷史清理（歷史保留 200 筆）。
- 核准者必須是 SuperAdmin，請確保輪值人員具備此角色且能收到 Telegram 通知。
- Approval Message 不要放密碼或金鑰。
- 核准者應檢視變數內容（目標主機、參數），而不是只看訊息就按核准。

## 設計建議
- 一個 Workflow 的高風險動作可分段設置多個核准節點，每段都寫清楚「要做什麼、影響誰」。
- 核准節點之後建議接 Telegram 通知節點，回報執行結果。
- 正式上線前，先用測試主機完整跑過「核准」與「拒絕」兩條路徑。

## 升級處理
- 等待超過預期時間仍無人核准：直接聯絡輪值 SuperAdmin，或到 Execution Logs 以 Reject 結束該次執行，避免長期懸置。
- 誤核准造成影響：立即依對應 Runbook 處置，並在 Audit log 與工單中記錄經過。
- 審核者不確定風險時，應拒絕並要求補充資訊，而不是勉強核准。

## 常見問題
- 沒收到 Telegram 通知：確認 Workflow 分類已啟用，並直接到 Execution Logs 查看等待中的執行。
- 核准後流程沒有繼續：檢查後續節點的狀態與錯誤訊息；核准只會讓流程從核准節點之後繼續。

## 相關資源
- sop-workflow-condition-script：條件判斷語法與 Script 節點
- 選單：Workflow Editor、System Settings（Telegram 通知分類）、Audit log
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-workflow-condition-script',
        title: 'Workflow 條件判斷語法與 Script 節點沙箱 SOP',
        component: 'Workflow Editor',
        tags: ['流程自動化', '自動化', '新人教學'],
        content: `# Workflow 條件判斷語法與 Script 節點沙箱 SOP

## 適用情境 / 觸發條件
- 在 Workflow Editor 設計 Condition 分支、或用 JS Script 節點處理資料。
- Condition 節點失敗、Script 節點逾時或回傳異常。

## 一、可用的 Context
- \`ctx.<nodeId>.stdout\`、\`ctx.<nodeId>.exitCode\`、\`ctx.<nodeId>.status\`、\`ctx.<nodeId>.body\`（HTTP 節點）
- Script 節點的回傳值：\`ctx.<nodeId>.result\`
- 舊寫法 \`ctx["node_1.stdout"]\` 仍可使用。
- 欄位內可用 {{VAR}} 變數替換。

## 二、Condition 語法（安全子集，不是完整 JS）
支援：比較運算、&& || !、算術、三元 a ? b : c；函式 parseInt、parseFloat、Number、String、Boolean、isNaN、isFinite；Math.abs/max/min/round/floor/ceil；字串 includes、startsWith、endsWith、indexOf、lastIndexOf、toLowerCase、toUpperCase、trim、trimStart、trimEnd、split、slice、substring、charAt、.length；陣列 includes、indexOf、lastIndexOf、join、slice；數字 toFixed。
範例：
\`\`\`
ctx.node_1.exitCode === 0 && ctx.node_1.stdout.includes("OK")
parseInt(ctx.node_2.stdout.trim()) > 80
\`\`\`
**不支援**其他語法（例如自訂函式、迴圈、正規表達式方法）。

## 三、執行語意
1. 表達式有錯（打錯字、引用到不存在的節點資料）時，Condition 節點**會失敗**，不會當成 FALSE 走另一條分支。
2. 只執行被選中的分支，另一分支及其下游節點為 SKIPPED。
3. 節點失敗時，其下游節點 SKIPPED，不相依的分支仍會執行，最後整體狀態為 FAILED。

## 四、JS Script 節點沙箱
- 僅 SuperAdmin 可觸發。
- 在隔離的子行程執行（Node 權限模型）：**無檔案系統、無子行程、無 worker、環境變數為空**。
- 逾時 5 秒；支援 await。
- console.log 輸出到 STDOUT；回傳值與 ctx 必須可序列化為 JSON（Date 轉為 ISO 字串、函式會被丟棄）。
- 無法修改 EXECUTION_ID、TRIGGERED_BY、TRIGGER_USER_ROLE。
範例：
\`\`\`
const lines = ctx.node_1.stdout.split("\\n").filter(l => l.trim());
console.log("rows=" + lines.length);
return { count: lines.length };
\`\`\`

## 驗證
- 在 Execution Logs 檢查各節點狀態（SUCCESS / FAILED / SKIPPED）與輸出，確認走了預期分支。
- 先用「會成立」與「不成立」兩組資料各測一次。

## 注意事項 / 疑難排解
- Condition 失敗：檢查節點 ID 拼寫、該節點是否已執行並有輸出、是否用了不支援的語法。
- Script 逾時：避免大量運算或等待外部資源，改用 HTTP/SSH 節點取得資料。
- 需要讀寫檔案或呼叫系統指令時，請改用 PowerShell / SSH 節點。

## 相關資源
- sop-workflow-approval
- 選單：Workflow Editor
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-release-deploy',
        title: '版本發佈與部署流程 SOP',
        component: 'Platform',
        tags: ['部署', '平台維運', '例行維護'],
        content: `# 版本發佈與部署流程 SOP

## 適用情境 / 觸發條件
將 SOMP Vanguard 新版本由開發機發佈到正式環境（Windows 服務 somp-vanguard）。

## 影響與風險
- 後端檔案有變更時會停止並重啟服務，期間 API 短暫中斷；僅前端變更則零停機。
- 正式環境**不會自動執行 npm install**。

## 處理步驟（開發機）
1. 更新版本號：
\`\`\`powershell
scripts\\Update_Version.bat 1.7.3
\`\`\`
   會更新 backend/frontend 的 package.json、lock 檔、README 與 docs（系統執行時的版本號一律讀取 backend/package.json，正式機 .env 的 VERSION 不再使用）；只有次版本變更（例如 1.7 → 1.8）才會把今天日期寫入 docs 發佈說明標題，**請事後檢閱並補上本版卡片**。
2. 執行測試與建置（全部必須通過）：
\`\`\`powershell
cd backend; npm test
cd ..\\frontend; npm test; npm run build
\`\`\`
3. 傳送到正式機：
\`\`\`powershell
scripts\\SCP_to_Prod.bat
# 可選：-Since "YYYY-MM-DD" 或 -All
\`\`\`
   此腳本會先跑後端測試，並檢查 frontend\\dist 比 frontend\\src 新，否則中止；排除 node_modules、.env、tests、dist_backup*、docs\\superpowers；完成後記錄 .last_scp_sync。檔案先放在正式機 C:\\somp-staging。

## 處理步驟（正式機）
4. 部署前先備份，見 sop-deploy-rollback。
5. 執行部署：
\`\`\`powershell
scripts\\Deploy_to_Prod.ps1
\`\`\`
   會把 C:\\somp-staging 複製到 C:\\Program Files\\somp-vanguard；後端有變更才重啟 somp-vanguard 服務。
6. 若有新增 npm 套件，需在正式機手動執行 npm install（於 backend 目錄），再重啟服務。

## 驗證
\`\`\`powershell
Invoke-RestMethod http://localhost:5000/api/health
Get-Service somp-vanguard
\`\`\`
- /api/health 回傳的版本等於剛發佈的版本，服務狀態為 Running。
- 瀏覽器 Ctrl+F5 後登入，抽查主要頁面；前端若沒更新見 sop-frontend-stale-cache。
- 可用 Remote Command 的「Check System Uptime」「List Running Services」協助確認主機狀態。

## 注意事項 / 升級處理
- 測試失敗時**不要使用 -SkipTests / -SkipBuildCheck**，除非是緊急情況且已了解失敗原因。
- 勿發佈 .env；機密設定一律由 System Settings 介面維護。
- 部署失敗或服務起不來，立即依 sop-deploy-rollback 回滾。

## 發佈前檢查清單
- [ ] 版本號已更新且 docs 發佈說明已檢閱
- [ ] 後端、前端測試全部通過，npm run build 成功
- [ ] 已備份正式環境目錄（sop-deploy-rollback）
- [ ] 已通知使用者可能的短暫中斷（後端變更時）
- [ ] 發佈後完成 /api/health 與頁面抽查

## 相關資源
- sop-deploy-rollback、sop-frontend-stale-cache、sop-backend-tests
`,
        workflowId: null,
        commandIds: ['p1', 'p11'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-deploy-rollback',
        title: '部署失敗回滾 SOP',
        component: 'Platform',
        tags: ['部署', '緊急應變', '備份還原'],
        content: `# 部署失敗回滾 SOP

## 適用情境 / 觸發條件
- 部署後服務 somp-vanguard 無法啟動、反覆重啟，或 /api/health 無回應。
- 新版本出現重大功能錯誤，需回到前一版。

## 影響與風險
- 回滾期間服務會短暫中斷。
- 回滾只還原程式檔；資料（database.sqlite、scout.sqlite）與 .system_key 位於資料目錄，不應被覆蓋。⚠️ 切勿動 .system_key，遺失會導致所有 enc: 機密無法解密。

## 事前準備（每次部署前）
\`\`\`powershell
$ts = Get-Date -Format yyyyMMdd_HHmmss
robocopy "C:\\Program Files\\somp-vanguard" "C:\\somp-backup\\$ts" /E /XD node_modules
\`\`\`
node_modules 可排除以節省空間；若本次有 npm install，請另記錄前一版 package-lock.json（已含在備份中）。

## 處理步驟
1. 確認症狀：
\`\`\`powershell
Get-Service somp-vanguard
Invoke-RestMethod http://localhost:5000/api/health
\`\`\`
   並到資料目錄 logs\\auth_YYYY-MM-DD.log 與 WinSW 日誌查看錯誤。
2. 停止服務：
\`\`\`powershell
Stop-Service somp-vanguard
\`\`\`
3. ⚠️ 還原檔案（請確認備份資料夾名稱正確）：
\`\`\`powershell
robocopy "C:\\somp-backup\\<備份時間>" "C:\\Program Files\\somp-vanguard" /E /XD node_modules
\`\`\`
   不要使用 /MIR，以免刪掉 node_modules 與正式環境專屬檔案（如 .env）。
4. 若新版本曾新增 npm 套件並已執行 npm install，回滾後的舊版通常仍可運作；若舊版的 package.json 相依有變，請在 backend 目錄重新執行 npm install。
5. 啟動服務：
\`\`\`powershell
Start-Service somp-vanguard
\`\`\`

## 驗證
- Get-Service 顯示 Running，/api/health 回傳**舊版本號**。
- 登入 SOMP，抽查 Scout Monitor、Alerts & Rules 等主要頁面；瀏覽器 Ctrl+F5。
- Audit log 無持續性錯誤。

## 注意事項 / 升級處理
- 服務設定為失敗後 10 秒自動重啟，反覆重啟代表程式啟動即錯，應回滾而非等待。
- 回滾後請記錄失敗原因、修正後走完整測試再重新發佈（sop-release-deploy）。
- 若懷疑資料損毀，另行使用 Backup & Restore 的備份還原，並先通知主管。

## 回滾決策準則
- 服務無法啟動、/api/health 無回應超過 5 分鐘：立即回滾。
- 僅單一功能異常且有暫時繞過方式：可評估熱修，但需主管同意。
- 資料相關問題：不要只回滾程式，先停止寫入並諮詢資深工程師。

## 相關資源
- sop-release-deploy、sop-frontend-stale-cache
- 選單：Backup & Restore、Audit log
`,
        workflowId: null,
        commandIds: ['p11'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-frontend-stale-cache',
        title: '部署後前端畫面未更新 SOP',
        component: 'Platform',
        tags: ['部署', '告警排障', '平台維運'],
        content: `# 部署後前端畫面未更新 SOP

## 適用情境 / 觸發條件
- 部署後使用者仍看到舊畫面或舊行為（新功能沒出現、舊 bug 仍在）。
- 部分使用者正常、部分使用者不正常（典型快取問題）。

## 事件教訓（DNS Hub）
曾發生部署後 DNS Hub 刪除記錄時主機名稱在「-」處被截斷：後端已修正，但使用者瀏覽器仍快取舊的 index.html，載入舊的 JS，因而持續出現舊行為。使用者按 Ctrl+F5 即恢復正常。教訓：**部署後遇到「已修正卻仍重現」，先確認使用者載入的是不是新版前端**，再懷疑程式。

## 目前機制
- index.html 以 \`Cache-Control: no-cache\` 提供，瀏覽器每次會向伺服器驗證。
- /assets/ 下含雜湊的檔案（如 index-<hash>.js）標為 immutable，快取一年；內容改變時檔名雜湊也會變。
- 因此新版部署後通常不需要手動處理；唯有使用者的瀏覽器仍快取「舊版 index.html」（在此機制啟用之前載入）時，需要 Ctrl+F5 一次。

## 處理步驟
1. 請使用者按 **Ctrl+F5** 強制重新整理（或清除該網站快取），再重現問題。
2. 驗證瀏覽器載入的版本：按 F12 → Network（或 Sources），找到 \`index-<hash>.js\` 的檔名。
3. 與伺服器比對：
\`\`\`powershell
Get-ChildItem "C:\\Program Files\\somp-vanguard\\frontend\\dist\\assets" -Filter "index-*.js"
\`\`\`
   - 兩者雜湊相同：瀏覽器載入的就是最新版，問題在程式邏輯，請回報開發。
   - 雜湊不同：瀏覽器仍快取舊版，重複步驟 1；若仍舊，檢查是否有反向代理 / CDN 快取 index.html。
4. 若伺服器上的 dist 本身就是舊的：代表部署未包含前端建置，請回到 sop-release-deploy，確認 npm run build 已執行、frontend\\dist 已被 SCP_to_Prod 傳送並由 Deploy_to_Prod.ps1 複製。

## 驗證
- Network 面板中 index.html 回應標頭含 Cache-Control: no-cache。
- 載入的 index-<hash>.js 與伺服器 dist 相同，且功能行為符合新版。
- 也可用 /api/health 確認後端版本是否與預期一致。

## 注意事項
- 不要要求所有使用者清除全部瀏覽器資料；一次 Ctrl+F5 即可。
- 公告新版時可順帶提醒使用者重新整理。
- 若反向代理額外快取了 index.html，應關閉對 index.html 的快取。

## 常見誤判
- 把快取問題當成程式 bug，重複改程式卻沒有重新驗證載入版本。
- 只在自己電腦驗證（已清過快取），沒發現其他使用者仍是舊版。
- 用無痕視窗測試可快速判斷是否為快取問題。

## 升級處理
若 Ctrl+F5 後雜湊仍與伺服器不同、且已排除代理快取，請通知平台管理員檢查 frontenddist 與部署紀錄，必要時重新執行 Deploy_to_Prod.ps1。

## 預防
發佈完成後，由發佈者自行以另一個瀏覽器或無痕視窗登入，確認新版畫面與行為，再宣告發佈完成。

## 相關資源
- sop-release-deploy、sop-deploy-rollback
- 選單：DNS Hub（事件案例）
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-notification-categories',
        title: 'Telegram / Webhook 通知分類設定 SOP',
        component: 'Platform',
        tags: ['平台維運', '例行維護', 'AI Agent'],
        content: `# Telegram / Webhook 通知分類設定 SOP

## 適用情境 / 觸發條件
- 通知太多（吵）或收不到特定類型通知。
- 新增 Webhook / Telegram 群組，需要決定各自接收哪些類型。
- 要讓 AI Agent 提問紀錄也推送出去。

## 通知分類一覽
| 分類 | 內容 |
|---|---|
| AuditLogs | 系統操作稽核 |
| AuthSecurity | 登入 / 帳號鎖定 |
| ScoutMonitor | 主機效能與上下線 |
| SSLMonitor | 憑證到期 |
| Inventory | 資產盤點 |
| Prometheus | Prometheus 相關 |
| Workflow | Workflow 執行（含人工核准等待通知） |
| GeneralLogs | 一般日誌 |
| AIAgent | 🤖 AI Agent 提問紀錄（**opt-in**） |

## 處理步驟
1. 進入 **System Settings**，找到「Telegram 通知分類」，勾選要推送到 Telegram 的分類後儲存。
   - 對應環境鍵 TELEGRAM_ENABLED_LOGS（逗號分隔清單）；**未設定時＝推送所有分類，但不含 opt-in 的 AIAgent**。
2. 每個 Webhook 可在其設定中獨立選擇分類：
   - 有儲存分類清單：只收清單內分類。
   - 沒有儲存清單：收到所有分類，同樣**不含 AIAgent**。
3. 若要推送 AI Agent 提問紀錄，必須在 Telegram 或該 Webhook 的分類中**明確勾選**「🤖 AI Agent 提問紀錄」（AIAgent）。預設不推送，是為了避免提問內容外流到非預期的頻道。
4. 建議配置：
   - 值班群組：ScoutMonitor、SSLMonitor、Workflow、AuthSecurity。
   - 資安 / 稽核群組：AuditLogs、AuthSecurity。
   - 對外整合 Webhook：僅勾選整合方需要的分類。

## 驗證
- 觸發一個該分類的事件（例如登入失敗 → AuthSecurity，或執行 Workflow），確認對應群組有收到、其他群組沒有。
- 未勾選 AIAgent 時，向 AI Agent 提問不應產生推送。

## 注意事項
- 若啟用 Workflow 分類，Manual Approval 的等待通知才會送到 Telegram，否則核准者可能沒收到通知。
- AI Agent 提問可能包含主機名稱、告警細節，推送前請確認接收方有權限閱讀。
- Webhook URL 與 Telegram Token 屬機密，不要貼在工單或聊天；一律透過 System Settings 介面設定。

## 常見問題
- 收不到通知：先確認該分類已勾選，再確認 Telegram Bot / Webhook 本身連線正常。
- 通知過多：取消 GeneralLogs 與 AuditLogs 這類量大的分類，保留 ScoutMonitor 與 AuthSecurity。
- 變更分類後請以實際事件測試，不要只看設定畫面。

## 變更紀錄建議
每次調整分類後，請在工單記錄「調整對象（Telegram 或哪個 Webhook）、新增或移除的分類、原因」，方便日後追溯通知行為改變的原因。

## 相關資源
- sop-ai-agent-setup、sop-workflow-approval
- 選單：System Settings、Audit log
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-backend-tests',
        title: '後端自動化測試執行與判讀 SOP',
        component: 'Platform',
        tags: ['部署', '平台維運', '例行維護'],
        content: `# 後端自動化測試執行與判讀 SOP

## 適用情境 / 觸發條件
- 發佈前驗證（sop-release-deploy 步驟 2）。
- SCP_to_Prod.bat 因測試失敗而中止。
- 修改後端程式後的回歸檢查。

## 影響與風險
- 測試使用暫存資料目錄，**不會碰正式資料**；仍請在開發機執行，不要在正式機跑測試。

## 處理步驟
1. 後端測試（精簡摘要）：
\`\`\`powershell
cd backend
npm test
\`\`\`
2. 需要完整輸出時：
\`\`\`powershell
npm run test:verbose
\`\`\`
3. 檢視涵蓋率：
\`\`\`powershell
npm run test:coverage
\`\`\`
4. 前端純函式測試與建置：
\`\`\`powershell
cd ..\\frontend
npm test
npm run build
\`\`\`

## 判讀結果
- 全部 pass，且 fail 為 0：可繼續發佈。
- 標記為 **todo** 的測試是已知問題，不會讓整體失敗，也不算通過；請不要因此誤判為已修好，應追蹤在待辦中。
- 有 fail：先用 test:verbose 找出失敗的測試檔與斷言訊息，區分是「程式回歸」「測試環境問題」或「不穩定測試」。

## 不穩定測試 (flaky) 處理
1. 重跑一次或單獨執行該測試檔，觀察是否可重現：
\`\`\`powershell
node --test test/<子目錄>/<檔名>.test.js
\`\`\`
2. 時而通過時而失敗，通常與時間、隨機值、檔案鎖定或並行有關。曾有加解密相關測試不穩定而擋住 SCP_to_Prod，最後以修正測試根因解決。
3. 不要靠反覆重跑直到通過；找出根因並修正測試或程式。

## -SkipTests 政策
- SCP_to_Prod.bat 的 -SkipTests / -SkipBuildCheck 只供**緊急**使用，且必須已了解失敗原因、確認與本次修改無關，並事後補修。
- 一般發佈一律不得跳過。

## 驗證
- 最終摘要顯示所有測試通過；frontend npm test 與 npm run build 無錯誤。

## 注意事項
- 修改加解密、RBAC、Workflow 相關程式時，務必檢查相關測試是否有新增或調整。
- 測試新增請放在 backend 的 tests 目錄並維持獨立、不依賴外部服務。

## 失敗排查順序
1. 確認是否為本次修改造成（比較修改前是否通過）。
2. 檢查 Node 版本（需 Node.js 24）與 npm install 是否完整。
3. 查看失敗斷言的實際值與預期值，再回頭讀對應程式。
4. 修正後重跑完整 npm test，不要只跑單一檔案就收工。

## 發佈前最終確認
正式執行 SCP_to_Prod.bat 時，腳本會再跑一次後端測試；因此發佈前先於本機跑過可節省中止後重來的時間。測試通過只代表自動化範圍內沒有回歸，仍需於發佈後做 /api/health 與主要頁面抽查。

## 測試失敗時的升級
若無法在合理時間內判斷失敗原因，請停止發佈，將 test:verbose 的輸出附在工單中交給開發負責人，不要自行跳過。

## 本機環境需求
- Node.js 24、已在 backend 與 frontend 各執行過 npm install。
- 測試不需要網路上的正式服務，也不需要 .env 內的真實金鑰。

## 相關資源
- sop-release-deploy、sop-deploy-rollback
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-alert-quality',
        title: '告警品質設定與上線檢查 SOP',
        component: 'Alerts & Rules',
        tags: ['告警排障', '例行維護', '即時監控'],
        content: `# 告警品質設定與上線檢查 SOP

## 適用情境 / 觸發條件
- 新版本部署前後的告警上線檢查（指標 / 日誌告警自此版本起才真正生效，預期會出現新告警）。
- 計畫性維護前建立維護時段，避免誤報。
- 告警太吵（抖動、洪水）或未處理告警需要升級通知。

## 事前準備
- 需 Operator / SuperAdmin 權限；升級目的地與總開關僅 SuperAdmin 可修改。
- 先確認 Telegram 群組、Email 或 Webhook 已可正常收訊，再啟用升級目的地。
- 背景：過去指標（cpu / memory / disk / ping / tcp / service / process）與日誌（winevent / syslog）告警因 web 程序未載入評估器而從未評估，只有離線告警有效；本版起全部生效，標籤綁定的指標規則也會比對，部署後出現新告警屬預期。

## 上線前預估與部署
1. 部署前於伺服器執行 scripts\\Alert_Preview.bat（唯讀，不寫入、不通知）；部署後可改用 Alerts & Rules → Alert Rules 的「🔍 Preview Alerts」。
2. 預估只看每台啟用主機的最新指標、略過超過 10 分鐘未更新的主機（列為 stale）、僅限指標規則；日誌與離線規則無法預估。
3. 預計觸發數量過多時先調整門檻或綁定，再部署。實際觸發需連續達到 alertHits 次。
4. 部署後第一小時觀察 Audit log 與 Telegram；啟動時殘留的 alerting 狀態會靜默重設（不會有假恢復通知）。
5. 部署後超過 7 天的已恢復告警會由 worker 分批清除（啟動 2 分鐘後首次執行，之後每小時），舊歷史消失屬預期。
6. 太吵時：Alerts & Rules → ⚙️ Alert Settings → 關閉「Alert evaluation (master switch)」（web 程序立即、worker 最多 30 秒），調整門檻後再開啟。

## 建立維護時段
1. Alerts & Rules → 🔧 Maintenance Windows → + New Maintenance Window。類型：單次（起訖時間）或每週（星期、起始時間、持續分鐘，使用伺服器本地時間，可跨午夜）。
2. 範圍：全部 / 指定主機 / Tag / 環境；可限定規則（空白 = 範圍內所有規則含離線）。
3. 維護期間告警照常記錄並標示 🔕，只是不通知；結束後若仍異常會補送「🔧 維護結束後仍異常」。
4. 臨時處理可在告警列按「🔕 Mute」選 1 h / 4 h / 24 h。

## 升級設定
1. 規則設定「Escalate if unresolved for N minutes (blank = never)」（空白 = 不升級）。
2. 目的地於 Alerts & Rules → ⚙️ Alert Settings（Escalation destinations：Telegram 群組 / Email / Webhook，可各自啟用），所有人可檢視，僅 SuperAdmin 可修改。
3. 規則：只升級一次；僅限存在時間介於 N 分鐘與 N 分鐘 + 24 小時、且主機啟用的告警；維護或抖動中不升級；每分鐘最多 10 則加 1 則摘要。Telegram 升級不受通知分類限制。

## 抖動與摘要通知判讀
- 〰️ 不穩定：短時間內狀態反覆切換，暫停觸發 / 恢復通知，穩定後送 1 則恢復穩定通知。
- 📦 告警摘要：每分鐘通知超過速率上限（預設 10）時，多出的合併成 1 則（最多 20 行）。
- 告警列標記：🔕 維護中、〰️ 不穩定、⏱ 冷卻中（不重複通知）、📦 已合併（已併入摘要通知）、⏫ 已升級、×N 日誌告警重複命中次數。
- Dashboard 即時報告對每台主機 15 秒更新一次屬正常節流。

## 驗證
- 預估結果與實際新增告警相符；維護時段內無通知；摘要與升級通知符合預期。

## 注意事項 / 升級處理
- 異常無法判斷時先關閉總開關再處理，不需重啟服務。
- 相關：sop-notification-categories、sop-release-deploy
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inventory-scan-troubleshoot',
        title: 'Server Inventory 掃描失敗或卡住 SOP',
        component: 'Server Inventory',
        tags: ['盤點', '排障', 'Worker'],
        content: `# Server Inventory 掃描失敗或卡住 SOP

## 適用情境 / 觸發條件
- Server Inventory 的掃描一直顯示 Running、進度不動，或排程時間到了沒有執行。
- 立即掃描（Scan Now）回應 503，或主機清單長時間沒有更新。
- 主機列出現紅色警告圖示（specsError），例如 WinRM timed out、SSH 逾時。

## 事前準備
- 需 Operator / SuperAdmin 權限。掃描只在背景 Worker 程序執行，Web 程序不會掃描；Worker 沒有啟動時，立即掃描會回 503。
- 確認 Worker 服務為 Running（Windows 服務或 ENABLE_EMBEDDED_WORKER 設定）。

## 處理步驟
1. 開啟 Server Inventory，查看掃描狀態：進度、目前網段、下次排程時間（nextRunAt）。掃描狀態超過 6 小時未更新時，系統視為已中斷，可直接重新掃描。
2. 若顯示卡住：按 Abort 中止，等待狀態變為已中止後再按 Scan Now。也可以只重掃單一網段或單一 IP（主機列的 Retry）。
3. 回應 503：確認 Worker 程序存活，必要時重啟 SOMP Worker 服務；Worker 啟動時會自動補跑 6 小時內錯過的排程。
4. 單一主機失敗：查看紅色圖示的原因。WinRM 逾時 60 秒、SSH 逾時 30 秒；通常為防火牆、5985/5986/22 埠未開或憑證錯誤。
5. 認為整個網段異常時，先看 Scan History 該次掃描是否標示 DEGRADED（見 sop-inventory-subnet-outage）。
6. 排程沒跑：於 Settings 檢查排程設定（每日 / 每週 / cron）與 Enabled，儲存設定後 Worker 會自動重新載入排程。

## 驗證
- Scan History 出現新的一筆掃描且 Running 狀態結束；主機的 Last Seen 更新。
- 下次排程時間 nextRunAt 合理。

## 注意事項 / 升級處理
- 不要在 Web 主機另外啟動第二個 Worker，同一時間只允許一個掃描。
- 反覆失敗請收集 Worker 日誌與 Scan History 截圖，聯絡平台維護者。
- 相關：sop-inventory-subnet-outage、sop-inventory-credential-profiles
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inventory-delete-restore',
        title: 'Server Inventory 刪除與還原主機 SOP',
        component: 'Server Inventory',
        tags: ['盤點', '例行維護', '刪除'],
        content: `# Server Inventory 刪除與還原主機 SOP

## 適用情境 / 觸發條件
- 退役或已不存在的主機仍出現在 Server Inventory，需要清除。
- 誤刪主機，需要還原；或刪除的主機又被重新註冊。

## 事前準備
- 刪除需 Operator / SuperAdmin 權限；強制刪除（force）僅 SuperAdmin。
- 預設只允許刪除「已離線超過 offlineDeleteDays（預設 7 天）」的主機。
- 預設不會移除 Prometheus 目標、Scout 歷史與規則綁定；這些清理選項預設為關閉，需要時請在刪除對話框中勾選。

## 處理步驟
1. 在主機列按 Delete，先看「刪除預覽」：會列出 Server List、Prometheus 目標、Scout 監控、規則綁定、維護時段、IPAM 與 VIP 影響，確認後才執行。
2. 需要連同監控資料清理時，才勾選清理選項（Prometheus、Scout 歷史、規則綁定）；不確定時保持關閉。
3. 離線時間不足被擋下（409）：等待到期，或由 SuperAdmin 使用強制刪除並留下稽核紀錄。
4. 批次清理長期離線主機：使用 Bulk delete offline，先 dry-run 預覽名單，再確認 IP 清單後執行。
5. IPAM 只會釋放狀態為 used 的位址；reserved 與 VIP 位址會保留。
6. 被刪除的主機會記入已刪除清單，後續掃描與遙測不會再自動把它註冊回 Server List 或 Prometheus。
7. 還原：到 Server List 的 Deleted Servers 清單，選擇該主機執行 Restore；之後下一次掃描會重新納入。
8. IP 被新機器重複使用時，系統會視為新主機，不會被舊的刪除標記擋住。

## 驗證
- 主機從 Inventory 清單消失，Audit log 有刪除紀錄；還原後 Server List 恢復顯示。

## 注意事項 / 升級處理
- 刪除預覽內容與預期不符時請先取消，不要強制執行。
- 相關：sop-inventory-scan-troubleshoot
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inventory-subnet-outage',
        title: 'Server Inventory 網段中斷（Degraded）處理 SOP',
        component: 'Server Inventory',
        tags: ['盤點', '緊急應變', '網路'],
        content: `# Server Inventory 網段中斷（Degraded）處理 SOP

## 適用情境 / 觸發條件
- 收到「Scan degraded - possible network outage」通知，或 Scan History 出現 DEGRADED 標記。
- 同一網段大量主機同時沒回應。

## 背景
- 判斷主機存活：TCP 連接埠（預設 22、3389、5985、5986）或 ICMP Ping 任一有回應即視為存活。
- 連續未回應達 missesBeforeOffline 次（預設 2 次）才標記離線，避免單次網路抖動誤判。
- 保護機制：網段中先前在線的主機，未回應比例超過門檻（預設 50%）時判定為整體中斷，該網段本次掃描標為 degraded、不改變主機狀態，只發出一則通知。

## 處理步驟
1. 先確認是否為真實中斷：從 SOMP 主機 ping 該網段閘道與幾台代表主機，檢查交換器、路由、VPN 或防火牆變更。
2. 若網路正常，檢查掃描主機自身的網路或防火牆是否擋住探測（TCP 22/3389/5985/5986、ICMP）。
3. 網路恢復後，對該網段按 Scan Now（可只選此網段）重新掃描。
4. 若某網段本來就有大量不穩定主機，可在 Settings 的 Probe & Subnets 調整 outageThresholdPct、missesBeforeOffline 或個別網段的探測連接埠。
5. degraded 期間不要批次刪除離線主機。

## 驗證
- 重新掃描後該網段不再標示 DEGRADED，主機狀態與實際相符。

## 注意事項 / 升級處理
- 持續 degraded 且網路正常：保留 Scan History 與 Worker 日誌，聯絡平台維護者。
- 相關：sop-inventory-scan-troubleshoot
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inventory-credential-profiles',
        title: 'Server Inventory 憑證設定檔問題 SOP',
        component: 'Server Inventory',
        tags: ['盤點', '排障', '憑證'],
        content: `# Server Inventory 憑證設定檔問題 SOP

## 適用情境 / 觸發條件
- 主機列顯示 credential profile cannot be decrypted，或遠端部署 Scout Agent 回應 409。
- 掃描收不到規格（WinRM / SSH 驗證失敗），或設定儲存時被回 403。
- SSH 出現 host key changed 錯誤。

## 背景
- 憑證設定檔（Credential Profile）僅 SuperAdmin 可新增、修改、刪除或指派給網段；密碼以加密方式儲存，介面不會顯示。
- 網段未指定設定檔時，使用 .env 的 AD_ADMIN_* 與 LINUX_ADMIN_* 預設憑證。掃描與遠端部署使用同一來源。

## 處理步驟
1. 無法解密：通常是 .system_key 變更或還原不同備份所致。由 SuperAdmin 到 Settings → Credentials 重新輸入該設定檔的密碼並儲存。系統不會回退使用預設密碼。
2. 儲存設定出現 403：訊息會列出受影響網段；請 SuperAdmin 代為變更憑證設定檔指派。
3. 刪除設定檔被擋（PROFILE_IN_USE）：先把使用該設定檔的網段改指其他設定檔，再刪除。
4. 驗證失敗：確認帳號格式（網域帳號為 DOMAIN\\user）、密碼已更新、目標主機 WinRM（5985/5986）或 SSH（22）可連線。
5. SSH host key changed：系統採首次信任並釘選指紋，指紋不符時會拒絕送出密碼。確認主機確實重灌或更換後，由 SuperAdmin 清除該 IP 的已記錄指紋，再重新掃描。
6. 修正後對該 IP 按 Retry 單機重掃驗證。

## 驗證
- 該主機 specsError 消失、規格正常更新；部署 Agent 不再回 409。

## 注意事項 / 升級處理
- 不要在聊天或工單貼出明文密碼。
- 未確認主機身分前，不要清除 SSH 指紋（可能為中間人攻擊）。
- 相關：sop-inventory-scan-troubleshoot、sop-somp-secrets-key
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
];
