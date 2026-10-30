# SOMP Vanguard - Scout Open API 開發介接指南 (v1.0.0)

本指南說明如何透過 **Scout Open API** 查詢受監控主機的即時效能指標 (Metrics)、歷史時序效能數據，以及 Windows Event Log / Linux Syslog 事件日誌。

---

## 1. 認證機制 (Authentication)

所有 Open API 端點皆必須經過 API Key 驗證。請向系統管理員（SuperAdmin / Operator）於 **Monitor Service > Agents > API Keys** 申請或建立一組 API Key。

### 傳遞方式 (三選一，建議使用 Header)
1. **HTTP Authorization Header (推薦)**:
   ```http
   Authorization: Bearer <YOUR_API_KEY>
   ```
2. **Custom HTTP Header**:
   ```http
   X-API-Key: <YOUR_API_KEY>
   ```
3. **URL Query Parameter**:
   ```http
   https://somp.internal:8080/api/v1/open/hosts?apiKey=<YOUR_API_KEY>
   ```

---

## 2. API 基礎資訊 (Base Information)

* **Base URL**: `http://<SERVER_IP>:8080/api/v1/open` (或 `/api/open/scout`)
* **資料格式**: `application/json` (Prometheus 端點為 `text/plain`)
* **時間格式**: ISO 8601 (例: `2026-08-14T18:00:00.000Z` 或 `2026-08-14T18:00:00+08:00`)

---

## 3. 端點總覽與詳細規格 (Endpoints)

### 3.1 服務健康度檢查
* **Method**: `GET`
* **Path**: `/status`
* **說明**: 檢查 API 服務狀態、當前授權 Key 名稱與受監控主機總數。

**Response 範例 (200 OK)**:
```json
{
  "status": "online",
  "service": "SOMP Scout Open API",
  "version": "v1.0.0",
  "authenticatedKey": "Grafana Integration Key",
  "totalMonitoredHosts": 42,
  "activeAlerts": 1,
  "serverTime": "2026-08-14T18:00:00.000Z"
}
```

---

### 3.2 查詢受控主機清單
* **Method**: `GET`
* **Path**: `/hosts`
* **Query 參數**:
  * `ip`: 指定主機 IP 查詢 (例: `?ip=198.51.100.56`，支援精確或部分比對) (可選)
  * `keyword`: 搜尋關鍵字 (支援 IP、主機名稱、Tags 模糊比對) (可選)
  * `status`: `online` 或 `offline` (可選)
  * `os`: `windows` 或 `linux` (可選)
  * `group`: 主機群組名稱 (可選)
  * `envId`: 環境識別碼 (可選)

**Response 範例 (200 OK)**:
```json
{
  "total": 1,
  "hosts": [
    {
      "id": "mon_01",
      "name": "PRD-APP-01",
      "ip": "198.51.100.56",
      "os": "linux",
      "group": "Application",
      "tags": ["prod", "web"],
      "status": "online",
      "lastSeen": "2026-08-14T17:59:30.000Z",
      "version": "1.0.15",
      "lastMetricSnapshot": {
        "timestamp": "2026-08-14T17:59:30.000Z",
        "cpuUsed": 12.5,
        "memoryUsed": 45.2,
        "diskUsage": [
          { "mount": "/", "used": 68.4, "totalGB": 100.0, "freeGB": 31.6 }
        ]
      }
    }
  ]
}
```

---

### 3.3 查詢即時效能指標 (Real-time Metrics)
* **Method**: `GET`
* **Path**: `/metrics/realtime`
* **Query 參數**:
  * `ip`: 主機 IP (例: `?ip=198.51.100.56`) (可選)
  * `host`: 主機名稱、IP 或 Monitor ID (例: `?host=198.51.100.56` 或 `?host=PRD-APP-01`) (可選)
  * `id`: Monitor 唯一識別碼 (可選)
  * *註：若不帶任何參數則回傳所有主機之最新效能快照清單。*

**Response 範例 (200 OK)**:
```json
{
  "host": {
    "id": "mon_01",
    "name": "PRD-APP-01",
    "ip": "198.51.100.56",
    "os": "linux",
    "status": "online",
    "lastSeen": "2026-08-14T18:00:00.000Z"
  },
  "timestamp": "2026-08-14T18:00:00.000Z",
  "metrics": {
    "cpu": { "used": 14.8, "cores": 4 },
    "memory": { "used": 48.2, "totalGB": 16.0, "freeGB": 8.3 },
    "disk": [
      { "mount": "/", "used": 62.0, "totalGB": 100.0, "freeGB": 38.0 }
    ],
    "network": [
      { "interface": "eth0", "bytesSent": 1048576, "bytesRecv": 5242880 }
    ],
    "tcpPing": [
      { "target": "198.51.100.1:80", "status": "UP", "latencyMs": 1.2 }
    ],
    "services": [
      { "name": "nginx", "status": "running" }
    ]
  }
}
```

---

### 3.4 查詢歷史時序指標 (Historical Metrics)
* **Method**: `GET`
* **Path**: `/metrics/history`
* **Query 參數**:
  * `host` (必填): 主機名稱、IP 或 Monitor ID
  * `from`: 起始時間 (ISO 8601，例: `2026-08-14T00:00:00Z`)
  * `to`: 結束時間 (ISO 8601，例: `2026-08-14T18:00:00Z`)
  * `limit`: 回傳筆數限制（預設 100，最大 1000）

**Response 範例 (200 OK)**:
```json
{
  "host": { "id": "mon_01", "name": "PRD-APP-01", "ip": "198.51.100.56", "os": "linux" },
  "from": "2026-08-14T00:00:00.000Z",
  "to": "2026-08-14T18:00:00.000Z",
  "count": 50,
  "records": [
    {
      "timestamp": "2026-08-14T17:59:00.000Z",
      "cpu": { "used": 15.0 },
      "memory": { "used": 42.0 },
      "disk": [{ "mount": "/", "used": 60.0 }]
    }
  ]
}
```

---

### 3.5 查詢 Windows Event Logs
* **Method**: `GET`
* **Path**: `/logs/windows`
* **Query 參數**:
  * `ip` 或 `host`: 主機 IP、主機名稱、Monitor ID 或別名 (例: `?ip=192.0.2.6`、`?host=APP-SYS-PROXY01` 或 `?host=PROXY01`)
  * `level`: `Critical` (1), `Error` (2), `Warning` (3), `Information` (0/4)。支援大小寫不拘與數字代碼。
  * `eventID`: 事件代碼（例: `4625` 登入失敗, `7036` 服務狀態變更）
  * `provider`: 事件來源（例: `Service Control Manager`）
  * `keyword`: 訊息內容全文檢索
  * `from`, `to`: 時間範圍 (ISO 8601 UTC，例: `2026-08-18T00:00:00Z`)
  * `page`: 頁碼（預設 1）
  * `limit`: 每頁筆數（預設 100，上限 1000）

**Response 範例 (200 OK)**:
```json
{
  "total": 1,
  "page": 1,
  "limit": 100,
  "totalPages": 1,
  "events": [
    {
      "id": "evt_12345",
      "host": "WIN-SRV-01",
      "level": "Error",
      "eventID": 7036,
      "provider": "Service Control Manager",
      "message": "The Print Spooler service entered the stopped state.",
      "timestamp": "2026-08-14T16:30:00.000Z"
    }
  ]
}
```

---

### 3.6 查詢 Linux Syslog & File Logs
* **Method**: `GET`
* **Path**: `/logs/linux`
* **Query 參數**:
  * `ip` 或 `host`: 主機 IP、主機名稱、Monitor ID 或別名 (例: `?ip=192.0.2.6` 或 `?host=UBUNTU-SRV01`)
  * `filePath`: 日誌來源路徑（例: `/var/log/syslog`, `/var/log/auth.log`, `/var/log/messages`）
  * `level`: 嚴重度過濾（支援 `error`, `warning`, `info`，同時比對 tags 與訊息關鍵字）
  * `keyword`: 訊息全文檢索
  * `from`, `to`: 時間範圍 (ISO 8601 UTC)
  * `page`, `limit`: 分頁參數

---

### 3.7 跨平台日誌統一搜尋
* **Method**: `GET`
* **Path**: `/logs/events`
* **Query 參數**:
  * `ip` 或 `host`: 主機 IP、主機名稱、Monitor ID 或別名 (例: `?ip=192.0.2.6` 或 `?host=PRD-APP-01`)
  * `os`: `windows` 或 `linux`（不填則同時搜尋兩者）
  * `level`: 嚴重度過濾 (`Error`, `Warning`, `Information`, `Critical`)
  * `keyword`: 關鍵字搜尋
  * `from`, `to`: 時間範圍 (ISO 8601 UTC)
  * `limit`: 最大回傳筆數（預設 100，上限 500）

---

### 3.8 Prometheus Text Format Exporter
* **Method**: `GET`
* **Path**: `/prometheus`
* **Header**: `Authorization: Bearer <API_KEY>`
* **說明**: 提供 Prometheus Server 直接 scrape 的標準 Text 格式指標。

**Response 範例 (200 OK - Content-Type: text/plain)**:
```text
# HELP scout_host_status Host online status (1 = online, 0 = offline)
# TYPE scout_host_status gauge
scout_host_status{id="mon_01",name="PRD-APP-01",ip="198.51.100.56",os="linux"} 1

# HELP scout_cpu_usage_percent CPU utilization percentage
# TYPE scout_cpu_usage_percent gauge
scout_cpu_usage_percent{id="mon_01",name="PRD-APP-01",ip="198.51.100.56"} 14.80

# HELP scout_memory_usage_percent Memory utilization percentage
# TYPE scout_memory_usage_percent gauge
scout_memory_usage_percent{id="mon_01",name="PRD-APP-01",ip="198.51.100.56"} 48.20
```

---

## 4. 程式碼呼叫範例 (Code Examples)

### 4.1 cURL
```bash
# 1. 查詢即時效能指標
curl -X GET "http://198.51.100.98:8080/api/v1/open/metrics/realtime?host=198.51.100.56" \
  -H "Authorization: Bearer my-secret-api-key-12345"

# 2. 查詢近 24 小時 Windows 錯誤事件
curl -X GET "http://198.51.100.98:8080/api/v1/open/logs/windows?level=Error&from=2026-08-13T18:00:00Z" \
  -H "X-API-Key: my-secret-api-key-12345"
```

### 4.2 Python (requests)
```python
import requests

BASE_URL = "http://198.51.100.98:8080/api/v1/open"
API_KEY = "my-secret-api-key-12345"

headers = {
    "Authorization": f"Bearer {API_KEY}"
}

# 取得所有主機與最新 Metrics 快照
res = requests.get(f"{BASE_URL}/hosts", headers=headers)
if res.status_code == 200:
    hosts_data = res.json()
    for host in hosts_data.get("hosts", []):
        print(f"Host: {host['name']} ({host['ip']}) - Status: {host['status']}")
```

### 4.3 PowerShell
```powershell
$apiKey = "my-secret-api-key-12345"
$headers = @{
    "Authorization" = "Bearer $apiKey"
}

# 查詢主機即時指標
$response = Invoke-RestMethod -Uri "http://198.51.100.98:8080/api/v1/open/metrics/realtime?host=198.51.100.56" -Headers $headers -Method Get
Write-Host "CPU Used: $($response.metrics.cpu.used)%"
Write-Host "Memory Used: $($response.metrics.memory.used)%"
```

---

## 5. 常見 HTTP 狀態碼與錯誤處理 (Error Codes)

| 狀態碼 | 錯誤原因 | 解決方式 |
| :--- | :--- | :--- |
| `200 OK` | 請求成功 | 正常取得 JSON 數據 |
| `400 Bad Request` | 缺少必要參數（如未指定 host） | 檢查 Query Parameter 是否齊全 |
| `401 Unauthorized` | 缺少 API Key 或 API Key 無效/已撤銷 | 確認 Header 帶有有效的 `Authorization: Bearer <KEY>` |
| `403 Forbidden` | 後端設定關閉了 Open API | 請管理員於 Settings -> Integration Hub 開啟 `ENABLE_SCOUT_OPEN_API` |
| `404 Not Found` | 指定的 Host 或 Monitor ID 不存在 | 檢查主機名稱或 IP 是否正確 |
| `500 Server Error` | 伺服器內部異常 | 查看後端 Console 與日誌記錄 |
