const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { readDataSync, writeDataSync } = require('../lib/db');

router.use(requireAuth);
router.use(checkFeature('runbook')); // only the SOP Runbook screen calls these endpoints (the AI agent reads runbooks in-process)

const PRESEEDED_RUNBOOKS = [
  // 1. Server List (Simplified CMDB)
  {
    id: 'sop-server-list',
    title: 'Server List (Simplified CMDB) 全域同步與資產關聯維運 SOP',
    component: 'Server List',
    tags: ['例行維護', 'CMDB', '自動化'],
    content: `# Server List (Simplified CMDB) 維運管理 SOP

## 總覽
Server List 是 SOMP Vanguard 的核心伺服器資產資料庫 (CMDB)，自動聚合 Scout Agent、Prometheus、Redis、IPAM 以及 Data Center Server Rack 的資產資料。

## 前置條件
- 具備 Operator 或 SuperAdmin 角色權限。
- 底層各資料來源（IPAM 網段、Prometheus、Server Rack 資源）已就緒。

## 詳細步驟
1. **進入 Server List 頁面**:
   - 點擊左側導覽列 **Server Operation > Server List**。
   - 可在 **Card Matrix View** 與 **Detailed Table View** 之間自由切換檢視。
2. **執行 Global Auto-Sync 全域自動同步**:
   - 點擊右上角 **Edit Mode** 進入編輯模式。
   - 點擊 **Global Auto-Sync** 按鈕。
   - 系統將平行觸發：
     1. IPAM 線上子網路 Active IP 掃描。
     2. Prometheus 作用中 Targets 指標與標籤匯入。
     3. **Server Rack 機櫃 Compute 資源全面掃描**（包含獨立 Server、Nutanix 節點、Blade Chassis 刀鋒節點之 SN 與位置資訊）。
   - 系統將自動帶入並更新既有與新發現的主機資料。
3. **管理 Dual-NIC / VIP 虛擬 IP 關聯**:
   - 點擊主機卡片或列的 **Link Secondary IP**。
   - 選擇次要 IP (VIP, Management IP, iLO IP)，系統將建立資產關聯聚合。
   - 若要解除綁定，點擊次要 IP 旁的 **Unlink** 圖示即可拆分。
4. **檢視 360° CMDB 抽屜與詳細 Metadata**:
   - 點擊任何主機名稱即可開啟側邊 360° CMDB Drawer。
   - 可檢視與手動編輯：主機名稱、OS 類型、主/次 IP、環境分類 (Environment)、群組、SN 序號、iLO IP、CVM IP、機房位置與 U 數槽位。

## 疑難排解
- 若 Server Rack 內的舊 Compute 資源未出現在清單：請確保於 Edit Mode 下點擊 **Global Auto-Sync**，系統將自動比對機櫃並全量匯入。`,
    workflowId: null,
    commandIds: ['p4', 'p9'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 2. Hardware Drift Detection
  {
    id: 'sop-hardware-drift',
    title: 'CMDB 硬體規格漂移 (Hardware Drift) 偵測與校準 SOP',
    component: 'Server List',
    tags: ['例行維護', 'CMDB', '資產稽核'],
    content: `# CMDB 硬體規格漂移 (Hardware Drift) 偵測 SOP

## 總覽
當實體主機或虛擬機在線上進行硬體變更（如熱插拔增加 vCPU、擴充 RAM 記憶體）而 CMDB 尚未更新時，系統將主動發出 Hardware Drift 告警。

## 檢測機制
- **基準資料 (Baseline)**: CMDB 記錄的 CPU 核心數與 RAM 容量。
- **即時遙測 (Live Telemetry)**: Scout Agent / Prometheus 即時採集到的硬體規格。
- **觸發條件**: Live CPU != CMDB CPU 或 Live RAM 與 CMDB RAM 差異 > 1GB。

## 處理步驟
1. 於 **Server List** 檢視帶有 ⚠️ **Drift Detected** 標籤的主機。
2. 點擊開啟 **360° CMDB Drawer**，檢閱 **Hardware Drift Comparison Table**：
   - 檢視「記錄規格 (Recorded)」與「實際規格 (Live Actual)」之差異。
3. **規格確認與校準**:
   - 若實體擴充為合法變更：點擊 **Sync Specs from Live Agent**，系統將自動將 CMDB 欄位更新為最新實際規格並消除 Drift 標記。
   - 若為異常配置：請排查虛擬化平台或聯絡機房維運人員確認是否被誤改配額。`,
    workflowId: null,
    commandIds: ['p1', 'p2'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 3. Scout Monitor & Self-Healing
  {
    id: 'sop-scout-monitor',
    title: 'Scout Monitor 主機即時效能監控與自動自癒 (Self-Healing) SOP',
    component: 'Scout Monitor',
    tags: ['即時監控', '自動自癒', '緊急應變'],
    content: `# Scout Monitor 效能監控與自動自癒 SOP

## 總覽
Scout Monitor 提供企業級跨平台主機監控、自訂警報閾值與腳本自動修復 (Self-Healing) 機制。

## 詳細步驟
1. **儀表板巡檢**:
   - 進入 **Scout Monitor** 首頁，檢視線上主機總數 (Online)、離線 (Offline)、告警 (Alerting) 與過期代理 (Outdated)。
   - 支援依據 Environment（環境）、狀態、群組及搜尋關鍵字進行多維度過濾。
2. **主機效能深度分析**:
   - 點擊主機進入 **Host Detail View**。
   - 檢視即時 CPU/Memory/Disk/Network 趨勢圖表、TCP Ping 延遲、Windows Services / Linux 守護程序狀態與 Top 10 處理程序清單。
3. **配置自癒規則 (Self-Healing Remediation)**:
   - 於 **Self-Healing Rules** 頁籤新增規則。
   - 設定觸發條件（例如：Print Spooler 或 Nginx 服務狀態為 Stopped、CPU > 95% 持續 5 分鐘）。
   - 設定修復動作：
     - **Windows**: 執行 PowerShell 腳本（例如 \`Restart-Service Spooler\`）。
     - **Linux**: 執行 Bash 腳本（例如 \`systemctl restart nginx\`）。
4. **自癒稽核與追蹤**:
   - 當 Agent 偵測到故障並執行自癒腳本後，會自動將執行輸出與 Return Code 回報至 SOMP 後端。
   - 前往 **Remediation Logs** 檢視自癒歷史與腳本執行成功率。`,
    workflowId: null,
    commandIds: ['p1', 'p2', 'p3', 'p9'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 4. Scout Agent Multi-platform Deployment
  {
    id: 'sop-scout-agent-deploy',
    title: 'Scout Agent 多平台自動部署與發行版適配 (DEB / RPM / Windows) SOP',
    component: 'Scout Monitor',
    tags: ['Agent部署', 'Linux', 'Windows', '新人教學'],
    content: `# Scout Agent 跨平台自動化部署 SOP

## 總覽
說明如何於 Windows Server 及各大 Linux 發行版快速安裝並啟動 Scout Agent 守護服務。

## 支援環境
- **Windows**: Windows Server 2012R2 / 2016 / 2019 / 2022, Windows 10/11
- **Linux (Debian/Ubuntu)**: Ubuntu 18.04+, Debian 10+ (原生使用 \`.deb\` 套件安裝)
- **Linux (RHEL系)**: RHEL / CentOS / Rocky Linux / AlmaLinux 7/8/9 (原生使用 \`.rpm\` 套件安裝)

## 部署方式一：一鍵 Shell / PowerShell 快速安裝
1. 前往 **Agent > Install Agent > Deploy Scout Agent**。
2. 複製頁面上專屬的一鍵安裝指令（已包含一次性 Token 與後端 Server URL）：
   - **Linux 一鍵指令 (全自動適配 Debian/Ubuntu 與 RHEL)**:
     \`\`\`bash
     curl -sSL "http://<SERVER_IP>:8080/api/inventory/install.sh?token=<TOKEN>" | sudo bash
     \`\`\`
     *腳本會自動辨識 OS：Ubuntu/Debian 自動下載 \`scout-*-amd64.deb\` 並以 \`dpkg -i\` 安裝；RHEL/Alma 則自動下載 \`.rpm\` 安裝。*
   - **Windows 一鍵指令 (PowerShell 管理員)**:
     \`\`\`powershell
     iex (New-Object Net.WebClient).DownloadString('http://<SERVER_IP>:8080/api/inventory/install.ps1?token=<TOKEN>')
     \`\`\`
3. 安裝完成後，服務將自動註冊為 \`scout\` (Linux systemd) 或 \`ScoutMonitorAgent\` (Windows Task) 並立即上線回報。

## 部署方式二：後台遠端一鍵 SSH / WinRM 推送
1. 於 **Server Inventory** 選取目標主機，點擊 **Deploy Agent**。
2. 輸入管理員憑證，後端將自動透過 SFTP 上傳正確格式的安裝包並透過 SSH / PowerShell 靜默執行安裝與啟動。`,
    workflowId: null,
    commandIds: ['p4', 'p17'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 5. Scout Open API
  {
    id: 'sop-scout-openapi',
    title: 'Scout Open API 企業自動化整合與 Prometheus Exporter SOP',
    component: 'Scout Open API',
    tags: ['OpenAPI', 'API整合', 'Prometheus'],
    content: `# Scout Open API 自動化介接 SOP

## 總覽
Scout Open API 提供標準 RESTful JSON 介面與 Prometheus Text Format Exporter，便於第三方系統、監控告警平台 (Grafana, Zabbix) 與自動化腳本整合。

## 認證機制
- 於請求 Header 加入：\`Authorization: Bearer <YOUR_API_KEY>\`
- 或於 URL Query 帶入：\`?apiKey=<YOUR_API_KEY>\`

## 核心端點與使用範例
1. **查詢受監控主機清單**:
   - \`GET /api/v1/open/hosts?ip=192.0.2.6\` (支援 \`ip\`, \`keyword\`, \`status\`, \`os\`, \`envId\`, \`group\`)
2. **查詢即時指標與歷史時序**:
   - 即時指標: \`GET /api/v1/open/metrics/realtime?ip=192.0.2.6\`
   - 歷史趨勢: \`GET /api/v1/open/metrics/history?ip=192.0.2.6&from=2026-08-17T00:00:00Z&limit=100\`
3. **跨平台事件與日誌檢索**:
   - 整合日誌: \`GET /api/v1/open/logs/events?ip=192.0.2.6&keyword=error\`
   - Windows 事件: \`GET /api/v1/open/logs/windows?ip=192.0.2.6&level=Error\`
   - Linux Syslog: \`GET /api/v1/open/logs/linux?ip=192.0.2.6&level=error\`
4. **Prometheus Text Exporter**:
   - \`GET /api/v1/open/prometheus\`
   - 輸出標準 Prometheus Metrics，可直接由 Prometheus Server 抓取。

## 嚴格參數檢驗注意事項
- Open API 具備嚴格參數白名單校驗。若傳入未定義之 Query 參數（如誤打 \`ips\`、\`server\`），系統將回傳 \`400 Bad Request\` 並提示正確的參數清單。`,
    workflowId: null,
    commandIds: ['p6'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 6. SIEM Security & Forensics
  {
    id: 'sop-siem-forensics',
    title: 'SIEM 跨平台日誌審核與資安事件鑑識調查 SOP',
    component: 'SIEM Logs',
    tags: ['資安審計', '日誌分析', '鑑識調查'],
    content: `# SIEM 資安日誌分析與鑑識 SOP

## 總覽
整合 Windows Event Log 與 Linux Syslog/Secure 日誌，提供即時安全事件監控、異常頻率分析與事件鑑識調閱。

## 關鍵事件檢索指南
1. **Windows 安全威脅排查**:
   - **Event ID 4625**: 登入失敗 (Brute-Force 暴力密碼破解偵測)。
   - **Event ID 4720 / 4726**: 使用者帳號建立 / 刪除。
   - **Event ID 4728 / 4732**: 使用者加入 Domain Admins 或 Local Administrators 敏感群組。
   - **Event ID 7036 / 7045**: 核心服務狀態變更 / 新服務安裝 (潛在後門安裝)。
2. **Linux 系統威脅排查**:
   - 檢索 \`/var/log/secure\` 或 \`/var/log/auth.log\` 中的 \`Failed password\` 與 \`Accepted publickey\`。
   - 檢索 \`sudo:\` 提權執行記錄。
3. **日誌留存與輪替政策**:
   - 系統預設單表上限 200,000 筆，最長保留 30 天。
   - 可於 **SIEM Settings** 調整各資料表的輪替容量與天數。`,
    workflowId: null,
    commandIds: ['p11', 'p12'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 7. Nutanix Prism Management
  {
    id: 'sop-nutanix-vm',
    title: 'Nutanix Prism 虛擬機運維與 VM Clone API 自動化 SOP',
    component: 'Nutanix',
    tags: ['虛擬化', 'Nutanix', '自動化'],
    content: `# Nutanix Prism VM 維運與自動克隆 SOP

## 總覽
透過 Nutanix Prism REST API 監控叢集狀態、查詢虛擬機硬體指標並執行電源操作與快速克隆。

## 步驟
1. **開啟 Nutanix 模組**:
   - 選擇目標 Nutanix 叢集（檢查 Prism API 連線狀態）。
2. **VM 效能與狀態檢視**:
   - 查詢 vCPU、vRAM、儲存 IOPS 及 Controller VM (CVM) 運行狀態。
3. **VM 電源操作**:
   - 提供 **Power On**, **Power Off**, **Guest Shutdown**, **Reset VM** 操作。
   - *注意：執行 Reset VM 或強制關機前請務必確認是否有用戶連線與未儲存資料。*
4. **VM Clone API 自動化克隆**:
   - 系統整合 Nutanix v2/v3 API 腳本，支援自訂 VM 名稱、目標 Storage Container、vCPU/RAM 規格並一鍵完成虛擬機部署。`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 8. Server Rack & Chassis Management
  {
    id: 'sop-dc-rack-management',
    title: '伺服器機櫃 (Server Rack) 槽位佈局、多節點 Chassis 與硬體報修 SOP',
    component: 'Server Rack',
    tags: ['機房維運', '硬體管理', 'SOP'],
    content: `# 伺服器機櫃與多節點 Chassis 維運 SOP

## 總覽
管理資料中心實體機櫃 (Rack) 42U/48U 空間配置、多節點刀鋒/Nutanix 機箱、設備序號 (SN) 與硬體報修流程。

## 機櫃標準規範
- **空間分配**: 較重儲存設備與大型 Chassis (3U/4U) 置於機櫃底層 (U1-U10)。
- **電力備援**: 必須分別接入 PDU-A 與 PDU-B 雙迴路獨立電源。
- **排序配置**: 支援機房集中設定之 \`uOrder\` (Top-Down 或 Bottom-Up) 正反向顯示。

## 多節點 Chassis 維護
1. 在機櫃中點擊 Blade / Nutanix Chassis 設備。
2. 檢閱節點列表：可維護各 Node 之 Node Name、**SN (序號)**、**iLO/iDRAC IP**、**CVM IP**。
3. **硬體故障報修 (HW Report)**:
   - 若特定節點或硬體零件（硬碟、記憶體、電源）故障，點擊 **Report Hardware Failure**。
   - 填寫故障現象、SN 序號與受影響槽位，系統將標記為 Repairing 狀態並連動 Spare Parts 備品模組。`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 9. Data Centers Navigation
  {
    id: 'sop-dc-centers',
    title: '資料中心廠房 (Data Centers) 平面圖導航與拓樸方向維運 SOP',
    component: 'Data Centers',
    tags: ['機房設施', '平面圖', '新人教學'],
    content: `# 資料中心廠房設施維運 SOP

## 總覽
維護企業區域資料中心實體廠房庫存、2D 頂視平面圖導航、機櫃排列方向與設施安全日誌。

## 操作步驟
1. **進入 Data Centers 模組**:
   - 檢視各區域 DC 概覽卡片（包含機櫃總數、伺服器總數、總耗電負載與溫度狀態）。
2. **2D Top-Down 平面圖瀏覽**:
   - 點擊 DC 進入平面圖可視化介面。
   - 點擊任何機櫃方塊，系統將以高亮顯示並支援一鍵跳轉至該機櫃的詳細 42U/48U 槽位配置圖。
3. **機房全域排序方向設定**:
   - 可於機房編輯抽屜中集中指定：
     - \`rowOrder\` (Row 排序方向)
     - \`rackOrder\` (機櫃號碼由左至右或由右至左)
     - \`uOrder\` (U 數由上至下或由下至上)
   - 設定將統一套用至該機房內所有機櫃視圖，確保現場人員對齊實體機房視角。`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 10. IPAM Network & Subnet Scan
  {
    id: 'sop-ipam-network',
    title: 'IPAM 子網路 IP 分配、線上掃描與衝突排查 SOP',
    component: 'IPAM',
    tags: ['網路管理', 'IPAM', '例行維護'],
    content: `# IPAM 網路位址管理與衝突排除 SOP

## 總覽
管理企業各網段 IP 空間分配、自動化 ICMP/ARP 存活掃描、保留靜態 IP 與排除 IP 衝突。

## 步驟
1. **子網路容量檢視**:
   - 開啟 **IPAM** 儀表板，檢閱各 Subnet (/24, /23) 之總容量、已分配 (Allocated)、可用 (Available) 與使用率 %。
2. **執行子網路存活掃描**:
   - 點擊網段旁的 **Scan Subnet**。
   - 系統將快速進行平行連線偵測並更新各 IP 的線上狀態與回應時間。
3. **IP 衝突排除 (IP Conflict Remediation)**:
   - 若系統偵測到同一個 IP 回應不同 MAC 位址或未登錄主機佔用：
     1. 檢查該 IP 關聯的主機名稱與 MAC。
     2. 透過 Switch Port 查詢 (NetSearch) 定位接取連接埠。
     3. 修正靜態 IP 設定或調整 DHCP 保留區段。`,
    workflowId: null,
    commandIds: ['p5', 'p7'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 11. Task Scheduler & Native Local Time Engine
  {
    id: 'sop-task-scheduler',
    title: '原生本地時間輪任務排程器 (Native Time Engine) 維護 SOP',
    component: 'Task Scheduler',
    tags: ['排程任務', '自動化', '例行維護'],
    content: `# 原生時間輪任務排程器 SOP

## 總覽
SOMP Vanguard 排程引擎嚴格採用「原生本地時間輪詢引擎」（依據 Windows Server 本地時間 Date 物件與 setInterval 輪詢），徹底避免跨時區、跨日與夏令時轉換 Bug。

## 建立排程任務
1. 進入 **Task Scheduler**，點擊 **New Task**。
2. 設定任務名稱、執行頻率（Cron 表達式或間隔週期）、目標主機群組與執行腳本 (PowerShell / Shell / HTTP)。
3. 儲存後排程引擎將自動掛載並於預定本地時間精確執行。

## 執行日誌與除錯
- 檢閱 **Task History** 列表。
- 點擊失敗任務可查看完整 Standard Output 與 Error Traceback。
- 點擊 **Run Now** 可立即手動觸發測試以驗證修復。`,
    workflowId: null,
    commandIds: ['p11', 'p14'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 12. RBAC & System Settings
  {
    id: 'sop-rbac-security',
    title: '系統 RBAC 權限管理、模組開關與安全審計 SOP',
    component: 'Settings',
    tags: ['系統管理', 'RBAC', '安全審計'],
    content: `# RBAC 權限與模組安全管理 SOP

## 總覽
管理 SOMP Vanguard 系統角色權限 (Role-Based Access Control)、各功能模組之 Enable/Disable 全域開關與操作稽核日誌 (Audit Log)。

## 角色權限矩陣
- **SuperAdmin**: 擁有全系統最高權限（包含模組開關、使用者權限指派、API Key 管理、全域資料刪除）。
- **Operator**: 擁有日常維運操作權限（主機管理、Agent 派送、腳本執行、DNS/AD 操作）。
- **Viewer**: 僅具備唯讀權限（無法執行任何異動、重開機、部署或刪除操作）。

## 模組開關管理 (Feature Flags)
1. 進入 **Settings > Feature Flags**。
2. 針對未啟用的功能模組（例如 DNS Hub, Nutanix, Runbook 等）進行勾選啟用或停用。
3. 停用之模組將自動從所有使用者的導覽選單中隱藏，並拒絕相關 API 存取。

## 密碼與資安規範
- 系統中儲存之所有管理員密碼、SSH Key 均強制加密儲存。
- 禁止於前端使用瀏覽器原生 alert / confirm 彈窗，一律採用系統內建自訂 Modal 與 Toast 提示。`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 13. DNS Hub
  {
    id: 'sop-dns-hub',
    title: 'DNS Hub 網域紀錄管理與存活檢查 SOP',
    component: 'DNS Hub',
    tags: ['例行維護', '緊急應變'],
    content: `# DNS Hub 紀錄管理 SOP

## 總覽
驗證 DNS 伺服器健康狀態、切換伺服器狀態以及新增/編輯 DNS A 或 CNAME 紀錄的標準作業程序。

## 前置條件
- 具備存取 DNS Hub 模組的權限 (SuperAdmin 或 Operator)。
- 目標 DNS 伺服器可連線。

## 詳細步驟
1. **導覽至 DNS Hub**: 從側邊欄開啟 DNS Hub 介面。
2. **伺服器檢查**: 點擊 **Refresh Status** 按鈕讓系統平行驗證連線能力。
3. **紀錄操作**:
   - 在啟用的伺服器卡片上點擊 **Add Record**。
   - 輸入標準選項：Hostname、Record Type (A/CNAME/MX/TXT)、Value、TTL。
   - 點擊 **Save** 套用設定。

## 疑難排解
- 若伺服器顯示 **offline**，請確認伺服器正在運行，且防火牆已開放 port 53 (UDP/TCP)。`,
    workflowId: null,
    commandIds: ['p8', 'p5'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 14. Active Directory Control
  {
    id: 'sop-ad-control',
    title: 'Active Directory 使用者查詢與密碼重設 SOP',
    component: 'AD Control',
    tags: ['新人教學', '例行維護'],
    content: `# Active Directory 使用者 SOP

## 總覽
在企業網域中尋找使用者並執行安全密碼重設的程序。

## 步驟
1. **尋找使用者**: 使用 AD Control 面板的搜尋列（支援使用者名稱、顯示名稱或電子郵件）。
2. **檢閱群組成員資格**: 確認使用者屬於正確的 AD 群組。
3. **重設密碼**:
   - 點擊 **Reset Password** 按鈕並產生高強度臨時密碼。
   - 勾選 **Require password change at next logon**。
4. **解鎖帳號**: 若帳號狀態為已鎖定，點擊 **Unlock Account** 即可立即解除鎖定。`,
    workflowId: null,
    commandIds: ['p13'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 15. GPO Manager
  {
    id: 'sop-gpo-manager',
    title: '群組原則物件 (GPO) 安全設定稽核 SOP',
    component: 'AD Control',
    tags: ['例行維護', '資安審計'],
    content: `# 群組原則物件 (GPO) 安全設定稽核 SOP

## 總覽
透過 AD Control 的 GPO Manager，自網域控制站 (DC) 載入 GPO 清單，檢視啟用狀態與最後修改時間，並可在受控流程下備份 GPO、切換啟用狀態或調整單一登錄檔 (Registry) 型安全原則。所有變更都應先備份、再修改、後驗證。

## 前置條件與權限
- 目標 AD 伺服器已安裝 RSAT-GPMC。若頁面顯示 "RSAT-GPMC missing on remote AD Server"，請在該伺服器執行：
\`\`\`powershell
Install-WindowsFeature RSAT-GPMC
\`\`\`
- 角色：Viewer 僅能檢視（顯示 Read Only）；SuperAdmin 與 Operator 才能備份、變更狀態與編輯原則。
- 變更前請開立變更單，並確認 GPO 連結範圍 (OU) 與影響對象。

## 詳細步驟
1. 左側選單進入 **AD Control**，點選頁籤「🛡️ Group Policy (GPO) Manager」，系統會載入 GPO 清單（欄位：GPO Name、Status、Last Modified、Actions）。
2. 備份（修改前必做）：在右上「💾 Backup Path」填入備份路徑（留空則使用 DC 本機預設 C:\GPO_Backups，建議改填 NAS 路徑），按單筆列上的「💾 Backup」，或按「Backup ALL」備份全部 GPO，出現確認視窗後按 Confirm。
3. 檢視設定：點「✏️ Edit Security」，視窗上方「Configured Registry Settings in GPO」會列出該 GPO 已配置的登錄檔項目，點選任一項可帶入下方欄位供檢視或修改。
4. 修改原則：填入 Registry Key（例如 HKLM\Software\...）、Value Name (Optional)、Type（String / ExpandString / Binary / DWord / MultiString / QWord）與 Value Data，按「Set Policy」。要移除該項則按「Remove Policy」。
5. 切換狀態：每列的下拉選單可選 Enable All、Disable All、Disable Computer Settings、Disable User Settings，確認後套用。⚠️ 停用生產環境 GPO 前請先評估影響範圍。
6. 讓用戶端立即套用：用 Remote Command 對目標主機執行（Windows 欄位）：
\`\`\`powershell
gpupdate /force
\`\`\`

## 驗證
- 重新整理 GPO 清單，確認 Status 與 Last Modified 已更新。
- 在目標主機以 \`gpresult /r\` 或 \`gpresult /h C:\temp\gp.html\` 確認原則已套用。
- 於 Audit log 確認變更紀錄（操作者、GPO 名稱）。

## 常見問題與注意事项
- 載入失敗且訊息含 Get-GPO / GroupPolicy：多半為 RSAT-GPMC 未安裝，或 SOMP 使用的 AD 管理帳號權限不足。
- 變更後用戶端未生效：確認 GPO 已連結到正確 OU、安全篩選 (Security Filtering) 包含目標帳號，並等待複寫或執行 gpupdate。
- 誤改原則：以 Remove Policy 移除該項，或使用先前備份還原，必要時請 AD 管理員協助。

## 相關資源
- SOP：AD 目錄與帳號管理 (sop-ad-control)、遠端腳本執行 SOP (sop-remote-command)
- SOMP 選單：AD Control、Remote Command、Audit log`,
    workflowId: null,
    commandIds: ['p11', 'p12'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 16. Remote Command
  {
    id: 'sop-remote-command',
    title: '遠端腳本執行 (PowerShell / SSH) 與安全指令庫 SOP',
    component: 'Remote Command',
    tags: ['例行維護', '緊急應變'],
    content: `# 遠端腳本執行 (PowerShell / SSH) 與安全指令庫 SOP

## 總覽
Remote Command 可同時對多台主機執行維運指令：Windows 目標透過 WinRM (PowerShell)，Linux 目標透過 SSH。系統會依各 IP 自動偵測作業系統並分流指令，結果以串流方式即時顯示。目標是用最小、可稽核的指令完成診斷或修復。

## 前置條件與權限
- 需具備 Remote Command 功能權限（依 RBAC 群組設定）；所有執行與被擋下的危險指令都會寫入 Audit log。
- Windows：SOMP 以登入者或系統設定的 AD 管理帳號透過 WinRM 連線，目標需開放 WinRM。
- Linux：需在頁面輸入該 SSH 帳號的密碼。
- 目標主機必須可 ping 通，否則狀態為 Offline。

## 詳細步驟
1. 左側選單進入 **Remote Command**。
2. 在「Target IPs / Hostnames (One per line)」每行填入一個 IP 或主機名稱；頁面會統計已知的 Windows / Linux / 未知主機數量。
3. 如含 Linux 目標，於「Linux SSH Credential」輸入密碼。
4. 點右上「📚 Command Library」，選擇預設指令按「Use Command」帶入（建議優先使用，例如 Check System Uptime、Disk Space Overview、List Running Services、Tail System Logs）；也可在「Save Custom Command」填入 Command Name、Category、Windows Command、Linux Command 後按「Save Command」存成自訂指令。
5. 確認「🖼️ Windows (PowerShell)」與「🐧 Linux (Shell Script)」兩個欄位：欄位留空時，該 OS 的目標會被跳過 (Skipped)。
6. 先用唯讀指令（如 uptime、df -h）驗證目標，再執行變更類指令。按「⚡ Execute on All Targets」，於 Real-time Execution Output 檢視各主機結果。
7. 需要定期執行時，按「📅 Save as Scheduled Task」轉到 Task Scheduler 建立排程。

範例：
\`\`\`powershell
Get-Service | Where-Object Status -eq 'Running' | Select-Object -First 20
\`\`\`
\`\`\`bash
systemctl status nginx --no-pager
\`\`\`

## 驗證
- 各主機結果狀態：Online（有輸出）、Offline（ping 失敗）、Skipped（該 OS 指令為空）、Blocked（被安全政策擋下）。
- 變更類指令執行後，再跑一次唯讀指令確認服務或設定已如預期。
- 於 Audit log 查核執行人、時間與目標清單。

## 常見問題與注意事项
- 同時最多 10 台並行；Linux SSH 單次指令逾時約 5 秒，Windows 工作階段約 30 秒，長時間作業請改用 Task Scheduler 或 Workflow Editor。
- 出現 "Command blocked by security policy"：指令命中危險樣式，請改用更精確、可回復的指令，勿嘗試繞過。
- "Missing Linux password"：尚未輸入 SSH 密碼。"WinRM Error"：檢查 WinRM 服務、防火牆與 AD 帳號權限。
- ⚠️ 禁止在事件處理 SOP 中使用關機 / 重新啟動類指令，除非已取得變更核准。
- 不要把密碼、金鑰寫進指令內容。

## 相關資源
- SOP：群組原則 (GPO) 稽核 (sop-gpo-manager)、視覺化工作流程 (sop-workflow-automation)
- SOMP 選單：Remote Command、Task Scheduler、Audit log`,
    workflowId: null,
    commandIds: ['p11', 'p12', 'p15'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 17. SSL Certificate
  {
    id: 'sop-ssl-lifecycle',
    title: 'SSL/TLS 憑證生命週期管理與自動更新 SOP',
    component: 'SSL Certificate',
    tags: ['例行維護', '緊急應變'],
    content: `# SSL/TLS 憑證生命週期管理與自動更新 SOP

## 總覽
SSL Certificate 頁面集中追蹤各站台 HTTPS 憑證的到期日，並提供加密保存的憑證備份庫 (Archive Vault)。系統會掃描憑證並於即將到期時以 Telegram 與 SMTP 告警，目標是在到期前 30 天內完成更換與部署。

## 前置條件與權限
- Operator 與 SuperAdmin 可新增、掃描、刪除與解密私鑰；Viewer 僅能檢視（顯示 Read Only）。
- 需有 CA 簽發流程（內部 CA、商業 CA 或 ACME 工具）與目標 Web Server 的維運權限。
- 私鑰、PFX 密碼與憑證備份會以 AES-256 加密儲存；加密金鑰為資料目錄的 .system_key，請務必備份。

## 詳細步驟
1. 左側選單進入 **SSL Certificate**，檢視上方卡片：DOMAINS HEALTH（Safe > 30 days / Critical < 30 days / Unreachable）、TOTAL CERTIFICATES、ALERT SYSTEM。
2. 在 Certificate List 使用環境下拉與搜尋框（Search by domain, file...）篩選，依 DAYS REMAINING 找出 30 天內到期者。
3. 新增監控：按「+ Add Certificate」，填入 FRIENDLY NAME、ENVIRONMENT、HOST / DOMAIN、PORT（預設 443）；若要備份憑證檔，可上傳 PEM、DER、PFX/P12、JKS，或貼上憑證文字 (.CRT)、私鑰 (.KEY) 與 KEY / PFX PASSWORD（選填）。僅上傳檔案時列表會顯示 Backup File Only。
4. 立即重新檢查：按「🔄 Scan All Now」。
5. 申請新憑證：依 CA 流程簽發（ACME 自動化或 CA 入口網站），取得新憑證與完整憑證鏈。
6. 部署到 IIS、Nginx 或 Apache 後平滑重載，例如：
\`\`\`bash
nginx -t && systemctl reload nginx
\`\`\`
7. 部署後回到 SSL Certificate，重新 Scan 並確認 EXPIRATION DATE 已更新；必要時刪除舊紀錄（Delete）並保留新備份。
8. 需取回備份私鑰時，按「🔑 Decrypt Key」，該操作屬敏感行為，請在安全環境使用並避免外傳。

## 驗證
- 列表中該網域 DAYS REMAINING 回到 30 天以上，狀態為 Safe。
- 用 Remote Command 的 Check Open/Listening Ports 確認 443 正常監聽，或以 \`openssl s_client -connect host:443 -servername host\` 檢查憑證鏈。

## 常見問題與注意事项
- 排程與告警：系統掃描憑證後，會依到期天數透過 Telegram 與 SMTP 發出警示，請確認 System Settings 的通知設定有效。
- Unreachable：檢查 DNS、防火牆與 Port 是否正確，或服務是否已停止。
- 憑證鏈不完整會讓部分用戶端報錯，請部署含中繼憑證的 fullchain。
- 切勿將私鑰貼入工單或聊天；變更前先備份舊憑證，保留回復路徑。

## 相關資源
- SOP：DNS Hub (sop-dns-hub)
- SOMP 選單：SSL Certificate、Remote Command、Audit log`,
    workflowId: null,
    commandIds: ['p6', 'p8'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 18. FortiProxy Manager
  {
    id: 'sop-fortiproxy',
    title: 'FortiProxy 防火牆存取控制與原則 SOP',
    component: 'FortiProxy Manager',
    tags: ['例行維護', '緊急應變'],
    content: `# FortiProxy 防火牆存取控制與原則 SOP

## 總覽
FortiProxy Manager 以 REST API 管理 FortiProxy 節點：單筆部署位址物件、批次匯入、CMDB 狀態查詢、孤兒物件清理、Web Filter 測試、設定備份、原則啟停與 Session 追蹤。所有變更都會寫入 Audit log，部署前提供設定差異 (Diff) 預覽。

## 前置條件與權限
- 需先在 System Settings 設定 FortiProxy 伺服器節點，否則頁面會提示尚未配置任何節點。
- Operator 與 SuperAdmin 可部署；Viewer 只能查詢，部署區顯示 "Only Operator or Admin can deploy configurations."。
- 變更前取得變更核准，並確認目標環境（TARGET NODE）。

## 詳細步驟
1. 左側選單進入 **FortiProxy Manager**，於「TARGET NODE」選擇節點。頁籤有：📊 Usage Analytics、🚀 Single Deployment、🔍 CMDB Status Checker、🛠️ Advance Feature。
2. 單筆部署：進入「🚀 Single Deployment」，OPERATION TYPE 選 Add Proxy Address (URL Regex) / Add Proxy Address (Dst IP) / Add Source IP Address / Add Service Port；選擇 BUSINESS UNIT (BU)（Service Port 則填 PORT RANGE 1-65535）；在 INPUT LIST 每行輸入一筆；按「Execute Deployment」。
3. 在「FortiProxy Config Diff Preview」視窗檢視 Configuration Diff，確認無誤再按「Confirm & Deploy」，結果顯示於 Execution Results。
4. 先查再改：「🔍 CMDB Status Checker」選 CHECK TYPE（Proxy Address Match / Source IP Match）並輸入 TARGET QUERY，確認該 IP 或網域是否已存在綁定。
5. 進階功能（🛠️ Advance Feature 左側子選單）：📦 Bulk Import / Export（可下載範本、拖放 CSV）、♻️ Object Cleanup（掃描未綁定群組的孤兒物件）、🛡️ Web Filter Tester、📦 Config Backups、🔀 Policy Manager（Enable / Disable 原則）、🔍 Session Tracer（輸入來源 IP 檢視即時 Session）。
6. ⚠️ 停用原則、批次部署與刪除孤兒物件屬高風險操作，執行前請先檢視 Config Backups 是否有最新備份。

## 驗證
- Execution Results 或 Bulk Deployment Results 顯示 SUCCESS，無 FAILED。
- 再次以 CMDB Status Checker 查詢，確認物件與群組綁定正確。
- 用 Session Tracer 輸入使用者來源 IP，確認 Policy Hit 與 State 符合預期；以 Web Filter Tester 驗證 URL 類別。

## 常見問題與注意事项
- 部署失敗：檢查節點 API 連線與權限、輸入格式（IP、網域、Port 範圍）。
- Usage Analytics 若顯示 COMING SOON 屬功能調整中，非故障。
- 用 Remote Command 的 Print Routing Table 或 Ping 可輔助確認 SOMP 到 FortiProxy 的網路連通性。

## 相關資源
- SOP：Squid Proxy (sop-squid)、網路設定分析 NetSearch (sop-netsearch)
- SOMP 選單：FortiProxy Manager、Remote Command、Audit log`,
    workflowId: null,
    commandIds: ['p5', 'p6', 'p7'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 19. Squid Proxy
  {
    id: 'sop-squid',
    title: 'Squid Proxy ACL 規則與快取維護 SOP',
    component: 'Squid Proxy',
    tags: ['例行維護'],
    content: `# Squid Proxy ACL 規則與快取維護 SOP

## 總覽
Squid Proxy 頁面管理各環境的 Squid 伺服器：檢視即時流量與拒絕事件、編輯 ACL 與主設定檔、維護全域封鎖網域清單，以及從備份庫還原。部署設定時系統會先在本機建立備份，再推送到該環境全部伺服器並以 \`systemctl reload squid\` 平滑重載，不中斷既有連線。

## 前置條件與權限
- 需先在 System Settings 設定 SQUID_ENVS 與 SQUID_SERVERS，否則頁面顯示 "No Squid Environments Configured"。
- 編輯 / 部署設定需 Operator 或 SuperAdmin；Viewer 為唯讀。啟用或停用 URL 封鎖與更新黑名單僅限 SuperAdmin。
- 進入 Config、Block 與 Backup 功能前需輸入「🔒 sudo Authentication」密碼（僅用於本次 SSH 工作階段）。

## 詳細步驟
1. 左側選單進入 **Squid Proxy**，於「ENVIRONMENT」選擇環境。頁籤：📊 Dashboard、⚙️ Config Editor、🚫 URL Block/Allow、📦 Backup Vault。
2. 日常檢視：Dashboard 顯示 CACHE HIT RATIO、TRANSFERRED BANDWIDTH、ACTIVE CONNECTIONS、SECURITY DENIALS (403)、AVG RESPONSE TIME，以及 Top 10 Internal Clients / Visited Domains；Interactive Access Log Explorer 可用 All Logs / Denied / Hits / Errors / HTTPS Connects 篩選，並按 IP 或網域快速過濾。
3. 修改 ACL：進入 Config Editor，TARGET CONFIGURATION FILE 選 Access List (/etc/squid/allowip.txt) 或 Main Config (/etc/squid/squid.conf)，按「Fetch Live Configuration (Host 1)」載入，在編輯區修改。
4. ⚠️ 修改 squid.conf 前請確認語法；部署前先把原內容另存，確認每行 ACL 順序（deny 規則需在 allow 之前）。
5. 按「Deploy to <環境> Servers & Reload」並在確認視窗核准。
6. 封鎖網域：進入 URL Block/Allow，在「BLACKLISTED DOMAINS (One per line)」輸入（例如 \`.facebook.com\` 會封鎖該網域與所有子網域），依 STATUS 開關決定啟用，按部署後系統會更新黑名單並 reload。
7. 發生異常：Dashboard 的 AI 診斷可彙整客戶端流量與 403 事件，產生安全診斷報告（需先在 System Settings > AI Service 啟用）。

## 驗證
- 部署結果中每台伺服器皆顯示成功，並產生 *_backup.txt 備份檔（可在 Backup Vault 檢視）。
- 在 Dashboard 的 Access Log Explorer 以測試 IP 或網域確認被拒（TCP_DENIED / 403）或放行行為符合預期。
- 以 Remote Command 的 Check Open/Listening Ports 確認 Squid 埠（常見 3128）仍在監聽。

## 常見問題與注意事项
- 語法錯誤可能使 reload 失敗：請從 Backup Vault 開啟前一版，按其「還原」入口回到 Config Editor 再部署。
- 只更新 Host 1 載入的內容，但部署會同步到該環境所有伺服器，請確認各台設定一致。
- sudo 密碼錯誤會導致 Fetch 或 Deploy 失敗。

## 相關資源
- SOP：FortiProxy (sop-fortiproxy)、Mail Relay (sop-mail-relay)
- SOMP 選單：Squid Proxy、System Settings、Audit log`,
    workflowId: null,
    commandIds: ['p6', 'p12'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 20. Mail Relay
  {
    id: 'sop-mail-relay',
    title: 'Mail Relay SMTP 佇列清除與安全 SOP',
    component: 'Mail Relay',
    tags: ['例行維護', '緊急應變'],
    content: `# Mail Relay SMTP 佇列清除與安全 SOP

## 總覽
Mail Relay 頁面管理以 Sendmail 為基礎的郵件轉送節點：檢視當日寄送 / Deferred / Bounced 統計、以 Message Trace 追蹤單封郵件、管理佇列 (mailq)，並可編輯 /etc/mail 下的設定檔後部署與重啟服務。

## 前置條件與權限
- 需先在 System Settings 設定 Mail Relay 伺服器節點，否則頁面提示尚未設定。
- 需 Operator 或 SuperAdmin；清除 / 刪除佇列僅限 SuperAdmin 且需二次確認。
- 進入功能前需輸入「🔒 sudo Authentication」密碼。

## 詳細步驟
1. 左側選單進入 **Mail Relay**，選擇環境。頁籤：📊 Dashboard、🔍 Message Trace、📨 Queue Manager、⚙️ Config Editor、📦 Backup Vault。
2. Dashboard 檢視當日 Sent / Deferred / Bounced 與 Top 寄件來源；點 Deferred 或 Bounced 可展開明細（含寄件人與收件人）。可複製資訊作為調查依據，也可開啟 AI 顧問協助分析。
3. 追蹤單封郵件：Message Trace 輸入 Email、IP 或 Message-ID，系統在 /var/log/maillog 搜尋並回傳最近 200 行。
4. 佇列處理：Queue Manager 按「🔄 Refresh Queue」檢視 mailq。
   - 佇列暫時卡住：先按「🚀 Flush Queue」（執行 sudo sendmail -q 重送）。
   - 單封問題郵件：在「DELETE BY QUEUE ID」輸入 Queue ID（如 35I6Kx7v012345）後刪除。
   - ⚠️ 「🗑️ Clear Entire Queue」會把 /var/spool/mqueue 內全部郵件移到 /tmp/mqueue_trash，僅在確認為垃圾郵件暴增且已通報主管後使用。
5. 修改設定：Config Editor 選擇 access、smarttable 或 mailertable，按「Fetch Live Configuration (Host 1)」，修改後按「Deploy to <環境> Mail Server & Restart Sendmail」（系統會 makemap 並重啟 sendmail，並先備份）。
6. 異常來源 IP 可加入 access 檔 REJECT，並同步檢查該 IP 是否被列入 DNSBL（使用外部 DNSBL 查詢工具）。

## 驗證
- 再次 Refresh Queue，確認佇列數量下降且無新增大量 Deferred。
- Message Trace 以測試信件確認 stat=Sent。
- 用 Remote Command 的 Check Open/Listening Ports 確認 25 埠仍在監聽。

## 常見問題與注意事项
- Deferred 多為對端暫時拒收或 DNS 問題；Bounced 多為 User unknown，通知寄件者勿重寄。
- Clear 與 Delete 皆影響郵件遞送，請先記錄佇列內容；被移到 /tmp/mqueue_trash 的檔案可於伺服器上人工搬回。
- 設定部署後務必抽測，確認備份在 Backup Vault 可還原。

## 相關資源
- SOP：Squid Proxy (sop-squid)、SSL 憑證 (sop-ssl-lifecycle)
- SOMP 選單：Mail Relay、System Settings、Audit log`,
    workflowId: null,
    commandIds: ['p5', 'p6'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 21. ELK Manager
  {
    id: 'sop-elk-manager',
    title: 'ELK 叢集健康狀態與索引原則稽核 SOP',
    component: 'ELK Manager',
    tags: ['例行維護'],
    content: `# ELK 叢集健康狀態與索引原則稽核 SOP

## 總覽
ELK Manager 提供 Elasticsearch 叢集的健康與磁碟檢視、分片配置維運（停用/啟用分配、Flush、重啟節點、Explain、Reroute）、Logstash 設定部署、索引範本與 ILM 建立、索引生命週期違規掃描，以及 SIEM (winlogbeat) 輪詢規則設定。

## 前置條件與權限
- 需先在 System Settings 配置 ELK / SIEM 節點，否則頁面提示尚未配置。
- 叢集操作需 Operator 或 SuperAdmin；Viewer 唯讀。
- 涉及 SSH 的動作需先通過「🔒 sudo Authentication」；請記錄變更單號。

## 詳細步驟
1. 左側選單進入 **ELK Manager**，於「🎯 Target Cluster」選擇叢集。頁籤：Health & Disk、Cluster Operations、Logstash Deployer（有設定時才顯示）、Dev Tools & Indexing、🚨 SIEM。
2. 日常巡檢：Health & Disk 檢視 _cluster/health 燈號（綠：正常；黃：副本分片未分配；紅：主分片遺失）與各節點磁碟使用率，磁碟接近水位線時優先處理。
3. 計畫性重啟節點（Cluster Operations），依序操作並於「Execution Results Console」確認每步結果：
   - 先按「Disable Shard Allocation」暫停分片重新平衡。
   - 按「Perform Flush」將 translog 刷到磁碟。
   - 輸入節點 IP，按「Restart Target Node」並確認視窗。
   - 節點回到叢集後，按「Re-enable Shard Allocation」。
4. 黃燈 / 紅燈排障：先按「Explain Allocation」讀取原因（磁碟水位、分配過濾等），排除後再按「Force Reroute Shards」重試失敗的分片分配。
5. 索引治理（Dev Tools & Indexing）：使用「Index Template & ILM Creator」填入 Index Name (Alias)、Index Template Name、Index Patterns（不可以 * 開頭、不可含空白、長度不超過 200）、Lifecycle Policy 後部署。
6. 在「Index Lifecycle Policy Violation Scanner」可設定掃描頻率（每日 / 每週 / 每月 / 停用），掃描後檢視 Index Name、Health、Docs Count、Storage Size，勾選未受管索引後刪除。⚠️ 刪除不可復原，請先確認保留政策。
7. 「Danger Zone: Execute _delete_by_query」僅限明確核准的資料清理，務必先以小範圍條件測試。

## 驗證
- Health & Disk 回到綠燈且 unassigned shards 為 0。
- 重啟完成後確認節點已重新加入叢集、Re-enable 已執行。
- 違規掃描結果 Violations 為 0，或已逐筆處置。

## 常見問題與注意事项
- 磁碟爆滿會讓索引變唯讀：先清理或擴充磁碟，再處理索引的 read-only block。
- 忘記 Re-enable Shard Allocation 會讓叢集長期黃燈，操作後務必確認。
- Logstash Deployer 要求 NAS 上對應資料夾已存在。

## 相關資源
- SOP：SIEM 事件鑑識 (sop-siem-forensics)、Prometheus 目標 (sop-prometheus-target)
- SOMP 選單：ELK Manager、Audit log`,
    workflowId: null,
    commandIds: ['p9', 'p12'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 22. Prometheus Target
  {
    id: 'sop-prometheus-target',
    title: 'Prometheus 目標發現與指標抓取 SOP',
    component: 'Prometheus Target',
    tags: ['例行維護'],
    content: `# Prometheus 目標發現與指標抓取 SOP

## 總覽
Prometheus Target 頁面維護 HTTP Service Discovery 的目標清單。Prometheus 伺服器向 SOMP 的 SD 端點取得目標，系統只回傳未暫停的目標；頁面同時提供健康檢查排程、批次新增/更新、停用、刪除、匯出 CSV 與 scrape YAML。Windows 目標預設埠為 9182 (windows_exporter)，Linux 為 9100 (node_exporter)。

## 前置條件與權限
- 後端環境需設定 PROMETHEUS_SD_TOKEN（於 System Settings 管理），SD 端點使用 Bearer Token 驗證；未設定時端點回 401。
- Viewer 不可執行健康掃描與變更；請以 Operator 或 SuperAdmin 操作。

## 詳細步驟
1. 左側選單進入 **Prometheus Target**，頂端卡片顯示 Windows / Linux 數量與 Offline 數，並可依 BU、環境 (Zone)、狀態篩選；在「Registered Targets」搜尋 IP、Host、App。
2. 批次新增 / 更新：按「+ Add / Update Targets」，貼上每行一筆：
\`\`\`text
IP, HOSTNAME, ZONE, APPLICATION, BU
198.51.100.112, N-SYS-PROME01, MM_C1, Prometheus server, INFRA-SYS
\`\`\`
   按「Parse & Process Targets」，系統會探測作業系統並寫入；既有 IP 會更新標籤。
3. 暫停 / 啟用：對單筆或多選目標執行停用 (disable) 或啟用；暫停的目標不會出現在 SD 回應中。刪除目標需在 Confirm Deletion 視窗確認。
4. 健康檢查：按「Settings」，設定 CHECK INTERVAL（5 / 10 / 15 / 30 / 60 分鐘或 2 小時）後按「Save Settings」；需立即檢查則按「Run Scan Now」，LAST INSPECTION 會顯示上次執行時間。
5. 取得 Prometheus 設定：Settings 內的「Prometheus Scrape Config YAML」按「Copy YAML」，貼入 prometheus.yml 並 reload Prometheus。
6. 目標為 offline 時，在 Prometheus 伺服器驗證 exporter 端點：
\`\`\`bash
curl -s -m 5 http://<目標IP>:9100/metrics | head
\`\`\`
   Windows 目標改用 9182 埠，並確認 windows_exporter 服務為 Running。

## 驗證
- 目標清單中該主機不再是 offline，Offline 卡片數量下降。
- 在 Prometheus 的 Status > Targets 頁確認該目標為 UP。
- 可用 Remote Command 的 Check Open/Listening Ports 確認 9100 / 9182 在監聽。

## 常見問題與注意事项
- Prometheus 取得 401：檢查 Bearer Token 與 PROMETHEUS_SD_TOKEN 是否一致。
- 新目標未出現：確認 Prometheus 的 http_sd 刷新間隔，或目標被暫停。
- 防火牆需放行 Prometheus 伺服器到目標的 exporter 埠。

## 相關資源
- SOP：ELK 叢集健康 (sop-elk-manager)、Scout 監控 (sop-scout-monitor)
- SOMP 選單：Prometheus Target、System Settings、Remote Command`,
    workflowId: null,
    commandIds: ['p6'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 23. Redis Control
  {
    id: 'sop-redis-cluster',
    title: 'Redis 叢集記憶體分配與快取調校 SOP',
    component: 'Redis Control',
    tags: ['例行維護', '緊急應變'],
    content: `# Redis 叢集記憶體分配與快取調校 SOP

## 總覽
Redis Control 頁面管理 Redis 連線（依 BU 分組），並可對選定的執行個體讀取與修改執行期設定 (CONFIG GET / SET) 及寫回設定檔 (CONFIG REWRITE)。此頁面不提供資料清空 (FLUSH) 功能，記憶體相關調整主要透過 maxmemory 與 maxmemory-policy 參數完成。

## 前置條件與權限
- Operator 與 SuperAdmin 可新增 / 編輯 / 刪除連線、修改參數與 REWRITE；Viewer 僅能檢視。
- 需備妥 Redis 主機、埠 (預設 6379)、密碼與是否啟用 TLS。
- 所有 CONFIG SET 與 CONFIG REWRITE 都會記入 Audit log。

## 詳細步驟
1. 左側選單進入 **Redis Control**。若連線不存在，按新增連線，填入 BU (Business Unit)、Hostname、IP Address、Port、Password、「Enable TLS Connection」後按「Save Connection」。也可用 📥 Import / 📤 Export 批次維護。
2. 在 Connections 清單點選目標列，開啟 \`📡 IP:Port\` 設定視窗，標頭會顯示 Master 或 "Slave of ..." 角色；先確認角色，避免誤改。
3. 以「Search parameters...」搜尋 \`maxmemory\`、\`maxmemory-policy\`，記錄目前值。
4. 評估調整：快取型服務通常用 allkeys-lru；有持久化資料需求不可誤用淘汰策略。調整時點該參數的編輯按鈕，輸入新值後按「Save」。例如：
\`\`\`text
maxmemory-policy = allkeys-lru
maxmemory = 4gb
\`\`\`
5. 為了讓變更在重啟後仍有效，按「💾 REWRITE」並在確認視窗核准。⚠️ 這會覆寫 redis.conf；系統會先把當前設定 JSON 備份後再寫入。
6. 需要即時確認目前記憶體與碎片率時，使用 Remote Command 或 SSH 在 Redis 主機執行：
\`\`\`bash
redis-cli -a '<密碼>' INFO memory | egrep 'used_memory_human|maxmemory_human|mem_fragmentation_ratio'
\`\`\`

## 驗證
- 重新整理設定視窗（🔄 Refresh），確認參數值已更新。
- INFO memory 顯示 used_memory 低於 maxmemory，evicted_keys 增長速度符合預期。
- 應用端快取命中率與延遲無劣化。

## 常見問題與注意事项
- 連不上：檢查 IP、埠、密碼與 TLS 設定，並確認防火牆。
- 僅 CONFIG SET 而未 REWRITE，重啟後設定會回復。
- 主從架構請分別檢查 Master 與各 Slave，且 Slave 的 maxmemory 不應小於 Master。
- 不要把密碼寫入工單或截圖。

## 相關資源
- SOP：Kubernetes 維運 (sop-k8s-cluster)、遠端腳本執行 (sop-remote-command)
- SOMP 選單：Redis Control、Remote Command、Audit log`,
    workflowId: null,
    commandIds: ['p6'],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 24. Kubernetes
  {
    id: 'sop-k8s-cluster',
    title: 'Kubernetes Pod 復原與命名空間檢查 SOP',
    component: 'Kubernetes',
    tags: ['緊急應變', '容器維運'],
    content: `# Kubernetes Pod 復原與命名空間檢查 SOP

## 總覽
Kubernetes 頁面集中管理多個叢集：節點儀表板、Workloads (Pod)、Deployments、Services & Ingress、Storage & Config、Prometheus Monitoring 與 Events。針對故障 Pod 可檢視 Logs、YAML、Web Exec、重啟，也可對 Deployment 擴縮或回滾，並提供 AI 事故診斷。

## 前置條件與權限
- 叢集需先新增：按新增叢集，填入 Cluster Name、Environment，認證方式選 Kubeconfig YAML，或填 API Server URL 與 Bearer Token；憑證會加密保存。Skip TLS Verify 僅限測試環境。
- Operator 與 SuperAdmin 可 Exec、Restart、Scale、Rollback；Viewer 僅能檢視 Logs 與 YAML；刪除叢集僅限 SuperAdmin。

## 詳細步驟
1. 左側選單進入 **Kubernetes**，在 Clusters 清單點選叢集進入，頁籤包含 Node Dashboard、Workloads、Deployments、Services & Ingress、Storage & Config、Prometheus Monitoring、Events。
2. 先看全局：Node Dashboard 確認節點 Ready；Events 頁查看近期 Warning（如 FailedScheduling、BackOff、OOMKilled）。
3. 在 Workloads 選擇 Namespace，檢視 Pod 狀態（Running、Pending、CrashLoopBackOff 等）。對故障 Pod 從 Action 下拉選：「📋 Logs」看應用日誌、「⚙️ YAML」看資源限制與探針、「🤖 AI 事故診斷」產生診斷報告。
4. 嘗試復原：先確認該 Pod 由 Deployment 等控制器管理，再選「🔄 Restart」（實際為刪除 Pod 由控制器重建），確認視窗核准後觀察新 Pod 狀態。⚠️ 單獨存在（無控制器）的 Pod 被刪除後不會重建。
5. 版本問題：在 Deployments 頁的 Action 選「History」查看 REVISION 與映像版本，確認有問題的更新後按「Rollback to this」回滾到前一個穩定版本。
6. 容量問題：選「Scale」調整副本數；注意資源與 HPA 設定。
7. 需要深入主機層級時，可使用節點的 SSH OS Diagnostics 檢視作業系統狀態。

可搭配的命令列範例（在有 kubectl 的主機）：
\`\`\`bash
kubectl -n <namespace> describe pod <pod>
kubectl -n <namespace> get events --sort-by=.lastTimestamp | tail -20
\`\`\`

## 驗證
- Pod 狀態回到 Running 且 READY 為全部容器就緒。
- Deployment 的 REPLICAS (READY / DESIRED) 一致，Events 無新 Warning。
- 應用健康檢查與服務存取正常。

## 常見問題與注意事项
- CrashLoopBackOff：先看 Logs（必要時以 kubectl logs --previous 取得前一次容器日誌），常見原因為設定錯誤、相依服務不通、記憶體不足 (OOMKilled)。
- ImagePullBackOff：檢查映像名稱、倉庫憑證與網路。
- 切勿在生產環境隨意 Web Exec 修改容器內檔案，重啟即遺失，應修正 Deployment 或 ConfigMap。
- 回滾與擴縮前先通知相關團隊。

## 相關資源
- SOP：Prometheus 目標 (sop-prometheus-target)、視覺化工作流程 (sop-workflow-automation)
- SOMP 選單：Kubernetes、Audit log`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 25. Workflow Editor
  {
    id: 'sop-workflow-automation',
    title: '視覺化工作流程自動化 (Visual Workflow DAG) 開發 SOP',
    component: 'Workflow Editor',
    tags: ['流程自動化', '新人教學'],
    content: `# 視覺化工作流程自動化 (Visual Workflow DAG) 開發 SOP

## 總覽
Workflow Editor 以畫布 (DAG) 串接多個節點，將重複性維運作業轉為可稽核、可重跑的流程。支援節點：SSH、PowerShell、HTTP/Webhook（含 Telegram 預設）、Kubernetes、Nutanix AHV、JS Script、Condition、For-Each Loop、Manual Approval、Sleep。

## 前置條件與權限
- 需具備 Workflow Editor 功能權限；JS Script 節點僅 SuperAdmin 可觸發。
- 先用 Remote Command 或手動驗證每個指令都能獨立成功，再放進流程。
- 敏感值（密碼、Token）不要寫在節點內，改用 System Settings 與 Webhook 整合預設。

## 詳細步驟
1. 左側選單進入 **Workflow Editor**，在上方下拉選取既有流程或建立新流程，並命名。
2. 從節點面板把節點拖到畫布，依執行順序連線；用 Auto Layout（垂直 Ctrl+Shift+A / 水平）整理版面。
3. 設定變數：在變數區填入 Variable Key（例如 TARGET_HOST）與值，節點欄位以 \`{{TARGET_HOST}}\` 引用。
4. 在節點間取用結果：\`ctx.<nodeId>.stdout\`、\`ctx.<nodeId>.exitCode\`、\`ctx.<nodeId>.status\`、HTTP 為 \`ctx.<nodeId>.body\`、JS Script 為 \`ctx.<nodeId>.result\`。
5. 條件分支：Condition 使用受限的安全運算式（比較、&& || !、三元、Math、字串與陣列常用方法），非完整 JS；運算式錯誤或缺少節點資料會使該節點失敗，不會當成 FALSE。例如：
\`\`\`text
ctx.node_1.exitCode == 0 && ctx.node_1.stdout.includes('OK')
\`\`\`
6. 高風險步驟前加入 Manual Approval，填「Approval Message」（可用 {{VAR}}）；流程暫停為 WAITING_APPROVAL，並透過 Workflow 通知類別發送 Telegram，SuperAdmin 在 Execution Logs 選 ✅ Approve 或 ⛔ Reject（可附註解）。
7. 儲存（Ctrl+S）後按「▶ Execute」測試，並開啟 Execution History / Execution Logs 逐節點檢視。需重複使用時可存成範本 (Save as Template)。
8. 定期執行請搭配 Task Scheduler。

## 驗證
- Execution Logs 各節點狀態：SUCCESS、FAILED、SKIPPED、PENDING、AWAITING APPROVAL、REJECTED，確認符合預期。
- 失敗節點的後代會被標為 SKIPPED，獨立分支仍會執行，整體狀態為 FAILED。
- 先用測試主機 / 測試資料驗證，再套用到生產目標。

## 常見問題與注意事项
- JS Script 在隔離子行程執行：無檔案系統、無子行程、環境變數為空，逾時 5 秒，回傳值與 ctx 必須可序列化為 JSON。
- 舊格式 \`ctx["node_1.stdout"]\` 仍相容，但建議改用新寫法。
- 等待審核中的執行沒有逾時，也不會被歷史清理（歷史保留 200 筆）；Reject 後其餘節點為 SKIPPED。
- 流程刪除前請確認沒有被排程引用。

## 相關資源
- SOP：遠端腳本執行 (sop-remote-command)、任務排程 (sop-task-scheduler)
- SOMP 選單：Workflow Editor、Task Scheduler、Audit log`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 26. NetSearch
  {
    id: 'sop-netsearch',
    title: '網路設定分析與介面視覺化 SOP',
    component: 'NetSearch',
    tags: ['例行維護', '新人教學'],
    content: `# 網路設定分析與介面視覺化 SOP

## 總覽
NetSearch (Configuration Visualizer) 將後端定期匯入並解析的防火牆 / 交換器 / F5 設定檔轉為可搜尋的畫面：FQDN、安全規則、NAT 規則、路由表、安全物件、F5 虛擬服務與 Pool。支援 IP、CIDR、Port 或關鍵字查詢，用於變更前影響分析與稽核。

## 前置條件與權限
- 需具備 NetSearch 功能權限；Operator 與 SuperAdmin 可手動重新載入設定。
- 後端需設定 NETSEARCH_BACKUP_ROOT（設定備份根目錄；留空則 NetSearch 整體停用）。可選 NETSEARCH_CRON_SCHEDULE 定期重新載入、NETSEARCH_DEVICES 與 NETSEARCH_FQDN_FILE。
- 頁首的 Backend Sync 時間顯示最近一次資料同步時間，若過舊先手動重新載入。

## 詳細步驟
1. 左側選單進入 **NetSearch**，先確認 Backend Sync 時間是否符合預期，並在「Device Sources」選擇要查詢的設備來源。
2. 在搜尋框輸入 IP、CIDR、Port 或規則關鍵字（placeholder：Search IP, CIDR, Port, or Rule...）。左側按鈕可切換搜尋模式 Keyword（模糊）與 Exact（完全比對）。
3. 縮小範圍：使用「From Zone...」、「To Zone...」、「Tag Filter...」與來源 / 目的篩選，勾選 F5 Disabled Only 可只看停用的 F5 成員。
4. 在頁籤間切換：FQDN、Sec Rules、NAT Rules、Routes、Objects、F5 Virtuals、F5 Pools；每個頁籤旁會顯示符合筆數。可用展開 / 收合 (Expand / Collapse) 控制群組顯示，Clear 重設全部篩選。
5. 多筆查詢：開啟 Bulk Search Engine，每行輸入一個 IP / CIDR / Port / 關鍵字批次查詢。
6. 匯出：切到 Export 頁籤，於「Configure Export Columns (Drag to Reorder)」選擇並排序欄位（Device、Rule Name、Action、From / To Zone、Source / Destination Address、Service、Application 等）後匯出。
7. 臨時比對：Import 按鈕可匯入自訂設定檔做 ad-hoc 分析（不改變後端資料）。
8. 對照原始設定：Raw Config 頁籤檢視原文；Debug 頁籤的 Parser Diagnostic Metrics 協助確認解析是否完整。

## 驗證
- 以已知 IP 搜尋，確認回傳的規則與設備記錄和原始設定一致。
- 多設備比對同一 IP / Port 的放行規則，確認 Source、Destination、Service 與 Action。
- 修改防火牆後，等待同步或重新載入，再驗證新規則已被解析。

## 常見問題與注意事项
- 搜尋結果為空：確認 Search Mode（Exact 需完全相同）、Zone 篩選、設備來源與備份檔是否已匯入。
- 資料過舊：NetSearch 依賴設定備份檔，備份未更新就不會看到最新規則。
- 匯出檔可能含敏感網段資訊，請依資料分級保管。

## 相關資源
- SOP：FortiProxy (sop-fortiproxy)、IPAM 網路管理 (sop-ipam-network)
- SOMP 選單：NetSearch、Network Device、IPAM`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  },

  // 27. Spare Parts & RMA
  {
    id: 'sop-spare-parts-rma',
    title: '硬體備品庫存與 RMA 退換貨追蹤 SOP',
    component: 'Spare Parts',
    tags: ['例行維護', '硬體管理'],
    content: `# 硬體備品庫存與 RMA 退換貨追蹤 SOP

## 總覽
Spare Parts 管理備品庫存（RAM、HDD、SSD、PSU 等）：分類、位置、單價、最低庫存警示、入庫 / 出庫與異動歷史。RMA 追蹤則結合 Hardware Issues（故障單與處理時間軸）與 Contracts & Warranties（保固合約），確保故障件可溯源、保固內件向原廠請換。

## 前置條件與權限
- 需具備資料中心相關功能權限；Viewer 僅能檢視，Operator 與 SuperAdmin 可異動。
- 先確認故障設備在 Server Rack / Data Centers 內已有資料，以便故障單關聯設備與序號。
- 保固資訊維護於 Contracts & Warranties（可關聯設備、填寫 Vendor、Serial Number、Start Date 與 End Date）。

## 詳細步驟
1. 左側選單進入 **Spare Parts**，上方卡片顯示 TOTAL INVENTORY VALUE、TOTAL ITEMS IN STOCK、LOW STOCK ALERTS；低於最低水位的品項會標示「⚠️ Low Stock」並排在最前。
2. 新增品項：開啟新增視窗「New Spare Item」，填 Category、Item Name、Model、Location / Bin Number、Unit Price (TWD)、Minimum Stock Alert Level、Specification，按「Save Item」。分類可在左側 Categories 區新增。
3. 異動庫存：品項列的「📥 In」入庫（Stock In 視窗填 Quantity 與 Note / Reference，如 PO 單號）、「📤 Out」出庫（備註填 Issue ID）；庫存不足時系統會拒絕。按 📜 開啟 Stock History 查詢 Date、Type、Qty、User、Note。
4. 故障換件：到 **Hardware Issues** 建立故障單（Datacenter、Device、Location、Failed Parts、Urgency、Status），勾選「🛠️ Use Spare Part for Repair (Auto Deduct Inventory)」並選擇備品與數量，即可自動扣庫存。
5. RMA 寄修：目前系統沒有專用的 RMA 狀態欄位，請在該故障單的 Process Timeline 以「Process」新增紀錄，註明原廠名稱、RMA 單號 / Tracking 序號、寄出日期，並維持故障單狀態為 Processing。
6. 收到更換件：更新 Process Timeline 並將備品以「📥 In」入庫（Note 填 RMA 單號），故障單確認完成後選「Close」。
7. 每月盤點：比對實體數量與系統數量，低於安全水位者提出補貨申請。

## 驗證
- Stock History 有對應的入 / 出庫紀錄，且 Note 含單號。
- 故障單 Process Timeline 完整保留 RMA 單號與日期，Status 為 Closed。
- LOW STOCK ALERTS 為 0 或已有補貨單；設備保固未過期時，確認以保固流程請換。

## 常見問題與注意事项
- 出庫顯示 "Not enough stock!"：庫存不足，需先入庫或改用其他來源。
- 故障單選不到備品：該品項庫存為 0 時選項會被停用。
- 更換下來的故障件在寄回原廠前，請先依資安規範清除儲存媒體資料。

## 相關資源
- SOP：資料中心與機櫃管理 (sop-dc-rack-management)
- SOMP 選單：Spare Parts、Hardware Issues、Contracts & Warranties、Server Rack`,
    workflowId: null,
    commandIds: [],
    updatedBy: 'SYSTEM',
    updatedAt: new Date().toISOString()
  }
];

// Additional SOP presets (功能操作、主機/服務告警應變、平台維運)
PRESEEDED_RUNBOOKS.push(
    ...require('../lib/runbookPresets/featuresOps'),
    ...require('../lib/runbookPresets/incidentsHost'),
    ...require('../lib/runbookPresets/incidentsService'),
    ...require('../lib/runbookPresets/platformOps'),
);

// GET list of runbooks
router.get('/', (req, res) => {
  try {
    let runbooks = readDataSync('runbooks.json', null);
    if (runbooks === null || runbooks.length === 0) {
      runbooks = PRESEEDED_RUNBOOKS;
      writeDataSync('runbooks.json', runbooks);
    } else {
      // Auto-merge new or updated preseeded runbooks into database
      let changed = false;
      const existingMap = new Map();
      runbooks.forEach(r => existingMap.set(r.id, r));

      PRESEEDED_RUNBOOKS.forEach(seed => {
        const existing = existingMap.get(seed.id);
        if (!existing) {
          existingMap.set(seed.id, seed);
          changed = true;
        } else if (existing.updatedBy === 'SYSTEM' || !existing.updatedBy) {
          existingMap.set(seed.id, { ...existing, ...seed, updatedAt: seed.updatedAt });
          changed = true;
        }
      });

      if (changed) {
        runbooks = Array.from(existingMap.values());
        writeDataSync('runbooks.json', runbooks);
      }
    }

    const { query, component, tag } = req.query;
    let filtered = [...runbooks];

    if (component) {
      filtered = filtered.filter(r => r.component === component);
    }

    if (tag) {
      filtered = filtered.filter(r => r.tags && r.tags.includes(tag));
    }

    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(r => 
        (r.title && r.title.toLowerCase().includes(q)) || 
        (r.content && r.content.toLowerCase().includes(q)) ||
        (r.component && r.component.toLowerCase().includes(q))
      );
    }

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single runbook details
router.get('/:id', (req, res) => {
  try {
    let runbooks = readDataSync('runbooks.json', []);
    const rb = runbooks.find(r => r.id === req.params.id);
    if (!rb) return res.status(404).json({ error: 'Runbook not found' });
    res.json(rb);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST new runbook
router.post('/', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    const { title, component, tags, content, workflowId, commandIds } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and Content are required' });

    let runbooks = readDataSync('runbooks.json', null);
    if (runbooks === null || runbooks.length === 0) {
      runbooks = [...PRESEEDED_RUNBOOKS];
    }

    const newRb = {
      id: `sop-${Date.now().toString(36)}`,
      title,
      component: component || 'Other',
      tags: tags || [],
      content,
      workflowId: workflowId || null,
      commandIds: commandIds || [],
      updatedBy: req.user.username,
      updatedAt: new Date().toISOString()
    };

    runbooks.push(newRb);
    writeDataSync('runbooks.json', runbooks);
    auditLog(req.user.username, 'Runbook', `Created SOP Runbook: ${title}`);
    res.status(201).json(newRb);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update runbook
router.put('/:id', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    const { title, component, tags, content, workflowId, commandIds } = req.body;
    
    let runbooks = readDataSync('runbooks.json', []);
    const idx = runbooks.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Runbook not found' });

    const updated = {
      ...runbooks[idx],
      title: title || runbooks[idx].title,
      component: component || runbooks[idx].component,
      tags: tags || runbooks[idx].tags,
      content: content || runbooks[idx].content,
      workflowId: workflowId !== undefined ? workflowId : runbooks[idx].workflowId,
      commandIds: commandIds || runbooks[idx].commandIds,
      updatedBy: req.user.username,
      updatedAt: new Date().toISOString()
    };

    runbooks[idx] = updated;
    writeDataSync('runbooks.json', runbooks);
    auditLog(req.user.username, 'Runbook', `Updated SOP Runbook: ${updated.title}`);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE runbook
router.delete('/:id', checkRole(['SuperAdmin']), (req, res) => {
  try {
    let runbooks = readDataSync('runbooks.json', []);
    const filtered = runbooks.filter(r => r.id !== req.params.id);
    writeDataSync('runbooks.json', filtered);
    auditLog(req.user.username, 'Runbook', `Deleted SOP Runbook ID: ${req.params.id}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read-only access for the AI Agent (lib/agent/tools/common.js)
router.PRESEEDED_RUNBOOKS = PRESEEDED_RUNBOOKS;

module.exports = router;
