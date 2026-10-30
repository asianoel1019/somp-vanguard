# SFTP 服務純 Python 化與 Windows AD 整合最佳架構方案

> **文件版本**：1.0  
> **建立日期**：2026-09-01  
> **專案目標**： **純 Python 輕量化 SFTP 伺服器**，並原生支援 **Windows AD 網域認證**、**Web 遠端管理** 與 **Windows 服務常駐**。

---

## 🎯 核心需求與設計原則

1. **無需專用客戶端**：標準化 SFTP 協定（SSHv2），完美相容市面上所有標準客戶端（FileZilla、WinSCP、Cyberduck、Linux CLI、Apache NiFi 等）。
2. **sftpd + 遠端 Web 管理介面**：現代化 Web 控制台,並且能由somp-vanguard管理（支援瀏覽器本地及跨網段遠端管理、即時連線監控、線上查閱 Log）。
3. **Windows AD 網域帳號整合**：免維護額外帳密，透過 Windows API 原生支援 AD 帳號鑑別與專屬主目錄自動分配。
4. **企業級 Windows 服務常駐**：利用標準 Windows Service Wrapper（WinSW）實現開機免登入自啟、崩潰自動重啟與日誌輪替。

---

## 🏗️ 系統架構藍圖 (System Architecture)

```mermaid
graph TD
    subgraph ClientLayer [存取與管理層]
        SFTPClients["標準 SFTP 客戶端<br/>(FileZilla / WinSCP / NiFi)"]
        AdminBrowser["管理員瀏覽器<br/>(遠端管理 / 任何電腦)"]
    end

    subgraph ServiceWrapper [Windows 服務封裝 (WinSW / LocalSystem)]
        subgraph PythonCore [純 Python 核心服務]
            SFTPEngine["SFTP 核心引擎<br/>(AsyncSSH / Paramiko)<br/>Port: 22"]
            WebUI["Web API & 控制台<br/>(FastAPI + Vue/HTML5)<br/>HTTPS Port: 8443"]
            AuthModule["身份驗證模組<br/>(Win32 LogonUserW / 本地雜湊)"]
            VFS["實體目錄映射與安全沙箱<br/>(Directory Mapping & Sandbox)"]
        end
    end

    subgraph WindowsOS [作業系統與網域環境]
        AD["Windows Active Directory<br/>(Domain Controller)"]
        Storage["NTFS 磁碟儲存<br/>(C:\SFTP_Data\...)"]
    end

    SFTPClients -->|SSH / SFTP: 22| SFTPEngine
    AdminBrowser -->|HTTPS: 8443| WebUI
    SFTPEngine --> AuthModule
    AuthModule -->|Win32 API LogonUserW| AD
    SFTPEngine --> VFS
    VFS -->|路徑正規化與防跳脫| Storage
```

---

## 🛠️ 關鍵技術選型

| 元件層級 | 推薦技術 | 評估理由 |
| :--- | :--- | :--- |
| **SFTP 核心** | **AsyncSSH** *(或 Paramiko)* | 基於 Python `asyncio` 異步 I/O，在大檔案傳輸與高併發下效能明顯優於 Paramiko。 |
| **Web 管理後台** | **FastAPI + Uvicorn** | 高效能非同步 Web 框架，原生支援 RESTful API、WebSocket 即時日誌串流與 OpenAPI 文檔。 |
| **前端管理介面** | **單一 HTML + Vue.js (CDN) + Tailwind** | 單檔案免 Node.js/npm 建置流程，輕量好維護，打包後體積極小。 |
| **AD 網域驗證** | **`ctypes` (Win32 `LogonUserW`)** | 無需安裝額外第三方 LDAP 模組，主機加入網域即可自動支援 AD 驗證與本機帳號。 |
| **服務封裝常駐** | **WinSW (Windows Service Wrapper)** | 業界標準服務封裝器，免在 Python 內寫複雜的 `pywin32` 服務框架，自帶崩潰重啟與日誌輪替。 |
| **組態儲存** | **JSON / SQLite** | 簡單透明，支援熱重載 (Hot-reload) 與審計日誌 (Audit Log) 保存。 |

---

## 🔑 Windows AD 整合與權限控管方案

### 1. 認證機制 (`LogonUserW`)
使用 Python 內建 `ctypes` 調用 Windows 核心驗證 API：
```python
import ctypes
from ctypes import wintypes

advapi32 = ctypes.windll.advapi32
kernel32 = ctypes.windll.kernel32

LOGON32_LOGON_NETWORK = 3
LOGON32_PROVIDER_DEFAULT = 0

def verify_windows_credentials(username: str, password: str, domain: str = None) -> bool:
    """支援 DOMAIN\\user 或 user@domain.com 格式驗證"""
    if '\\' in username:
        domain, username = username.split('\\', 1)
    elif '@' in username:
        username, domain = username.split('@', 1)
        
    token = wintypes.HANDLE()
    success = advapi32.LogonUserW(
        username, domain, password,
        LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT,
        ctypes.byref(token)
    )
    if success:
        kernel32.CloseHandle(token)
        return True
    return False
```

### 2. 使用者指定目錄對應架構 (Explicit Directory Mapping)
管理員在 Web 控制台（或 `config.json`）為每個允許登入的 AD 帳號明確指派本機或網路實體目錄：

```json
{
  "Users": [
    {
      "Username": "CORP\\alice",
      "AuthType": "AD",
      "HomeDir": "D:\\Projects\\AccountingData",
      "Enabled": true,
      "ReadOnly": false
    },
    {
      "Username": "bob@corp.local",
      "AuthType": "AD",
      "HomeDir": "E:\\Backups\\ServerLogs",
      "Enabled": true,
      "ReadOnly": true
    }
  ]
}
```

- **認證與授權流程**：
  1. **名單與開關檢查**：客戶端嘗試登入時，伺服器先檢查該 AD 帳號是否在已配置的名單中且 `Enabled: true`。
  2. **AD 密碼鑑別**：透過 Win32 `LogonUserW` 向 Domain Controller 驗證密碼真實性。
  3. **實體路徑綁定**：驗證通過後，將該 SFTP Session 的根目錄直接綁定到管理員預先指定的 `HomeDir`（例如 `D:\Projects\AccountingData`）。
  4. **路徑安全防護 (Sandbox)**：確保該使用者在 SFTP 協議下看到根目錄 `/` 即為該指定實體資料夾，嚴格防範路徑跳脫（如 `../../`），確保不會存取到該目錄以外的任何系統檔案。

---

## 🚀 部署與 Windows 服務註冊 (WinSW)

### 1. 服務組態設定檔 (`sftp_service.xml`)
```xml
<service>
  <id>PythonSFTPServer</id>
  <name>Python SFTP and Web Admin Service</name>
  <description>純 Python 高效能 SFTP 伺服器與 Web 遠端管理後台</description>

  <executable>%BASE%\app.exe</executable>
  <arguments>--config config.json</arguments>
  <workingdirectory>%BASE%</workingdirectory>

  <startmode>Automatic</startmode>

  <!-- 崩潰 3 秒內自動重啟 -->
  <onfailure action="restart" delay="3 sec"/>
  <resetfailure>1 hour</resetfailure>

  <!-- 標準輸出與錯誤日誌自動大小滾動 (10MB) -->
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>10</keepFiles>
  </log>
</service>
```

### 2. 管理與維運指令
```powershell
# 1. 註冊 Windows 服務
.\sftp_service.exe install

# 2. 啟動服務 (開機亦會自動背景啟動)
.\sftp_service.exe start

# 3. 停止 / 解除服務
.\sftp_service.exe stop
.\sftp_service.exe uninstall
```

---

## ⚠️ 關鍵痛點與防範措施 (Pain Points & Solutions)

| 痛點 / 挑戰 | 風險說明 | 應對防範策略 |
| :--- | :--- | :--- |
| **1. 大檔案傳輸與 GIL 限制** | Paramiko 在多連線大檔案傳輸時 CPU 單核易達上限 (40~80MB/s) | 改用 **`asyncssh`** 異步協程架構，顯著提升 I/O 吞吐量與併發數。 |
| **2. 遠端 Web 管理介面資安** | 後台暴露於網路，可能遭受未授權訪問或暴力破解 | ① 強制啟用 **HTTPS / TLS**<br/>② 內建 **JWT 登入機制** 與 **IP 速率限制 (Rate-Limiting)**<br/>③ 登入失敗 5 次自動封鎖 IP 15 分鐘。 |
| **3. 多執行緒 AD 權限切換風險** | 在 Python 執行緒中切換 `ImpersonateLoggedOnUser` 易發生 Token 污染 | 採用 **軟體層虛擬根目錄隔離 (Virtual Chroot)**，不直接在執行緒頻繁抽換 OS Token。 |
| **4. 單一 exe 打包冷啟動延遲** | PyInstaller 打包整個 Web + SSH 環境體積較大 (約 50MB) | 採用 PyInstaller 封裝或提供**可攜式 Python 綠色免安裝目錄**，由 WinSW 直接調用，啟動只需 0.1 秒。 |

---

## 📅 後續實作建議時程

1. **Phase 1: 核心重構**：撰寫純 Python 的 SFTP 伺服器模組，並整合 `LogonUserW` AD 認證。
2. **Phase 2: Web 後台實作**：建立 FastAPI 遠端控制台（狀態儀表板、使用者管理、Log 即時串流）。
3. **Phase 3: 整合與服務封裝**：配置 WinSW，測試 Windows 服務開機自動啟動與崩潰自動喚醒。
4. **Phase 4: 壓力與相容性測試**：使用 FileZilla / WinSCP 進行大檔案傳輸壓測與安全檢驗。
