# SOMP Vanguard (somp-vanguard) 使用說明書

歡迎使用 **SOMP Vanguard**，這是一套專為企業級 IT 基礎設施與營運維護設計的一站式智能管理平台。本手冊將完整導引您了解各項核心模組的功能與操作方式。

---

## 📑 目錄
1. [系統登入與安全 (Security & RBAC)](#1-系統登入與安全)
   - [角色權限控管 (RBAC)](#-角色權限控管-rbac)
2. [伺服器維運與資產管理 (Server Operation & CMDB)](#2-伺服器維運與資產管理)
   - [Server List (Simplified CMDB)](#-server-list-simplified-cmdb)
   - [硬體規格漂移偵測 (Hardware Drift)](#-硬體規格漂移偵測-hardware-drift)
   - [Server Inventory (伺服器盤點與掃描)](#-server-inventory-伺服器資產盤點)
3. [智慧監控與代理程式 (Scout Monitor & Open API)](#3-智慧監控與代理程式)
   - [Scout Monitor 監控中心](#-scout-monitor-主機監控中心)
   - [Scout Agent 跨平台自動部署 (DEB / RPM / Windows)](#-scout-agent-跨平台自動化部署)
   - [自動自癒機制 (Self-Healing Remediation)](#-自動自癒機制-self-healing-remediation)
   - [Scout Open API 企業整合介面](#-scout-open-api-企業整合介面)
4. [資料中心與實體架構 (Data Center & Infrastructure)](#4-資料中心與實體架構)
   - [Data Centers 廠房設施與 2D 頂視平面圖](#-data-centers-廠房設施與-2d-平面圖)
   - [Server Rack 機櫃槽位與多節點 Chassis](#-server-rack-機櫃槽位與多節點-chassis)
   - [Topology Map 網路拓撲視覺化](#-topology-map-網路拓撲視覺化)
   - [IPAM 網路位址管理與衝突排查](#-ipam-ip-位址管理與子網路掃描)
5. [資訊安全與日誌鑑識 (SIEM & Security)](#5-資訊安全與日誌鑑識)
   - [SIEM Log Manager 跨平台日誌](#-siem-log-manager-跨平台日誌管理)
   - [安全事件鑑識調查 (Security Forensics)](#-安全事件鑑識調查-security-forensics)
6. [服務管理 (Services Management)](#6-服務管理)
   - [DNS Hub 網域紀錄管理](#-dns-hub)
   - [Nutanix Prism 虛擬化與克隆](#-nutanix-prism-虛擬化管理)
   - [SSL Certificate 憑證生命週期中心](#-ssl-certificate-ssl-憑證管理中心)
   - [Proxy、Mail Relay、Prometheus 與 Redis](#-其他服務管理)
7. [自動化維運 (Automation)](#7-自動化維運)
   - [Remote Command 遠端指令庫](#-remote-command-遠端命令執行)
   - [Task Scheduler 原生時間輪排程引擎](#-task-scheduler-原生時間輪任務排程中心)
   - [SOP Runbook Library 運維手冊庫](#-sop-runbook-library-運維手冊庫)
   - [Visual Workflow Editor 流程設計器](#-workflow-editor-工作流程設計器)
8. [後台系統設定 (System Settings)](#8-後台系統設定)
9. [前後端技術架構與部署 (Tech Stack & Deployment)](#9-前後端技術架構與部署)

---

## 1. 系統登入與安全

系統提供雙軌登入機制，確保在 AD 環境異常時仍能進行維運：

*   **本地管理員 (Local Admin)**：
    *   帳號格式：`admin@local`
    *   用途：系統初始化、AD 設定變更、緊急維護。
*   **AD 網域帳號登入**：
    *   帳號格式：`username@yourdomain.com`
    *   權限控制：僅限在 `Settings` 中 `ALLOWED_LOGIN_AD_OU` 指定路徑下的用戶登入。
*   **安全稽核**：
    *   所有成功與失敗的登入嘗試都會記錄在審計日誌中。
    *   多次登入失敗將觸發 **Telegram / Email 警報通知**。
*   **主題自訂**：使用者可依偏好切換多種佈景主題（Gaming, Pink, Warm, Default）。

### 🛡️ 角色權限控管 (RBAC)
系統內建三層式角色權限，確保在協作維運時的安全性，預設所有 AD 登入用戶皆為 **Operator**。
*   **底層加密防禦 (AES-256-CBC)**：權限設定檔 (`rbac.json`) 全面使用系統密鑰加密。若嘗試從伺服器底層直接覆蓋明文，系統會阻擋並退回預設安全狀態，強制所有權限異動必須經由系統介面操作。
*   **SuperAdmin (超級管理員)**：擁有系統最高權限，可進行所有操作，並能進入 Settings 頁面指派其他人員的權限與控制 Feature Flags。
*   **Operator (維運人員)**：預設角色。具備日常維運的大部分操作權限，但無法進行高風險的系統層級設定。
*   **Viewer (唯讀人員)**：僅能瀏覽各項系統狀態與報表，無法執行任何會變更系統狀態的操作（如執行指令、重開機、派送設定、刪除資料）。

**內建「SuperAdmin」AD Mapping（SuperAdmin 功能開關）：**
*   位置：**Settings → RBAC → AD Mappings**，排在第一列並標示 **Built-in**。它不綁定任何 OU / AD 群組，**套用於所有角色為 SuperAdmin 的使用者**。
*   **只能編輯、不能刪除**：僅 SuperAdmin 可按 **Edit** 調整功能開關；無刪除、停用、改名，也不能再建立同名（不分大小寫）的 Mapping。每次修改都寫入稽核（記錄開啟 / 關閉了哪些功能）。
*   **SuperAdmin 的功能 = 這個 Mapping 的開關**：不再沿用「任一群組有開就有」的舊規則；SuperAdmin 本身所屬的其他 AD Mapping 不影響其功能。關閉某功能後，該畫面會從所有 SuperAdmin 的側邊欄隱藏，**該功能的 API 也會回 403**（每個功能開關都有對應的 API 檢查）。
*   **功能開關同時管制 API（適用所有角色）**：不只 SuperAdmin，一般使用者也一樣——所屬 Mapping 沒有開啟某功能時，側邊欄不顯示該畫面，直接呼叫其 API 也會回 403。v1.7.6 起新增 API 檢查的功能：`remoteCmd`（Remote Command）、`serverCheck`（Server Check）、`nutanix`、`prometheus`（Prometheus HTTP SD 的 `/api/prometheus/targets` 仍以 SD Token 驗證，不受影響）、`redisControl`、`runbook`、`scheduler`、`sftpManager`、`networkDevice`、`monitorWinEvent`（Live Event Viewer）、`monitorLinuxLog`（Log Settings）。
*   **共用 API**：多個畫面共用的 API 只要具備任一相關功能即可呼叫，例如 Web Remote（`/api/remote`，Host Detail 視窗與 Nutanix）接受 Remote Command、Nutanix、Server List、Server Check、Inventory、IPAM、Scout Monitor、Alerts、Agents 任一功能；SNMP 設定與輪詢接受 Network Device 或 Data Center；System Settings 的「Run Scan Now」與 SFTP 伺服器「測試連線」也可由 Settings 使用。Network Device 的設備管理（`/devices`）改為需要 `networkDevice`（原為 `dataCenter`）；Live Event Viewer / Log Settings 的 API 改依各自的功能判定，不再需要 `monitorScout`。首頁的「排程失敗」提示只對有 Task Scheduler 功能的使用者顯示，「合約到期 / 備品不足」提示只對有 Data Center 功能的使用者顯示。
*   **其他原本沒有功能檢查的 API 也納入**（依呼叫它的畫面判定，未新增功能鍵）：Data Center（`/api/rack`；Network Device 畫面讀取機房 / 機櫃清單時也可用）、指令庫 `/api/cmd-library`（讀取：Remote Command 或 SOP Runbook；新增 / 刪除：Remote Command）、ELK SIEM `/api/siem`（ELK Manager）、Live Event Viewer 內的 SIEM Analytics `/api/monitor-siem` 與 On-Demand Forensics `/api/monitor/forensics`（`monitorWinEvent`；Scout Agent 上傳鑑識資料不受影響）、Webhooks（清單：Settings、Scout Monitor、Alerts、Agents、Workflow 任一；新增 / 編輯 / 刪除 / 測試：System Settings）、AI Service `/api/ai`（讀取設定：AI Ops Agent 或 Settings；修改設定 / 測試 / 取得模型：Settings；AI 對話：AI Ops Agent；鑑識修復建議：Live Event Viewer）。外部 Webhook 接收端（`/api/webhooks/incoming/:id`）不受影響。
*   **新增的角色限制（Viewer 不可執行）**：Remote Command 執行指令（`/api/ops/command`，需 Operator 以上；Server Check 仍開放 Viewer）；Task Scheduler 新增 / 編輯 / 啟停 / 立即執行（Operator 以上）與刪除（僅 SuperAdmin）；Prometheus Target 的新增 / 匯入 / 編輯 / 暫停 / 刪除 / 還原 / 健康檢查設定與執行（Operator 以上，查詢仍開放 Viewer）；Settings 的「Run Scan Now」（Operator 以上，另需 Task Scheduler、Settings 或該模組本身的功能）。畫面原本即對 Viewer 隱藏這些按鈕。
*   **AI Ops Agent**：查詢 Runbook 的工具需要 `runbook` 功能；搜尋日誌的工具接受 Scout Monitor、Live Event Viewer 或 Log Settings 任一功能。
*   **側邊欄**：所有使用者（不只 SuperAdmin）的 `/api/auth/config` 都會回傳完整的功能清單，因此所屬 Mapping 未開啟的畫面（包含 Scout Monitor、Alerts & Rules、Agents、NAS Manager、HostMonitor Checker）一律隱藏；Web Remote 被拒（403）時，主機詳情視窗不再顯示遠端連線按鈕。
*   **Web RDP 帳密**：帳號預設帶入目前登入者（可修改），密碼一律需自行輸入；系統不再於帳號等於 `AD_ADMIN_USER` 時自動帶入 `AD_ADMIN_PWD`，未輸入密碼時無法建立連線。每次連線都會記錄操作者、目標主機與使用的帳號。Web SSH 行為不變（帳密於連線時自行輸入）。
*   **生效時間**：API 檢查在修改後立即生效；側邊欄在重新整理頁面或下次登入後更新；登入時取得的功能清單（例如 Self-Healing 按鈕）在下次登入後更新。
*   **防鎖死**：Settings（System Settings、Dev Tools、RBAC & AD Mappings）與 Audit log 對 SuperAdmin 永遠開啟，在編輯器中顯示為已勾選且不可取消。
*   **緊急帳號**：本機管理員帳號（`LOCAL_ADMIN_USER`，網域 local）不受此 Mapping 限制，永遠擁有全部功能。
*   全域開關 `APP_ENABLE_<功能>=false` 仍對所有人優先生效。
*   **升級說明**：首次啟動時自動建立，初始開關 = 升級前 SuperAdmin 實際看得到的功能（舊版會依「任一已啟用 Mapping 有開」過濾的功能沿用該結果；舊版從未對 SuperAdmin 隱藏的功能，如 Monitor 各頁、NAS、Network Device、SFTP、HostMonitor Checker、Self-Healing 一律開啟；若沒有任何 Mapping 則全部開啟），因此升級後行為不變。若既有 Mapping 剛好叫 `SuperAdmin`，會自動改名為 `SuperAdmin (legacy)`，其角色指派一併搬移。

**各頁面權限細部對照表：**

| 模組名稱 | Viewer (唯讀) | Operator (維運) | SuperAdmin (超級管理) |
| :--- | :--- | :--- | :--- |
| **Settings (系統設定與 RBAC)** | ❌ 無法存取 | ❌ 無法存取 | ✅ 完整設定權限 (包含 Feature Flags 開關) |
| **Server List (Simplified CMDB)**| 👁️ 僅檢視資產 | ✅ 編輯資產/關聯 IP/同步 | ✅ 完整管理與大量刪除 |
| **Scout Monitor** | 👁️ 僅檢視指標 | ✅ 派送 Agent/配置自癒規則 | ✅ 完整管理與金鑰配置 |
| **DNS Hub** | 👁️ 僅檢視紀錄 | ✅ 管理 DNS 紀錄 | ✅ 新增/編輯 AD Server |
| **SIEM & Forensics** | 👁️ 僅檢視日誌 | ✅ 日誌查詢與分析 | ✅ 調整日誌輪替政策 |
| **Nutanix Manager** | 👁️ 僅檢視清單 | ✅ 虛擬機電源管理與克隆 | ✅ 叢集連線與 API 配置 |
| **Server Rack & Data Centers** | 👁️ 僅檢視機櫃 | ✅ 編輯機櫃設備內容與報修 | ✅ 新增 Rack / 編輯 IDC 平面圖 |
| **AD User Control** | 👁️ 僅查詢 | ✅ 帳號解鎖/密碼重置 | ✅ 完整帳號操作與授權 |
| **SSL Certificate** | 👁️ 僅檢視 | ✅ 新增/刪除憑證、解密私鑰 | ✅ 完整憑證管理 |
| **IPAM** | 👁️ 僅檢視 | ✅ 分配/編輯 IP / 掃描網段 | ✅ 完整網段管理 |
| **Task Scheduler / Remote Cmd**| ❌ 無法執行 | ✅ 執行指令與管理排程 | ✅ 完整排程控制 |

---

## 2. 伺服器維運與資產管理

### 🖥️ Server List (Simplified CMDB)
Server List 是 SOMP Vanguard 的核心伺服器資產資料庫 (CMDB)，自動關聯 Scout Agent、Prometheus、IPAM 以及機房 Server Rack 的資產資料。
*   **雙模式瀏覽**：提供卡片矩陣視圖 (**Matrix Card View**) 與詳細表格視圖 (**Table View**)。
*   **全域自動同步 (Global Auto-Sync)**：
    *   於 Edit Mode 點擊 **Global Auto-Sync**，系統將平行掃描：
        1. IPAM 線上子網路 Active IP。
        2. Prometheus 作用中 Targets 與標籤。
        3. **Server Rack 機櫃 Compute 資源**（包含獨立 Server、Nutanix 節點、Blade Chassis 刀鋒節點之 SN 與位置）。
*   **Dual-NIC / VIP 虛擬 IP 關聯**：支援主機綁定次要 IP (VIP, Management IP, iLO IP)，並支援一鍵 Unlink 解除綁定。
*   **360° CMDB 抽屜**：點擊主機可開啟側邊抽屜，檢視與維護主機名稱、OS、SN 序號、iLO IP、CVM IP、機房位置與 U 數槽位。

### ⚠️ 硬體規格漂移偵測 (Hardware Drift)
*   **即時規格比對**：系統自動比對 CMDB 記錄之 CPU/RAM 與 Agent/Prometheus 即時採集規格。
*   **漂移警報**：若規格不符會標記 ⚠️ **Drift Detected**。
*   **一鍵校準**：在 360° 抽屜中點擊 **Sync Specs from Live Agent** 即可快速同步校準並消除告警。

### 🔍 Server Inventory (伺服器資產盤點)
*   **多網段並行掃描**：自動探測 Windows/Linux 主機並採集規格（CPU、記憶體、OS、網域、時區）。掃描只在背景 Worker 執行；Worker 未啟動時「Scan Now」會回應 503。同一時間只會有一個掃描，可隨時 Abort。
*   **掃描範圍**：可掃描全部網段、單一網段或單一 IP（主機列的 Retry 即單機重掃）。網段格式為 `10.1.2` 或 `10.1.2:10~50`，儲存時會嚴格驗證。
*   **排程**：支援每日（時間）、每週（星期 + 時間）或 cron 運算式；畫面顯示下次執行時間與即時進度。Worker 啟動時，若 6 小時內有錯過的排程會補跑一次。
*   **主機存活判斷**：以 TCP 連接埠（預設 22、3389、5985、5986）與 ICMP Ping 任一有回應即視為存活，因此封鎖 Ping 的 Windows 主機不會被誤判。需連續未回應 N 次（預設 2 次）才標記離線，並記錄離線起始時間。
*   **網段中斷保護 (Outage Breaker)**：網段內先前在線的主機超過 50%（可調）同時未回應時，該網段本次掃描標為 **DEGRADED**，不更動主機狀態，只發一則通知，避免網路事故造成大量誤報。
*   **掃描歷史 (Scan History)**：每次掃描記錄觸發方式、操作者、耗時、在線 / 離線 / 新增 / 消失數量與變更明細（主機名稱、OS、CPU、記憶體、時區、狀態）；主機列的 HISTORY 可查看單機異動。預設保留 180 天（30–730 天可調）。
*   **新主機通知**：第一次出現的 IP，或在線但不在 CMDB / IPAM 的主機，每次掃描合併成一則通知（可於 Settings 關閉）；主機列於 7 天內顯示 NEW 標記。
*   **各網段設定 (Probe & Subnets)**：可針對網段設定並行數、探測連接埠、是否自動同步 Prometheus、憑證設定檔與時區偏移；另有全域探測參數（每網段並行 1–64、同時網段數、離線所需連續未回應次數、中斷門檻）。
*   **憑證設定檔 (Credential Profiles)**：僅 SuperAdmin 可建立 / 修改 / 刪除並指派給網段；密碼加密儲存、畫面不顯示。未指派時使用 .env 預設的 AD_ADMIN_* / LINUX_ADMIN_*。掃描與遠端部署使用同一來源；無法解密時會明確報錯，不會改用其他密碼。SSH 採首次信任並釘選主機指紋，指紋改變時拒絕送出密碼（SuperAdmin 可清除）。
*   **匯出**：Export CSV 依目前篩選條件匯出（Operator 以上），所有欄位加引號並防止公式注入。
*   **刪除主機**：Delete 會先顯示「刪除預覽」（Server List、Prometheus、Scout、規則綁定、維護時段、IPAM、VIP）。預設只允許刪除離線超過 7 天（offlineDeleteDays）的主機，SuperAdmin 可 Force（會留稽核紀錄）；也可使用批次刪除長期離線主機（先預覽再確認）。清理 Prometheus 目標、Scout 歷史、規則綁定的選項**預設關閉**，需要時才勾選；IPAM 只釋放 used 位址，reserved 與 VIP 保留。
*   **已刪除主機**：被刪除的主機不會被後續掃描或遙測重新註冊；可在 Server List 的 Deleted Servers 清單還原（Restore）。
*   **權限**：檢視為具 inventory 功能的登入使用者；掃描、設定、刪除、連結 VIP、產生安裝連結為 Operator / SuperAdmin；憑證設定檔與 SSH 指紋管理為 SuperAdmin。Viewer 不可產生安裝 Token。
*   **時區合規檢查 (Timezone Check)**：依據 UTC Offset 自動判斷時區是否正確，並支援自動產出 HTML 郵件報表。

### 🚀 Server Provision (遠端軟體部署)
*   **用途**：對既有 Windows / Linux 主機依 BU 範本遠端部署軟體（Windows 走 WinRM、Linux 走 SSH）。部署以背景工作執行，關閉瀏覽器不會中斷，結果與記錄保存在歷史中。
*   **選擇目標**：用搜尋框查 CMDB / Server Inventory 的主機後多選，或手動輸入 IP。只有「已知」主機（在 CMDB 且未刪除，或在 Server Inventory 中，含盤點掃描發現的 IP）可部署；未知 IP 會被拒絕並列出。僅 SuperAdmin 可勾選「Allow unknown targets」覆寫（會留稽核紀錄）。
*   **預檢 (Pre-check)**：唯讀檢查連線埠、登入驗證、X: 資料碟剩餘空間（預設至少 5 GB；X: 不存在會失敗，資料碟由 Nutanix Clone VM 建立）、已安裝的套件（資訊列）、NAS 路徑與是否已有其他工作處理該 IP；不會安裝任何東西。預檢失敗仍可按 Install，但會警告。Linux 預檢首次連線會釘選 SSH 主機指紋（首次信任）。
*   **執行與工作檢視**：按 Execute 後進入工作檢視，每 2 秒更新各主機狀態、套件結束代碼與是否需重開機，可展開記錄。記錄僅 Operator / SuperAdmin 可見。同一 IP 已在另一工作中會被略過 (skipped)。
*   **執行程序**：工作優先在背景 Worker 執行；Worker 不可用或 5 秒內未回應時改由 Web 執行（工作檢視顯示「runs in: Background worker / Web server (fallback)」）。每個程序自行從設定讀取憑證，密碼不會經 IPC 傳送也不會儲存。同一工作只會在一個程序執行。
*   **執行帳號（行為變更）**：Windows 安裝改以 Settings 的服務帳號 `AD_ADMIN_USER` / `AD_ADMIN_PWD`（與 Server Inventory 同一來源）執行，不再使用登入者本人的帳密；Linux 以 `LINUX_ADMIN_*` 執行。觸發者記錄在 SOMP 稽核與歷史（工作檢視顯示「Triggered by」與「Run as」）。必須先設定服務帳號，否則 Execute / Pre-check / Retry 會回錯誤「Server Provision requires the service account in Settings (AD_ADMIN_USER / AD_ADMIN_PWD)」。
*   **取消**：不再啟動新主機 / 套件；**已在執行的 Windows 主機不會被中斷**，會跑完其套件。取消旗標寫在資料庫，執行程序每台主機 / 套件前與每 15 秒檢查，IPC 中斷也會生效。
*   **歷史與重試**：History 分頁列出過去的工作；「Retry failed hosts」建立新工作，只含 failed / interrupted / skipped 主機，並重新檢查是否為已知目標（不會繼承未知目標覆寫，SuperAdmin 需明確再次允許）。
*   **重新開機**：只有該主機所有套件都成功、且至少有一個套件實際安裝才會重開機。
*   **已安裝偵測**：軟體主清單每行最後可選填 `|@detect:類型:值`，已安裝的套件會標示 SKIP 並略過。Windows：`@detect:reg:顯示名稱樣式`（可加 `>=最低版本`，例如 `Google Chrome*>=120.0`）或 `@detect:file:C:\路徑\app.exe`；Linux：`@detect:rpm:套件`、`@detect:dpkg:套件`、`@detect:cmd:指令`（結束代碼 0 = 已安裝）。範例：`Chrome|chrome\setup.msi|/qn|@detect:reg:Google Chrome*>=120.0`。勾選「Force reinstall」可忽略偵測。只檢查 HKLM（不含個別使用者安裝）；偵測錯誤或逾時 30 秒視為未安裝並繼續；預檢不會執行 `cmd:` 規則，且 `cmd:` 規則必須沒有副作用。
*   **部署後清理**：Windows 安裝檔複製到 `X:\SOMP_Provision\<工作編號>\`，主機處理完後自動刪除該資料夾（install_*.log 內容先存入記錄）；清理失敗只顯示警告。腳本套件（.bat / .cmd / .ps1 的資料夾）維持在 `X:\<資料夾名>` 且不會被刪除；只有單一安裝檔與其記錄被清理。勾選「Keep installers」可保留以便除錯；記錄請用相對路徑。
*   **Disk Setup 已移除**：資料碟 X:、網卡更名、停用 IPv6 由 Nutanix Clone VM 負責。
*   **服務 / Worker 重啟**：接手的程序會把尚未開始 (queued) 的主機自動續跑一次（重新讀取憑證、重新檢查已知目標與 IP 佔用，不符者標示 skipped），工作顯示「Resumed after restart」；執行到一半 (running) 的主機標示為 interrupted、不會自動重跑，請確認目標主機狀態後用「Retry failed hosts」。已要求取消的工作直接結束為 cancelled；已續跑過一次、或服務帳號已無法使用的工作，剩餘主機標示 interrupted。
*   **通知**：每個工作結束時送出一則 Provision 摘要（成功 / 失敗 / 需重開機數與失敗主機）。
*   **設定值**：`PROVISION_HOST_CONCURRENCY`（預設 4，最大 10，每個執行程序；工作都在 Worker 時等同全域）、`PROVISION_HISTORY_RETENTION_DAYS`（預設 180，30–730）、`PROVISION_MIN_FREE_GB`（預設 5，1–500）。可在 Settings 的 Remote Install 分頁編輯（僅 SuperAdmin），儲存時驗證範圍，不需重啟即生效。
*   **權限**：執行、預檢、取消、重試、目標搜尋為 Operator 以上；檢視歷史需 install 功能。
*   **API 變更**：`POST /api/install/execute` 改為回傳 `202 { jobId }`，請以 `GET /api/install/jobs/:id` 查詢結果。

### 📡 HostMonitor Checker (HM_checker 監控覆蓋率比對)
*   **用途**：比對 CMDB（或貼上的 Excel 清單）與 HostMonitor 備份檔中的測試項目（Ping / CPU / Memory / Disk），列出缺漏並可產出 HostMonitor 匯入檔。僅在使用者開啟畫面或按下比對時執行，**沒有排程、也不會發送通知**。
*   **自動使用最新備份檔**：只要設定一次 UNC / 目錄路徑，每次開啟畫面與每次比對，系統都會重新掃描該目錄（最多往下 4 層，略過隱藏與系統資料夾），自動取用最新的備份檔，不需要重新輸入路徑。只有符合檔名規則的檔案才算數（預設 `hostmonitor-item-backup-*.txt`，不分大小寫，可在「備份與 UNC 管理」改為其他規則，只支援 `*` 萬用字元）；其他 .txt 會被忽略。最新檔案依檔名中的日期、其次依修改時間判斷。
*   **畫面上顯示實際使用的檔案**：標頭會顯示檔名、所在目錄、修改時間、大小與來源（UNC 共享 / 已上傳的備份）。
*   **固定檔案 (Pin)**：在「備份與 UNC 管理」按「固定使用此檔」可改用指定的舊檔；標頭會出現「已固定：檔名（改用最新）」，按下即回到最新檔案。重新開啟畫面一律回到最新檔案，不會保留固定。
*   **今日快取**：只是加速用。僅當快取是由**目前最新檔案**（檔名、修改時間、大小皆相同）且「略過環境」設定相同時才會重用，否則自動重新比對；按「重新比對」可強制重算。
*   **UNC 失敗不會悄悄改用其他檔案**：已設定 UNC 路徑但掃描失敗或逾時時，畫面會以紅色橫幅顯示原因並不進行比對。掃描逾時秒數可設定（預設 20 秒，範圍 5–120）。只有在**未設定 UNC 路徑**，或你明確按下「使用已上傳的備份」時，才會使用已上傳的備份。
*   **手動貼上 / 上傳備份**：備份內容儲存在系統資料目錄下的私有資料夾（`hm_checker_uploads`），不會放在可公開存取的 `docs/` 下。檔名僅允許英數字、點、底線、連字號且副檔名須為 `.txt`（最長 128 字元，路徑部分會被忽略；未填則為 `hostmonitor-item-backup-<日期>.txt`），內容上限 50 MB。**舊版若曾把備份放進專案的 `docs/` 目錄，現在不會再被讀取；請自行確認後手動刪除這些檔案**（備份可能含主機清單，且 `docs/` 可被網頁存取）。
*   **上傳規則（新增）**：上傳的檔名必須符合目前的檔名規則（`filePattern`），否則回 400 且不儲存（否則上傳後也不會被使用）；已有同名檔案時回 409，畫面會詢問是否覆蓋，確認後才會覆蓋（Operator / SuperAdmin），不會悄悄蓋掉舊檔。
*   **掃描結果快取**：UNC 掃描結果（含失敗原因）最多快取 10 秒，同時間的多個請求共用同一次掃描，避免網路共享卡住時累積大量等待；儲存設定或上傳備份會立即清除此快取，因此新檔案最久約 10 秒後出現。
*   **固定檔案不存在時**：若固定的檔案已被移除，比對會回 404，畫面會清空結果並自動取消固定、提示「已改回最新檔案，請重新比對」。
*   **CMDB 來源**：排除已除役 (decommissioned) 與在 Server List 被刪除 (Deleted) 的主機。
*   **匯入檔依 OS 產生**：產生匯入檔時，系統以 IP 到 CMDB 查詢 OS（以 CMDB 為準，貼上清單的主機也會查）：
    *   **Linux**（CentOS、RHEL、Ubuntu、Oracle Linux 等）：CPU / Disk 用 SNMP（`1.3.6.1.4.1.2021.11.9.0` / `1.3.6.1.4.1.2021.9.1.9.1`），Memory 用 SNMP。
    *   **Windows**：CPU 用 PerfCounter `\\IP\Processor(_Total)\% Processor Time`（> 85），Memory 用 WMI（剩餘 < 15 %），Disk 用 DriveSpace，一台一個測試，涵蓋所有本機磁碟（剩餘 < 15%）。
    *   **OS 未知**（CMDB 未填，或不是 Windows / Linux，例如 ESXi、AIX）：只產生 Ping，CPU / Memory / Disk 會略過並列在匯入檔最後，畫面也會提示；請先到 CMDB 補上 OS 再產生。
    *   比對結果的主機名稱旁會顯示 OS 標籤（Windows / Linux / OS 未知），CSV 匯出也多一欄 OS。
*   **權限**：所有具 hmChecker 功能的使用者可檢視與比對；儲存設定、測試 UNC、上傳備份、產生匯入檔為 Operator / SuperAdmin。

---

## 3. 智慧監控與代理程式

### 📊 Scout Monitor (主機監控中心)
*   **即時遙測看板**：提供 CPU、Memory、Disk、Network、TCP Ping 延遲、Windows Services / Linux 守護程序與 Top 10 處理程序之實時監控。
*   **狀態與環境過濾**：支援依據 Environment（環境）、狀態 (Online/Alerting/Offline/Outdated) 及關鍵字搜尋，切換條件時自動重置頁碼並具備邊界保護。

### 🚀 Scout Agent 跨平台自動化部署
支援三大平台發行版原生適配：
*   **Linux (Ubuntu / Debian)**：自動下載並使用原生 **`.deb`** (`scout-*-amd64.deb`) 套件透過 `dpkg -i` 安裝。
*   **Linux (RHEL / CentOS / Rocky / AlmaLinux)**：自動下載並使用原生 **`.rpm`** 套件安裝。
*   **Windows Server (2012R2+)**：自動註冊為高效能背景排程任務 `ScoutMonitorAgent`。
*   **部署方式**：支援網頁一鍵複製安裝指令 (`install.sh` / `install.ps1`) 或後台遠端 SSH / SFTP 靜默推送。

### 🛠️ 自動自癒機制 (Self-Healing Remediation)
*   **自訂修復規則**：可設定當特定服務中斷（如 Nginx、Print Spooler）或資源告警時，由 Agent 本地自動觸發修復腳本 (PowerShell / Bash)。
*   **執行追蹤**：於 **Remediation Logs** 完整記錄自癒時間、指令輸出與成功狀態。

### 🌐 Scout Open API 企業整合介面
提供標準 RESTful 介面與 Prometheus Text Exporter：
*   **認證方式**：支援 `Authorization: Bearer <API_KEY>` 與 URL Query `?apiKey=...`。
*   **核心端點**：
    *   `/api/v1/open/hosts`：查詢受監控主機清單（支援 `ip`, `keyword`, `status`, `os`, `envId`, `group`）。
    *   `/api/v1/open/metrics/realtime` 與 `/api/v1/open/metrics/history`：即時與歷史時序指標。
    *   `/api/v1/open/logs/events`、`/logs/windows`、`/logs/linux`：跨平台日誌查詢（支援 IP / Hostname 智慧轉譯）。
    *   `/api/v1/open/prometheus`：標準 Prometheus Metrics 匯出。
*   **嚴格參數白名單校驗**：若呼叫時傳入未支援的參數名稱，API 會立即回傳 `400 Bad Request` 並提示正確參數清單。

---

## 4. 資料中心與實體架構

### 🏢 Data Centers 廠房設施與 2D 平面圖
*   **2D Top-Down 平面圖瀏覽**：可視化檢視各機房機櫃排列，點擊機櫃方塊可高亮並一鍵直達該機櫃的 42U/48U 視圖。
*   **機房全域方向控制**：支援於機房抽屜中集中設定 `rackOrder` (機櫃排序方向)、`rowOrder` (Row 排序方向) 與 `uOrder` (U 數上下方向)。

### 🗄️ Server Rack 機櫃槽位與多節點 Chassis
*   **42U/48U 空間管理**：直觀視覺化槽位放置與 PDU-A/B 雙迴路電源配置。
*   **多節點 Chassis 管理**：針對 Blade 及 Nutanix Chassis，支援維護節點之 **SN (序號)**、**iLO/iDRAC IP** 與 **CVM IP**。
*   **硬體故障報修 (HW Report)**：可針對故障節點或零件建立維修紀錄，標記 Repairing 狀態並連動備品管理。

### 🔐 Data Center 編輯規則（v1.7.6）
*   **權限**：所有新增 / 修改 / 刪除（機房、機櫃、硬體問題、備品、合約）需 Operator 以上；刪除機房與永久刪除合約僅限 SuperAdmin。Viewer 只能檢視。
*   **機房逐筆儲存**：新增與編輯只影響該機房，不會再把整份清單送回覆蓋。刪除機房需 SuperAdmin，並輸入機房名稱確認；刪除會一併移除該機房的機櫃與設備、在 IPAM 釋放其 IP、刪除 SNMP 設定，且立即生效。
*   **多人同時編輯機櫃**：每座機房的機櫃資料有版本號。若你開著畫面期間別人已修改同一座機房（包含 Network Device 畫面調整設備），你的下一次儲存會被拒絕並提示「資料已被其他人修改」，畫面自動載入最新資料，**你這次的變更不會儲存**，請重新操作一次。不會再覆蓋別人的設備或誤釋放 IP。
*   **儲存前檢查**：新增或修改的設備會檢查 U 位重疊、超出機櫃高度、跨越 Split 機櫃的上下分界與設備 ID 重複；未修改的舊資料不受影響。直立式 PowerBar 不佔 U 位，不算重疊。注意：以前若有設備跨越 Split 分界，修改該設備或該機櫃的高度 / 分界設定時會被拒絕，需先調整位置。
*   **備品庫存**：數量一律由伺服器計算，入庫 / 出庫送出的是異動數量；出庫超過庫存會被拒絕。編輯備品只能修改名稱、型號等資料，數量請用入庫 / 出庫。新增備品可設定初始庫存（記為一筆入庫）。
*   **報修使用備品**：在硬體問題選用備品時會扣除庫存並記入該備品的異動紀錄；庫存不足時整筆報修不會儲存。同一次選用即使重送也只扣一次。

### 🖧 Network Device 與 SNMP 查詢（v1.7.6）
*   **SNMP 查詢開關**：每台設備的 SNMP 設定有「啟用 SNMP 查詢」（Network Device 的 Info & SNMP 頁籤、Server Rack 設備的 SNMP 頁籤）。停用時系統完全不會對該設備發出 SNMP 查詢，查詢按鈕隱藏，Ports & Cables 改為手動維護。從未設定過 SNMP 的設備視為停用（不再預設以 `public` 查詢）；升級前已儲存過 SNMP 設定的設備維持啟用。
*   **查詢一律使用已儲存的 IP**：SNMP 查詢只會對機櫃資料中儲存的設備 IP 發出；表單上修改 IP 後須先儲存才能查詢。
*   **SNMP 版本**：支援 v1、v2c、v3（v3 為 SHA + AES、authPriv）。舊版選 v2c 實際卻以 v1 查詢，已修正。啟用時 v1 / v2c 必須填 community；v3 必須填使用者名稱，且 auth / priv 密碼至少 8 字元。停用時可先不填。
*   **設備管理**：新增設備由伺服器產生 ID，並檢查類型、IP 格式、U 位重疊、機櫃高度與 Split 分界（不符合回 400）。修改 IP 時會在 IPAM 釋放舊 IP、登記新 IP；未填的欄位維持原值。刪除設備時會釋放 IP 並刪除該設備的 SNMP 設定。
*   **注意**：Server Rack 中尚未儲存到機櫃的新設備無法先存 SNMP 設定，請先儲存設備。

### 🕸️ Topology Map 網路拓撲視覺化
*   **自動拓撲繪製**：依據 Port Links 自動生成拓撲連線圖。
*   **雙向連線同步**：配置線路時自動建立回程連線；拔線時自動雙向清除。
*   **一條實體線只畫一條（v1.7.6）**：雙向記錄的連線合併成一條無箭頭的線，標示兩端埠號（如 `P1 ↔ P3`、電源 `W1 ↔ …`）；同一對設備間有多條線時每條都會分開顯示。機櫃背面的設備也會畫出（位置標示「(背面)」）。
*   **對端辨識**：依主機名稱 → 名稱 → IP 比對。名稱對到多台設備時優先選同機房的；仍無法判斷時以橘色虛線標示「不明確」，並在側邊欄列出候選設備。對端在其他機房時顯示為青色外部節點（`主機名 @ 機房`）；完全找不到才顯示紅色虛線節點。
*   **檢視工具**：預設隱藏沒有接線的設備（可勾選「顯示未接線設備」）；可切換網路線 / 電源線圖層並依設備類型篩選（兩端都符合類型的線才顯示）；搜尋主機名稱、名稱或 IP 會自動置中並高亮其連線，只有選取設備的連線有動畫。拖曳後的位置會依機房記在瀏覽器中，按「重新排版」可恢復自動排版；「重新整理」重新讀取機櫃資料，載入失敗時畫面會顯示錯誤並可重試。
*   **Config Ports & Cables**：Nutanix / Blade 節點會開啟其所屬機箱；其他機房的設備會先切換到該機房再開啟。
*   **即時埠狀態**：按「顯示即時埠狀態」才會查詢（不會自動或定時查詢），只查已啟用 SNMP 的網路設備，最多同時 3 台；線的兩端依埠狀態顯示綠（Up）/ 紅（Down）/ 灰（未知），查詢失敗的原因顯示在該設備的側邊欄。

### 🗄️ IPAM (IP 位址管理與子網路掃描)
*   **容量與使用率檢視**：即時掌握各網段已分配與剩餘 IP。
*   **子網路存活掃描**：平行 ICMP 探測線上主機。
*   **IP 衝突排查**：偵測重複 MAC 或未登錄設備佔用。
*   **環境清單改由 Settings 管理**：IPAM 不再提供環境的新增 / 編輯 / 刪除；新增子網路與 IP 時仍從全域環境清單下拉選擇。SuperAdmin 可按頁首的「Manage environments →」直接跳到 `Settings > Environments`。
*   **網段建立規則（v1.7.6）**：CIDR 會正規化為網路位址（例如 `10.0.0.5/24` 存成 `10.0.0.0/24`）；新網段遮罩限 /20～/30（最多 4094 個 IP）；重複或與既有網段重疊會被拒絕。舊有的 /16～/19 網段保留並標示「未完整展開」，同步或手動設定到清單外的 IP 時會自動補上該筆 IP。批次新增會逐列列出被拒絕的原因。
*   **編輯網段不影響 IP**：編輯網段只會修改名稱、VLAN、環境、閘道與保留範圍，不會再覆蓋各 IP 的使用狀態。
*   **閘道與保留範圍**：新網段的閘道預設為第一個可用位址，可改為其他位址或清空；保留範圍可填單一位址或 `a.b.c.d-a.b.c.e`。「下一個可用 IP」會跳過閘道、保留範圍與他人正在保留的 IP，取得後保留 10 分鐘（儲存 IP 即結束保留），兩人同時取號不會拿到同一個。
*   **系統管理的 IP**：由 Server Rack、Network Device 等功能自動登記的 IP，手動修改狀態 / 主機名稱 / 指派對象會被拒絕並顯示來源；SuperAdmin 確認後可強制修改（記入稽核紀錄）。FQDN、服務、標籤、環境仍可編輯。
*   **刪除網段**：沒有使用中 IP 的網段 Operator 即可刪除；含使用中 IP 的網段僅限 SuperAdmin，且需輸入網段 CIDR 確認。
*   **DNS 同步**：只清除「本次確定抓取成功的 DNS 區域」中已不存在的 FQDN，其他區域的 FQDN 保留；未指定區域的同步只會新增 / 更新，不會清除。公網 IP 不再自動建立網段（Server Rack / Network Device / Inventory 的自動建立同樣只限私有 IP）。
*   **多個功能同時寫入**：網頁與背景服務（DNS 排程、Inventory 掃描、Server Rack 等）對 IPAM 的寫入改為在資料庫鎖定下讀取最新資料再寫回，不會再互相覆蓋。
*   **載入速度**：網段清單只載入摘要與使用數量，點開網段時才載入該網段的 IP。

---

## 5. 資訊安全與日誌鑑識

### 🔍 SIEM Log Manager 跨平台日誌管理
*   **多來源聚合**：集中收集 Windows Event Log 與 Linux Syslog / Secure 日誌。
*   **容量輪替政策**：預設單表上限 200,000 筆，最長保留 30 天，保障資料庫效能。

### 🛡️ 安全事件鑑識調查 (Security Forensics)
*   **關鍵安全事件偵測**：
    *   **Event ID 4625**：暴力破解登入失敗偵測。
    *   **Event ID 4720 / 4726**：帳號建立與刪除。
    *   **Event ID 4728 / 4732**：管理員群組異動。
    *   **Event ID 7036 / 7045**：服務狀態變更與新服務安裝。
    *   **Linux \`sudo:\` 提權與 SSH 登入分析**。

---

## 6. 服務管理

### 🌐 DNS Hub
*   **AD DNS 管理**：查詢與編輯 AD DNS 伺服器上的 Zone 與 Record (A/CNAME/MX/TXT)。
*   **在線存活探測**：卡片即時顯示在線健康狀態，支援快速啟用/停用切換。

### 🏢 Nutanix Prism 虛擬化管理
*   **VM 電源操作**：支援 Power On, Power Off, Guest Shutdown, Reset VM。
*   **VM Clone API 自動化**：整合 Prism API 腳本，實現自訂規格與快速克隆部署。

### 🔑 SSL Certificate (SSL 憑證管理中心)
*   **線上探測與解析**：支援 Host:Port 探測、文字證書貼上與證書檔上傳解析（PEM / DER / CER / CRT / PFX / P12，上限 1 MB；不支援 JKS）。主機欄只填網域或 IP（會自動去掉 `https://` 與結尾 `/`），Port 1–65535。
*   **AES-256 透明加密**：私鑰與密碼強制加密儲存；清單不會回傳任何加密資料。檢視私鑰僅限 SuperAdmin，每次檢視都會記入稽核紀錄。
*   **狀態（v1.7.6）**：正常 / 即將到期（≤ `SSL_ALERT_THRESHOLD_DAYS`，預設 30 天）/ 已過期 / 錯誤，剩餘天數依到期日即時計算。另會標示「不受信任」並說明原因（自簽、主機名稱不符、中繼憑證過期等）。只上傳檔案、沒有監控主機的憑證不會被探測，但仍會依到期日倒數與告警。
*   **掃描**：每日排程與「全部檢查」在背景平行執行（最多同時 5 台），畫面顯示掃描進度；同一時間只會有一個掃描。掃描結果只合併回現有紀錄，掃描期間新增、刪除或編輯的資料不會被覆蓋。
*   **到期預警**：Telegram 通知只在狀態改變時發送：進入 30（門檻）/ 14 / 7 / 1 天、已過期、連續兩次探測失敗、恢復正常；重複掃描或服務重啟不會重複通知；更新憑證後重新計算。升級後第一次掃描，會對已在門檻內的憑證各發一次通知。
*   **編輯**：可修改名稱、主機、Port、環境並更換憑證 / 私鑰；私鑰欄位留空表示不變，勾選清除才會刪除已存的私鑰。刪除監控紀錄會一併刪除已存的私鑰與檔案。

### 📦 其他服務管理
*   **FortiProxy & Squid Proxy**：在線編輯 ACL 存取原則與配置快照備份庫 (Backup Vault)。
*   **Mail Relay**：管理郵件轉發叢集、Access 清單與外寄佇列。
*   **Prometheus Target & Redis Control**：目標端點健康檢查與 Redis 記憶體調校。
*   **NAS Manager**：選擇 NAS 裝置後管理共用資料夾與權限。檢視（含權限查詢）所有具 NAS 功能的角色皆可；建立 / 刪除共用資料夾與設定權限需 `Operator` 以上。裝置本身的新增 / 編輯 / 刪除已移至 `Settings > File Services > NAS Devices`；SuperAdmin 可按頁面右上角「Manage devices →」直接前往。尚未設定任何裝置時，頁面會提示由 SuperAdmin 先至 Settings 新增。

---

## 7. 自動化維運

### ⌨️ Remote Command (遠端命令執行)
*   **PowerShell & SSH 雙軌支援**：支援指令庫 (Cmd Library)、執行逾時設定與即時 NDJSON 串流回饋。
*   **權限**：執行指令、新增 / 刪除指令庫的自訂指令需 Operator 以上（Viewer 只能檢視指令庫）；指令庫的新增與刪除都會寫入稽核紀錄。
*   **Windows 執行帳號**：以 AD 帳號登入時，可在「Windows 帳密」欄輸入自己的 Windows 密碼，系統先以 `網域\登入者` 連線；個人帳號連線失敗（例如密碼錯誤、在目標主機沒有權限）或未輸入密碼時，改用 Settings 的服務帳號（`AD_ADMIN_USER` / `AD_ADMIN_PWD`）。結果卡片會標示「個人帳號」或「服務帳號」，改用服務帳號時會在輸出最前面註明個人帳號失敗的原因。只有「連線」失敗才會改用服務帳號；指令本身執行失敗不會重跑，每台主機的指令最多只執行一次。本機帳號（緊急帳號）登入時一律使用服務帳號。密碼只用於本次執行，不會儲存，也不會寫入暫存檔。
*   **目標主機**：每行一個 IPv4 或主機名稱，其他格式（含空白、引號、分號等）一律拒絕且不會執行任何主機；重複的主機自動合併（不分大小寫）；一次最多 200 台。
*   **逾時與輸出上限**：每台 Windows 主機最多 120 秒；Linux 指令最多執行 120 秒（`top`、`tail -f` 這類不會結束的指令會在時間到時中止並顯示逾時）；每台主機的輸出最多保留 512 KB，超過會截斷。
*   **停止**：執行中可按「⏹ 停止」，尚未開始的主機不會執行；已在執行中的主機仍會在遠端跑完，畫面標示為 Stopped。關閉或重新整理頁面也有相同效果。
*   **稽核紀錄**：開始執行時即記錄目標、指令與 Windows 使用的帳號方式，結束（或停止）時再記錄成功 / 失敗 / 離線 / 略過 / 未執行的數量。
*   **危險指令攔截**：`rm -rf`、`Format-Volume` 等關鍵字會整批拒絕（400）。這只能防止手誤，可以被刻意繞過，並非安全防線。

### ⏱️ Task Scheduler (原生時間輪任務排程中心)
*   **原生本地時間輪詢引擎**：嚴格採用 Windows OS 本地時間（`Date` 物件與 `setInterval`），徹底杜絕跨日時區與夏令時 Bug。
*   **多模式排程**：支援 Local PowerShell、Remote SSH、Remote WMI 及智慧 OS 自動路由。

### 📖 SOP Runbook Library (運維手冊庫)
*   **27 篇專業標準 SOP**：涵蓋全系統所有功能操作流程、故障排查與最佳實踐。
*   **智慧自動合併**：系統啟動時自動同步官方最新 SOP，同時保留使用者自訂文章。

### 📋 Workflow Editor (工作流程設計器)
*   **DAG 視覺化畫布**：拖拉 SSH, PowerShell, HTTP, Delay, Branch 節點建立自動化流程。

---

## 8. 後台系統設定 (System Settings)
進入路徑：Vanguard 主主控台左側導覽列 `Settings` 分組（需具備 `SuperAdmin` 權限，舊版 `/_setting` 獨立路徑已正式棄用）
*   **Feature Flags 模組開關**：SuperAdmin 可針對各功能模組自由啟用或停用。
*   **環境變數透明加密**：所有敏感資訊 (`_PWD`, `_SECRET`, API Token) 儲存時自動加密 (AES-256-CBC)。
*   **SQLite 自動備份與設定快照**：定時產出資料庫備份檔案與系統輕量快照。
*   **RBAC 權限矩陣與 Dev Tools**：AD 網域群組對應、JWT 測試簽發與系統運行診斷。
*   **File Services**（`Settings > File Services`，介面文字為英文；原「SFTP Server」分類已併入，舊的連結 / 書籤會自動導向 SFTP Servers 分頁）：
    *   **SFTP Servers** 分頁：多台 SFTP 伺服器的新增 / 編輯 / 刪除 / 測試 / 啟用停用，行為與儲存方式（按 `Save Changes`）與先前相同。
    *   **NAS Devices** 分頁：NAS 裝置清單，可新增 / 編輯 / 刪除 / 測試連線（Synology、QNAP、Windows Share、Linux SMB）。裝置異動**立即生效**並寫入稽核日誌（記錄操作者與裝置名稱，不含密碼）；全域 NAS 設定 `NAS_DEFAULT_TIMEOUT_MS`、`NAS_DEFAULT_SYNC_ON_LOAD`（原在 Others）移到此分頁底部，需按右上角 `Save Changes` 儲存。
    *   密碼欄位僅可寫入：編輯時留空代表保留原密碼；畫面與 API 都不會回傳密碼。裝置名稱 1–64 字元（不分大小寫不可重複）、IP / 主機名稱需為有效格式、連接埠 1–65535、使用者名稱最多 128 字元。
    *   NAS 密碼以系統金鑰（`.system_key`）加密，不再依賴 `JWT_SECRET`（輪替 JWT_SECRET 不影響 NAS）。升級後第一次讀取時，系統會一次性把舊版明文或舊格式密文改以系統金鑰加密，可重複執行且不影響已轉換的資料。若舊密文已無法解密，該裝置會顯示「Password needs to be re-entered」，請編輯裝置重新輸入密碼；在此之前連線會明確失敗。
    *   測試連線時若密碼留空，僅在 IP / 主機與連接埠未變更時才沿用已儲存的密碼；否則請重新輸入。連接埠可清空（改用類型預設值）。Viewer 在 NAS Manager 僅能檢視共用與權限（唯讀）。
*   **Environments 全域環境清單**（`Settings > Environments`，介面文字為英文）：集中管理 IPAM、SSL、Database、Kubernetes、Scout、CMDB 等畫面共用的環境清單。所有登入者可讀取清單（供各畫面下拉選單使用），**只有 SuperAdmin 能新增 / 編輯 / 刪除**，每次變更都會留稽核紀錄。
    *   名稱 1–64 字元（前後空白自動去除）、不分大小寫不可重複；用途最多 256 字元；環境 ID 建立後不可變更。預設的 `Others` 不可更名或刪除，最後一個環境也不可刪除。
    *   **以環境 ID 儲存**：CMDB / Server List、IPAM 子網路與 IP、SSL 憑證、DB Inventory / 申請單、Kubernetes、Scout 監控、API Key、告警規則綁定、維護時段一律儲存環境 **ID**，畫面上的名稱是依 ID 從全域清單即時帶出（舊名稱欄位仍保留作為回復用）。因此改名後各畫面立即顯示新名稱，不需要串聯更新。找不到對應的環境時一律顯示 **Unassigned**（不會再默默顯示成 Production）。
    *   **旗標**：每個環境可設定 **Production**（各畫面的紅色 / 正式環境標示一律依此旗標，不再寫死 PRD / Production / TRUST）與 **Default**（恰好一個，預設為 `Others`；新增資料未指定環境時使用，例如 IPAM 新子網路、SSL 憑證）。Default 環境不可刪除，要更換請在另一個環境勾選 Default。
    *   **Usage（使用狀況）**：按「Show usage」或開啟 Edit / Delete 對話框時載入，列出各處引用數量（依環境 ID 計算；尚未轉換的舊資料仍以不分大小寫的名稱比對）。
    *   **改名**：「Also update references (N items)」現在只需處理仍以名稱儲存的 Prometheus 標籤（並順便更新各處保留的名稱副本）；取消勾選時，其他畫面仍會正確顯示新名稱。
    *   **刪除**：只要仍有任何引用（以環境 ID 判斷）就會被拒絕（HTTP 409，並附上 Usage），畫面上的 Delete 按鈕會停用；請先移轉或移除引用。
    *   **Unmapped values（未對應值）**：升級後系統會在啟動時自動把既有資料中的環境名稱（不分大小寫比對名稱、ID 或代碼）轉成環境 ID，每個來源只執行一次。無法對應的值保持原樣，並列在此區塊（依來源、值、筆數）；SuperAdmin 可逐一選擇目標環境後按 Apply，系統會更新該來源所有帶有此值的資料並寫入稽核。Prometheus 標籤僅列出供參考，不會自動改寫（請到 Prometheus SD 編輯）。
    *   **匯入驗證**：Server List Excel 比對匯入、IPAM 批次新增、Prometheus 文字匯入、Nutanix Clone VM 的環境欄位必須是清單中的環境（名稱、ID 或代碼，不分大小寫，會轉成正式名稱）；未知的值整列拒絕並顯示原因（Prometheus 文字匯入會列出行號），絕不套用預設值。
    *   **補充規則**：CMDB 與 Server List metadata 在 Unmapped values 中互相連動，套用其中一邊時同一批 IP 會一併指定，之後的 Sync All、掃描或未填環境的 Excel 匯入都不會把對應結果改回；自動來源傳入空白或未知的環境值時，不會覆蓋已有效的環境。轉換或套用時，原本的文字會另外保留（`envRaw` / `environmentRaw`）供回復與稽核。`Unassigned` 與 `(empty)` 是保留字，不能當作環境名稱。編輯環境為 Unassigned 的 DB Inventory / Kubernetes 項目時，不選環境即維持原狀；Inventory 自動加入的 Prometheus 目標，zone 取自該主機的 CMDB 環境，否則使用 Default 環境；Prometheus 文字匯入會回報被略過的行（非 IP、重複）。
    *   **HM_checker**：環境清單只來自全域 Environments；未儲存過「略過環境」設定時，預設略過 DEV 與 SIT（以環境 ID 儲存，比對不分大小寫）。

---

## 9. 前後端技術架構與部署
- **Frontend**: React 18, Vite, Vanilla CSS (Glassmorphism), Axios
- **Backend**: Node.js, Express.js, Native Local Time Engine, better-sqlite3 / node:sqlite
- **Security**: AES-256-CBC, RBAC, RSAT Integration
- **OS**: Windows Server 2016 (WinSW 服務託管)

**© 2026 SOMP Vanguard Team**  
*Maintainer: Noel Huang*

---

## 🤖 AI Ops Agent（告警調查助理）

AI Ops Agent 以自然語言協助調查告警與排除故障。它只會**查詢**資料並提供建議，不會執行任何指令或修改設定。

### 啟用方式（SuperAdmin）
1. 「System Settings > AI Service」確認 AI 服務已啟用並設定好 Provider、Model 與 API Key。
2. 勾選「🤖 啟用 AI Ops Agent」，必要時指定支援工具呼叫的「Agent Model」，按 **Save AI Configuration**。
3. 按「🧪 測試 Agent 工具呼叫」，顯示 ✅ 即代表模型可用。
4. 在 RBAC 群組的功能權限中勾選「🤖 AI Ops Agent」，讓需要的使用者可以使用。

### 使用方式
- **告警一鍵調查**：在 Scout Monitor 的告警列表或 Alerts & Rules 的作用中告警，點選「🤖 調查」。
- **自由提問**：點選側邊欄底部的 🤖 按鈕開啟對話面板，例如「web-03 從下午兩點開始 CPU 很高，幫我查原因」。
- 調查過程會即時顯示每一個查詢步驟（可展開查看參數與結果摘要）。
- 結論下方的建議卡片可直接開啟對應的 Runbook 或 Workflow，由使用者自行確認後執行。
- 「🕘 歷史」可回到之前的對話繼續追問；對話保留 30 天、每人最多 50 個。
- 若 AI 服務回報請求次數已達上限（例如 Gemini 免費方案每分鐘 5 次），Agent 會依服務要求的時間自動等待並重試（最多 3 次，畫面會顯示倒數訊息）；已達每日額度時則直接提示。

### Agent 可查詢的資料
主機清單與 CMDB、Scout 指標（最多 7 天）、告警、Windows / Linux 日誌（最多 7 天）、CMDB 變更紀錄、SOP Runbook、Workflow 清單。每項查詢都依照使用者本身的功能權限檢查。

### 安全機制
- 送給 AI 服務前自動遮蔽密碼、Token、金鑰、連線字串等機密。
- 日誌內容一律視為不可信資料，Agent 無任何寫入或執行能力。
- 每人每小時提問次數有上限（預設 30 次），每次提問寫入稽核日誌。
- 提問通知預設**不推播**到 Telegram / Webhook。若需要，請在「Telegram 通知分類」或各 Webhook 的通知分類中勾選「🤖 AI Agent 提問紀錄」。


---

## 🔔 告警品質（Alert Quality）

減少誤報與通知洪水：維護時段、靜音、升級、抖動偵測、速率上限與總開關。位置：Alerts & Rules 分頁（🔧 Maintenance Windows、⚙️ Alert Settings）。介面文字為英文。

### ⚠️ v1.7.x 起指標與日誌告警開始生效
- **過去的問題**：指標告警（CPU / 記憶體 / 磁碟 / ping / tcp / 服務 / 程序）與日誌告警（Windows 事件 / syslog）在 web 程序從未被評估，正式機實際上只有「離線告警」有效。
- **本版起**：這些規則全部生效，綁定 Tag 的指標規則也會比對。**部署後會出現過去沒有的新告警，這是預期現象**，通知量可能增加。
- **建議上線流程**：
  1. 部署前在伺服器執行 `scripts\Alert_Preview.bat`（唯讀、不寫入、不通知），查看目前會觸發的主機 / 規則 / 值。
  2. 調整不合理的門檻或綁定。
  3. 部署。
  4. 第一個小時觀察稽核日誌（Audit log）與 Telegram 通知。
  5. 若太吵：Alerts & Rules → ⚙️ Alert Settings → 關閉「Alert evaluation (master switch)」，調整門檻後再開啟。
- **部署後的行為變化**：
  - 啟動時殘留為 alerting、但已無對應告警列的狀態會靜默重設（不會誤送「已恢復」）；已確認（Acknowledge）的告警保留原狀態。
  - 超過 7 天的已恢復告警由 worker 分批清除（啟動後 2 分鐘首次執行，之後每小時）。過去此清除從未有效執行，**部署後較舊的已恢復歷史會消失**。
  - Dashboard 即時回報更新每台主機最多每 15 秒一次。

### 🔧 維護時段（Maintenance Windows）
Alerts & Rules →「🔧 Maintenance Windows」→「+ New Maintenance Window」新增；可 Edit / Disable（Enable）/ Delete。期間告警**照常記錄**（畫面可見、標示 🔕），但不送通知。
*   **單次**：指定開始與結束時間（結束需晚於開始，最長 31 天）。
*   **每週固定**：選擇星期、起始時間（伺服器本地時間）與持續分鐘（1–10080，可跨午夜）。
*   **範圍**：全部、指定主機、Tag 或環境（最多 500 項）。
*   **限定規則**：可只靜音特定規則；留空代表範圍內所有規則（含離線告警）。
*   維護結束後若告警仍未恢復，會補送一次「🔧 維護結束後仍異常」通知。
*   Scout Monitor 主機列表中，維護中的主機會顯示 🔧。

### 🚫 排除主機（Excluded Hosts）
規則以環境、Tag 或 API Key 套用時，可針對少數主機**排除**，讓該規則完全不在這些主機上執行。位置：Scout Monitor、Alerts & Rules、Agents 的規則頁籤，「🔗 Rule Assignments」下方的「🚫 Excluded Hosts」區塊（Operator / SuperAdmin 可新增 / 移除，Viewer 唯讀）。
*   **新增**：「Exclude host…」→ 選擇規則 →「Hosts」（可搜尋名稱 / IP / Tag、可多選）或「Tag」（1–64 字元，之後才加上此 Tag 的主機也會被排除）→ 選填原因（最多 500 字）→「Exclude」。
*   **效果**：被排除的主機**不評估**該規則：不產生告警、不通知、不記錄抑制、不計入抖動 / 升級；Agent 也不再收到該規則的 ping / tcp / 服務 / 程序監看目標與自我修復腳本。指標、離線、日誌（含未綁定的全域日誌規則）規則一律適用。
*   **排除優先**：即使該主機另有「直接」綁定同一規則，排除仍然生效（新增時畫面會警告）。要恢復請移除排除。
*   **既有告警**：新增排除時，該規則在這些主機上未處理的告警會自動結束（標記 🚫 Excluded，不送「已恢復」通知），相關計數狀態一併清除。主機之後才加上被排除的 Tag（主機編輯或批次更新）時同樣處理；Worker 每分鐘也會再檢查一次，被排除的組合不會升級、不送維護結束補通知或抖動恢復通知。已排入「📦 告警摘要」的訊息仍會隨下一則摘要送出一次。
*   **離線規則**：主機被排除其離線規則時不發離線告警；Dashboard 的離線判定改用預設門檻（5 分鐘或 3 倍回報間隔取大者）。
*   **多條離線規則（行為變更）**：同一主機適用多條離線 / 連線規則時，以最明確的綁定為準：直接指定主機 > API Key > Tag > 環境（過去依建立順序）。
*   **清單**：每條規則列出被排除的主機（名稱 / IP）或 Tag、原因、建立者與日期，可按 × 移除（移除後規則立即恢復適用）。
*   **主機明細**：主機詳細視窗的 Rules 分頁顯示「🚫 Excluded from: 規則名稱」，被排除的規則以刪除線與 EXCLUDED 標示。
*   **預估觸發**（🔍 Preview Alerts / `scripts\Alert_Preview.bat`）同樣排除這些主機。
*   刪除規則會一併刪除其排除設定；刪除 Scout 主機或在 Server List 刪除主機時，一律刪除該主機的排除設定（Tag 排除保留）。每次新增 / 移除都寫入稽核日誌（使用者、規則、主機或 Tag、原因）。
*   維護時段不受影響，兩者可並用：維護時段 = 照常記錄但不通知；排除 = 完全不評估。

### 🔕 快速靜音
告警列表（Scout Monitor Alerts 分頁、Alerts & Rules）每則告警有「🔕 Mute」按鈕（僅 Operator / SuperAdmin 可見，「🔍 Preview Alerts」亦同），可選 1 h / 4 h / 24 h，會自動建立僅限該主機與該規則的單次維護時段。

### 告警標記
| 標記 | 意義 |
|---|---|
| 🔕 | 維護中，已記錄但不通知 |
| 〰️ | 不穩定（抖動），暫停通知 |
| ⏱ | 冷卻中：冷卻時間內的同一告警，不重複通知 |
| ⏫ | 已升級通知 |
| 📦 | 已合併：超過每分鐘速率上限，已併入「📦 告警摘要」通知（此標記指「已包含在摘要通知中」） |
| ×N | 日誌告警重複命中 N 次（同一未處理告警累計，不新增列） |
| 🚫 | 因主機被排除於該規則而自動結束（未送恢復通知） |

### ⏫ 升級設定
*   規則編輯視窗「Escalate if unresolved for N minutes (blank = never)」：空白或 0 = 不升級。
*   目的地於 Alerts & Rules → ⚙️ Alert Settings 設定（「Escalation destinations」），全域共用，可各自啟用：Telegram 群組、Email、Webhook。所有可開啟 Alerts & Rules 的使用者皆可檢視，僅 SuperAdmin 可修改（其他人唯讀，並顯示 Only SuperAdmin can change these settings.）。
*   只升級**一次**；僅限存在時間介於 N 分鐘到 N 分鐘 + 24 小時、且主機為啟用狀態的告警；維護中或抖動中不升級。
*   每分鐘最多逐則送 10 則，其餘合併為 1 則摘要。Telegram 升級不受「Telegram 通知分類」限制。
*   「處理」= Acknowledge 或告警自動恢復。

### 抖動與速率上限
*   **抖動**：同一主機＋規則在視窗時間內狀態切換達門檻次數（預設 30 分鐘內 4 次）→ 標示 〰️，送 1 則「不穩定」通知後暫停觸發 / 恢復通知；穩定（預設 30 分鐘無變化）後送出恢復穩定通知。
*   **冷卻**：同一主機＋規則的觸發 / 恢復通知各自冷卻（預設 15 分鐘），重啟服務不會歸零。
*   **速率上限**：全系統每分鐘通知超過上限（預設 10）時，超出的合併為每分鐘 1 則「📦 告警摘要」（最多 20 行、3500 字元）。維護結束的補通知也計入上限。
*   以上抑制的告警仍會寫入告警列表，可查核原因。

### 告警評估總開關
Alerts & Rules → ⚙️ Alert Settings →「Alert evaluation (master switch)」：關閉（需確認）後停止評估與通知（主機上下線狀態仍更新）。web 程序立即生效，worker 最多 30 秒，不需重啟。

### 🔍 預估觸發（Preview Alerts）
Alerts & Rules → Alert Rules →「🔍 Preview Alerts」（Operator / SuperAdmin），或伺服器執行 `scripts\Alert_Preview.bat`。
*   唯讀：以每台**啟用**主機最新一筆指標套用**指標規則**，不寫入、不通知。
*   超過 10 分鐘未更新的指標會略過並計入「過期」；無指標資料的主機另計。
*   日誌規則與離線規則無法預估；實際觸發仍需連續達到規則的 alertHits 次數。
