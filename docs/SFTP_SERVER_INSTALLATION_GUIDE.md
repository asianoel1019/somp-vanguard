# Scout SFTP Server 免 Python 安裝與 Windows Service 部署手冊

## 📖 系統簡介

本系統為專為 **Windows Server 2016 / 2019 / 2022** 設計的高效能、純 Python 獨立 SFTP 伺服器模組。已完整封裝為獨立執行檔 (`.exe`)，**目標主機無需安裝 Python、Git 或任何編譯器**，即可一鍵註冊為 Windows 原生系統服務 (Windows Service)。

### 🌟 核心特色
- **免安裝環境**：內建獨立 Python 3.11 核心與所有依賴函式庫，解壓縮即用。
- **Windows Service 原生守護**：採用 `scout_sftp_server.exe` (WinSW) 服務封裝，支援開機自動背景啟動、崩潰 3 秒內自動重啟與日誌輪替。
- **Windows Active Directory 原生網域驗證**：免裝 LDAP 套件，直接呼叫 Win32 API (`advapi32.LogonUserW`) 進行 AD 帳號密碼檢驗。
- **實體目錄安全沙箱 (VFS Chroot)**：嚴格限制使用者僅能在指定目錄內操作，杜絕 `../` 目錄跳脫。
- **雙管理介面**：
  - **本機 Web 控制台**：瀏覽器開啟 `http://localhost:8443` 離線管理。
  - **somp-vanguard 遠端集中納管**：透過 REST API 與 API Key 進行多伺服器跨網段集中管控。

---

## 📁 部署套件目錄結構

```text
sftp-server/
│
├── scout_sftp_server.exe     # Windows Service 守護程序 (WinSW Wrapper)
├── scout_sftp_server.xml     # Windows Service 設定檔 (服務名稱、重啟策略、日誌大小)
├── sftp_engine.exe           # SFTP 核心與 Web API 獨立可執行檔 (免 Python 環境)
├── config.json               # 伺服器組態檔 (連接埠、API 金鑰、使用者與目錄映射)
│
├── install_service.bat       # 【一鍵安裝】以系統管理員身分執行即可註冊並啟動服務
├── uninstall_service.bat     # 【一鍵移除】停止並解除 Windows Service 註冊
├── start_standalone.bat      # 【除錯模式】在命令提示字元前台執行 (測試時使用)
├── service_manager.ps1       # 【PowerShell 管理器】提供 install/uninstall/restart/status 指令
│
├── build_package.ps1         # 【開發者一鍵打包】自動重編譯 Python 並打包為完整 Release ZIP
├── build_package.bat         # 【開發者一鍵打包批次檔】滑鼠連點兩下即可開始建置
└── SFTP_INSTALLATION_GUIDE.md# 安裝與操作說明手冊
```

---

## 🛠️ 開發者一鍵打包 (程式變更後自動生成安裝包)

當您修改了 `main.py`、`sftp_server.py`、`auth.py` 或 `api.py` 任何 Python 程式碼後，只需執行打包腳本：

```powershell
# 執行 PowerShell 打包腳本 (或在 Windows 檔案總管連點兩下 build_package.bat)
.\build_package.ps1
```

**打包流程會自動完成：**
1. 檢查 Python 與 PyInstaller 環境（若缺少會自動透過 pip 安裝）。
2. 清理舊有 `build/` 與 `dist/` 暫存檔。
3. 將純 Python 核心編譯打包為獨立免安裝之 `sftp_engine.exe`。
4. 自動匯集 WinSW 守護程序 (`scout_sftp_server.exe`)、XML 設定檔、批次安裝檔與說明文件至 `release/scout-sftp-server`。
5. 自動壓縮生成 **`release/scout-sftp-server-latest.zip`**（以及附帶時間戳記的發布檔）。
6. **部屬人員只需將該 ZIP 複製到目標 Windows Server 解壓縮並執行 `install_service.bat` 即可上線！**

---

---

## 🚀 快速開始：一鍵安裝為 Windows Service

### 步驟 1：放置目錄
將 `sftp-server` 資料夾複製到目標伺服器的固定路徑（例如：`C:\Program Files\ScoutSFTPServer` 或 `C:\Services\sftp-server`）。

### 步驟 2：執行一鍵安裝
1. 在 `install_service.bat` 上點擊滑鼠右鍵，選擇 **「以系統管理員身分執行 (Run as administrator)」**。
2. 腳本將自動：
   - 註冊 Windows 服務：`ScoutSFTPServer`（名稱：`Scout SFTP and Web Admin Service`）
   - 設定啟動類型為 **自動 (Automatic)**
   - 立即啟動服務

### 步驟 3：驗證服務狀態
開啟 **Windows 服務管理員 (`services.msc`)**，確認 `Scout SFTP and Web Admin Service` 狀態為 **執行中 (Running)**。

---

## 🖥️ 存取管理後台

### 1. 本機 Web 管理控制台
- 網址：`http://localhost:8443/`
- 功能：線上監控 SFTP 狀態、Active Sessions 即時踢除、使用者目錄映射 CRUD、Active Directory 登入即時測試。

### 2. somp-vanguard 遠端集中納管
1. 登入 `somp-vanguard` 管理後台。
2. 進入 **Settings → SFTP Server**。
3. 點擊 **「➕ Add SFTP Server」**：
   - **Server Name**：例如 `Taipei Production SFTP`
   - **Host / IP**：輸入目標主機 IP (例如 `198.51.100.20`)
   - **Web API Port**：`8443`
   - **SFTP Port**：`2222` (或自訂埠號)
   - **API Key**：預設為 `<YOUR_API_KEY>`（可於 `config.json` 內變更）
4. 點擊 **「⚡ Test Connection」** 驗證連線無誤後儲存。
5. 即可於 **Service Platform → SFTP Manager** 進行遠端跨主機維運！

---

## ⚙️ 組態檔說明 (`config.json`)

```json
{
  "sftp_host": "0.0.0.0",
  "sftp_port": 2222,
  "web_host": "0.0.0.0",
  "web_port": 8443,
  "api_key": "<YOUR_API_KEY>",
  "host_key_path": "C:\\Services\\sftp-server\\ssh_host_key",
  "users": [
    {
      "username": "sftpuser",
      "auth_type": "LOCAL",
      "domain": "",
      "password_hash": "pbkdf2:sha256:...",
      "home_dir": "C:\\SFTP_Data\\sftpuser",
      "read_only": false,
      "enabled": true
    },
    {
      "username": "CORP\\david",
      "auth_type": "AD",
      "domain": "CORP",
      "password_hash": "",
      "home_dir": "D:\\Shared_SFTP\\Accounting",
      "read_only": true,
      "enabled": true
    }
  ]
}
```

### 參數說明：
| 欄位 | 說明 | 預設值 |
| :--- | :--- | :--- |
| `sftp_port` | SFTP 用戶端連線傳輸埠 | `2222` (若需標準 SSH 埠可改為 `22`) |
| `web_port` | Web 管理控制台與 REST API 埠 | `8443` |
| `api_key` | somp-vanguard 遠端連線授權金鑰 | 自訂安全字串 |
| `auth_type` | 驗證模式：`AD` (Windows 網域) 或 `LOCAL` (本地雜湊密碼) | `LOCAL` |
| `home_dir` | 使用者專屬實體根目錄（登入後自動 Chroot 隔離） | `C:\SFTP_Data\<user>` |
| `read_only` | 是否啟用唯讀模式 (`true` 拒絕上傳/刪除/改名) | `false` |

---

## 🛠️ 維運指令集 (PowerShell)

您可使用系統管理員身分開啟 PowerShell，進入本目錄執行：

```powershell
# 查詢服務運行狀態
.\service_manager.ps1 status

# 重新啟動 SFTP 服務
.\service_manager.ps1 restart

# 停止 SFTP 服務
.\service_manager.ps1 stop

# 啟動 SFTP 服務
.\service_manager.ps1 start

# 解除安裝 Windows 服務
.\service_manager.ps1 uninstall

# 前台偵錯模式執行 (不透過服務，直接輸出 log 於視窗)
.\service_manager.ps1 test
```

---

## 🛡️ Windows 防火牆設定 (Firewall Rules)

若 SFTP 或 Web Console 需接受外部連線，請於 Windows 伺服器開啟入站連接埠：

```powershell
# 開放 SFTP 傳輸埠 (TCP 2222)
New-NetFirewallRule -Name "Scout_SFTP_Port" -DisplayName "Scout SFTP Service (TCP 2222)" -Direction Inbound -Protocol TCP -LocalPort 2222 -Action Allow

# 開放 Web 管理埠 (TCP 8443)
New-NetFirewallRule -Name "Scout_SFTP_WebAPI" -DisplayName "Scout SFTP Web API (TCP 8443)" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
```

---

## ❓ 常見問題 (FAQ)

### Q1: 連接埠 2222 發生衝突無法啟動？
**A:** 開啟 `config.json`，修改 `"sftp_port": 2222` 為其他可用埠號（如 `22222` 或 `22`），並於 PowerShell 執行 `.\service_manager.ps1 restart` 即可。

### Q2: 如何重設或更換 Host Key（主機識別金鑰）？
**A:** 刪除目錄下的 `ssh_host_key` 檔案後重啟服務，系統將自動產生全新的 `ED25519` 高強度主機金鑰。

### Q3: 網域帳號 (AD) 登入失敗？
**A:**
1. 請確認伺服器已加入 Windows 網域 (Active Directory Domain)。
2. 使用者名稱可格式化為 `DOMAIN\username` 或 `username@domain.com`。
3. 可至 Web 控制台使用「Test AD Logon」功能直接測試 AD 憑證是否正確。
