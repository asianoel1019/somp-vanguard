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
   - [AD Control：帳號管理](#-ad-control帳號管理)
   - [AD Control：Group Policy 管理](#-ad-controlgroup-policy-管理)
   - [AD 密碼到期通知](#-ad-密碼到期通知)
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
    *   權限控制：帳號必須在 `Settings > RBAC` 有對應（AD 群組、OU 或直接指定帳號），且角色不是 `None`，才能登入；沒有任何對應的帳號會被拒絕。
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
*   **Web Remote（RDP / SSH）連線安全**：
    *   連線 token 改為 AES-256-GCM 加密並驗證完整性，**30 秒內有效、只能使用一次**；被複製或出現在記錄中的連線網址無法再開啟第二個連線。重新連線會自動取得新的 token。金鑰由 `JWT_SECRET` 另行衍生，未設定 `JWT_SECRET` 時無法使用 Web Remote。
    *   目標只接受 IP 位址（IPv4 / IPv6）或主機名稱，埠號須為 1–65535，RDP 安全模式只接受 Any / NLA / TLS / RDP。
    *   稽核紀錄由伺服器自動寫入：申請連線、連線成功、斷線（含連線時間長度）、無法建立連線（含原因），不再依賴瀏覽器回報；原本可由瀏覽器寫入任意稽核內容的 `/api/remote/audit-event` 已移除。
    *   遠端畫面以視窗實際大小開啟（不再固定 1024×768 再縮放），調整視窗大小或切換全螢幕時，RDP 桌面與 SSH 終端機會跟著調整。
    *   修正重新連線後鍵盤每個按鍵會送出兩次的問題，以及「重試」可能使用修改前網域的問題。
    *   guacd 連不到時只顯示警告，不再自動改連本機的 guacd。
    *   後端只對網路中斷與 Guacamole / WebSocket 本身的錯誤容錯；其他未處理的錯誤會讓服務結束並由服務管理程式重新啟動，不再帶著不一致的狀態繼續執行。
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
*   **歷史與重試**：History 分頁上方顯示近 30 天的工作數、執行中、處理主機數、主機成功率與失敗主機數；可依工作 ID、建立者、範本、主機 IP / 名稱搜尋，並依狀態（Running / Done / Partial / Failed / Cancelled）與作業系統篩選；表格每列顯示成功 / 失敗比例，點一列從右側開啟工作詳情（Esc 或 X 關閉），清單中有執行中的工作時每 15 秒自動更新。「Retry failed hosts」建立新工作，只含 failed / interrupted / skipped 主機，並重新檢查是否為已知目標（不會繼承未知目標覆寫，SuperAdmin 需明確再次允許）。
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

### ⚡ Live Event Viewer / Log Settings 效能與 scout.sqlite 維護
*   **Live Event Viewer**：
    *   預設只讀最新的 100 筆事件，**不再自動讀取壓縮歸檔**；需要時勾選「Include archives」（只讀最新的 14 個歸檔檔）。
    *   搜尋在停止輸入約 0.6 秒後才送出（以前每打一個字就搜尋一次）。伺服器由新到舊分段搜尋，找到 200 筆、搜完全表或約 8 秒後停止，期間不會讓整個網站停住；沒搜完全表時頁面會提示「只涵蓋最新的事件」。
    *   瀏覽器分頁在背景時暫停每 5 秒的自動更新；SIEM Analytics / On-Demand Forensics 分頁不再在背景輪詢事件。
    *   SIEM Analytics 的統計（總數、前幾名主機與 Event ID、趨勢）每張表只讀一次、分段計算，期間不會讓網站停住；同一時間範圍的統計保留 60 秒（輸入搜尋字不會重算）。「最新重大事件」與搜尋結果每次都即時查詢。
*   **日誌輪替（Log Settings > Rotation）**：
    *   改由背景 worker 每 30 分鐘執行（服務啟動 5 分鐘後第一次），每批只處理約 1,000 筆、批次之間讓出執行緒，不再在網頁程序中一次刪除大量資料而讓網站停住。歸檔檔每個最多 20,000 筆。
    *   「Run now」只會請背景 worker 開始執行並立即回應；進度與結果寫在服務日誌（`[Log Rotation]`）。
    *   `maxRecords` 依寫入順序保留最新的筆數。
*   **Vacuum 按鈕**：SQLite 資料庫超過 2 GB 時會拒絕執行（VACUUM 會讓整個服務停住很久），請改用下方的維護腳本在停機時段處理。
*   **效能紀錄**：服務日誌會記錄
    *   `[DB Slow] <毫秒> <類型>: <SQL>`：單次資料庫操作超過 500 毫秒（`DB_SLOW_QUERY_MS` 可調整；只記錄 SQL 語句，不含參數值）。
    *   `[Event Loop] web|worker blocked ~<毫秒>; DB: <次數> call(s), <毫秒> in total`：程序被卡住超過 1 秒（`EVENT_LOOP_BLOCK_MS` 可調整），附上這段時間的資料庫操作次數、總耗時、耗時最多的 3 種語句（`top: <毫秒> <次數>x <語句>`）與最慢的一個。資料庫總耗時很少時，代表卡住的是其他運算（例如 JSON 處理）。用來找出頁面變慢的原因。
    *   Agent 回報的資料由寫入佇列分批寫入，每個交易最多 200 筆、且不超過 `DB_FLUSH_BUDGET_MS`（預設 50 毫秒），交易之間讓出執行緒，讓頁面請求可以穿插處理。
*   **維護腳本 `backend\scripts\scoutDbOptimize.bat`**（在 Vanguard 主機上執行）：
    *   不加參數：只產生報告，不做任何變更。內容包括檔案與 WAL 大小、空頁比例、`metrics` / `windows_events` / `linux_logs` 的筆數範圍與索引、重複的索引，以及 VACUUM 需要的磁碟空間。
    *   `--drop-duplicates`：刪除重複的索引（同一張表、相同欄位的索引；保留服務自己建立的那個，唯一索引與主鍵一律不動）。舊版維護流程會建立重複索引，每筆寫入都要多更新一份。
    *   `--vacuum`：重寫資料庫以回收空頁並縮小檔案。需要約「已使用空間 × 1.1」的可用空間，資料庫所在磁碟與執行帳號的 TEMP 資料夾（通常在 C:）各一份（同一顆磁碟則要兩份），報告會列出兩處的剩餘空間，不足時拒絕執行；大型資料庫可能需要一小時以上，執行中不可中斷。
    *   會先確認：`somp-vanguard` 服務已停止，且沒有其他程序正在使用資料庫，否則不做任何變更；執行前會詢問確認（`--yes` 可略過），`--db <路徑>` 可指定其他檔案。
    *   建議流程：先執行一次不加參數看報告 → 停止服務 → `scoutDbOptimize.bat --drop-duplicates --vacuum` → 啟動服務。

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

### 🔐 Data Center 編輯規則（v1.7.7）
*   **權限**：所有新增 / 修改 / 刪除（機房、機櫃、硬體問題、備品、合約）需 Operator 以上；刪除機房與永久刪除合約僅限 SuperAdmin。Viewer 只能檢視。
*   **機房逐筆儲存**：新增與編輯只影響該機房，不會再把整份清單送回覆蓋。刪除機房需 SuperAdmin，並輸入機房名稱確認；刪除會一併移除該機房的機櫃與設備、在 IPAM 釋放其 IP、刪除 SNMP 設定，且立即生效。
*   **多人同時編輯機櫃**：每座機房的機櫃資料有版本號。若你開著畫面期間別人已修改同一座機房（包含 Network Device 畫面調整設備），你的下一次儲存會被拒絕並提示「資料已被其他人修改」，畫面自動載入最新資料，**你這次的變更不會儲存**，請重新操作一次。不會再覆蓋別人的設備或誤釋放 IP。
*   **儲存前檢查**：新增或修改的設備會檢查 U 位重疊、超出機櫃高度、跨越 Split 機櫃的上下分界與設備 ID 重複；未修改的舊資料不受影響。直立式 PowerBar 不佔 U 位，不算重疊。注意：以前若有設備跨越 Split 分界，修改該設備或該機櫃的高度 / 分界設定時會被拒絕，需先調整位置。
*   **備品庫存**：數量一律由伺服器計算，入庫 / 出庫送出的是異動數量；出庫超過庫存會被拒絕。編輯備品只能修改名稱、型號等資料，數量請用入庫 / 出庫。新增備品可設定初始庫存（記為一筆入庫）。
*   **報修使用備品**：在硬體問題選用備品時會扣除庫存並記入該備品的異動紀錄；庫存不足時整筆報修不會儲存。同一次選用即使重送也只扣一次。

### 📜 Contracts & Warranties 合約與保固
*   **畫面**：上方切換硬體保固 / 軟體授權 / 垃圾桶（附筆數）。統計卡顯示有效、60 天內到期、已過期（點卡片即篩選，再點一次取消）、90 天內待續約（金額依幣別分列）與進行中合約的費用。**不同幣別不會相加**，各自顯示。可依狀態、廠商篩選，依到期日 / 名稱 / 廠商 / 金額 / 最近修改排序，搜尋可找名稱、廠商、序號、授權金鑰、備註與連結設備名稱。表格與卡片兩種檢視，「Export CSV」匯出目前清單。
*   **詳細資料**：點一列從右側開啟抽屜：期間進度、序號、聯絡窗口、授權座位使用量、授權金鑰（預設遮蔽，可顯示 / 複製）、連結設備（可「Show in rack」直接跳到機櫃）、這些設備的硬體問題、附件下載、備註與建立 / 修改紀錄。
*   **連結設備**：可連結所有機房的設備（依機房、機櫃分組，可搜尋）。硬體保固連結第一台設備時，若序號空白會自動帶入該設備的 SN。硬體保固需填序號或連結設備，Hardware Issues 才找得到它。
*   **授權座位**：可手動填「已使用」數量；未填時以連結設備數計算，超過座位數會標紅。
*   **續約**：按「Renew」會帶入同樣的內容，期間自動接在舊合約到期日之後、長度相同。儲存後舊合約保留為歷史並標記「Renewed」，不再列入到期提醒；兩筆可互相跳轉。
*   **多人同時編輯**：若你開著表單期間別人已修改同一筆合約，儲存會被拒絕並提示，你的變更不會覆蓋對方，請關閉表單重新開啟後再改。
*   **附件**：接受 PDF、DOCX、PNG、JPG，5 MB 以內（依檔案內容判斷類型）。更換或移除附件時，舊檔案會一併刪除。中文檔名下載時保持原名。
*   **垃圾桶**：移到垃圾桶可隨時還原；永久刪除僅限 SuperAdmin，且只能刪除垃圾桶裡的合約（附件一併刪除）。
*   **到期通知**：背景 Worker 每小時檢查一次（伺服器本地時間 `CONTRACT_NOTIFY_HOUR` 點之後，預設 9），合約到期前 `CONTRACT_NOTIFY_DAYS` 天（預設 `60,30,7`；設為 `off` 關閉）以 Telegram 發送一則彙整通知。每筆合約在每個天數只通知一次，首次啟用時只通知最接近的一個天數；到期後一週內會再通知一次「已過期」。修改到期日會重新計算；已續約、在垃圾桶的合約不通知。通知走 General Logs 類別，需在 Telegram 通知設定中啟用該類別。首頁的到期提醒同樣排除已續約與垃圾桶中的合約。

### 🖧 Network Device 與 SNMP 查詢（v1.7.7）
*   **SNMP 查詢開關**：每台設備的 SNMP 設定有「啟用 SNMP 查詢」（Network Device 的「基本資料 & SNMP」頁籤、Server Rack 設備的 SNMP 頁籤）。停用時系統完全不會對該設備發出 SNMP 查詢，查詢按鈕隱藏，Ports & Cables 改為手動維護。從未設定過 SNMP 的設備視為停用（不再預設以 `public` 查詢）；升級前已儲存過 SNMP 設定的設備維持啟用。
*   **查詢一律使用已儲存的 IP**：SNMP 查詢只會對機櫃資料中儲存的設備 IP 發出；表單上修改 IP 後須先儲存才能查詢。
*   **SNMP 版本**：支援 v1、v2c、v3（v3 為 SHA + AES、authPriv）。舊版選 v2c 實際卻以 v1 查詢，已修正。啟用時 v1 / v2c 必須填 community；v3 必須填使用者名稱，且 auth / priv 密碼至少 8 字元。停用時可先不填。
*   **設備管理**：新增設備由伺服器產生 ID，並檢查類型、IP 格式、U 位重疊、機櫃高度與 Split 分界（不符合回 400）。修改 IP 時會在 IPAM 釋放舊 IP、登記新 IP；未填的欄位維持原值。刪除設備時會釋放 IP 並刪除該設備的 SNMP 設定。
*   **注意**：Server Rack 中尚未儲存到機櫃的新設備無法先存 SNMP 設定，請先儲存設備。

### 🔌 Network Device 廠牌整合（唯讀）
*   **設備列表**：上方統計卡顯示全部設備、連線正常、連線異常（有異常時整張卡標紅）、未設管理連線、SNMP 未設定的數量，點卡片即篩選該類（再點一次取消）。類型標籤（Firewall / Switch / Router / LoadBalancer，附台數）可快速切換；搜尋可找主機名稱、IP、廠牌、型號；機房下拉保留。列表每列前方有狀態燈號（綠＝正常、紅＝異常、黃＝尚未讀取、空心＝未設定或停用），連線異常的設備排在最前面並整列標紅，「廠牌 / 型號」下方顯示錯誤原因與發生時間（滑鼠移上可看完整訊息），或最後讀取時間。設備視窗標題也顯示同樣的狀態與廠牌型號。
*   **設備視窗分頁**：分成三組。「即時狀態」是經管理連線讀取的資料（Overview、Interfaces 等，依廠牌與設備類型顯示，未設定或停用管理連線時不出現）；「SNMP」是連接埠、ARP、MAC（SNMP）輪詢結果，未啟用 SNMP 時分頁變淡；「設定」是基本資料 & SNMP、管理連線與設定備份（Operator 以上）。「管理連線」上次讀取失敗時標紅點，SNMP 啟用但未填 Community / v3 帳號時「基本資料 & SNMP」標黃點。Switch 有兩個 MAC 分頁：「MAC 表」由管理連線讀取（可對應 CMDB 主機），「MAC（SNMP）」由 SNMP 輪詢。
*   **用途**：在設備視窗的「管理連線」頁籤設定廠牌 API 連線後，可直接在 Vanguard 讀取設備資料：Overview（型號、韌體、序號、CPU / 記憶體 / Session 數）、Interfaces、Policies（含命中次數與最後命中時間，可搜尋、分頁）、Routes、Sessions、VPN（IPsec 通道與 SSL VPN 使用者）、HA。全部為唯讀，不會修改設備設定。
*   **目前支援**：Firewall 的 **Fortinet FortiGate**（FortiOS REST API）、**Palo Alto Networks**（PAN-OS XML API）與 **Check Point**（Management API）。Cisco、Juniper、F5 已列在廠牌清單中，標示「尚未支援」，後續版本陸續提供。
*   **FortiGate 設定方式**：在 FortiGate 的 System → Administrators 建立 REST API Admin，指派**唯讀**的 admin profile，並把 Trusted Hosts 設為 Vanguard 伺服器的 IP；把產生的 API token 貼到 「管理連線」頁籤。多 VDOM 的設備可填 VDOM 名稱（留空用設備預設）。先按「Test Connection」確認可連線（不會儲存），再按「Save Connection」。
*   **Palo Alto 設定方式**：在 Device → Admin Roles 建立只開 XML API 讀取（Operational Requests、Configuration 唯讀）的角色並指派給 API 帳號，再用該帳號產生 API key 貼到「API Key」。也可以不填 key、改填帳號密碼：Vanguard 會用 POST 向防火牆換取 key（不會出現在網址），key 只存在記憶體，失效時自動重新換取。多 vsys 的設備可填 vsys 名稱（留空用 vsys1）。Policies 讀取的是**執行中**的 security rulebase，ID 欄為規則順序；Panorama 推送的 pre / post 規則目前不列出。Sessions 的 POLICY 欄顯示規則名稱。
*   **Check Point 設定方式**：Check Point 透過**管理伺服器**（Security Management 或 Multi-Domain Server）讀取，管理位址請填管理伺服器，不是 Gateway。在 SmartConsole 建立唯讀權限的管理員（Permission Profile 設為 Read Only），填帳號密碼或 API key；Vanguard 一律以唯讀模式登入，Session 存在記憶體重複使用。Multi-Domain 環境請填 Domain 名稱。「Gateway 名稱 / IP」填這台設備在 SmartConsole 的 Gateway 或 Cluster 物件名稱（管理伺服器只有一台時可留空；有多台卻沒填時，畫面會列出可選的名稱）。提供 Overview、Interfaces（設定值，無連線狀態）、Policies（已安裝政策套件的第一個 Access Layer，含 Section 與命中次數，最多讀 5000 條）與 HA（Cluster 成員設定，不含目前 Active 是哪台）。管理 API 沒有 Gateway 的即時路由、Session 與 VPN 狀態，因此不提供這些頁籤。
*   **Token 保護**：token、API key 與密碼加密儲存，畫面與 API 一律只顯示遮罩；修改其他欄位時保持遮罩即沿用原 token。**變更管理位址、埠號或廠牌時，原 token 不會帶到新位址，必須重新輸入。**
*   **憑證驗證**：設備多半使用自簽憑證，預設不驗證；勾選「驗證設備憑證」並貼上簽發設備憑證的 CA（PEM）即可改為驗證。
*   **權限**：Viewer 可檢視資料；Operator / SuperAdmin 可設定、測試與移除連線（皆記入稽核紀錄）。刪除設備時其管理連線一併刪除。
*   **讀取頻率**：同一份資料 30 秒內重複開啟會使用快取（畫面顯示資料時間），按「Refresh」強制重新讀取；同一台設備同時只會送出一份相同的請求。Sessions 必須填來源 IP、目的 IP 或目的埠至少一項，最多顯示 500 筆。
*   **設定備份頁籤**：Operator 以上可按「Back Up Now」立即備份並查看備份清單（時間、大小、行數、執行者）；**查看內容、比對差異、下載限 SuperAdmin，且都記入稽核紀錄**，因為備份含加密後的密碼與 VPN 預先共享金鑰。FortiGate 備份完整設定檔（VDOM 範圍的 token 只備份該 VDOM），Palo Alto 備份執行中的 XML 設定，Check Point 備份 Gateway 物件與已安裝政策套件的所有 Access Layer（JSON，不含 Gaia 系統設定，已去除修改時間與命中次數等每次都會變的欄位）。內容與上一份相同時不另存新檔，只更新「Last checked」時間，因此保留的份數都是真正不同的版本。勾選兩份後按「Compare Selected」可看差異（舊 → 新）。
*   **備份檔案與保留**：檔案存於 `<DB_DATA_DIR>\netdevice_backups\<設備ID>\`，每台保留最近 `NETDEVICE_BACKUP_KEEP` 份（預設 30，1–365），刪除設備時其備份一併刪除。
*   **排程備份**：在 System Settings 的備份區設定 `NETDEVICE_BACKUP_SCHEDULE`（HH:MM，伺服器本地時間；留空 = 關閉），由背景 Worker 每天對所有已啟用管理連線的設備依序備份。當天是否已執行會記錄下來，重啟不會重跑；Worker 在設定時間一小時後才啟動則跳過當天。
*   **從機櫃圖 / 拓撲圖開啟**：Server Rack 的設備視窗與 Topology Map 的設備側欄，對 Switch、Router、Firewall、Load Balancer 顯示「🖧 Open in Network Device」，按下後切到 Network Device 並直接開啟該設備（已設定管理連線時開在 Overview，否則開在 基本資料 & SNMP）。只有具備 Network Device 功能的使用者看得到這個按鈕；Server Rack 視窗中尚未儲存的修改不會保留。
*   **錯誤訊息**：token 錯誤或過期、權限不足、連不到設備、憑證驗證失敗、韌體不提供該資料，畫面會分別提示處理方式。設備清單的「MANAGEMENT」欄顯示廠牌、型號、韌體版本與最後一次連線狀態（滑過可看錯誤原因）。

### 🔀 Network Device：Switch 整合（Cisco IOS / IOS-XE，唯讀）
*   **連線方式**：IOS-XE（16.x 以後，如 Catalyst 9000）可走 **RESTCONF**（HTTPS，填在「API Port」，預設 443，Switch 上需 `restconf` 與 `ip http secure-server`）；舊版 IOS 或沒開 RESTCONF 的設備走 **SSH**（只執行固定的 `show` 指令，絕不進入設定模式）。「管理連線」頁籤選「Cisco IOS / IOS-XE」，填管理位址、API Port、SSH Port（預設 22）、帳號密碼；SSH 登入後權限不到 15 級時，另填「Enable 密碼」供設定備份使用。
*   **「連線方式」選項**：「只用 API」、「只用 SSH」只走該方式；「自動」先用上次成功的方式（第一次先試 RESTCONF），設備沒回應或沒開 RESTCONF 才改用 SSH，並記住能用的方式（「管理連線」頁籤下方顯示「自動判斷目前使用」）。帳密錯誤、權限不足、憑證錯誤**不會**改試 SSH，避免同一組帳密連試兩次被鎖。儲存或「測試連線」後會重新判斷；測試結果會標示實際用的方式（API / SSH）。
*   **設定備份**：一律走 SSH（RESTCONF 沒有純文字設定）；只開 RESTCONF、SSH 連不到時，設定備份 會提示到設備上開啟 SSH。
*   **建議帳號**：RESTCONF 需要 privilege 15 帳號；若現場政策不允許，改用「只用 SSH」，並以 `parser view` 或 AAA 授權限制只能執行 show 指令。設定備份需要能執行 `show running-config`（privilege 15 或 Enable 密碼）。
*   **SSH 主機金鑰**：第一次連線時記住設備的金鑰指紋，之後指紋不同就拒絕連線（不會送出密碼）並顯示「主機金鑰與第一次連線時不同」。確認設備確實更換或重新產生金鑰後，在 「管理連線」頁籤按「重設主機金鑰」（Operator 以上，記入稽核紀錄）。
*   **分頁**：Overview（型號、韌體、序號、運作時間、堆疊成員）、Interfaces（狀態含 err-disabled、模式 access / trunk / routed、VLAN、錯誤計數 input / CRC / output、Discards、收送速率；可只看有錯誤或非 up 的 Port）、VLAN（Access 成員與允許通過的 Trunk）、MAC 表（可用任何格式的 MAC、Port、VLAN 搜尋，最多顯示 1000 筆，並標示每個 Port 學到幾個 MAC，學到 10 個以上的多半是 uplink / trunk）、設定備份（running-config，已去除「Last configuration change」等每次都會變的行）。Router 類型只顯示 Overview、Interfaces 與 設定備份。
*   **注意**：錯誤計數為自上次 `clear counters` 以來的累計；速率為設備回報的平均值（IOS 預設 5 分鐘）。走 RESTCONF 時看不到 err-disabled 狀態（顯示為 down），需要時改用「只用 SSH」。同一台 Switch 同時只會開一條 SSH 連線，避免佔滿 vty 線路。

*   **MAC 對應主機**：MAC 表的「HOST (CMDB)」欄顯示 Server List / Inventory 掃描記錄的 MAC 所屬主機（主機名稱與 IP，同一個 MAC 最多列 3 台，已刪除的主機不列）。IPAM 不記錄 MAC，因此只用 CMDB；未掃描或沒有 MAC 紀錄的設備顯示「-」。主機清單每分鐘更新一次。此欄適用所有 Switch 廠牌。

### 🔀 Network Device：Switch 整合（Cisco NX-OS / Nexus，唯讀）
*   **連線方式**：「管理連線」頁籤選「Cisco NX-OS」。API 為 **NX-API**（設備上需 `feature nxapi`，HTTPS，填在「API Port」，預設 443）；SSH 只執行固定的 `show … | json` 指令（需 NX-OS 7.x 以上）。「連線方式」的「自動」規則與 IOS 相同：先試 NX-API，設備沒回應或沒開 NX-API 才改用 SSH；帳密錯誤、權限不足、憑證錯誤不會改試。
*   **建議帳號**：角色 `network-operator`（唯讀）即可讀取所有分頁與設定備份，不需 Enable 密碼。
*   **分頁**：Overview（型號、版本、序號、運作時間、CPU、記憶體；模組化機箱列出各 Slot 板卡）、Interfaces（Port 名稱以 NX-OS 短名 Eth1/1、Po10 顯示，狀態含 err-disabled）、VLAN、MAC 表、設定備份（running-config，已去除 `!Time:` 等時間行；走 NX-API 或 SSH 皆可）。
*   **注意**：速率為 NX-OS load-interval 1 的平均值（預設 30 秒）。

### 🔀 Network Device：Switch / Router 整合（Juniper Junos，唯讀）
*   **連線方式**：「管理連線」頁籤選「Juniper Junos」。API 為 **Junos REST API**（設備上需 `set system services rest https`，HTTPS，填在「API Port」，預設 **3443**）；SSH 只執行固定的 `show … | display json` 指令（需 Junos 14.2 以上）。「自動」規則與 Cisco 相同：先試 REST API，設備沒回應或沒開 REST 才改用 SSH；帳密錯誤、權限不足、憑證錯誤不會改試。
*   **建議帳號**：login class `read-only` 即可讀取所有分頁與設定備份。
*   **分頁**：Overview（型號、版本、序號、運作時間、CPU、記憶體；Virtual Chassis 列出各成員與 master / backup 角色）、Interfaces（只列實體 Port、ae、管理介面與 irb 的各 unit，如 `irb.10`）、VLAN、MAC 表（EX2300 / 3400 / 4300 以後、QFX 等 ELS 平台；舊版 EX 的 VLAN、MAC 格式不支援）、設定備份（`show configuration | display set`，已去除「## Last commit」行；一律走 SSH）。Router 類型只顯示 Overview、Interfaces 與 設定備份。
*   **注意**：Junos 回報的是當下速率，不是區間平均；錯誤計數的 CRC 取自 MAC 統計（沒有時用 framing errors）。

### ⚖️ Network Device：Load Balancer 整合（F5 BIG-IP，唯讀）
*   **連線方式**：設備類型為 LoadBalancer 時，「管理連線」頁籤選「F5 BIG-IP」，填管理位址、Port（預設 443）、帳號密碼。Vanguard 以 **iControl REST** 登入取得 token（只存在記憶體，快到期時自動重新登入），之後只做讀取，不執行任何指令、不改任何設定。
*   **登入來源**：本機帳號用 `tmos`（預設）；遠端驗證（LDAP / RADIUS / TACACS）帳號填 F5 上的 provider 名稱。
*   **Partition（選填）**：填了只看該 partition 的 Virtual Server；留空看全部 partition。
*   **建議帳號**：F5 角色 `Auditor`（唯讀）。帳號登入被拒且訊息提到 token 時，可能是同帳號的有效 token 太多，稍候（約 20 分鐘）再試。
*   **分頁**：Overview（平台、版本與 Build、序號、CPU、記憶體）、HA（本機角色 Active / Standby、Device Group、同步狀態 In Sync / Changes Pending、各設備角色與管理位址）、Virtual Servers（燈號：綠＝可用、黃＝暫不可用如連線數上限、紅＝離線、藍＝未知、灰＝停用；目的 IP:Port、協定、Pool、目前連線數、累計流量；可用名稱 / IP / Pool 搜尋、只看非綠燈；滑鼠移到列上顯示狀態原因）。
*   **Pools**：列出每個 Pool 的燈號、成員上線數 / 總數（有成員沒上線時標黃）、負載平衡方式、monitor、目前連線數；可搜尋 Pool 名稱、只看非綠燈。點選 Pool 展開成員明細：每個成員的燈號、monitor 狀態、啟用狀態（enabled / disabled / forced-offline）、連線數、流量與狀態原因（例如被 monitor 標記為 down）。成員明細在展開時才讀取。
*   **Certificates**：依到期日排序列出 SSL 憑證（名稱、Common Name、簽發者、到期日），已過期標紅、30 天內到期標黃；可只看已過期或快到期的。CA bundle（如 `ca-bundle.crt`）只列出、不計入快到期數量。
*   **設定備份（設定快照）**：iControl REST 無法以唯讀權限取得 tmsh 文字設定，因此備份存的是 **JSON 設定快照**：Virtual Server、Pool（含成員）、Node、Monitor（http / https / tcp / icmp / gateway-icmp）、client-ssl / server-ssl / http Profile、iRule、Data Group、SNAT、SNAT Pool、Self IP、VLAN、Route，依名稱排序，並去除版本連結、generation 等會自行變動的欄位；Pool 成員與 Node 的 monitor 結果（up / down）屬於狀態不是設定，不存，只保留 forced offline。帳號讀不到的項目列在 `_skipped`。沿用手動 / 排程備份、內容相同不重存、差異比對（SuperAdmin 查看並稽核）。**快照用於追蹤變更，不能直接還原設備；完整還原請使用 F5 的 UCS 備份。**
*   **注意**：Route domain 的位址顯示為 `IP%編號`，IPv6 以 `.` 分隔 Port（F5 的寫法）。

### 🕸️ Topology Map 網路拓撲視覺化
*   **自動拓撲繪製**：依據 Port Links 自動生成拓撲連線圖。
*   **雙向連線同步**：配置線路時自動建立回程連線；拔線時自動雙向清除。
*   **一條實體線只畫一條（v1.7.7）**：雙向記錄的連線合併成一條無箭頭的線，標示兩端埠號（如 `P1 ↔ P3`、電源 `W1 ↔ …`）；同一對設備間有多條線時每條都會分開顯示。機櫃背面的設備也會畫出（位置標示「(背面)」）。
*   **對端辨識**：依主機名稱 → 名稱 → IP 比對。名稱對到多台設備時優先選同機房的；仍無法判斷時以橘色虛線標示「不明確」，並在側邊欄列出候選設備。對端在其他機房時顯示為青色外部節點（`主機名 @ 機房`）；完全找不到才顯示紅色虛線節點。
*   **檢視工具**：預設隱藏沒有接線的設備（可勾選「顯示未接線設備」）；可切換網路線 / 電源線圖層並依設備類型篩選（兩端都符合類型的線才顯示）；搜尋主機名稱、名稱或 IP 會自動置中並高亮其連線，只有選取設備的連線有動畫。拖曳後的位置會依機房記在瀏覽器中，按「重新排版」可恢復自動排版；「重新整理」重新讀取機櫃資料，載入失敗時畫面會顯示錯誤並可重試。
*   **Config Ports & Cables**：Nutanix / Blade 節點會開啟其所屬機箱；其他機房的設備會先切換到該機房再開啟。
*   **即時埠狀態**：按「顯示即時埠狀態」才會查詢（不會自動或定時查詢），只查已啟用 SNMP 的網路設備，最多同時 3 台；線的兩端依埠狀態顯示綠（Up）/ 紅（Down）/ 灰（未知），查詢失敗的原因顯示在該設備的側邊欄。

### 🗄️ IPAM (IP 位址管理與子網路掃描)
*   **容量與使用率檢視**：即時掌握各網段已分配與剩餘 IP。
*   **子網路存活掃描**：平行 ICMP 探測線上主機。
*   **IP 衝突排查**：偵測重複 MAC 或未登錄設備佔用。
*   **環境清單改由 Settings 管理**：IPAM 不再提供環境的新增 / 編輯 / 刪除；新增子網路與 IP 時仍從全域環境清單下拉選擇。SuperAdmin 可按頁首的「Manage environments →」直接跳到 `Settings > Environments`。
*   **網段建立規則（v1.7.7）**：CIDR 會正規化為網路位址（例如 `10.0.0.5/24` 存成 `10.0.0.0/24`）；新網段遮罩限 /20～/30（最多 4094 個 IP）；重複或與既有網段重疊會被拒絕。舊有的 /16～/19 網段保留並標示「未完整展開」，同步或手動設定到清單外的 IP 時會自動補上該筆 IP。批次新增會逐列列出被拒絕的原因。
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
*   **AD DNS 管理**：查詢 AD DNS 伺服器上的 Zone 與 Record；新增 / 修改 A 紀錄；刪除 A、AAAA、CNAME、TXT、MX、PTR 紀錄。
*   **新增 / 修改（Add / Modify）**：名稱沒有 A 紀錄時新增；只有一筆時改成新 IP（結果顯示「Updated 舊 IP -> 新 IP」），IP 相同時顯示 Unchanged、不寫變更紀錄；同名已有**多筆** A 紀錄（輪詢）時不會更動，結果列出現有的 IP，請先用 Delete 刪掉不要的再新增。IP 格式不正確的行不會送出。
*   **刪除（Delete）**：按下後先讀取每個名稱在 DNS 伺服器上**實際存在的紀錄**（類型、資料、TTL）並列出，只刪除勾選的紀錄。A、AAAA、CNAME 預設勾選，TXT、MX、PTR 需自行勾選；NS、SOA 等 Zone 設定紀錄與 Zone 根（`@`）不能在這裡刪。透過 API 只送名稱時，只會刪該名稱的 A 紀錄，不會連帶刪掉同名的 TXT、MX 等紀錄。
*   **變更紀錄**：新增記為 `Add: 名稱 -> IP`，修改記為 `Modify: 名稱: 舊 IP -> 新 IP`，刪除每筆紀錄各記一行 `Delete: 名稱 類型 資料`，事後可查到原本的值。
*   **一次處理上限**：新增、刪除每次最多 500 筆。整批失敗時顯示錯誤原因的第一行（例如 WinRM 連不到伺服器），不會顯示帳密。
*   **在線存活探測**：卡片即時顯示在線健康狀態，支援快速啟用/停用切換。

### 👥 AD Control：帳號管理
AD Control 上方有五個分頁：「Browse BU Hierarchy」、「OU Tree」、「Object Search」、「Reports」與「Group Policy」。上次選的分頁會被記住。
*   **Browse BU Hierarchy（原本的模式）**：依 `.env` 設定的公司 / BU（`AD_COMPANIES`、`AD_BUS_*`、`AD_OU_*`）列出該 OU 的帳號，可用 Grant 加入 `_Guardian_<BU>` 群組（`AD_GRANT_COMPANIES` 中的公司）。
*   **OU Tree（新模式，與 BU 模式並行）**：左側是網域實際的 OU 階層，加上網域根底下的 Users、Computers 等容器（System、Program Data 不顯示）；右側列出所選 OU / 容器**這一層**的使用者、群組、電腦（各最多 2000 筆，超過會提示）。使用者可直接做與 BU 模式相同的操作；電腦顯示作業系統、最後登入、是否停用。OU 最多讀取 2000 個。
*   **Object Search**：以名稱搜尋使用者、群組或電腦（最多 200 筆）。電腦結果新增作業系統、最後登入、狀態欄位。
*   **Reports（維運報表）**：
    *   「Locked accounts」：目前被鎖定的帳號。
    *   「Inactive accounts」：N 天（預設 90）沒有登入或從未登入的帳號；依 `lastLogonTimestamp` 計算，誤差最多約 14 天。
    *   「Passwords expiring」：N 天（預設 14）內密碼到期或已過期的啟用帳號（密碼永不過期的帳號不列入）。
    *   有設定 `AD_OU_SEARCH` 時只查該 OU 底下；每份報表最多 2000 筆。報表中的帳號一樣可以單筆或批次操作。
*   **帳號清單（所有模式共用）**：
    *   可篩選、分頁（每頁 50 筆），點帳號名稱看詳細資料。Operator 以上可停用 / 啟用、解鎖、重設密碼（重設後的密碼只顯示一次）。
    *   **批次操作（Operator 以上）**：勾選帳號（標題列的勾選框選取本頁全部）後，可批次「Unlock」、「Enable」、「Disable」。執行前先預覽：已經是目標狀態的帳號（例如沒被鎖定的帳號之於 Unlock）會被排除；一次最多 100 個帳號。執行後逐筆列出成功或失敗原因，每個成功的帳號各記一筆稽核紀錄。批次不提供重設密碼。
    *   **Export CSV**：匯出目前篩選後的清單（UTF-8，Excel 可直接開啟）。開頭為 `=`、`+`、`-`、`@` 的內容會加上 `'`，避免被當成公式執行。群組與電腦清單也可匯出。
*   **使用者詳細資料**：
    *   群組名稱改由完整的 DN 解析，名稱中含逗號等跳脫字元（例如 `Sales, East`）也會正確顯示；另列出主要群組（Primary group，通常是 Domain Users）。
    *   「Last logon (approx.)」是 AD 複寫的 `lastLogonTimestamp`，可能比實際晚最多約 14 天。需要精確時間時按「Check exact」：會逐台詢問網域控制站自己的 `lastLogon`，顯示最新的時間與是哪台 DC，無法連線的 DC 會列出（DC 多時需要一點時間）。
*   **可操作的帳號範圍**（停用 / 啟用、解鎖、重設密碼、Grant、批次操作都適用，SuperAdmin 也一樣）：
    *   **受保護帳號一律不能改**：`adminCount = 1` 的帳號（Domain Admins 等受 AdminSDHolder 保護群組的成員，或曾經是成員）、`krbtgt`，以及 Vanguard 使用的 AD 服務帳號本身。清單中這類帳號會標示「Protected」，不顯示操作按鈕，批次預覽也會自動排除。
    *   **只能改受管 OU 底下的帳號**：在 Settings > System Settings > AD 設定 `AD_MANAGE_OUS`（多個 OU 的 DN 以 `;` 分隔，含其下所有子 OU）。沒有設定時，以所有 `AD_OU_*` 設定的 OU（含 `AD_OU_SEARCH`）為範圍；這些也都沒設定時才是整個網域（仍排除受保護帳號）。`AD_MANAGE_OUS` 格式錯誤時，所有帳號操作都會被拒絕並顯示原因。
    *   檢查在網域控制站上、變更前一刻依帳號目前的 DN 與 `adminCount` 進行，並直接對檢查過的那個帳號變更。被拒絕時單筆操作顯示原因；批次結果標示「Refused」並列出原因。查詢與報表不受範圍限制。

### 📧 AD 密碼到期通知
每天定時檢查 AD 帳號，密碼即將到期的使用者會收到 email 提醒，管理者另外收到一封彙整。
*   **設定位置**：Settings > System Settings > AD Hierarchy & SearchBase 的「Password expiry notifications」卡片（按 Save Changes 後生效，不需重啟）。這頁現在分成「Search and scope」、「BU hierarchy」與通知三張卡片。
    *   `PWD_NOTIFY_ENABLED`：每天執行的開關，預設關閉。
    *   `PWD_NOTIFY_TEST_MODE`：測試模式，**預設開啟**：給使用者的信全部改寄到彙整收件人（主旨標示原本的收件人），使用者不會收到。確認內容無誤後再關閉。
    *   `PWD_NOTIFY_TIME`：每天執行時間，預設 09:00。服務在設定時間後一小時內啟動仍會補跑，超過就略過當天。
    *   `PWD_NOTIFY_DAYS`：剩餘幾天時寄信，預設 `14,7,3,2,1`（1–90 的整數，以逗號分隔）。剩餘天數以伺服器時區的日曆天計算，到期當天為 0。
    *   `PWD_NOTIFY_OUS`：要檢查的 OU（以 `;` 分隔，含子 OU）。空白時用 `AD_OU_SEARCH`；也沒設定時為整個網域。只檢查啟用中、密碼會過期的帳號，到期時間依 `msDS-UserPasswordExpiryTimeComputed`（細緻密碼原則也會正確計算）。
    *   `PWD_NOTIFY_ADMIN_TO`：彙整收件人（可多個，以 `;` 或 `,` 分隔）；空白時用 Mail Relay 的 `MAIL_RELAY_RECIPIENT`。
    *   `PWD_NOTIFY_CHANGE_URL`：選填，自助變更密碼頁面的網址，會放進信中。可使用 repo 中獨立的 `pwdchange` 小程式（不需登入、只開放內部網段的 AD 變更密碼頁，安裝與設定見 `pwdchange/README.md`）。
    *   需要先設定 Mail Relay（`MAIL_RELAY_SERVER`、`MAIL_RELAY_SENDER`），否則卡片會顯示警告；欄位格式錯誤時會標示原因，且無法儲存。
*   **給使用者的信**：中英雙語，包含帳號、到期時間、剩餘天數與變更方式（Ctrl+Alt+Del →「變更密碼」，或上述網址），並提醒 IT 不會以 email 索取密碼。沒有 email 的帳號不寄，列入彙整。
*   **給管理者的彙整**：每次執行一封，列出已寄送、寄送失敗（含原因）、沒有 email、超過上限的帳號；讀取 AD 失敗時也會寄出並附上錯誤。每次最多寄 500 封，其餘列入彙整、隔天再依天數判斷。
*   **AD Control > Reports**：最上方的「Password expiry notifications」區塊顯示目前生效的設定與最近的執行結果（可展開每位使用者的結果）。
    *   「Preview today」（Operator 以上）：列出今天會通知誰，不寄信、不記錄。
    *   「Run now」（只限 SuperAdmin）：立即執行一次，遵守測試模式。測試模式關閉時，手動執行會算作當天的執行，當天排程不會重複寄信；當天已寄過則無法再手動執行。
*   每次執行都會寫一筆稽核紀錄（模組「AD Password Notify」，含各項人數），並保留最近 30 次的執行明細。

### 🛡️ AD Control：Group Policy 管理
AD Control 的「Group Policy」分頁仿照微軟的群組原則管理主控台（GPMC）排版：可以檢視網域、OU 與 GPO，管理 GPO 連結與繼承封鎖，新增、複製、重新命名、刪除 GPO，編輯安全性篩選、WMI 篩選與委派，以及切換狀態、備份、還原與編輯登錄值。尚未提供：群組原則結果 / 模型、新增 WMI 篩選、系統管理範本的完整編輯器。
*   **左側樹狀**：網域 → OU 階層，每個網域 / OU 底下列出連結的 GPO（依連結順序）；另有「Group Policy Objects」（網域內所有 GPO）與「WMI Filters」兩個容器。強制（Enforced）的連結有鎖頭圖示，停用的連結與全部設定停用的 GPO 會變淡，封鎖繼承的 OU 有藍色驚嘆號。OU 最多讀取 2000 個，超過時頁面會提示。
*   **點網域或 OU**：
    *   「Linked Group Policy Objects」：連結順序、強制、連結啟用、GPO 狀態、WMI 篩選、修改時間。
    *   「Group Policy Inheritance」：實際套用到這裡的 GPO 與優先順序。計算方式同 GPMC：停用的連結不算；封鎖繼承會擋掉上層的連結，但強制的連結照樣套用並排在最前面，越上層的強制連結優先。
*   **點 GPO**：
    *   「Scope」：連結到哪些網域 / OU（雙擊可跳到該位置）、安全性篩選（套用對象）、WMI 篩選。
    *   「Details」：網域、擁有者、建立 / 修改時間、使用者與電腦設定的 AD / SYSVOL 版本、GUID、GPO 狀態（Operator 以上可在此切換）、註解。AD 與 SYSVOL 版本不一致時會提示可能還在複寫。
    *   「Settings」：GPMC 原生的設定報表。只有 Operator 與 SuperAdmin 能看，因為群組原則喜好設定可能含有儲存的密碼；報表在不執行任何腳本的沙箱框架中顯示。
    *   「Delegation」：每個群組 / 使用者對這個 GPO 的權限與是否繼承。
*   **WMI Filters**：列出網域內的 WMI 篩選，點進去可看描述、查詢語句，以及哪些 GPO 使用它。
*   **操作**：在樹狀或表格上按右鍵，或使用上方工具列。Operator 以上可以切換 GPO 狀態、備份（單一 GPO 或在「Group Policy Objects」上備份全部，路徑留空則存到 DC 的 `C:\GPO_Backups`），以及編輯 `Software\Policies` 底下的登錄值設定。
*   **連結管理（Operator 以上）**：
    *   **連結既有的 GPO**：在網域或 OU 上按右鍵選「Link an Existing GPO…」（或工具列的「Link an existing GPO」），從尚未連結到這裡的 GPO 中挑一個。新連結為啟用狀態，排在連結順序的最後。
    *   **強制 / 停用連結 / 刪除連結**：在連結（樹狀中 OU 底下的 GPO、「Linked Group Policy Objects」或 GPO「Scope」分頁的列）上按右鍵，切換「Enforced」、「Link Enabled」，或「Delete link」。刪除連結不會刪除 GPO 本身。
    *   **連結順序**：在「Linked Group Policy Objects」分頁用 ▲ ▼ 調整，順序 1 優先。
    *   **封鎖繼承**：在網域或 OU 上按右鍵勾選 / 取消「Block Inheritance」。封鎖後上層的連結不再套用到這裡，強制的連結除外。
    *   除了調整順序與連結新 GPO，每項變更都會先請你確認；完成後會重新讀取樹狀。所有變更都記在稽核紀錄（操作者、GPO 名稱、OU 的 DN 與變更內容）。只能連結到網域根或 OU，其他容器（例如 `CN=Users`）會被拒絕。
*   **GPO 本身（Operator 以上，刪除限 SuperAdmin）**：
    *   **新增**：在「Group Policy Objects」上按右鍵選「New…」（不連結），或在網域 / OU 上選「Create a GPO in this domain, and Link it here…」（建立後直接連結到該處）。可輸入註解。建立後會自動選取新的 GPO。
    *   **複製**：GPO 右鍵「Copy…」，輸入新名稱；可勾選保留原本的權限，否則套用預設權限。連結不會被複製。
    *   **重新命名**：GPO 右鍵「Rename…」。
    *   **註解**：GPO「Details」分頁的「Comment」旁按「Edit」。
    *   **刪除（只限 SuperAdmin）**：在「Group Policy Objects」底下的 GPO 上按右鍵選「Delete GPO…」，必須再輸入一次 GPO 名稱才能刪除；網域內所有指向它的連結也會一併刪除，無法復原（需靠備份還原）。若 GPO 在這段期間被改名，DC 端會拒絕刪除。
*   **安全性篩選與 WMI 篩選（Operator 以上）**：在 GPO「Scope」分頁：
    *   「Security Filtering」按「Add…」加入使用者 / 群組 / 電腦（給予套用權限）；按「Remove」移除套用權限但保留讀取權限（GPO 必須仍能被讀取，否則電腦無法處理群組原則）。
    *   「WMI Filtering」用下拉選單選擇網域內既有的 WMI 篩選，或選「&lt;none&gt;」移除。
*   **委派（只限 SuperAdmin）**：GPO「Delegation」分頁按「Add…」，輸入使用者 / 群組並選擇「Read」、「Edit settings」或「Edit settings, delete, modify security」；既有項目可「Change」或「Remove」。繼承來的或拒絕的權限不能在這裡修改；屬於安全性篩選的「Read (from Security Filtering)」項目請在「Scope」分頁處理。
*   **備份還原（Operator 以上）**：在「Group Policy Objects」上按右鍵選「Manage Backups…」，輸入備份位置（留空為 DC 的 `C:\GPO_Backups`），會列出最新的 500 份備份。按「Restore」：GPO 還存在時以備份覆蓋目前的設定；GPO 已被刪除時，會以備份中的名稱重新建立（新的 GUID，沒有連結，需要再連結）。
*   以上每項變更都會先請你確認（新增、複製、重新命名、註解在對話框中確認），並記在稽核紀錄。
*   **需求**：DC 上要有 GroupPolicy（RSAT-GPMC）與 ActiveDirectory PowerShell 模組，並使用 Settings 中設定的 AD 服務帳號。

### 🏢 Nutanix Prism 虛擬化管理
*   **VM 電源操作（v1.7.8）**：需 Operator 以上。PE 模式提供 PowerOff、PowerCycle、Reset、GuestShutdown、GuestReboot；PC 模式（Prism Central v3）只提供 PowerOff 與 GuestShutdown。一次最多同時處理 5 台；有失敗時會列出每台 VM 與原因。送出後清單會立即、10 秒、30 秒各自動更新一次（VM 實際改變狀態需要一點時間）。
*   **VM 清單（v1.7.8）**：電源欄顯示 Prism 回報的實際狀態（PAUSED、SUSPENDED、UNKNOWN 以黃色標示）。Refresh 會保留目前選的 cluster / host / 電源篩選。某台 PE 或某個 cluster 讀不到時，清單上方會顯示「清單不完整」並列出來源與原因。CSV 匯出含名稱、IP、Cluster、Host、電源、vCPU、記憶體 GB、磁碟 GB（不含光碟）與 UUID。
*   **VM Clone API 自動化**：整合 Prism API 腳本，實現自訂規格與快速克隆部署。需 Operator 以上；IP Switch / Template-BU 對照表儲存時逐列驗證，錯誤會列出列號。
    *   **逐台處理（v1.7.8）**：每台 VM 建立成功後才寫入 Server List 並安裝 Linux 軟體；失敗的 VM 跳過，log 結尾的 `[Summary]` 列出建立、未建立與安裝失敗的台數。
    *   **重啟不中斷**：Clone 進行中重啟網頁服務，重啟後會接手仍在執行的工作或依 log 完成後續步驟；同時只能有一批 Clone。
    *   **逾時設定（`.env`，選填）**：`NUTANIX_CLONE_TIMEOUT_MINUTES`（整批上限，預設 max(60, 每台 30) 分鐘）、`NUTANIX_LINUX_INSTALL_TIMEOUT_MINUTES`（每台 Linux 安裝上限，預設 20）。
*   **TLS 憑證驗證（選填）**：`NUTANIX_TLS_VERIFY=true` 開啟對 Prism 的憑證驗證，內部 CA 以 `NUTANIX_CA_CERT_FILE` 指定 PEM 檔路徑；未設定時不驗證（與舊版相同）。

### 🔑 SSL Certificate (SSL 憑證管理中心)
*   **線上探測與解析**：支援 Host:Port 探測、文字證書貼上與證書檔上傳解析（PEM / DER / CER / CRT / PFX / P12，上限 1 MB；不支援 JKS）。主機欄只填網域或 IP（會自動去掉 `https://` 與結尾 `/`），Port 1–65535。
*   **AES-256 透明加密**：私鑰與密碼強制加密儲存；清單不會回傳任何加密資料。檢視私鑰僅限 SuperAdmin，每次檢視都會記入稽核紀錄。
*   **狀態（v1.7.7）**：正常 / 即將到期（≤ `SSL_ALERT_THRESHOLD_DAYS`，預設 30 天）/ 已過期 / 錯誤，剩餘天數依到期日即時計算。另會標示「不受信任」並說明原因（自簽、主機名稱不符、中繼憑證過期等）。只上傳檔案、沒有監控主機的憑證不會被探測，但仍會依到期日倒數與告警。
*   **掃描**：每日排程與「全部檢查」在背景平行執行（最多同時 5 台），畫面顯示掃描進度；同一時間只會有一個掃描。掃描結果只合併回現有紀錄，掃描期間新增、刪除或編輯的資料不會被覆蓋。
*   **到期預警**：Telegram 通知只在狀態改變時發送：進入 30（門檻）/ 14 / 7 / 1 天、已過期、連續兩次探測失敗、恢復正常；重複掃描或服務重啟不會重複通知；更新憑證後重新計算。升級後第一次掃描，會對已在門檻內的憑證各發一次通知。
*   **編輯**：可修改名稱、主機、Port、環境並更換憑證 / 私鑰；私鑰欄位留空表示不變，勾選清除才會刪除已存的私鑰。刪除監控紀錄會一併刪除已存的私鑰與檔案。

### 🛢️ Database 服務
*   **DB Connection Hub**：
    *   主機、使用者、資料庫名稱只接受英數字與 `. _ - :`（SQL Server 可用 `主機\執行個體`），不合格的值在存檔時就會被擋下。
    *   SQLite 檔案只能放在允許的目錄內：預設是 `<DB_DATA_DIR>\data`，填相對路徑也會放在這裡，其他目錄要用 `DB_SQLITE_ROOTS` 開放（以 `;` 分隔）。Vanguard 自己的資料檔一律不能登錄。
    *   設定 `DB_TARGET_ALLOWLIST`（以逗號分隔：完整主機名、`*.網域`、IPv4 CIDR）後，只有清單內的主機能連線、測試或備份；未設定時不限制。手動輸入的連線測試都會記入稽核紀錄。
    *   以上限制在使用時也會檢查，因此舊版存下、不符合規則的連線會無法使用，需要重新編輯。
    *   SQL Server 一律以加密連線；伺服器使用自簽憑證時，在連線設定勾選「信任伺服器憑證」（只對該筆連線生效）。
*   **SQL Query Terminal**：
    *   一次只能執行一個唯讀語句（SELECT / WITH；MySQL 另可用 SHOW、EXPLAIN、DESCRIBE；PostgreSQL 可用 SHOW、EXPLAIN；SQLite 可用 EXPLAIN、PRAGMA）。
    *   寫入、交易控制、有副作用的函式（例如 `pg_sleep`、`pg_terminate_backend`、`SLEEP`）與 MySQL 的 `/*! */` 註解都會被拒絕。
    *   查詢內容不會被改寫，JOIN 同名欄位、SQL Server 的 ORDER BY 與 CTE 都能直接執行。每次最多回傳 1000 筆，由資料庫端限制（MySQL `sql_select_limit`、PostgreSQL cursor、SQL Server `SET ROWCOUNT`）；超過時畫面會提示只顯示前 1000 筆。每個查詢最多執行 30 秒，資料庫回報的錯誤（語法、權限、逾時）會直接顯示。
    *   查詢結果會遮蔽敏感資料：依欄位名稱判斷，也包含別名（例如 `password AS p`），另外會遮蔽看起來像 Email、身分證字號、手機號碼的值。**只有 SuperAdmin 可以檢視未遮蔽的原始資料**。
    *   這些只是額外的保護：登錄到 Connection Hub 的帳號，請使用資料庫端的唯讀帳號。
    *   查詢歷史只存在瀏覽器，且依登入帳號分開；匯出 CSV 帶 BOM（Excel 可直接開啟中文），開頭為 `= + - @` 的值會加上 `'` 避免被當成公式。
*   **Backup & Restore**：
    *   備份會實際執行 `mysqldump`、`pg_dump`、`sqlcmd`，這些工具必須安裝在 Vanguard 主機上並在 PATH 中；SQLite 以 `VACUUM INTO` 產生一致的副本（WAL 中尚未寫回的資料也會包含）。密碼不會出現在命令列上。
    *   清單會顯示每筆備份的狀態（執行中 / 完成 / 失敗）與失敗原因，執行中會自動更新。同一個資料庫一次只能有一個備份，目前只支援完整備份。
    *   SQL Server 的備份檔寫在 SQL Server 主機上，路徑由 `DB_SQLSERVER_BACKUP_DIR` 指定（SQL Server 主機上的目錄）。
    *   還原只有 SuperAdmin 可以執行，而且只能還原狀態為完成、備份檔還在的紀錄；還原結果會記在該筆備份上。刪除備份時會一併刪除本機的備份檔。
    *   還原會取代現有資料庫：PostgreSQL 先刪除備份內的物件再重建（`pg_restore --clean --if-exists`）；SQL Server 會先中斷該資料庫的所有連線（SINGLE_USER），以 `WITH REPLACE` 還原後恢復 MULTI_USER。
    *   SuperAdmin 可下載本機的備份檔（每次下載都記入稽核紀錄）；SQL Server 的備份檔在 SQL Server 主機上，無法從這裡下載。
    *   舊版每天 02:00 寫入的「(Simulated)」紀錄並沒有實際備份，清單上會標示 SIMULATED，而且不能還原。
    *   **排程備份預設關閉**。設定 `DB_BACKUP_SCHEDULE=HH:MM`（例如 `02:00`）後，每天在該時間對所有資料庫各做一次完整備份。服務重啟不會重跑當天的備份；超過設定時間一小時後才啟動的服務，當天就不會補跑。
    *   設定 `DB_BACKUP_RETENTION_DAYS`（天數）後，每小時清除超過天數的備份紀錄與本機檔案；每個資料庫最新一份完成的備份一定保留。未設定時全部保留。SQL Server 主機上的 .bak 檔不會被刪除，請由 SQL Server 端自行清理。
    *   頁面標題下方會顯示目前的排程時間、上次執行日與保留天數。
*   **Performance Dashboard**：
    *   只顯示 SQL 查得到的真實數值：是否連得上、`SELECT 1` 的回應時間、連線數，以及請求速率（MySQL 為 QPS、PostgreSQL 為 TPS、SQL Server 為每秒批次數）。速率要取樣兩次才算得出來。
    *   CPU、記憶體不顯示，因為無法透過 SQL 取得。
    *   Health & Storage 會讀各引擎的系統資料表，取得總容量與前 10 大資料表（SQL Server 另外顯示其中記錄檔的大小）。
    *   **Slow Queries & Lock Waits**：選好資料庫後按 Analyze，列出總執行時間最長的 10 個語句，以及正在等待鎖的連線與擋住它的連線。來源分別是 MySQL `performance_schema` / `sys.innodb_lock_waits`、PostgreSQL `pg_stat_statements` / `pg_blocking_pids`、SQL Server DMV（需 VIEW SERVER STATE）；來源未啟用或權限不足時會顯示說明。
    *   **Kill**（SuperAdmin）：MySQL 與 PostgreSQL 只取消正在執行的查詢，連線保留；SQL Server 沒有取消別人查詢的指令，KILL 會中斷整個連線並 Rollback 它的交易，系統連線不能 Kill。按鈕與確認視窗會標示是哪一種。
*   **Self-Service Provisioning**：
    *   資料庫名稱只能用英文字母開頭，只包含英數字與底線。每張申請只能審核一次。
    *   駁回原因照原文保存與顯示（舊版存成 `&lt;` 的內容也會正常顯示）。
    *   核准 SQLite 申請時，會建立一個空的資料庫檔案並自動登錄到 Connection Hub。
    *   其他引擎核准後不會自動建立資料庫，請 DBA 建好後再到 Connection Hub 登錄。舊版核准時自動產生、主機名稱為 `db-req-….local` 的連線並不存在，可以刪除。
*   **Schema Diff**：所有引擎都能比對。PostgreSQL 與 SQL Server 會列出所有 schema 的資料表（預設 schema 以外的顯示為 `schema.table`），SQL Server 也會標示主鍵。任一邊讀不到資料表（通常是權限不足），或兩邊引擎不同時，結果會顯示警告，不會誤報成「完全一致」。

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
*   **安全強化**：
    *   **機密不再送到瀏覽器**：System Settings 的密碼、Token、Secret 欄位只會顯示 `********`。不修改就保持原值，輸入新值會取代，清空欄位會清除。`JWT_SECRET` 完全不經過網頁，只能在主機的 `.env` 修改（改完需重啟服務）。
    *   **IP 白名單**（`API_ALLOWED_IPS` / `FRONTEND_ALLOWED_IPS`）：只有當連線來自信任的反向代理時，才採用 `X-Forwarded-For`；預設只信任本機。Vanguard 前面若有其他主機上的反向代理，請把它的 IP 加到 `TRUSTED_PROXY_IPS`（以逗號分隔），否則所有請求都會被當成代理本身的 IP。
    *   **角色變更立即生效**：在 RBAC 變更或移除某人（或某個 AD 對應群組）的角色後，對方已登入的畫面會在下一次操作時被要求重新登入。修改 AD 對應群組的目標、類型或啟用狀態，或刪除群組時，該群組的成員也會被要求重新登入；只調整功能開關則不受影響（功能開關本來就即時生效）。
    *   **稽核紀錄一律寫入**：所有使用者的操作都會寫入 Audit log。RBAC 群組編輯器中原本的「AUDIT LOG」欄改名為「NOTIFY」，只決定該操作是否另外推送 Telegram / Webhook 通知。每筆紀錄固定一行，使用者名稱等內容中的換行不會再被當成新的紀錄。
    *   **登出**：系統依登入憑證判斷是誰登出，不能再代替別人登出。
    *   **Dev Tools** 只能呼叫本系統的 `/api/...` 路徑，不接受外部網址；每次呼叫（包含失敗）都會記入稽核，查詢參數中的 key / token 會被遮蔽。
    *   **Incoming Webhook**：外部系統呼叫 `/api/webhooks/incoming/<id>` 時，必須在 `X-Webhook-Secret` header 帶上該 Webhook 的 Secret。請在 Integration Hub 編輯 Webhook，按「產生 Secret 以啟用」，Secret 只會顯示一次；沒有 Secret 的 Webhook 不接受外部呼叫。每個 Webhook 每分鐘最多接受 30 次呼叫。
    *   **儲存設定不會再遺失資料**：
        *   System Settings 載入失敗時，頁面會顯示警告並停用儲存，不會再把空白表單存回去而刪掉 AD、Forti、Mail、ELK、SFTP 等設定。
        *   兩人同時開著頁面時，後存的人會看到「設定已被其他人或其他程序修改」，必須重新整理頁面後再改，不會再蓋掉對方剛存的內容。
        *   `DB_DATA_DIR` 只能改到已經有 `.system_key`（加密金鑰檔）的目錄，否則改完重啟後所有加密設定與 RBAC 都會無法解密。搬移資料目錄時，請先把整個目錄（含 `.system_key`）複製過去再修改。
        *   AI Service 的 API Key 欄位留空儲存時，會保留原本的 Key（之前會被清空）。
        *   RBAC 新增 AD 對照時，名稱已存在（不分大小寫）會被拒絕，請改用編輯，不會再默默覆蓋原本的對照並清空其功能設定。
    *   **機密不再外洩**：
        *   AI Service：已儲存的 API Key 只會送往當初輸入時的 Provider 與 Base URL。變更 Provider 或 Base URL（包含「Test」與「Fetch Models」）時必須重新輸入 Key。修改、測試、取得模型改為只限 SuperAdmin。Gemini 的 Key 改放在 header（`x-goog-api-key`），不再出現在網址與錯誤 log。
        *   Webhook 清單中的 Authorization 等 header 與網址裡的 token 會遮蔽顯示；編輯時不動遮蔽的值就保持原值，輸入新值會取代。
        *   SFTP 伺服器的 API Key 改為加密儲存，頁面只顯示 `********`；按「Test」時，主機、Port、協定沒變才會使用已儲存的 Key，改了就要重新輸入。SFTP 主機欄只接受主機名稱或 IP。
        *   RBAC 查詢 AD 成員、NAS 的帳號 / 網域 / 共用資料夾名稱 / 路徑，送進 PowerShell 或遠端 shell 前都會先跳脫；NAS 帳號只接受英數字、空白、`.` `_` `-` 與一個 `\` 或 `@`。
    *   **不再顯示假的結果**：
        *   NAS 的「測試連線」改成實際登入（Synology / QNAP 登入 API、Windows 讀取磁碟、Linux 以 SSH 登入），帳密錯誤或主機不通時會顯示失敗原因。以前一律顯示成功，並帶出寫死的容量。
        *   NAS Manager 同步時，連不上的裝置會標示 Offline 並顯示錯誤，保留上次成功取得的資料；連得上才是 Online。尚未同步過的裝置顯示「Not checked」。
        *   QNAP 目前只支援測試登入；容量與共用資料夾清單尚未支援，會顯示說明，不再顯示假的 DataVol1 / QNAPPublic。
        *   目前沒有任何 NAS 類型支援從 Vanguard 修改共用資料夾權限，按儲存會被拒絕（以前只改了 Vanguard 內的記錄就回報成功，NAS 上並沒有變），請直接在 NAS 上修改。
        *   Scout Open API 的「MAX QUERY TIME RANGE (DAYS)」（`SCOUT_OPEN_API_MAX_DAYS`，預設 30，1–365）現在會生效：metrics / 日誌查詢最早只能從這麼多天前開始，沒有指定 `from` 時也一樣。
        *   System Settings 移除了從未生效的 `BACKEND_ALLOWED_IPS` 欄位；限制 API 來源請用 `API_ALLOWED_IPS`。
        *   Dev Tools 的內建範本改為實際存在的 API；Open API 範本會切到 Visual Builder 並帶入 `X-API-Key` header，請換成自己的 Open API Key。
    *   **Audit log 頁**：
        *   可以查到超過 7 天的紀錄（會讀 `logs\archive` 中壓縮過的檔案）。未選日期時顯示最近 30 天；頁面會顯示最早可查到的日期與保留天數。
        *   稽核紀錄保留 `AUDIT_LOG_RETENTION_DAYS` 天（預設 180，可設 30 到 3650，依檔名日期計算）；應用日誌仍保留 30 天。
        *   篩選、排序、分頁改由伺服器處理，而且只讀選定日期的檔案，資料量大時也不會拖慢整個系統。
        *   Export CSV 會匯出所有符合條件的紀錄（不只目前這一頁），開頭為 `=`、`+`、`-`、`@` 的內容會加上 `'`，避免 Excel 當成公式執行。
        *   儲存 System Settings 的稽核紀錄會列出改了哪些設定、移除了哪些設定（只列名稱，不記錄值）。
    *   **全專案掃描後移除的假資料**：
        *   Kubernetes：叢集沒有 metrics-server 時，Pod 清單的 CPU / 記憶體用量顯示 N/A（以前是依 Pod 名稱算出的假數字）。Monitoring 分頁沒有設定 Prometheus 時，只顯示 K8s API 取得的容量，用量、網路流量與 Top Pods 顯示 N/A（以前是依 Pod 數量推估）。
        *   FortiProxy URL Rating：只接受單一網址（不可含空白、引號、反斜線或換行），改為 Operator 以上才能執行，因為它會在 FortiProxy 上執行 CLI 指令。結果中的「Likely Action」是依 FortiGuard 分類名稱推測，不是 FortiProxy 原則的實際判斷。
        *   ELK SIEM 分頁移除了從未有資料來源的「System Status / Top Threat」區塊（以前永遠顯示一切正常），以及對應的 `/api/siem/telemetry`。
        *   Settings > File Services 移除了從未生效的 `NAS_DEFAULT_TIMEOUT_MS`、`NAS_DEFAULT_SYNC_ON_LOAD`。
    *   **AD Control / GPO**：
        *   一律使用 AD 服務帳號（Settings 的 `AD_ADMIN_USER` / `AD_ADMIN_PWD`）；沒有設定時，AD 查詢、帳號操作、GPO 與 RBAC 的 AD 成員查詢都會顯示錯誤，不再改用登入者自己的 AD 密碼。服務帳號密碼以環境變數傳給 PowerShell，不會寫進暫存的腳本檔或錯誤訊息。
        *   搜尋字、帳號名稱、GPO 編號、備份路徑與登錄設定值都會先檢查格式，並以安全的方式交給 PowerShell，輸入的內容不會被當成指令執行。
        *   物件搜尋至少 2 個字元，不可輸入 `*`（系統會自動前後加萬用字元），最多顯示 200 筆；目錄瀏覽最多載入 2000 個帳號，每頁 50 筆，超過時會提示。
        *   帳號操作的稽核紀錄記錄實際操作的 Vanguard 使用者（並註明由哪個服務帳號執行）。重設後的新密碼為 16 碼，包含大小寫、數字與符號。
        *   錯誤訊息只顯示 PowerShell 錯誤的重點，不含腳本位置與機密。GPO 登錄設定查詢不再把報表寫到伺服器暫存檔。
    *   **其他修正**：
        *   稽核紀錄的時間改為帶毫秒與時區的格式（例如 `2026-11-03T14:05:09.042+08:00`），瀏覽器不在台北時區時也會顯示正確時間；舊紀錄維持原格式。
        *   RBAC 角色寫入失敗時會顯示錯誤，不再回報成功。
        *   儲存 System Settings 時，只有 Telegram / Proxy 相關設定真的改變才會重啟 Telegram 監聽程式。
        *   System Settings 有修改但尚未儲存時，Save Changes 旁會顯示「有尚未儲存的變更」，關閉或重新整理頁面前會提示；SFTP 伺服器對話框按儲存後，也會提醒要再按 Save Changes。
        *   Dev Tools 的歷史紀錄改為每位使用者分開，request body 中名稱像密碼、Token、Key 的欄位會以 `***` 存放。
        *   NAS 共用資料夾名稱可以用中文等各國文字、空白、`_ - .` 與括號；含有不允許的字元時會直接提示，不會再默默刪掉字元（以前可能因此建立或刪除了不同名稱的資料夾）。
    *   **NAS 共用資料夾權限查詢**：共用資料夾名稱不可包含 `` ` ``、`$`、`"`、`;`、`|`、`&`、`<`、`>` 等字元。
*   **資料存取與保留（v1.7.7，維運人員參考）**：
    *   多個服務會同時修改的設定與清單（CMDB 補充資料、排程任務、Prometheus 目標、Webhooks、RBAC、IPAM、SSL 等）一律以資料庫鎖定方式「讀最新資料再寫回」，網頁服務與背景服務不會再互相覆蓋。
    *   排程執行紀錄、CMDB 變更紀錄、DNS 變更紀錄、Workflow 執行紀錄與版本歷史改存資料表；升級後第一次啟動自動搬移舊資料，舊文件保留不刪。保留期限可在 `.env` 調整：`RETENTION_SCHEDULER_LOGS_DAYS`（預設 90）、`RETENTION_WORKFLOW_EXECUTIONS_DAYS`（90）、`RETENTION_CMDB_HISTORY_DAYS`（365）、`RETENTION_DNS_CHANGES_DAYS`（365）、`RETENTION_WORKFLOW_HISTORY_DAYS`（預設 0 = 不依天數刪除，每個 Workflow 仍最多保留 10 個版本）；設為 0 表示不依天數清除，另有筆數上限。清除由背景服務每日執行。
    *   **寫入追蹤**：在 `backend/.env` 設定 `DOC_WRITE_TRACE=1` 並重啟，會把每次資料寫入（時間、服務、key、大小、呼叫位置）記錄到 `<資料目錄>\logs\doc_write_trace.log`（20 MB 自動輪替），用於排查；平常請保持關閉。
    *   **清理重複的舊 key**：從舊版檔案匯入的資料庫，每份資料可能存了兩份（例如 `network_service/...` 與 `network/service/...`）。在 `scripts` 目錄執行 `Cleanup_Doc_Aliases.bat <資料目錄>` 只產生報告；確認後加上 `--apply` 才會刪除，刪除前會先匯出到 `<資料目錄>\legacy_alias_backup\<時間>\`（含 manifest.json），只刪除有正式版本的舊 key。
*   **排程只在背景服務執行（修正）**：新增 / 編輯排程任務或 Prometheus 健康檢查設定時，改為通知背景服務重新載入；先前網頁服務也會另外啟動一個排程引擎，導致任務被執行兩次，重啟後才會恢復。
*   **File Services**（`Settings > File Services`，介面文字為英文；原「SFTP Server」分類已併入，舊的連結 / 書籤會自動導向 SFTP Servers 分頁）：
    *   **SFTP Servers** 分頁：多台 SFTP 伺服器的新增 / 編輯 / 刪除 / 測試 / 啟用停用，行為與儲存方式（按 `Save Changes`）與先前相同。
    *   **NAS Devices** 分頁：NAS 裝置清單，可新增 / 編輯 / 刪除 / 測試連線（Synology、QNAP、Windows Share、Linux SMB）。裝置異動**立即生效**並寫入稽核日誌（記錄操作者與裝置名稱，不含密碼）。
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
