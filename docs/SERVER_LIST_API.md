# Open Server List API 介接說明文檔

> **介面名稱**：Open Scout CMDB 伺服器清單開放介面  
> **端點路徑**：`GET /api/v1/open/server-list`  
> **認證方式**：Open API Key 認證（免帳密登入）  
> **版本**：v1.1.0  
> **更新時間**：2026-08-28  

---

## 📌 介面概述

`GET /api/v1/open/server-list` 為 sys-op-manager 提供給第三方系統、外部監控平台（如 Grafana、Zabbix、Prometheus）及自動化維運腳本之開放查詢介面。

本介面回傳收斂後的 CMDB 伺服器主機總表（包含規格、環境、業務單位、應用系統、機房機櫃位置），並完整保留虛擬 IP（VIP 漂移綁定關係）、帶外管理 IP（iLO/BMC）與 Nutanix CVM 節點管理 IP。

---

## 🔑 認證機制 (Authentication)

本 API 採用 **Open API Key** 機制進行安全驗證，支援以下三種傳遞方式（擇一即可）：

1. **HTTP Header (推薦)**：  
   `X-API-Key: YOUR_OPEN_API_KEY`
2. **Authorization Header**：  
   `Authorization: Bearer YOUR_OPEN_API_KEY`
3. **URL Query 參數**：  
   `?apiKey=YOUR_OPEN_API_KEY`

> 💡 **如何取得 API Key**：請洽系統管理員於後台 *「Agent Manager > API Keys」* 建立專用金鑰，並確認已勾選啟用「Open API Key」權限。

---

## 📡 請求規格 (Request)

- **HTTP Method**：`GET`
- **URL**：`http://<SERVER_IP>:8080/api/v1/open/server-list`（或 `http://<SERVER_IP>:8080/api/open/scout/server-list`）

### 查詢參數 (Query Parameters - 選填)

| 參數名稱 | 型態 | 說明 | 範例值 |
| :--- | :--- | :--- | :--- |
| `search` | `string` | 關鍵字搜尋（支援比對 IP、主機名稱、應用名稱、業務單位） | `?search=SL-SYS` |
| `env` / `envId` / `envName` | `string` | 依環境過濾 | `?env=prod` 或 `?env=Production` |
| `zone` / `platform` | `string` | 依網路分區 / 平台過濾 | `?zone=Intranet` 或 `?zone=DMZ` |
| `bu` / `businessUnit` | `string` | 依業務單位 / 團隊代碼過濾 | `?bu=SBK` |
| `application` / `applicationName` | `string` | 依所屬應用系統名稱過濾 | `?application=Payment` |
| `datacenterName` | `string` | 依資料中心名稱過濾 | `?datacenterName=TPE-DC1` |
| `status` | `string` | 依主機狀態過濾 (`online` / `offline`) | `?status=online` |

---

## 📦 回傳結構 (Response Schema)

- **HTTP Status Code**：`200 OK`
- **Content-Type**：`application/json`

```json
{
  "servers": [
    {
      "ip": "203.0.113.240",
      "hostname": "SL-SYS-RMA240",
      "cpuCores": 4,
      "memoryGB": 8,
      "diskGB": 280,
      "diskDisplay": "280GB (C:80GB / D:200GB)",
      "diskDetails": [
        { "mount": "C:", "totalGB": 80, "used": 45 },
        { "mount": "D:", "totalGB": 200, "used": 110 }
      ],
      "os": "Microsoft Windows Server 2016 Standard",
      "envName": "Production",
      "envId": "prod",
      "envColor": "#ef4444",
      "applicationName": "Payment Gateway",
      "businessUnit": "SBK",
      "zone": "Intranet",
      "platform": "Intranet",
      "datacenterName": "TPE-DC1",
      "rackId": "Rack-A01",
      "unitPosition": "U12-U14",
      "isVip": false,
      "linkedToIp": null,
      "secondaryIps": [],
      "iloIp": "203.0.113.250",
      "cvmIp": null,
      "status": "online",
      "deviceType": "Virtual Machine",
      "source": "Excel Batch Sync / Nutanix",
      "notes": "",
      "tags": [],
      "createdAt": "2026-08-27T04:37:52.000Z",
      "updatedAt": "2026-08-28T02:40:00.000Z"
    }
  ],
  "total": 369,
  "environments": [
    { "id": "1", "name": "Production", "code": "prod", "color": "#ef4444" },
    { "id": "2", "name": "Staging", "code": "staging", "color": "#f59e0b" },
    { "id": "3", "name": "Development", "code": "dev", "color": "#10b981" }
  ]
}
```

---

## 📋 欄位詳細定義表 (Field Definitions)

### 1. 核心硬體與主機資訊
| 欄位名稱 | 型態 | 說明 | 範例值 |
| :--- | :--- | :--- | :--- |
| `ip` | `string` | 主機主要 IPv4 位址（Primary Key） | `"203.0.113.240"` |
| `hostname` | `string` | 主機電腦名稱 | `"SL-SYS-RMA240"` |
| `cpuCores` | `number` | CPU 核心數 (Cores) | `4` |
| `memoryGB` | `number` | 記憶體 RAM 大小 (GB) | `8` |
| `diskGB` | `number` | 有效硬碟總容量 (GB) | `280` |
| `diskDisplay` | `string` | 磁碟分割槽容量文字摘要 | `"280GB (C:80GB / D:200GB)"` |
| `diskDetails` | `array` | 各磁碟分割區掛載點與容量明細 | `[{"mount":"C:","totalGB":80,"used":45}]` |
| `os` | `string` | 作業系統完整名稱 | `"Microsoft Windows Server 2016 Standard"` |

### 2. 業務維運與環境分區
| 欄位名稱 | 型態 | 說明 | 範例值 |
| :--- | :--- | :--- | :--- |
| `applicationName` | `string` | 所屬應用系統服務名稱 | `"Payment Gateway"` |
| `businessUnit` | `string` | 業務單位 / 維護團隊代碼 (Owner) | `"SBK"` |
| `envName` | `string` | 環境名稱 | `"Production"` |
| `envId` | `string` | 環境代碼識別碼 | `"prod"` |
| `envColor` | `string` | 環境色彩標籤 (HEX) | `"#ef4444"` |
| `zone` | `string` | 網路安全分區 | `"Intranet"` |
| `platform` | `string` | 平台架構分區（同 `zone`） | `"Intranet"` |
| `datacenterName` | `string` | 資料中心名稱 | `"TPE-DC1"` |
| `rackId` | `string` | 機房實體機櫃編號 | `"Rack-A01"` |
| `unitPosition` | `string` | 機櫃 U 位位置 | `"U12-U14"` |

### 3. 特殊網路與帶外管理 (VIP, iLO, CVM)
| 欄位名稱 | 型態 | 說明 | 範例值 |
| :--- | :--- | :--- | :--- |
| `isVip` | `boolean` | 是否為 VIP 虛擬漂移 IP / 負載平衡 IP | `false` |
| `linkedToIp` | `string` | 若為 VIP，所綁定關聯的實體主機主要 IP | `"203.0.113.240"` 或 `null` |
| `secondaryIps` | `array` | 次要 IP / 額外網卡 IP 清單 | `["203.0.113.245"]` |
| `iloIp` | `string` | 伺服器 iLO / BMC 帶外硬體管理 IP | `"203.0.113.250"` |
| `cvmIp` | `string` | Nutanix CVM 控制器節點 IP | `null` |

### 4. 狀態與中繼資料
| 欄位名稱 | 型態 | 說明 | 範例值 |
| :--- | :--- | :--- | :--- |
| `status` | `string` | 主機狀態 (`online` / `offline` / `unknown`) | `"online"` |
| `deviceType` | `string` | 設備型態 (`Virtual Machine` / `Physical Server`) | `"Virtual Machine"` |
| `source` | `string` | 資料來源標記 | `"Excel Batch Sync / Nutanix"` |
| `notes` | `string` | 備註說明 | `""` |
| `tags` | `array` | 自訂標籤陣列 | `["Tier1", "DB"]` |
| `createdAt` | `string` | 初次建立時間戳 (ISO 8601) | `"2026-08-27T04:37:52.000Z"` |
| `updatedAt` | `string` | 最後更新時間戳 (ISO 8601) | `"2026-08-28T02:40:00.000Z"` |

---

## 💻 呼叫範例 (Code Examples)

### cURL
```bash
# 1. 基礎查詢（使用 X-API-Key Header）
curl -X GET "http://<SERVER_IP>:8080/api/v1/open/server-list" \
  -H "X-API-Key: YOUR_OPEN_API_KEY"

# 2. 條件篩選（查詢 Production 環境下 Payment 應用之伺服器）
curl -X GET "http://<SERVER_IP>:8080/api/v1/open/server-list?env=prod&application=Payment" \
  -H "X-API-Key: YOUR_OPEN_API_KEY"

# 3. 使用 Bearer Authorization Header
curl -X GET "http://<SERVER_IP>:8080/api/v1/open/server-list" \
  -H "Authorization: Bearer YOUR_OPEN_API_KEY"
```

### Python
```python
import requests

url = "http://<SERVER_IP>:8080/api/v1/open/server-list"
headers = {
    "X-API-Key": "YOUR_OPEN_API_KEY"
}
params = {
    "env": "prod",
    "bu": "SBK"
}

response = requests.get(url, headers=headers, params=params)
data = response.json()

print(f"Total Servers: {data.get('total')}")
for server in data.get("servers", []):
    print(f"IP: {server['ip']} | Hostname: {server['hostname']} | App: {server['applicationName']}")
```

### PowerShell
```powershell
$headers = @{
    "X-API-Key" = "YOUR_OPEN_API_KEY"
}

$response = Invoke-RestMethod -Uri "http://<SERVER_IP>:8080/api/v1/open/server-list?env=prod" -Method Get -Headers $headers
Write-Host "Total Servers: $($response.total)"
$response.servers | Format-Table ip, hostname, os, applicationName, businessUnit, status
```

---

## ⚠️ 常見錯誤代碼 (Error Codes)

| HTTP Code | 錯誤代碼 / 訊息 | 原因與排查方式 |
| :---: | :--- | :--- |
| `401` | `Missing API Key` | 請求未帶入 API Key（需帶 `X-API-Key` 或 `Authorization: Bearer`） |
| `401` | `Invalid or revoked API Key` | 所提供的 API Key 不存在或已被撤銷 |
| `403` | `Forbidden: This API Key is dedicated to Scout Agent registration only...` | 該金鑰僅供 Agent 心跳使用，未開啟 Open API 權限。請至後台勾選啟用「Open API Key」 |
| `403` | `Scout Open API is currently disabled in system settings` | 系統後台設定關閉了 Open API 功能 |
| `400` | `不支援的查詢參數: xxx` | 帶入了未定義的 Query 參數名稱 |
