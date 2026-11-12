# pwdchange：AD 自助變更密碼頁

讓使用者不必登入任何系統，在公司內部網路自行變更 AD 密碼的小程式。與 SOMP Vanguard **完全獨立**：自己的資料夾、設定、服務帳號與日誌，可以裝在另一台主機。

只支援「知道目前密碼的變更」（包含已過期、或被要求下次登入必須變更的密碼）。忘記密碼、帳號被鎖定或停用時，頁面會請使用者聯絡管理員。

## 需求

* Windows 主機，已加入網域，安裝 **RSAT 的 Active Directory PowerShell 模組**（Windows Server：`Install-WindowsFeature RSAT-AD-PowerShell`）。
* Node.js 20 以上。
* HTTPS 憑證（`.pfx`），網域內電腦信任的憑證為佳。
* 一個專用的 AD 服務帳號：**一般網域使用者即可**。以舊密碼變更密碼不需要任何特殊權限；服務帳號只用來查詢帳號與送出變更。

## 安裝與啟動

1. 把 `pwdchange` 資料夾複製到主機，例如 `C:\pwdchange`。
2. 複製 `.env.example` 為 `.env`，填入設定（見下方）。`.env` 含服務帳號密碼，請限制只有管理員可讀。
3. 執行 `start.bat`（第一次會自動安裝套件）。看到 `Listening on https://0.0.0.0:8443 ...` 即啟動完成。
4. 防火牆只對使用者網段開放這個埠。
5. 在 Vanguard 的 Settings > AD Hierarchy & SearchBase 把 `PWD_NOTIFY_CHANGE_URL` 設為這個頁面的網址（例如 `https://pwd.example.test:8443/`），密碼到期通知信就會附上連結。

試用時可以設 `ALLOW_HTTP=true` 暫時用 HTTP（頁面會顯示警告），**正式使用前務必改回 HTTPS**。要長期執行時，可用工作排程器（開機時執行 `start.bat`）或 NSSM 等工具裝成 Windows 服務。

## 設定（.env）

| 設定 | 說明 |
|---|---|
| `PORT` | 監聽埠，預設 8443 |
| `HTTPS_PFX_PATH` / `HTTPS_PFX_PASSPHRASE` | HTTPS 憑證與密碼；`ALLOW_HTTP=true` 時可不填 |
| `ALLOW_HTTP` | `true` 時改用 HTTP，只供短期試用 |
| `ALLOWED_NETS` | **必填**。允許開啟頁面的網段，CIDR 或單一位址，以逗號分隔（IPv4 / IPv6）。不在範圍內的連線連頁面都看不到；未設定時程式不會啟動 |
| `TRUST_PROXY` | 前面有反向代理並會加上 `X-Forwarded-For` 時才設為 `true` |
| `AD_SERVER` | 網域控制站或網域名稱；空白時用本機所屬網域 |
| `AD_SERVICE_USER` / `AD_SERVICE_PWD` | 服務帳號（`DOMAIN\帳號`）與密碼 |
| `ALLOWED_OUS` | 可使用此頁的帳號所在 OU（以 `;` 分隔，含子 OU），建議與 Vanguard 的 `PWD_NOTIFY_OUS` 相同。空白時為整個網域 |
| `ADMIN_CONTACT` | 頁面上「請聯絡管理員」後顯示的聯絡方式 |
| `SMTP_*` | 選填。設定後，變更成功會寄「您的密碼已變更」通知給使用者本人（AD 的 `mail` 屬性） |
| `LOG_DIR` | 稽核日誌資料夾，預設 `pwdchange\logs` |

## 安全機制

* **只開放內部網段**：`ALLOWED_NETS` 以外的來源一律 403。
* **只走 HTTPS**（TLS 1.2 以上），並送出嚴格的安全標頭（CSP、禁止被嵌入、不快取、不送 Referer）。
* **不能改的帳號**：管理員帳號（`adminCount=1`）、`krbtgt`、服務帳號本身、已停用的帳號、`ALLOWED_OUS` 以外的帳號。
* **密碼由 AD 驗證與套用原則**：使用 `Set-ADAccountPassword -OldPassword`，長度、複雜度、歷程、最短使用期限都依網域設定；目前密碼錯誤會照 AD 的鎖定原則計算。
* **不洩漏帳號資訊**：帳號不存在、密碼錯誤、帳號停用、不在範圍內、受保護帳號都回覆同一句「帳號或目前密碼不正確」。只有新密碼不符合原則時有不同訊息。
* **限制嘗試次數**：同一來源 15 分鐘內最多 10 次、同一帳號 15 分鐘內最多 5 次。
* **密碼不落地**：密碼只以環境變數傳給當次的 PowerShell 程序，不在指令列、腳本檔、日誌或稽核紀錄中。
* **稽核**：每次嘗試寫一行到 `logs\audit-YYYY-MM-DD.log`（時間、來源 IP、帳號、結果、原因），不含密碼。
* **變更通知**：設定 SMTP 後，成功變更會寄信通知本人，若非本人操作可立即發現。

頁面上的密碼規則說明讀取自網域的預設密碼原則；若有使用細緻密碼原則（Fine-Grained Password Policy），實際檢查仍以 AD 為準。

## 測試

```
npm test
```

測試以假的 AD 與 SMTP 執行，涵蓋網段判斷、帳號格式、嘗試次數、各種 AD 回應的訊息、稽核與通知信。第一次部署請用測試帳號實際變更一次。
