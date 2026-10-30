# SOMP Vanguard - Workflow Editor 自動化工作流程引擎使用手冊 (v2.0)

SOMP Vanguard Workflow 引擎是一套專為企業級 IT 維運 (DevOps) 與資安維運 (SecOps) 所打造的視覺化自動化流程編排平台。透過靈活的節點圖形化畫布 (DAG Canvas)、多元的底層協議支援 (SSH / PowerShell / HTTP / K8s / Nutanix) 以及 Vanguard AI 智慧助手，維運人員可快速構建出具備自我修復、排程維護與告警聯動的高可用性自動化流程。

---

## 目錄
1. [系統架構與特色](#1-系統架構與特色)
2. [支援節點類型總覽](#2-支援節點類型總覽)
3. [畫布操作與快捷鍵指南](#3-畫布操作與快捷鍵指南)
4. [資產與憑證整合 (Server Inventory & Credentials)](#4-資產與憑證整合-server-inventory--credentials)
5. [全域變數與 Context 變數機制](#5-全域變數與-context-變數機制)
6. [單步即時除錯 (Single-Node Live Tester)](#6-單步即時除錯-single-node-live-tester)
7. [Vanguard AI Workflow Copilot 智慧助手](#7-vanguard-ai-workflow-copilot-智慧助手)
8. [版本歷程與 Diff 視覺比對](#8-版本歷程與-diff-視覺比對)
9. [範本庫管理 (Template Library)](#9-範本庫管理-template-library)
10. [實戰演練範例](#10-實戰演練範例)
11. [RBAC 權限與安全規範](#11-rbac-權限與安全規範)

---

## 1. 系統架構與特色

* **視覺化 DAG 編排**：基於拓撲有向無環圖 (DAG)，支援分支判斷、平行處理與迴圈迭代。
* **多協議混合調度**：在同一條工作流程中無縫串接 Linux Bash、Windows PowerShell、Kubernetes 與 REST API。
* **1-Click 演算法自動對齊**：內建階層式 BFS 排版引擎，一鍵將複雜流程圖自動整齊排列。
* **資產聯動**：直接從 SOMP Vanguard Server Inventory 下拉挑選目標伺服器主機。
* **Vanguard AI Copilot**：以自然語言直接生成完整工作流程，或對流程進行安全性與健檢分析。

---

## 2. 支援節點類型總覽

| 類別 | 節點名稱 | 圖示 | 說明 | 關鍵參數 |
| :--- | :--- | :---: | :--- | :--- |
| **Execution** | **SSH Command** | 🔑 | 連線至遠端 Linux 主機執行 Bash 指令 | `host`, `command`, `username`, `password`/`sshKey`, `timeout` |
| **Execution** | **PowerShell** | 🪟 | 在 Windows 主機上執行 PowerShell 腳本 | `host`, `command`, `username`, `password`, `timeout` |
| **Execution** | **HTTP / Webhook** | 🌐 | 發送 HTTP REST 請求或觸發第三方 Webhook 告警 | `url`, `method` (GET/POST/PUT/DELETE), `headers`, `body` |
| **Execution** | **Kubernetes** | ☸️ | 透過 `kubectl` 調度 K8s 叢集 (Pods, Deployments) | `command`, `namespace`, `kubeconfig`, `timeout` |
| **Execution** | **Nutanix AHV** | 🏢 | 透過 Prism API 進行 Nutanix 虛擬機開關機與快照控制 | `action`, `cluster`, `vmName`, `params` |
| **Execution** | **JS Script** | 📜 | 於隔離的子行程沙箱執行自訂 JavaScript 邏輯 (僅 SuperAdmin，詳見 5.6) | `code` (具備 `ctx`、`console.log` 與 `await`) |
| **Logic** | **Condition** | 🔀 | 條件式判斷，具備 `True` (綠) 與 `False` (紅) 雙分支 | `expression` (例如 `ctx.http_step.status === 200`，語法限制見 5.4) |
| **Logic** | **For-Each Loop** | 🔄 | 遍歷陣列變數，逐一將成員指派至變數執行迴圈 | `items`, `itemVar`, `indexVar` |
| **Control** | **Manual Approval** | 👤 | 暫停流程執行並發送 Telegram 通知，任一 SuperAdmin 核准後才繼續（無逾時） | `message` |
| **Control** | **Sleep Delay** | ⏳ | 延遲暫停特定秒數，適合等待服務重啟冷卻 | `seconds` |

---

## 3. 畫布操作與快捷鍵指南

### 3.1 節點新增方式
1. **左側面板拖曳 (Drag & Drop)**：從左側 Component Palette 將節點拖入畫布。
2. **快速新增搜尋 (Quick-Add Palette)**：在畫布任意空白處 **雙擊滑鼠左鍵**，或按下鍵盤 **`Space`** 或 **`/`**，即會跳出搜尋框，輸入名稱按 Enter 即可在游標位置生成節點。

### 3.2 節點連線與分支
* 將滑鼠懸浮在來源節點底部的輸出點（Handle），點擊並拖曳至目標節點頂部的輸入點。
* **Condition 節點** 具有兩個輸出點：
  * 左側綠色輸出點為 **`TRUE`** 分支。
  * 右側紅色輸出點為 **`FALSE`** 分支。

### 3.3 一鍵自動排版 (Auto-Layout)
* 點擊頂部工具列的 **`📐 Align Vertical`**：自動由上至下對齊階層。
* 點擊頂部工具列的 **`↔️ Align Horizontal`**：自動由左至右對齊階層。

### 3.4 快捷鍵一覽表

| 快捷鍵 | 功能說明 |
| :--- | :--- |
| **`Ctrl + S`** | 立即儲存當前工作流程 |
| **`Ctrl + D`** | 快速複製當前選取的節點與所有參數 |
| **`Delete` / `Backspace`** | 刪除當前選取的節點或連線 |
| **`Ctrl + Shift + A`** | 觸發垂直自動對齊 (Auto-Layout Vertical) |
| **`Double Click`** | 在畫布游標處開啟 Quick-Add 搜尋選單 |
| **`Esc`** | 關閉開啟的設定抽屜或彈出視窗 |

### 3.5 互動式導航小地圖 (Interactive MiniMap)
* **點擊跳轉 (Click to Jump)**：點擊小地圖任意位置，主要畫布將以平滑動畫立即對焦至該座標區域。
* **節點快速定位 (Node Quick-Focus)**：點擊小地圖上的個別色塊節點，畫布將自動放大居中並選取該節點開啟設定抽屜。
* **視野方框拖曳 (Viewport Panning)**：拖曳小地圖中的半透明矩形方框，可同步無段漫遊大畫布。
* **地圖縮放 (Zoomable MiniMap)**：在小地圖區域內滾動滑鼠滾輪可自由縮放全景視圖。

---

## 4. 資產與憑證整合 (Server Inventory & Credentials)

在設定 **SSH** 或 **PowerShell** 節點時，系統提供與 SOMP Vanguard 主機資產清單的聯動：

1. 點擊 `Target Host / IP` 輸入框右側的 **`🖥️ Quick Pick from Inventory`** 下拉選單。
2. 系統會列出當前所有已納管的主機名稱（Hostname）、IP 位址與作業系統。
3. 點選後自動將 IP 帶入目標欄位，避免人工輸入 IP 發生拼字錯誤。
4. **密碼安全性**：支援加密密碼字串（以 `enc:` 開頭），密碼在資料庫中皆經過 AES-256 加密儲存，確保憑證安全。

---

## 5. 全域變數與 Context 變數機制

### 5.1 全域變數 (Global Variables)
點擊工具列上的 **`⚙️ Variables`**，可定義流程共用的全域環境變數：
```json
{
  "TARGET_IP": "192.168.10.50",
  "ALERT_WEBHOOK": "https://outlook.office.com/webhook/...",
  "MAX_DISK_PERCENT": "85"
}
```

### 5.2 變數替換語法 (`{{VAR_NAME}}`)
在所有節點的 `command`、`url`、`host`、`headers`、`body` 欄位中，皆可使用 `{{變數名稱}}` 進行動態代換：
* 指令範例：`df -h | grep {{TARGET_MOUNT}}`
* 網址範例：`https://api.internal.service/nodes/{{TARGET_IP}}/restart`

### 5.3 上下游 Context 傳遞 (`ctx`)
每個節點執行後的回傳結果會自動寫入 `ctx` 物件中，供後續節點或 Condition 條件式取用：
* `ctx.node_1.stdout`：取得前一節點的標準輸出字串。
* `ctx.node_1.exitCode`：取得前一節點的 Exit Code (0 代表成功)。
* `ctx.http_step.status`：取得 HTTP 節點的回傳代碼 (例如 200)。
* `ctx.http_step.body`：取得 HTTP 回傳內容。
* 舊寫法 `ctx["node_1.output"]`、`ctx["node_1.stdout"]` 仍可使用。

### 5.4 Condition 條件式語法與分支規則
為了安全，條件式**不是**完整的 JavaScript，只支援以下子集（無法存取 `process`、`require` 等系統物件）：
* 比較與邏輯：`=== !== == != < <= > >=`、`&& || !`、`a ? b : c`、`+ - * / %`
* 函式：`parseInt` `parseFloat` `Number` `String` `Boolean` `isNaN` `isFinite`、`Math.abs/max/min/round/floor/ceil`
* 字串方法：`includes startsWith endsWith indexOf lastIndexOf toLowerCase toUpperCase trim trimStart trimEnd split slice substring charAt`、`.length`
* 陣列方法：`includes indexOf lastIndexOf join slice`、`.length`；數字：`toFixed`

**錯誤不再默默走 FALSE 分支**：語法錯誤或讀取不存在的資料（例如 `ctx.node_9.stdout` 但沒有 node_9）會讓 Condition 節點直接失敗，並在執行紀錄顯示原因。

**分支規則**：
* 只有被選中的分支（TRUE 或 FALSE）會執行，另一側及其下游節點標記為 `SKIPPED`。
* 兩條分支匯流到同一節點時，只要任一條入邊有效，該節點就會執行。
* 節點失敗時，其下游節點標記為 `SKIPPED`；不相依的其他分支照常執行，整體結果為 `FAILED`。

### 5.5 Manual Approval 審核流程
1. 流程執行到 Approval 節點時暫停，執行狀態為 `WAITING_APPROVAL`，並透過 Telegram 推播通知（訊息支援 `{{變數}}`）。
2. 任一 SuperAdmin 於 **Execution Logs** 點選 **✅ Approve** 或 **⛔ Reject**（可填寫備註）。
3. 核准：從 Approval 節點之後繼續執行，先前已完成的節點不會重跑。駁回：剩餘節點標記為 `SKIPPED`，執行狀態為 `REJECTED`。
4. 審核者、時間與備註會記錄於執行紀錄及稽核日誌。等待中的執行紀錄不會被歷史筆數上限（200 筆）清除，也沒有逾時。


### 5.6 JS Script 節點執行環境
* 每次執行會啟動一個獨立的 Node.js 子行程，以權限模型禁止檔案讀寫、子行程與 worker，且不帶任何系統環境變數；逾時 5 秒強制終止。
* 無法使用 `require`、`process`、`module` 等系統物件；可使用 `await`。
* `return` 的值存於 `ctx.<nodeId>.result`；`console.log` 輸出顯示於執行紀錄的 STDOUT。
* 回傳值與 `ctx` 會以 JSON 傳遞：`Date` 轉為 ISO 字串、函式會被移除。
* 腳本可新增或修改 `ctx` 欄位，但無法變更 `EXECUTION_ID`、`TRIGGERED_BY`、`TRIGGER_USER_ROLE`。
---

## 6. 單步即時除錯 (Single-Node Live Tester)

為了避免修改長流程時每次都必須從頭執行，Workflow Editor 提供了單步即時測試功能：

1. 點選畫布上的任一節點，右側開啟設定面板。
2. 點擊藍色按鈕 **`⚡ Test This Node (Dry Run)`**。
3. 系統將以當前節點設定及預設 Context 變數，即時連線執行該步驟。
4. 畫面上彈出 **Dark Terminal** 視窗，即時顯示：
   * 執行狀態：`✅ SUCCESS` 或 `❌ FAILED`
   * 耗費時間：如 `⏱️ 142ms`
   * 詳細輸出：`[STDOUT]`、`[STDERR]`、`[HTTP BODY]`、`[RETURN VALUE]`
5. 確認單一步驟執行無誤後，再串接後續流程，大幅縮短開發與除錯時間。

---

## 7. Vanguard AI Workflow Copilot 智慧助手

Workflow Editor 整合了 Vanguard 核心 AI 引擎，提供兩大生成與分析功能：

### 7.1 自然語言生成流程 (Prompt-to-Workflow)
1. 點擊頂部工具列 **`✨ AI Copilot`** 按鈕。
2. 在輸入框中以中文或英文描述您的自動化維運需求，例如：
   > *「檢查 192.168.1.10 的 NGINX 服務狀態，如果發現服務停止，自動執行 systemctl restart nginx，重啟後再次檢查，若仍失敗則發送 Webhook 告警至 Teams。」*
3. 您也可以點選預設的常用範本快捷標籤：
   * 🚀 *Linux Log Rotation & Cleanup*
   * 🛡️ *Windows Service Auto-Recovery*
   * ☸️ *K8s Pod Restart & Alert*
   * 🌐 *Multi-Stage Health Verification*
4. 點擊 **`✨ Generate & Load Canvas`**，AI 會自動產生所有對應的 DAG 節點、連線、分支與參數，並自動完成排版。

### 7.2 AI 流程健檢與代碼審查 (AI Audit & Lint)
在 Copilot 視窗點擊 **`🔍 AI Audit & Lint Workflow`**，AI 將全面掃描當前工作流程：
* **安全性檢查**：是否有明文密碼、高危險指令 (如 `rm -rf /`) 或權限過大疑慮。
* **邏輯性檢查**：是否有孤立未連線節點 (Orphaned Nodes)、永遠無法到達的分支或無窮迴圈。
* **可靠性建議**：是否缺少 Timeout 超時設定、缺少失敗重試機制等。
* 提供 **0 ~ 100 分** 的健康度評分與具體的改善指引。

---

## 8. 版本歷程與 Diff 視覺比對

1. 每次點擊 `💾 Save` 儲存工作流程時，系統會自動在後端封存版本快照 (Version Snapshot)。
2. 點擊工具列 **`⏳ History`**，可檢視此流程的所有歷史版本與儲存時間。
3. 點選任一歷史版本的 **`Compare`**，畫布將切換至 **Diff 視覺化比對模式**：
   * 🟢 **綠色節點 / 實線**：代表相較於歷史版本 **新增 (Added)** 的節點或連線。
   * 🟡 **橘色節點**：代表屬性或參數被 **修改 (Modified)** 的節點。
   * 🔴 **紅色虛線 / 半透明節點**：代表相較於歷史版本 **已刪除 (Deleted)** 的節點。
4. 點擊頂部 `Exit Diff View` 即可返回一般編輯模式。

---

## 9. 範本庫管理 (Template Library)

* **使用既有範本**：點擊 **`📦 Templates`**，選擇內建的維運範本（如 *Server Health Check*, *Batch SSH Command*, *Certificate Renewal Pipeline*），點擊 `Use` 即可快速複製為新流程。
* **另存為範本**：在當前編輯流程中，於 Templates 視窗右側輸入「Template Name」與描述，點擊 `Save Template`，即可將成熟的工作流程發布為團隊共用範本。

---

## 10. 實戰演練範例

### 範例情境：Linux 磁碟滿載自動清理與告警 Pipeline

```
[Start]
   │
   ▼
[Node 1: SSH 檢查磁碟使用量]
  Host: 192.168.1.10
  Command: df -h / | awk 'NR==2 {print $5}' | sed 's/%//'
   │
   ▼
[Node 2: Condition 判斷]
  Expression: parseInt(ctx.node_1.stdout) > 85
   ├── (TRUE) ──► [Node 3: SSH 執行 Log 清理]
   │                 Command: journalctl --vacuum-size=200M && rm -rf /tmp/*.log
   │                    │
   │                    ▼
   │              [Node 4: HTTP 發送 Telegram 通知]
   │                 URL: https://api.telegram.org/bot{{BOT_TOKEN}}/sendMessage
   │                 Method: POST
   │                 Body: {"text": "⚠️ Disk usage exceeded 85% on 192.168.1.10. Auto-cleanup completed."}
   │
   └── (FALSE) ─► [Node 5: Sleep 結束]
                     Seconds: 1
```

---

## 11. RBAC 權限與安全規範

Workflow Editor 嚴格遵循 SOMP Vanguard 的 RBAC 權限體系：

| 功能操作 | SuperAdmin | Operator | Viewer |
| :--- | :---: | :---: | :---: |
| 檢視工作流程、歷史紀錄與執行日誌 | ✅ | ✅ | ✅ |
| 建立、編輯、儲存工作流程 | ✅ | ✅ | ❌ |
| 執行工作流程 (Execute) 與單步測試 (Test Node) | ✅ | ✅ | ❌ |
| 建立與刪除自訂範本 (Templates) | ✅ | 僅建立 | ❌ |
| 撰寫與執行 **JS Script** 沙箱腳本 | ✅ | ❌ (安全限制) | ❌ |

> [!CAUTION]
> **安全最佳實踐**：
> 1. 嚴禁在腳本或指令中直接填寫明文密碼，請使用系統設定中的加密密碼格式 (`enc:...`)。
> 2. 針對所有遠端 SSH / PowerShell 節點，強烈建議設定合理的 `Timeout` 超時時間（建議 30 ~ 60 秒），以避免遠端主機當機造成流程永久掛起。
