# SOMP Vanguard (sys-op-manager-platform)

## 📝 產品宣告 (Product Declaration)
本系統是一套專為企業級 IT 基礎設施量身打造的自動化維運管理平台。透過整合 DNS、Active Directory、ELK 監控、虛擬化管理及自動化部署等核心模組，提供維運人員一個直觀、高效且安全的中央控制介面。系統致力於簡化複雜的 IT 流程，提升基礎設施的合規性與維運效率。

---

## ✍️ 作者 (Author)
**Noel Huang**

---

## 📌 版本 (Version)
**v1.7.6** (Build 2026.10.22)

---

**© 2026 SOMP Vanguard Team**  
*All Rights Reserved.*

---

## 🧪 自動化測試 (Backend Tests)

```bash
cd backend
npm test              # 執行全部測試（精簡摘要，失敗時才顯示細節）
npm run test:verbose  # 完整輸出（含每個測試與程式 log，除錯用）
npm run test:coverage # 含覆蓋率報告
```

- 測試使用 Node 內建 `node:test`，資料寫入暫存目錄（`SOMP_DISABLE_LEGACY_PATHS` 會停用 `C:\ProgramData` 備援路徑），不會影響正式資料或連線外部服務。
- `SCP_to_Prod.ps1` 上傳前會自動執行測試，失敗即中止；緊急時可加 `-SkipTests`。
- 標記為 `todo` 的測試是已知問題，修正後移除 `todo` 即成為回歸測試。
- 新增路由測試請參考 `backend/test/routes/rbac.route.test.js`。
- 修 bug 時先寫一個會失敗的測試重現問題，再修程式。
