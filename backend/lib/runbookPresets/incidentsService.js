// SOP Runbook presets — 服務類告警應變
const SEED_TIME = new Date().toISOString();

module.exports = [
    {
        id: 'sop-inc-network-latency',
        title: '網路延遲 / 封包遺失應變 SOP',
        component: 'Network Device',
        tags: ['緊急應變', '網路管理', '告警排障'],
        content: `# 網路延遲 / 封包遺失應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 出現主機離線閃動、Ping 逾時、HostMonitor 檢查間歇失敗
- 使用者回報應用程式變慢、連線逾時
- 外部連線 ping 8.8.8.8 延遲 > 100ms 或遺失率 > 2%

## 影響與風險
- 跨站台服務逾時、資料庫複寫延遲、監控誤報（主機實際正常但網路抖動）

## 處理步驟
1. **界定範圍**：單一主機？同網段？跨站台？先用 Remote Command 執行 p5（Ping Internet）、p7（Print Routing Table）。
2. **從來源端量測**
\`\`\`powershell
ping -n 50 <目標IP>
tracert -d <目標IP>
Test-NetConnection <目標IP> -Port 443 -InformationLevel Detailed
\`\`\`
\`\`\`bash
ping -c 50 <目標IP>
mtr -rwc 100 <目標IP>     # 看哪一跳開始遺失；僅最後一跳遺失多為 ICMP 限速，可忽略
\`\`\`
3. **查網段與位址**：IPAM 確認 IP 是否衝突或被重複使用；Remote Command 執行 p6 確認本機連線數是否異常。
4. **查網路設備**：Network Device 開啟該交換器 / 路由器，檢視 Port Status（錯誤封包、雙工不符、速率協商）、ARP Table、MAC Table（MAC 在多個 Port 跳動＝環路或衝突）。
5. **看拓撲**：Topology Map 找出來源到目標的路徑與共用上行鏈路，判斷是否為單一 uplink 壅塞。
6. **處置**
   - 實體問題：更換線材 / SFP、固定速率雙工
   - 壅塞：找出大流量來源並限速，或切換備援路徑
   - 位址衝突：依 IPAM 釐清並回收重複 IP
   - 本機網卡：\`Restart-NetAdapter -Name "Ethernet0"\`（⚠️ 會短暫中斷遠端連線，請先確認有帶外管理途徑）

## 驗證
- 再次 ping / mtr 連續 5 分鐘遺失率 0%、延遲回到基準
- Scout Monitor 告警自動恢復，無再閃動

## 注意事項 / 升級處理
- 20 分鐘內無法定位，或涉及 ISP / WAN 線路，升級網路組並附 mtr 輸出與時間點
- 重大設備（核心交換器）異動前須有變更單與回復計畫

## 事後紀錄
- 記錄起訖時間、受影響網段、mtr / ping 輸出與根因，供事後檢討
- 若為間歇性問題，建議在 Network Device 持續觀察 Port Status 錯誤計數 24 小時，確認未再增長
- 變更過路由或網卡設定者，需更新 IPAM 與相關文件

- 若問題集中於特定時段，比對該時段的備份、批次作業或大量傳檔排程（Task Scheduler），判斷是否為尖峰壅塞
## 相關資源
- SOMP：IPAM、Network Device、Topology Map、Remote Command（p5 / p6 / p7）
- sop-inc-dns-resolution（若僅名稱解析慢）
`,
        workflowId: null,
        commandIds: ['p5', 'p7', 'p6'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-dns-resolution',
        title: 'DNS 解析失敗應變 SOP',
        component: 'DNS Hub',
        tags: ['緊急應變', '網路管理', '告警排障'],
        content: `# DNS 解析失敗應變 SOP

## 適用情境 / 觸發條件
- 應用程式回報 Name not resolved / NXDOMAIN / 解析逾時
- 新增或刪除 DNS 記錄後，部分用戶端仍解析到舊值或解析不到
- DNS Hub 操作回傳 「Failed: Zone not found in any cache」

## 影響與風險
- 所有依賴該名稱的服務中斷；AD 登入、郵件（MX）、憑證驗證亦可能受影響

## 處理步驟
1. **確認現象與範圍**：用戶端與 DNS 伺服器各查一次
\`\`\`powershell
Resolve-DnsName app.example.local -Server <DNS伺服器IP>
Resolve-DnsName app.example.local -Type A -DnsOnly
ipconfig /flushdns
\`\`\`
\`\`\`bash
nslookup app.example.local <DNS伺服器IP>
dig +short app.example.local @<DNS伺服器IP>
\`\`\`
2. **基本連通**：Remote Command 執行 p8（DNS Resolution Test）確認受影響主機的解析能力；p6 確認 DNS 服務埠 53 是否監聽。
3. **查 SOMP 端記錄**：DNS Hub → Record Operations，輸入 fqdn 執行 Query，確認記錄是否存在、IP 是否正確。Record Change Log 可查是誰、何時修改。
4. **處理 「Zone not found in any cache」**：代表該 DNS 伺服器的 Zone 快取缺少此 Zone。到 DNS Hub → Server Management，更新（重新整理）該伺服器的 Zone cache，再回 Record Operations 重試。Zone 以最長後綴匹配（例：a-b.j-sbk.uat 對應 zone j-sbk.uat）。
5. **記錄有誤**：在 Record Operations 以 fqdn ip 格式更新；注意 Delete 不能刪除 Zone 根記錄。
6. **用戶端仍是舊值**：等待 TTL 或 \`ipconfig /flushdns\`、Linux \`resolvectl flush-caches\`。

## 驗證
- 各 DNS 伺服器與用戶端 Resolve-DnsName 結果一致
- Record Change Log 有對應異動紀錄；應用程式恢復

## 注意事項 / 升級處理
- 多台 DNS 伺服器結果不一致（複寫問題）或 DNS 服務無回應，升級系統組 / AD 管理員
- 批次異動前先 Query 備份現值

## 事後紀錄
- 於 Record Change Log 核對異動人員與時間，確認是否為人為誤改
- 若為 Zone 快取缺漏，建議新增 Zone 後立即更新快取，避免下次操作再次失敗
- 重大記錄異動前先 Query 保存舊值，以便快速回復

- 若問題集中於特定 Zone，請同時檢查該 DNS 伺服器的 Zone 轉送與複寫狀態，避免只修單點而遺漏其他伺服器
## 相關資源
- SOMP：DNS Hub（Server Management / Record Operations / Record Change Log）、Remote Command（p8）
- sop-inc-network-latency
`,
        workflowId: null,
        commandIds: ['p8'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-ssl-expiry',
        title: 'SSL 憑證即將到期 / 已過期緊急處理 SOP',
        component: 'SSL Certificate',
        tags: ['緊急應變', '資安審計', '告警排障'],
        content: `# SSL 憑證即將到期 / 已過期緊急處理 SOP

## 適用情境 / 觸發條件
- SSL Certificate 模組 DAYS REMAINING 低於警示門檻，或收到 SSLMonitor 類通知
- 瀏覽器出現 NET::ERR_CERT_DATE_INVALID、API 用戶端 certificate has expired

## 影響與風險
- 網站 / API 對外中斷、服務間 mTLS 失敗、使用者看到安全警告

## 處理步驟
1. **盤點**：SSL Certificate → Certificate List，依 Environment 篩選，記下受影響憑證的 HOST / ENDPOINT、ISSUER、EXPIRATION DATE。
2. **實測線上實際憑證**（確認伺服器真的在用哪一張）
\`\`\`bash
echo | openssl s_client -connect host:443 -servername host 2>/dev/null | openssl x509 -noout -subject -issuer -dates
openssl s_client -connect host:443 -servername host -showcerts   # 檢查完整鏈
\`\`\`
\`\`\`powershell
Test-NetConnection host -Port 443
\`\`\`
3. **取得新憑證**：向 CA / 內部 PKI 申請續期，取得憑證與中繼憑證，組成完整鏈（伺服器憑證 + 中繼 CA）。
4. **備份舊憑證**後安裝：
   - IIS：憑證匯入 LocalMachine\\My，IIS 管理員 → 站台 → 繫結 → https → 編輯並選新憑證
\`\`\`powershell
Import-PfxCertificate -FilePath .\\new.pfx -CertStoreLocation Cert:\\LocalMachine\\My -Password (Read-Host -AsSecureString)
\`\`\`
   - nginx：更新 ssl_certificate（fullchain）與 ssl_certificate_key，檢查後重載
\`\`\`bash
nginx -t && systemctl reload nginx
\`\`\`
5. **更新 SOMP 紀錄**：在 SSL Certificate 以 + Add Certificate 新增 / 更新該憑證資訊，確保到期日與監控一致。

## 驗證
- 再次 openssl s_client 確認 notAfter 為新日期、鏈驗證 Verify return code: 0
- 瀏覽器無警告；SSL Certificate 列表剩餘天數更新

## 注意事項 / 升級處理
- 私鑰與 PFX 密碼不得貼入工單或聊天；⚠️ 覆蓋憑證檔前務必備份
- 鏈不完整是常見原因（桌機正常、Java / curl 失敗）
- 已過期且無法自行續期，升級資安 / PKI 管理員；負載平衡器或 WAF 上的憑證需另行更換

## 預防措施
- 於 SSL Certificate 保持所有憑證登錄完整，並在到期前 30 / 14 / 7 天處理
- 確認 SSLMonitor 通知類別已推送到 Telegram / Webhook
- 續期完成後記錄憑證序號、到期日與部署位置

## 相關資源
- SOMP：SSL Certificate
- sop-inc-dns-resolution
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-k8s-crashloop',
        title: 'K8s Pod CrashLoopBackOff / ImagePullBackOff / Pending 應變 SOP',
        component: 'Kubernetes',
        tags: ['緊急應變', '容器維運', '告警排障'],
        content: `# K8s Pod CrashLoopBackOff / ImagePullBackOff / Pending 應變 SOP

## 適用情境 / 觸發條件
- Pod 狀態為 CrashLoopBackOff、ImagePullBackOff / ErrImagePull、Pending、OOMKilled、頻繁 Restart
- Deployment 可用副本數低於期望值，服務 5xx

## 處理步驟
1. **SOMP 先看全貌**：Kubernetes → 選叢集 → Workloads（Pod 狀態）、Events（Warning 事件）、Node Dashboard（節點資源）。
2. **取得細節**
\`\`\`bash
kubectl get pods -n <ns> -o wide
kubectl describe pod <pod> -n <ns>        # 看 Events、Last State、Exit Code
kubectl logs <pod> -n <ns> --previous      # 看上一次崩潰的日誌
kubectl get events -n <ns> --sort-by=.lastTimestamp
kubectl top pod -n <ns>; kubectl top node
\`\`\`
3. **依狀態處置**
   - **CrashLoopBackOff**：看 --previous 日誌；常見原因為設定 / Secret 缺漏、依賴服務不通、啟動命令錯誤、Liveness probe 過嚴
   - **OOMKilled（Exit Code 137，Reason: OOMKilled）**：調高 resources.limits.memory 或修正記憶體洩漏
   - **ImagePullBackOff**：確認映像名稱 / tag、私有倉庫 imagePullSecrets、節點到倉庫的網路與憑證
   - **Pending**：describe 看 FailedScheduling——資源不足、nodeSelector / taint 不符、PVC 未綁定
\`\`\`bash
kubectl get pvc -n <ns>
kubectl describe node <node> | grep -A8 "Allocated resources"
\`\`\`
4. **回復**：近期有發版就回滾
\`\`\`bash
kubectl rollout history deploy/<name> -n <ns>
kubectl rollout undo deploy/<name> -n <ns>
\`\`\`
5. ⚠️ \`kubectl delete pod\` 會重建 Pod，StatefulSet / 單副本服務會短暫中斷，確認副本數與 PDB 後再執行。

## 驗證
- Pod 為 Running 且 READY 滿格，Restart 數不再增加
- Events 無新的 Warning；服務健康檢查恢復

## 注意事項 / 升級處理
- 節點 NotReady、控制平面異常、儲存層問題，升級平台組
- Kubernetes 頁面的 AI 事故診斷可作為輔助，結論仍需以 describe / logs 佐證
- 勿直接在生產調整未經確認的 limits，先以變更單處理

## 相關資源
- SOMP：Kubernetes（Workloads / Deployments / Events / Node Dashboard）
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-elk-health',
        title: 'Elasticsearch 叢集 red / yellow 應變 SOP',
        component: 'ELK Manager',
        tags: ['緊急應變', '儲存空間', '告警排障'],
        content: `# Elasticsearch 叢集 red / yellow 應變 SOP

## 適用情境 / 觸發條件
- ELK Manager 的 Cluster Health 顯示 yellow（有副本未分配）或 red（有主分片未分配）
- Kibana 查無資料、Logstash 寫入失敗、索引為唯讀（read-only）

## 影響與風險
- red：部分資料不可查 / 不可寫；磁碟達 flood-stage 會使索引被鎖成唯讀，日誌攝取中斷

## 處理步驟
1. **SOMP 檢視**：ELK Manager → Cluster Health、Cluster Nodes、Health & Disk（磁碟使用率）、Thread Pools。
2. **查詢叢集狀態**
\`\`\`bash
curl -s localhost:9200/_cluster/health?pretty
curl -s "localhost:9200/_cat/nodes?v&h=name,ip,heap.percent,disk.used_percent,node.role"
curl -s "localhost:9200/_cat/shards?v&h=index,shard,prirep,state,unassigned.reason" | grep -v STARTED
curl -s localhost:9200/_cluster/allocation/explain?pretty
\`\`\`
3. **依原因處置**
   - **節點離線**：到該節點檢查服務 \`systemctl status elasticsearch\`、JVM heap、\`journalctl -u elasticsearch -n 100\`，啟動後分片會自動恢復
   - **磁碟水位（low 85% / high 90% / flood 95%）**：清理舊索引或擴容；確認 ILM 政策是否生效（ELK Manager 有 Lifecycle 違規檢查）
\`\`\`bash
curl -s "localhost:9200/_cat/indices?v&s=store.size:desc" | head -20
\`\`\`
   - ⚠️ 刪除索引不可逆：\`curl -X DELETE localhost:9200/<舊索引>\`，須確認保留政策並有快照後才可執行
   - 磁碟降到水位以下後解除唯讀：
\`\`\`bash
curl -X PUT localhost:9200/_all/_settings -H 'Content-Type: application/json' -d '{"index.blocks.read_only_allow_delete":null}'
\`\`\`
   - **分片分配失敗已達重試上限**：修正根因後 \`curl -X POST "localhost:9200/_cluster/reroute?retry_failed=true"\`

## 驗證
- _cluster/health 回到 green（單節點環境副本無法分配屬 yellow 為預期）
- unassigned_shards = 0；Logstash / Kibana 恢復讀寫

## 注意事項 / 升級處理
- 主分片遺失且無快照（red 持續）勿自行 reroute allocate_stale_primary（⚠️ 可能丟資料），升級平台組
- 變更前保留 _cluster/allocation/explain 輸出

## 相關資源
- SOMP：ELK Manager
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-redis-memory',
        title: 'Redis 記憶體滿 / 連線暴增應變 SOP',
        component: 'Redis Control',
        tags: ['緊急應變', '效能', '告警排障'],
        content: `# Redis 記憶體滿 / 連線暴增應變 SOP

## 適用情境 / 觸發條件
- 告警 Redis used_memory 接近 maxmemory，或應用程式出現 OOM command not allowed
- connected_clients 異常暴增、延遲升高、大量 evicted_keys

## 影響與風險
- 寫入被拒、快取命中率下降、連線耗盡導致應用程式逾時；Redis 同時承載 session 或佇列時影響更大

## 處理步驟
1. **SOMP 確認**：Redis Control → Connections 檢視各連線狀態，找出受影響的 Redis 與所屬 BU。
2. **診斷（只讀指令優先）**
\`\`\`bash
redis-cli -h <host> -p <port> INFO memory       # used_memory_human, maxmemory, mem_fragmentation_ratio
redis-cli -h <host> INFO stats | grep -E "evicted_keys|rejected_connections"
redis-cli -h <host> INFO clients                # connected_clients, blocked_clients
redis-cli -h <host> CONFIG GET maxmemory-policy
redis-cli -h <host> SLOWLOG GET 10
redis-cli -h <host> CLIENT LIST | awk '{print $2}' | cut -d= -f2 | cut -d: -f1 | sort | uniq -c | sort -rn | head
redis-cli -h <host> --bigkeys                   # 掃描大 key，生產環境請於離峰並加 -i 0.1
\`\`\`
3. **處置**
   - 無 TTL 的 key 持續累積：請應用團隊補上 EXPIRE；以 \`SCAN\` 搭配 \`TTL\` 抽查
   - 策略不合理：快取型可用 allkeys-lru；資料型勿用淘汰策略（noeviction）。調整 \`CONFIG SET maxmemory-policy allkeys-lru\` 前確認不影響資料型用途
   - 暫時提升上限：\`CONFIG SET maxmemory <bytes>\`，須確認主機實體記憶體仍有餘裕
   - 單一用戶端造成連線暴增：以 IP 統計找出來源後請該服務修正連線池；必要時 \`CLIENT KILL ADDR ip:port\`（⚠️ 會中斷該連線）
   - 大 key：改用 \`UNLINK <key>\` 非阻塞刪除（⚠️ 先確認該 key 可丟棄）
4. ⚠️ **嚴禁 FLUSHALL / FLUSHDB**：會清空所有資料，且 \`KEYS *\` 也會阻塞，生產環境不得使用。

## 驗證
- used_memory 低於 maxmemory 的 80%，evicted_keys 不再快速增長
- connected_clients 回到基準，SLOWLOG 無新增異常指令

## 注意事項 / 升級處理
- 持久化（RDB / AOF）與複寫同步期間記憶體會暫增，勿在此時重啟
- 擴容或改架構（Cluster、分片）屬變更，升級應用與平台團隊

## 相關資源
- SOMP：Redis Control
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-mail-queue',
        title: 'Mail Relay 佇列積壓 / 寄信失敗應變 SOP',
        component: 'Mail Relay',
        tags: ['緊急應變', '網路管理', '告警排障'],
        content: `# Mail Relay 佇列積壓 / 寄信失敗應變 SOP

## 適用情境 / 觸發條件
- 使用者回報信件延遲或未送達、Bounce Rate 升高
- Mail Relay 的 Queue Manager 顯示佇列數量持續增加

## 處理步驟
1. **SOMP 檢視**：Mail Relay → Dashboard 看成功 / 退信趨勢；Message Trace 以 Queue ID 或信箱查詢信件在各節點的日誌流；Queue Manager 查看佇列。
2. **主機端佇列診斷（Postfix）**
\`\`\`bash
mailq | tail -5
postqueue -p | head -50
qshape deferred | head            # 依目標網域看延遲分布
postcat -q <QUEUEID>              # 檢視單封內容與錯誤原因
tail -200 /var/log/maillog | grep -E "status=(deferred|bounced)"
\`\`\`
3. **依原因處置**
   - **DNS / MX**：Remote Command 執行 p8 確認解析；\`dig MX 目標網域\`、\`nslookup\` 驗證 MX 可解析
   - **對外連線被擋**：Remote Command p6 看本機埠；測試 \`Test-NetConnection 上游主機 -Port 25\` 或 \`nc -vz 上游主機 25\`
   - **上游認證失敗（SASL）**：檢查 sasl_passwd 內帳密是否過期，更新後 \`postmap\` 並 reload
   - **被列入黑名單**：日誌出現 blocked / 554 / 5.7.1，以 MXToolbox 查出口 IP，向黑名單單位申請移除，期間改走備援 Relay
   - **收件端暫時拒收（4xx）**：屬 deferred，修復後重送
4. **重送與清理**：Queue Manager 的 Flush Queue 可觸發重送；
\`\`\`bash
postqueue -f
\`\`\`
   ⚠️ Clear Entire Queue / \`postsuper -d ALL\` 會永久刪除所有待送信件，僅在確認為垃圾信或外洩帳號大量寄信時，經主管同意並備份後執行；單封刪除請用 Delete by Queue ID。
5. 若為帳號遭盜用寄垃圾信，先停用該帳號再清理佇列。

## 驗證
- mailq 數量持續下降，qshape deferred 趨近 0
- Message Trace 查測試信顯示 status=sent；Bounce Rate 回到正常

## 注意事項 / 升級處理
- 配置變更（Config Editor）前先確認 Backup Vault 有備份
- 對外 IP 信譽問題、上游 SMTP 服務異常，升級郵件管理員 / 供應商

## 事後紀錄
- 記錄佇列峰值、主要延遲網域與根因（DNS / 認證 / 黑名單 / 收件端）
- 設定檔修改請透過 Config Editor 並保留 Backup Vault 版本
- 若為外洩帳號，通知資安並要求重設密碼

## 相關資源
- SOMP：Mail Relay（Dashboard / Message Trace / Queue Manager / Config Editor / Backup Vault）、Remote Command（p6、p8）
- sop-inc-dns-resolution
`,
        workflowId: null,
        commandIds: ['p6', 'p8'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-prometheus-target-down',
        title: 'Prometheus Target Down 應變 SOP',
        component: 'Prometheus Target',
        tags: ['緊急應變', '即時監控', '告警排障'],
        content: `# Prometheus Target Down 應變 SOP

## 適用情境 / 觸發條件
- Prometheus 告警 up == 0，或 Prometheus Target 頁面 STATUS / HEALTH CHECK 顯示異常
- Grafana 儀表板出現資料缺口

## 影響與風險
- 該主機 / 應用失去監控與告警能力（盲區），可能掩蓋真實故障

## 處理步驟
1. **SOMP 確認**：Prometheus Target → Registered Targets，找出該 HOSTNAME / IP ADDRESS 的狀態與 LAST INSPECTION；確認該目標是否已正確登錄（可用 + Add / Update Targets 補登，系統會維護 prometheus.yml 的目標清單）。
2. **判斷是主機掛了還是 exporter 掛了**：Scout Monitor 看主機是否在線；Remote Command 執行 p11（List Running Services）檢查 exporter 服務、p6（Check Open/Listening Ports）確認 exporter 埠（例如 node_exporter 9100、windows_exporter 9182）有監聽。
3. **從 Prometheus 伺服器直接測試**
\`\`\`bash
curl -sS -m 5 http://<目標IP>:9100/metrics | head
nc -vz <目標IP> 9100
\`\`\`
\`\`\`powershell
Test-NetConnection <目標IP> -Port 9182
\`\`\`
4. **依結果處置**
   - 服務停止：\`systemctl restart node_exporter\` 或 \`Restart-Service windows_exporter\`
   - 埠不通（逾時）：檢查防火牆
\`\`\`powershell
Get-NetFirewallRule -DisplayName "*exporter*"
New-NetFirewallRule -DisplayName "Allow exporter 9182" -Direction Inbound -Protocol TCP -LocalPort 9182 -Action Allow
\`\`\`
   - 回應 401 / 403 / 404：檢查 scrape 設定的 metrics_path、認證或 TLS
   - 回應慢逾時：調整 scrape_timeout 或排查目標負載
5. 變更 scrape 設定後以 \`promtool check config prometheus.yml\` 驗證，再 reload（\`curl -X POST http://localhost:9090/-/reload\`，需啟用 lifecycle 選項）。

## 驗證
- Prometheus Targets 頁面該目標為 UP，Prometheus Target 的 HEALTH CHECK 恢復
- \`up{instance="<ip>:9100"}\` 回傳 1，Grafana 資料連續

## 注意事項 / 升級處理
- 主機整台失聯請改走主機離線流程；整批 Target 同時 Down 多為 Prometheus 伺服器或網路問題
- ⚠️ 防火牆規則請限定來源為 Prometheus 伺服器 IP，勿對全網開放

## 相關資源
- SOMP：Prometheus Target、Scout Monitor、Remote Command（p6、p11）
- sop-inc-network-latency
`,
        workflowId: null,
        commandIds: ['p6', 'p11'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-nutanix-vm-hang',
        title: 'Nutanix VM 無回應應變 SOP',
        component: 'Nutanix',
        tags: ['緊急應變', '系統管理', '告警排障'],
        content: `# Nutanix VM 無回應應變 SOP

## 適用情境 / 觸發條件
- VM 無法 Ping / RDP / SSH，Scout Monitor 顯示離線，但 Nutanix 中 power state 仍為 ON
- VM 畫面凍結、作業系統當機、藍屏

## 影響與風險
- 強制關機可能造成檔案系統損毀、資料庫未完成交易遺失

## 處理步驟
1. **確認不是網路問題**：從同網段另一台主機 ping / Test-NetConnection 該 VM；見 sop-inc-network-latency。
2. **SOMP 檢視**：Nutanix → Virtual Machines，搜尋 VM，確認 POWER 狀態、所在 HOST、CLUSTER，開啟 Properties 看 vCPU / 記憶體 / 磁碟；同時查看同一 HOST 上其他 VM 是否同樣異常（若是，為 host 或儲存問題，不要逐台重啟）。
3. **開啟 Console**：在 Prism 或 SOMP 的 VM 連線入口查看畫面（VM 需為 ON），判斷是 OS 當機、卡在開機、或等待輸入。
4. **由輕到重逐級處置（每級等待 3-5 分鐘）**
   1. GuestReboot（ACPI 重開機，需 NGT / OS 回應）
   2. GuestShutdown 後再開機
   3. ⚠️ Reset：相當於按重設鈕，OS 不會正常關閉
   4. ⚠️ PowerOff / PowerCycle：強制斷電，僅在 1-3 無效且已通知應用負責人時執行
5. **CVM / Host 檢查（SSH 到 CVM）**
\`\`\`bash
ncli cluster status | head -20
cluster status | grep -v UP        # 找出非 UP 的服務
ncli host ls | grep -E "Name|Under Maintenance"
acli vm.get <VM名稱>               # 檢視 VM 設定與狀態
acli vm.list
\`\`\`
   Host 或 CVM 異常、儲存 Container 容量滿，會導致大量 VM 同時凍結，應優先處理。
6. 開機後檢查事件記錄：Windows 事件檢視器 Kernel-Power 41、\`Get-WinEvent -LogName System -MaxEvents 30\`；Linux \`journalctl -b -1 -e\`。

## 驗證
- VM 可 Ping / 登入，應用服務與資料庫正常，Scout Monitor 告警恢復
- 磁碟 chkdsk / fsck 與服務啟動檢查無異常

## 注意事項 / 升級處理
- 強制電源操作前先確認是否有重要交易並通知應用負責人，操作皆會留下稽核紀錄
- 多台 VM 同時凍結、CVM 異常、儲存容量或硬體告警，立即升級 Nutanix 管理員並開立廠商支援案件

## 事後紀錄
- 記錄當機時間、所採取的電源操作層級、重開機後的檢查結果
- 建議確認 VM 已安裝 NGT 以支援 GuestReboot / GuestShutdown
- 若同一 VM 反覆當機，檢查驅動、記憶體配置與 Host 硬體事件，必要時至 Hardware Issues 登錄

## 相關資源
- SOMP：Nutanix（Virtual Machines、Power 操作）、Scout Monitor、Hardware Issues
`,
        workflowId: null,
        commandIds: [],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
];
