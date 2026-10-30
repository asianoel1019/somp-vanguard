# Scout-Win (Native Windows Agent)

Scout-Win 是一個專為 Windows Server 設計的高效能、極低資源佔用的監控代理程式 (Agent)。此專案旨在取代基於 Node.js 與 PowerShell 的舊版 \scout.js\，完全解決舊版因為呼叫 PowerShell 所導致的 CPU 與記憶體突波 (Spikes) 問題。

## 架構與特色 (Features)

1. **零依賴 (Zero Dependencies)**
   - 使用 Go 語言編譯為單一且靜態的執行檔 (\scout-win.exe\)。
   - 部署到 Windows Server 2016+ 時，**不需要**預先安裝 Node.js、Go 或其他環境。

2. **Native WEVTAPI (Windows Event Log API) 支援**
   - 拋棄了緩慢且消耗資源的 \Get-WinEvent\，直接透過 \syscall\ 呼叫 Windows 底層的 \wevtapi.dll\。
   - 支援 **多頻道訂閱 (Multiple Channels)**。
   - 達成次毫秒級 (sub-millisecond) 的事件擷取與推送。

3. **全方位系統數據採集 (Comprehensive Metrics)**
   - **CPU, Memory, Disk**: 使用跨平台效能庫 \gopsutil\ 原生抓取，效能極高。
   - **Ping & TCP Latency**: 支援持續追蹤伺服器連線品質。
   - **Service & Process Monitoring**: 精準監控指定的 Windows 服務與進程狀態。

## 目錄結構 (Directory Structure)

- \main.go\: 主程式進入點，負責初始化設定與啟動各個監控 Loop。
- \config.go\: 負責讀取與解析 \config.json\。
- \metrics.go\: 負責收集硬體資源 (CPU/RAM/Disk) 以及連線/服務狀態。
- \eventlog.go\: 負責封裝底層 \syscall\ 以對接 Windows 原生 Event Log 機制。
- \config.json\: 代理程式設定檔，包含 Backend API 網址、API Key 等。

## 安裝與建置 (Build & Install)

### 編譯方式 (開發環境)
若您需要自行編譯此 Agent，請先確保環境中已安裝 Go 1.20+。

`powershell
# 1. 進入專案目錄
cd scout-win

# 2. 下載相依套件
go mod tidy

# 3. 編譯為執行檔
go build -o scout-win.exe
`

### 部署方式 (正式環境)
1. 將編譯出的 \scout-win.exe\ 與 \config.json\ 複製到目標伺服器的任意目錄中 (例如 \C:\ScoutAgent\)。
2. 編輯 \config.json\，填寫正確的 \ackendUrl\ 與 \piKey\。
3. 執行 \scout-win.exe\，或是將其註冊為 Windows 服務 (Windows Service)。

## 技術細節：與舊版 (scout.js) 差異

| 比較項目 | 舊版 \scout.js\ (Node.js) | 新版 \scout-win\ (Go) |
| :--- | :--- | :--- |
| **執行檔大小** | Node.js 環境 (約 80MB) + 程式碼 | 單一 EXE (約 10~15MB) |
| **Event Log 獲取** | \child_process\ 呼叫 PowerShell | 原生 C API (\EvtQuery\, \EvtNext\) |
| **CPU 佔用 (空閒)** | 1% ~ 5% (受 Node V8 影響) | < 0.1% |
| **CPU 佔用 (查詢)** | **可能飆高到 20% ~ 50%** | < 1% |
| **記憶體佔用** | 40MB ~ 100MB | < 20MB |

---
**Build Engine:** System Team Operation Manager (SOMP)
