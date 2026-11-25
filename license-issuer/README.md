# license-issuer：SOMP Vanguard 授權簽發網頁（本機）

在**保管簽章私鑰的那台電腦**上，用瀏覽器簽發、查詢與下載 SOMP Vanguard 授權檔（`.lic`）的小程式。
功能與 `scripts\License_Issue.bat` 相同（共用 `scripts\licenseIssuerCore.js`，規則一致、登記表共用），只是多了操作畫面。

* **只聽 127.0.0.1**（寫死在程式中），其他電腦無法連線。
* **只供原廠使用，絕不部署**：`*license-issuer*` 已列在 `scripts\SCP_to_Prod.example.ps1` 與 `scripts\Deploy_to_Prod.ps1` 的排除清單。
* 必須放在 SOMP Vanguard 的原始碼資料夾中執行（會讀取 `backend\lib\licenseKeys.js` 的內建公鑰與 `backend\lib\licenseFormat.js` 的驗證規則）。

## 需求

* Node.js 20 以上。
* 以 `scripts\License_Keygen.bat` 產生的 Ed25519 私鑰，且其公鑰已內建於 `backend\lib\licenseKeys.js`（`KEY_ID` 對應）。

## 安裝與啟動

1. 執行 `Set_Password.bat`，輸入兩次登入密碼（至少 10 個字元，輸入時不顯示）。程式會以 `.env.example` 建立 `.env`，並寫入 `PASSWORD_HASH`（scrypt 雜湊，不存密碼本身）。
2. 編輯 `.env`，填入 `KEY_FILE` 等設定（見下方）。
3. 執行 `start.bat`（第一次會自動安裝套件）。看到 `Open http://127.0.0.1:8444/` 即啟動完成，用瀏覽器開啟該網址。

啟動前會檢查：`PASSWORD_HASH` 是否存在、私鑰是否可讀，以及私鑰是否與 `KEY_ID` 的內建公鑰相符（以私鑰簽一段測試資料、再以公鑰驗證）。任何一項不符都會顯示原因並結束，不會啟動。

要更換密碼時，再執行一次 `Set_Password.bat`，然後重新啟動。

## 設定（.env）

| 設定 | 說明 |
|---|---|
| `PORT` | 監聽埠，預設 8444（只在 127.0.0.1） |
| `KEY_FILE` | **必填**。私鑰檔，例如 `C:\somp-license-keys\k1-private.pem` |
| `KEY_ID` | 金鑰代號，預設 `k1`，必須是 `licenseKeys.js` 內建的代號 |
| `ISSUED_DIR` | 授權檔輸出資料夾，預設為私鑰旁的 `issued` 資料夾 |
| `REGISTRY_FILE` | 簽發登記表（Markdown），預設為私鑰旁的 `issued-licenses.md`，與 `License_Issue.bat` 共用 |
| `PASSWORD_HASH` | 登入密碼的 scrypt 雜湊，請用 `Set_Password.bat` 產生，勿手動輸入 |

`.env` 與 `logs\` 不會進入版本控制。

## 使用方式

* **Issue**：填入 Customer、License ID（預設為下一個可用編號，重複時立即警告）、Issued（預設今天）與 Expires（可按 1 / 2 / 3 年按鈕，或自行選日期）。按 **Review** 確認內容後，按 **Confirm & sign** 簽發。授權檔存為 `ISSUED_DIR\<ID>-<客戶名縮寫>.lic`（不會覆蓋既有檔案），並自動加入登記表；完成後可直接按 **Download .lic** 下載。
* **Registry**：列出登記表中的所有授權，依到期日排序，顯示剩餘天數與狀態（Active / Expires soon（30 天內）/ Expired / Format 1 (invalid)）。可搜尋客戶或編號；**Renew** 會以相同客戶、下一個編號、今天為簽發日預填續約（原授權尚未到期時，到期日為原到期日加一年；已到期或 Format 1 時為今天起一年）；**Download** 重新下載該授權檔。無法解讀的登記表行會連同行號列在表格下方，請手動修正。

規則與命令列工具相同：客戶名稱 1–200 字、編號格式 `L-YYYY-NNNN`、日期必須真實存在、到期日不得早於今天或簽發日、編號不得與登記表重複。若授權檔已寫出但登記表更新失敗，畫面會顯示需手動加入登記表的那一行（相當於命令列的 exit code 2）。

## 安全機制

* 只監聽 127.0.0.1；`Host` 標頭不是 `127.0.0.1:<埠>` 或 `localhost:<埠>` 的請求一律拒絕（防 DNS rebinding）。
* 密碼以 scrypt 雜湊比對（固定時間比較）；連續 5 次錯誤後鎖定 15 分鐘，畫面顯示剩餘次數與解鎖時間。
* 登入後的工作階段存在 HttpOnly、SameSite=Strict 的 cookie，閒置 30 分鐘自動登出；可隨時按 **Log out**。
* 會變更資料的請求必須帶正確的 `Origin` 與綁定工作階段的 CSRF token。
* 安全標頭：CSP（`default-src 'self'`，不使用外部 CDN）、`X-Frame-Options: DENY`、`Cache-Control: no-store`。
* 下載只限登記表列出的檔案，且檔案的 SHA-256 前 12 碼必須與登記表相符、必須是 `.lic` 檔，不會送出私鑰或其他檔案。
* 稽核日誌 `logs\audit.log`（每行一筆 JSON）：登入成功 / 失敗 / 鎖定、簽發、下載、登出。不記錄密碼、雜湊或金鑰。
* 私鑰只在啟動時讀入記憶體，不會出現在畫面、回應或日誌中。

## 測試

```
npm install
npm test
```

測試使用暫存資料夾與臨時產生的測試金鑰，不會碰到真正的私鑰或登記表。
