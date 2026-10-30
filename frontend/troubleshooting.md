# SOMP Vanguard - Troubleshooting Guide (故障排查與診斷指南)

本指南旨在協助系統管理員解決在 Windows Server 2016 環境下執行 **somp-vanguard** 時可能遇到的常見問題與排查步驟。

---

## 🛠️ 系統需求與環境規格 (System Requirements)

*   **作業系統**: Windows Server 2016 / 2019 / 2022
*   **執行環境**: Node.js v18.x 或更高版本
*   **安裝路徑**: `C:\Program Files\somp-vanguard`
*   **服務管理器**: [WinSW](https://github.com/winsw/winsw) (Windows Service Wrapper)
    *   執行檔: `somp-vanguard.exe`
    *   設定檔: `somp-vanguard.xml`
    *   服務名稱: `somp-vanguard`
*   **網路與通訊埠需求**:
    *   **Port 8080**: 平台前端與 API 存取 (`http://<SERVER_IP>:8080`)
    *   **平台設定 (Settings)**: 整合於 Vanguard 主控台側邊導覽列「Settings」分組（限定 SuperAdmin，舊式 `/_setting` 已正式棄用）
    *   **LDAP / LDAPS**: Port 389 / 636 (Active Directory 網域驗證)
    *   **WinRM / SSH**: Port 5985 / 22 (遠端命令執行與 Agent 部署)
    *   **Prometheus Exporter**: Port 9100 (Linux node_exporter), 9182 (windows_exporter)
    *   **DNS 服務**: Port 53 UDP/TCP (DNS Hub 存活探測)

---

## 🔍 常見故障排除 (Common Scenarios)

### 1. Scout Agent Linux 部署報錯 (`RPM should not be used directly... /bin/sh is needed`)
*   **現象**: 在 Ubuntu / Debian 主機上一鍵執行 `install.sh` 安裝 Scout Agent 時，出現 `rpm: RPM should not be used directly install RPM packages, use Alien instead! /bin/sh is needed` 錯誤。
*   **可能原因**: 早期安裝腳本未區分 Linux 發行版家族，嘗試在 Debian 系上強制安裝 RHEL RPM 套件導致依賴性失敗。
*   **解決方案**:
    1. 系統現已全面支援 **DEB / RPM 雙發行版自動適配**。
    2. 請至 **Agent > Install Agent > Deploy Scout Agent** 複製最新的一鍵指令。
    3. `install.sh` 會自動偵測 Debian/Ubuntu 系統並下載 `scout-*-amd64.deb` 原生透過 `dpkg -i` 完成乾淨安裝，不再需要安裝 rpm 工具。

---

### 2. Scout Open API 報錯 `400 Bad Request` (`不支援的查詢參數`)
*   **現象**: 呼叫 Open API 端點（例如 `/api/v1/open/logs/events?ips=192.0.2.6`）時回傳 `400 Bad Request`，提示 `不支援的查詢參數: ips (Unsupported query parameter(s))`。
*   **可能原因**: Open API 全面啟用了**嚴格參數白名單校驗**，防止傳入錯誤或拼寫不一致的 Query 參數。
*   **解決方案**:
    1. 檢查傳入的參數名稱是否正確：
       - 主機 IP 查詢請使用 `?ip=192.0.2.6` 或 `?host=192.0.2.6`（不可使用 `ips`、`server`、`node`）。
       - 受支援的參數清單可參考 API 回傳之 `supportedParameters` 或 `docs/SCOUT_OPEN_API.md`。

---

### 3. Scout Monitor 分頁切換環境時顯示「No hosts configured」
*   **現象**: 停留在第 2 或第 3 頁時，切換 Environment（環境）或狀態過濾標籤後，列表顯示空白，必須手動點回第 1 頁才能看到資料。
*   **可能原因**: 切換篩選條件後總頁數變少，但當前頁碼未自動歸零。
*   **解決方案**:
    1. 系統已加入條件變更自動重置（`currentPage = 1`）與 `safeCurrentPage` 邊界保護機制。
    2. 若仍有快取，請強制重新整理瀏覽器 (`Ctrl + F5`) 即可恢復正常。

---

### 4. Server List (Simplified CMDB) 未自動帶入 Server Rack 機櫃中的既有 Compute 資源
*   **現象**: 改版前已建立在 Server Rack 中的獨立 Server 或 Nutanix 刀鋒節點未自動顯示於 Server List 中。
*   **可能原因**: Server List 尚未執行全域資料同步關聯。
*   **解決方案**:
    1. 進入 **Server Operation > Server List**。
    2. 點擊右上角 **Edit Mode** 進入編輯模式。
    3. 點擊 **Global Auto-Sync** 按鈕。
    4. 系統將全量掃描所有 Data Center 的 Server Rack 結構，自動將所有 Compute 設備與 Nutanix 節點（包含 SN、iLO IP、CVM IP、位置槽位）匯入 CMDB。

---

### 5. CMDB 出現「Drift Detected」硬體規格漂移告警
*   **現象**: 主機卡片或表格列顯示 ⚠️ `Drift Detected` 警示標記。
*   **可能原因**: 主機於虛擬化平台熱插拔擴充了 CPU 核心數或記憶體容量，導致即時遙測 (Live Specs) 與 CMDB 歷史記錄不一致。
*   **解決方案**:
    1. 點擊主機開啟 **360° CMDB Drawer**。
    2. 檢閱 **Hardware Drift Comparison Table** 比對記錄值與實際值。
    3. 若擴充為正常合法變更，點擊 **Sync Specs from Live Agent** 按鈕，系統將自動校準 CMDB 資料並消除告警。

---

### 6. Data Centers 機房平面圖導航與方向設定
*   **現象**: 點擊 2D Top-Down 平面圖上的機櫃時，U 數排列或機櫃號碼由左至右順序與現場實體相反。
*   **可能原因**: 機房的視角排列方向未配置。
*   **解決方案**:
    1. 進入 **Data Centers** 模組，點擊該機房卡片的 **Edit**。
    2. 集中調整：
       - `rackOrder`: `normal` (由左至右) 或 `reverse` (由右至左)
       - `uOrder`: `normal` (1U 在下/42U 在上) 或 `reverse` (1U 在上/42U 在下)
       - `rowOrder`: `normal` 或 `reverse`
    3. 儲存後所有機房內機櫃將自動套用對齊現場視角。

---

### 7. 本地管理員 (admin@local) 登入失敗
*   **現象**: 密碼正確但顯示 "Invalid credentials"。
*   **可能原因**:
    *   `LOCAL_ADMIN_PWD` 在 `.env` 中被手動修改，且未正確套用 `enc:` 加密標記。
*   **解決方案**:
    1. 進入後台目錄下的 `.env`。
    2. 將 `LOCAL_ADMIN_PWD` 暫時改回明文密碼（不含 `enc:` 前綴）。
    3. 重啟服務後登入，再透過 Settings 介面儲存一次，讓系統自動重新加密。

---

### 8. AD 登入驗證異常 (Active Directory Error)
*   **現象**: 登入一直轉圈或顯示 "AD Error"。
*   **可能原因**:
    *   Windows Server 伺服器**未安裝 RSAT (Active Directory Tools)**，導致無法載入 `ActiveDirectory` 模組。
    *   帳號不在 `ALLOWED_LOGIN_AD_OU` 所允許的 OU 範圍內。
*   **解決方案**:
    1. 於 Server 執行：`Install-WindowsFeature RSAT-AD-PowerShell`。
    2. 確認 PowerShell 執行原則：`Set-ExecutionPolicy RemoteSigned -Scope Process`。

---

### 9. Task Scheduler 排程跨日時差或提早/延遲觸發
*   **現象**: 設定的排程任務在跨日或時區切換時未準時執行。
*   **可能原因**: 傳統排程套件可能受到 Windows 時區與 UTC 轉換影響。
*   **解決方案**:
    1. 系統已全面改用 **「原生本地時間輪詢引擎」**（依據 OS 本地 `Date` 物件配合 `setInterval` 輪詢）。
    2. 請確認 Windows Server 的本機時鐘與時區設定正確即可，排程引擎會全自動按本地時間精確觸發。

---

### 10. SIEM 日誌過多與資料庫膨脹
*   **現象**: 監控主機眾多，擔心 Event Logs 或 Syslog 佔滿伺服器儲存空間。
*   **機制說明與維護**:
    *   系統內建自動輪替引擎：單一資料表上限 **200,000 筆**，最長保存 **30 天**。
    *   超出上限或過期時系統會自動批次清理老舊資料，保障 SQLite 輕量與高速查詢。
    *   可於 **SIEM Settings** 依企業合規需求調整各資料表的保留天數。

---

### 11. SQLite 資料庫自動備份與保留天數排查
*   **現象**: 備份目錄未產生日期檔案，或擔心硬碟被歷史備份佔滿。
*   **機制說明與解決方案**:
    1.  **目錄設定 (`Backup Path`)**：請至 **Settings > SQLite Auto-Backup Settings** 指定備份目錄路徑（例如 `C:\ProgramData\somp-vanguard\config_backup`）。
    2.  **多版本歷史檔案**：系統每日於排程時間自動產出 `database_backup_YYYY-MM-DD.sqlite`，並同步更新 `database_backup_latest.sqlite`。
    3.  **自動輪替清理 (`Backup Retention`)**：在 Settings 中設定保留天數（預設 30 天），系統每次完成備份後會自動刪除超過保留期的歷史備份。

---

## 📋 日誌檔案位置 (Log Locations)

*   **系統審計日誌**: `backend\save_data\logs\auth_YYYY-MM-DD.log`
*   **Windows 服務日誌**: `C:\Program Files\somp-vanguard\somp-vanguard.wrapper.log`
*   **背景任務與標準輸出**: `C:\Program Files\somp-vanguard\somp-vanguard.out.log`
*   **排程執行日誌**: `backend\save_data\scheduler_logs.json`

---

**© 2026 SOMP Vanguard Team**  
*Maintainer: Noel Huang*
