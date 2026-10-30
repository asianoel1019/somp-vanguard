// SOP Runbook presets — 主機類告警應變
const SEED_TIME = new Date().toISOString();
module.exports = [
    {
        id: 'sop-inc-win-cpu-high',
        title: 'Windows CPU 使用率過高 (w3wp / sqlservr / 防毒 / Windows Update) 應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Windows', '效能', '告警排障'],
        content: `# Windows CPU 使用率過高應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 觸發 CPU 類（type: cpu）或 process_cpu（指定處理程序 CPU）告警，例如 CPU ≥ 90% 持續數分鐘。
- 常見元兇：w3wp.exe（IIS 應用程式集區）、sqlservr.exe（SQL Server）、防毒掃描（MsMpEng.exe 等）、Windows Update（TiWorker.exe / TrustedInstaller）。

## 影響與風險
- 網站/服務回應變慢、逾時；RDP 操作卡頓；嚴重時 Agent 回報延遲而誤報離線。

## 處理步驟
1. 在 Scout Monitor 開啟該主機，查看 CPU 曲線：是突發尖峰、規律排程（如整點）或持續滿載；Alerts 分頁可按「🤖 調查」讓 AI Ops Agent 彙整尖峰時的 Top 處理程序（選用，唯讀）。
2. 在 Remote Command 執行預設 **Top 10 CPU Processes（p2）**，確認元兇；再跑 **Check System Uptime（p1）** 判斷是否剛重開機（開機後 Windows Update/索引常短暫吃滿）。
3. 依元兇分流：
   - w3wp.exe：找出是哪個應用程式集區。
\`\`\`powershell
Get-CimInstance Win32_Process -Filter "Name='w3wp.exe'" | Select ProcessId,CommandLine
& "$env:windir\\system32\\inetsrv\\appcmd.exe" list wp
\`\`\`
   確認為該站台問題後，可回收該集區（影響該站台連線）：
\`\`\`powershell
# ⚠️ 回收集區會中斷進行中的請求，先確認離峰或已通知
& "$env:windir\\system32\\inetsrv\\appcmd.exe" recycle apppool /apppool.name:"<集區名>"
\`\`\`
   - sqlservr.exe：檢視高耗能查詢，勿直接重啟 SQL 服務。
\`\`\`powershell
sqlcmd -E -Q "SELECT TOP 5 r.session_id,r.cpu_time,r.status,t.text FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t ORDER BY r.cpu_time DESC"
\`\`\`
   - 防毒掃描：確認是排程全機掃描；於防毒主控台改到離峰、或對資料庫/IIS 目錄設定排除。
   - Windows Update：TiWorker 通常數十分鐘內結束，勿強制終止；確認後等待並安排重開機。
4. 若為失控處理程序（非關鍵、確認無資料損失）：
\`\`\`powershell
# ⚠️ 強制終止前先確認 PID 與用途
Stop-Process -Id <PID> -Force
\`\`\`
5. 若為關鍵服務且持續滿載：收集資料（工作管理員 → 建立傾印檔 或 procdump）後，再於維護視窗重啟服務。

## 驗證
- 再跑 p2，確認 CPU 回到基準；Scout Monitor 曲線回落、告警自動恢復（resolved）。
- 對應網站/應用程式回應時間恢復正常。

## 注意事項 / 升級處理
- 15 分鐘內無法降載、或元兇為業務核心 DB/應用，升級給應用/DBA 負責人。
- 反覆發生請建立常態化調整（集區回收排程、防毒排除、查詢最佳化）並記錄於 CMDB 變更歷史。

## 相關資源
- Scout Monitor、Alerts & Rules、Remote Command、Live Event Viewer
- sop-inc-linux-cpu-load、sop-inc-memory-oom`,
        workflowId: null,
        commandIds: ['p2', 'p1', 'p11'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-linux-cpu-load',
        title: 'Linux CPU / Load Average 過高應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Linux', '效能', '告警排障'],
        content: `# Linux CPU / Load Average 過高應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 的 cpu 或 process_cpu 告警觸發。
- 主機 SSH 緩慢、服務逾時。注意：Load 高不一定是 CPU 忙，也可能是 I/O wait 或 D 狀態程序（磁碟/NFS 卡住）。

## 影響與風險
- 服務延遲、排程逾時；嚴重時 Agent 上報延遲造成離線誤報。

## 處理步驟
1. Scout Monitor 查看 CPU 曲線與時間點；Alerts 分頁可用「🤖 調查」取得尖峰時 Top 程序摘要（選用）。
2. Remote Command 執行 **Top 10 CPU Processes（p2）**、**Check System Uptime（p1，看 load average）**、**Tail System Logs（p12）**。
3. 判斷是 CPU 還是 I/O：
\`\`\`bash
uptime
top -b -n1 | head -15          # 看 %us %sy %wa
vmstat 1 5                     # r 欄(可執行佇列)、b 欄(阻塞)、wa
nproc                          # load 與核心數比較
\`\`\`
   - %wa 高：改查磁碟 I/O。
\`\`\`bash
iostat -x 1 3
ps -eo pid,stat,wchan:20,cmd | awk '$2 ~ /^D/'
\`\`\`
   - %us 高：定位程序與執行緒。
\`\`\`bash
ps -eo pid,ppid,%cpu,%mem,etime,cmd --sort=-%cpu | head -10
top -H -p <PID>
\`\`\`
4. 查看是否為暴衝/迴圈、cron 疊跑或被入侵（挖礦）：
\`\`\`bash
crontab -l; ls /etc/cron.d
journalctl --since "30 min ago" -p warning | tail -50
\`\`\`
5. 處置（依序由低風險到高風險）：
   - 對非關鍵程序降優先權：
\`\`\`bash
renice +10 -p <PID>
\`\`\`
   - 服務層重啟（先確認可短暫中斷）：
\`\`\`bash
# ⚠️ 會中斷服務
systemctl restart <service>
\`\`\`
   - 失控且確認無資料風險：
\`\`\`bash
# ⚠️ 先 kill -15，無效再 -9
kill -15 <PID>
\`\`\`

## 驗證
- 再跑 p1、p2：load average 回到核心數以內；Scout Monitor 告警恢復。
- 服務健康檢查通過。

## 注意事項 / 升級處理
- 疑似入侵（不明程序、對外連線）：立即隔離網路並通知資安，勿先清除證據。
- 持續高載且確認為容量不足：升級給系統/容量規劃擴充 vCPU 或擴增節點。

## 相關資源
- Scout Monitor、Alerts & Rules、Remote Command
- sop-inc-win-cpu-high、sop-inc-memory-oom、sop-inc-linux-disk-full`,
        workflowId: null,
        commandIds: ['p2', 'p1', 'p12'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-memory-oom',
        title: '記憶體不足 / OOM（Windows 與 Linux）應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Windows', 'Linux', '效能', '告警排障'],
        content: `# 記憶體不足 / OOM 應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 的 memory（使用率）或 process_memory（指定程序記憶體 MB）告警。
- Linux 發生 OOM Killer 殺程序；Windows 出現 Event 2004（資源耗盡）、應用程式 OutOfMemory。

## 影響與風險
- 程序被強制結束、服務中斷、大量 swap/分頁造成整機變慢、甚至當機。

## 處理步驟
1. Scout Monitor 檢視記憶體趨勢：緩慢爬升（疑似 memory leak）或瞬間暴增（批次作業）。可按告警上的「🤖 調查」取得尖峰時程序排行（選用）。
2. Remote Command 執行 **Top 10 Memory Processes（p3）** 找出大戶；**Tail System Logs（p12）** 看是否有 OOM 紀錄。
3. Linux 確認 OOM：
\`\`\`bash
free -h
dmesg -T | grep -i -E "out of memory|oom-killer|killed process" | tail
journalctl -k --since "2 hours ago" | grep -i oom
ps -eo pid,%mem,rss,cmd --sort=-rss | head -10
\`\`\`
4. Windows 確認：
\`\`\`powershell
Get-Process | Sort WorkingSet64 -Desc | Select -First 10 Name,Id,@{n='MB';e={[int]($_.WorkingSet64/1MB)}}
Get-WinEvent -FilterHashtable @{LogName='System';Id=2004} -MaxEvents 5 | Format-List TimeCreated,Message
Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory,TotalVisibleMemorySize
\`\`\`
   Live Event Viewer 可搜尋同時段 Windows 事件。
5. 處置：
   - 釋放：結束非必要程序或排程批次；Linux 可清除可回收快取（通常無需）：
\`\`\`bash
# ⚠️ 影響效能，僅緊急時
sync; echo 1 > /proc/sys/vm/drop_caches
\`\`\`
   - 重啟洩漏服務（確認可中斷，並先保留傾印/記錄）：
\`\`\`powershell
# ⚠️ 會中斷服務
Restart-Service <服務名稱>
\`\`\`
\`\`\`bash
# ⚠️ 會中斷服務
systemctl restart <service>
\`\`\`
   - Java/.NET 應用檢查 heap 上限設定（-Xmx、app pool 私有記憶體限制）是否合理。
   - 容器環境：檢查 limits 是否過低（docker stats / kubectl top pod）。
6. 長期：增加 RAM、調整分頁檔（Windows）與 swap（Linux），為 process_memory 設定專屬告警。

## 驗證
- p3 顯示記憶體回落；Scout Monitor 告警恢復；dmesg 無新增 OOM。
- 被殺的服務已重新運作。

## 注意事項 / 升級處理
- 同一程序 24 小時內重複 OOM，視為 memory leak，升級給應用開發商並附上 Scout 曲線與 p3 輸出。
- 勿在未確認用途前殺 sqlservr / 資料庫程序。

## 相關資源
- Scout Monitor、Alerts & Rules、Live Event Viewer、Remote Command
- sop-inc-win-cpu-high、sop-inc-linux-cpu-load`,
        workflowId: null,
        commandIds: ['p3', 'p12'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-win-disk-full',
        title: 'Windows 磁碟空間不足（C: 清理 / IIS Log / WinSxS）應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Windows', '儲存空間', '告警排障'],
        content: `# Windows 磁碟空間不足應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 的 disk（指定磁碟機，如 C:）使用率告警。
- 症狀：服務寫入失敗、Windows Update 失敗、應用程式 log 無法寫入、SQL 檔案無法成長。

## 影響與風險
- C: 滿載可能使系統/IIS/資料庫停止運作；清理錯目錄可能損壞系統。

## 處理步驟
1. Scout Monitor 確認哪個磁碟、成長速度（突增＝log/dump；緩增＝資料成長）。
2. Remote Command 執行 **Disk Space Overview（p9）** 與 **Top 10 Largest Directories（p10）** 定位大目錄。
3. 找大檔案：
\`\`\`powershell
Get-ChildItem C:\\ -Recurse -File -ErrorAction SilentlyContinue | Sort Length -Desc | Select -First 20 FullName,@{n='GB';e={[math]::Round($_.Length/1GB,2)}}
\`\`\`
4. 常見安全清理項目（先確認保留政策）：
   - IIS Log（預設 C:\\inetpub\\logs\\LogFiles）保留 30 天：
\`\`\`powershell
# ⚠️ 刪除前先確認稽核保留需求，必要時先壓縮/備份
Get-ChildItem C:\\inetpub\\logs\\LogFiles -Recurse -File | Where LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -Force
\`\`\`
   - 暫存檔：
\`\`\`powershell
# ⚠️ 僅清理超過 7 天者
Get-ChildItem $env:TEMP,C:\\Windows\\Temp -Recurse -File -ErrorAction SilentlyContinue | Where LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item -Force -ErrorAction SilentlyContinue
\`\`\`
   - WinSxS 元件存放區（勿手動刪檔，使用 DISM）：
\`\`\`powershell
Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore
Dism.exe /Online /Cleanup-Image /StartComponentCleanup
\`\`\`
   - Windows Update 下載快取：停止 wuauserv 後清空 C:\\Windows\\SoftwareDistribution\\Download，再啟動服務。
   - 傾印檔：C:\\Windows\\MEMORY.DMP、C:\\Windows\\Minidump（確認已無需分析）。
   - 分頁檔（pagefile.sys）：僅在確認後移到其他磁碟，不要直接刪除。
   - 回收筒、舊使用者設定檔、舊的備份 .bak。
5. 資料庫 log 暴增：先確認備份鏈，再處理交易記錄，勿直接刪除 .ldf。
6. 無法清理時：擴充磁碟（VM 擴充 vDisk 後以 diskmgmt 或 Resize-Partition 延伸磁碟區）。
\`\`\`powershell
Resize-Partition -DriveLetter C -Size (Get-PartitionSupportedSize -DriveLetter C).SizeMax
\`\`\`

## 驗證
- p9 顯示可用空間恢復到告警閾值以下並留 20% 緩衝；Scout Monitor 告警恢復；相關服務可正常寫入。

## 注意事項 / 升級處理
- 不要刪除 C:\\Windows 下未知檔案；不確定者先詢問。
- 需擴充容量或涉及資料庫檔案，升級給儲存/DBA 團隊。
- 長期對策：設定 IIS Log 輪替排程（可用 Task Scheduler）並加上 80% 預警規則。

## 相關資源
- Scout Monitor、Alerts & Rules、Remote Command、Task Scheduler
- sop-inc-linux-disk-full`,
        workflowId: null,
        commandIds: ['p9', 'p10'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-linux-disk-full',
        title: 'Linux 磁碟 / inode 空間不足應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Linux', '儲存空間', '告警排障'],
        content: `# Linux 磁碟 / inode 空間不足應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 的 disk（指定掛載點，如 /、/var）使用率告警。
- 症狀：No space left on device、服務無法寫入、資料庫崩潰、無法登入寫 history。

## 影響與風險
- /var 滿載可使 log、DB、套件管理失敗；inode 耗盡時，df 顯示仍有空間卻無法建立檔案。

## 處理步驟
1. Scout Monitor 確認掛載點與成長速度。
2. Remote Command 執行 **Disk Space Overview（p9）**、**Top 10 Largest Directories（p10）**、**Tail System Logs（p12）**。
3. 判斷是空間還是 inode：
\`\`\`bash
df -hT
df -i
\`\`\`
4. 定位大目錄（-x 避免跨檔案系統）：
\`\`\`bash
du -xh / --max-depth=2 2>/dev/null | sort -rh | head -20
du -xh /var --max-depth=2 2>/dev/null | sort -rh | head -15
\`\`\`
   inode 耗盡時找小檔案過多的目錄：
\`\`\`bash
for d in /var /tmp /home; do echo $d; find $d -xdev -type f | cut -d/ -f1-4 | sort | uniq -c | sort -rn | head -5; done
\`\`\`
5. 常見處置：
   - systemd journal：
\`\`\`bash
journalctl --disk-usage
journalctl --vacuum-size=500M
\`\`\`
   - logrotate 未生效：
\`\`\`bash
logrotate -d /etc/logrotate.conf    # 先 dry-run
logrotate -f /etc/logrotate.conf
\`\`\`
   - 已刪除但仍被程序占用的檔案（刪檔後空間未釋放）：
\`\`\`bash
lsof +L1 | head
lsof -nP | grep '(deleted)' | sort -k7 -rn | head
\`\`\`
     重啟持有該檔案的服務或將其截斷：
\`\`\`bash
# ⚠️ 截斷會清空檔案內容
: > /proc/<PID>/fd/<FD>
\`\`\`
   - Docker：
\`\`\`bash
docker system df
# ⚠️ 會移除未使用的映像/容器/網路，執行前確認
docker system prune -f
\`\`\`
   - 套件快取：apt clean 或 yum clean all；舊核心 autoremove。
   - 大型暫存/core dump：確認後刪除。
\`\`\`bash
# ⚠️ 請先 ls 確認標的再刪除
find /var/log -type f -name "*.gz" -mtime +30 -delete
\`\`\`
6. 無法清出足夠空間：擴充 LVM。
\`\`\`bash
lvextend -r -L +10G /dev/<vg>/<lv>
\`\`\`

## 驗證
- df -h、df -i 恢復；p9 輸出正常；Scout Monitor 告警恢復；服務可寫入。

## 注意事項 / 升級處理
- 勿以 rm -rf 清理 /var 下的 DB 資料目錄；不確定請升級給 DBA。
- 需擴容或涉及儲存設備，升級給儲存團隊；請同步調整 logrotate 與預警閾值。

## 相關資源
- Scout Monitor、Alerts & Rules、Remote Command
- sop-inc-win-disk-full、sop-inc-memory-oom`,
        workflowId: null,
        commandIds: ['p9', 'p10', 'p12'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-host-offline',
        title: '主機離線 / Scout Agent 失聯應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Windows', 'Linux', '網路管理', '告警排障'],
        content: `# 主機離線 / Scout Agent 失聯應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor 偵測主機離線：Agent 超過離線閾值（預設 300 秒）未回報；Alerts & Rules 若有 Offline/Connectivity 規則則以該規則閾值為準。
- 離線不等於主機掛掉：可能是網路中斷、主機當機/關機，或僅 Agent 服務停止。

## 影響與風險
- 離線期間失去效能監控與告警；若為真實當機則業務受影響。

## 處理步驟
1. 先判斷範圍：同網段/同機房是否有多台同時離線？是 → 優先查網路（交換器、VLAN、防火牆），可查看 Topology Map、Network Device。單台 → 往下。
2. 以其他方式測試主機本身：從管理主機 ping / 測試埠：
\`\`\`bash
ping -c 4 <主機IP>
nc -zv <主機IP> 22     # Linux SSH
\`\`\`
\`\`\`powershell
Test-NetConnection <主機IP> -Port 3389
\`\`\`
   也可用 Server Check 檢視連線狀態。
3. 主機可 ping/連得上，但 Agent 離線 → 登入主機，在其上用 Remote Command（若仍可用）或本機執行 **Ping Internet（p5）** 與 **Check System Uptime（p1）**，確認網路出口與是否剛重開。
4. 檢查 Agent 服務：
   - Linux（systemd）：
\`\`\`bash
systemctl status scout.service
journalctl -u scout.service -n 50 --no-pager
cat /etc/scout/config.json | grep -v -i -E "key|token|secret"   # 勿外洩憑證
# ⚠️ 重啟僅影響 Agent
systemctl restart scout.service
\`\`\`
   - Windows（由 scout-win.exe 安裝的服務，目錄例如 C:\\ScoutAgent\\）：
\`\`\`powershell
Get-Service | Where Name -match "scout"
Get-Service <服務名稱> | Restart-Service
Get-Content C:\\ScoutAgent\\*.log -Tail 50
\`\`\`
5. 常見原因：Server URL/防火牆規則變更、DNS 解析失敗（可再用 DNS Resolution Test p8）、系統時間偏移造成驗證失敗（見 sop-inc-ntp-drift）、TLS/憑證問題、磁碟滿導致 Agent 無法寫入。
6. 主機完全無回應：確認虛擬化（Nutanix、vCenter）主控台狀態、電源；實體機查看 iDRAC/iLO；必要時依程序重啟。

## 驗證
- Scout Monitor 顯示主機上線、最新 Heartbeat 時間更新；離線告警恢復；p1 顯示預期的 uptime。

## 注意事項 / 升級處理
- 重啟前確認非計畫維護中；計畫性維護請事先通知值班人員，並事先建立維護時段（Alerts & Rules → 🔧 Maintenance Windows），維護期間告警照記錄但不通知。
- 15 分鐘內無法聯繫主機：升級給基礎架構/機房值班；多台離線升級給網路團隊。
- Agent 設定檔含憑證，勿貼入工單。

## 相關資源
- Scout Monitor、Alerts & Rules、Agents、Server Check、Topology Map
- sop-inc-ntp-drift、sop-inc-linux-disk-full`,
        workflowId: null,
        commandIds: ['p5', 'p1'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-win-service-stopped',
        title: 'Windows 服務異常停止應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Windows', '系統管理', '告警排障'],
        content: `# Windows 服務異常停止應變 SOP

## 適用情境 / 觸發條件
- Scout Monitor / Alerts & Rules 的 service（指定服務名稱）或 process 規則告警：服務非 Running。
- 事件檢視器出現 Event 7031（服務異常終止並將重試）、7034（服務未預期終止）、7000/7009（服務啟動失敗/逾時）、7023（服務回報錯誤）。

## 影響與風險
- 對應應用/資料庫/Agent 不可用；若服務反覆崩潰可能放大成資源耗盡。

## 處理步驟
1. 在 Scout Monitor 確認告警服務名稱與發生時間；可按「🤖 調查」讓 AI Ops Agent 搜尋同時段 Windows 事件（選用）。
2. Remote Command 執行 **List Running Services（p11）** 確認狀態，**Tail System Logs（p12）** 取得近期紀錄；Live Event Viewer 搜尋 7031/7034/7000 及 Application 錯誤。
3. 於主機上查詢服務與停止原因：
\`\`\`powershell
Get-Service <名稱> | Format-List *
Get-WinEvent -FilterHashtable @{LogName='System';Id=7031,7034,7000,7009,7023;StartTime=(Get-Date).AddHours(-3)} | Select TimeCreated,Id,Message | Format-List
Get-WinEvent -FilterHashtable @{LogName='Application';Level=2;StartTime=(Get-Date).AddHours(-3)} -MaxEvents 20
\`\`\`
4. 檢查相依性、帳號與資源：
\`\`\`powershell
sc.exe qc <名稱>               # 啟動類型、執行帳號、相依服務
sc.exe query <名稱>
Get-PSDrive C | Select Free    # 磁碟是否已滿
\`\`\`
   常見：服務帳號密碼過期/被鎖定、相依服務未啟動、埠被占用、設定檔錯誤、磁碟滿、記憶體不足。
5. 嘗試啟動：
\`\`\`powershell
Start-Service <名稱>
# 逾時（7009）屬啟動過慢，先查相依服務與資源；勿輕易調整 ServicesPipeTimeout（⚠️ 需改登錄檔並重開機）
\`\`\`
6. 設定復原選項，避免再次無人察覺：服務內容 → 復原 → 第一/第二次失敗「重新啟動服務」，後續失敗「執行程式」或不動作，重設失敗計數 1 天：
\`\`\`powershell
sc.exe failure <名稱> reset= 86400 actions= restart/60000/restart/120000//0
\`\`\`
7. 若啟動啟動類型被改成停用，確認是否為變更造成（參考 Audit log、CMDB 變更歷史），再決定是否改回 Automatic（延遲啟動）。

## 驗證
- Get-Service 顯示 Running；p11 清單包含該服務；Scout Monitor 告警恢復；應用功能測試通過；30 分鐘內無再次 7031/7034。

## 注意事項 / 升級處理
- 同一服務 1 小時內崩潰超過 3 次，勿無限重啟，保留傾印並升級給應用負責人。
- 重啟資料庫/AD 等核心服務前，先確認影響範圍與備份。

## 相關資源
- Scout Monitor、Alerts & Rules、Live Event Viewer、Remote Command
- sop-inc-win-cpu-high、sop-inc-memory-oom`,
        workflowId: null,
        commandIds: ['p11', 'p12'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-login-failure-lockout',
        title: '登入失敗暴增 / AD 帳號鎖定應變 SOP',
        component: 'AD Control',
        tags: ['緊急應變', 'Windows', '帳號安全', '告警排障'],
        content: `# 登入失敗暴增 / AD 帳號鎖定應變 SOP

## 適用情境 / 觸發條件
- 短時間內大量登入失敗（Event 4625）、AD 帳號被鎖定（Event 4740）、使用者反映帳號一直被鎖。
- 可能原因：使用者換密碼後舊密碼殘留（手機郵件、對應磁碟機、排程工作、服務帳號）、暴力破解/密碼噴灑、遭入侵的主機。

## 影響與風險
- 使用者/服務帳號無法登入、服務中斷；若為攻擊則有帳號被入侵風險。

## 處理步驟
1. 以 Live Event Viewer 搜尋 4625、4740、4771/4776，找出帳號、來源 IP/電腦名稱與時間分布。
2. 判斷型態：
   - 單一帳號、單一來源：多為殘留的舊憑證。
   - 多帳號、單一來源 IP：密碼噴灑/暴力破解。
   - 單一帳號、多來源：帳號資訊外洩。
3. 在網域控制站找出鎖定來源（4740 的 Caller Computer Name）：
\`\`\`powershell
Get-WinEvent -ComputerName <DC> -FilterHashtable @{LogName='Security';Id=4740;StartTime=(Get-Date).AddHours(-2)} | ForEach-Object { [xml]$x=$_.ToXml(); ($x.Event.EventData.Data | % {$_.'#text'}) -join ' | ' }
Search-ADAccount -LockedOut | Select Name,SamAccountName,LockoutTime
Get-ADUser <帳號> -Properties LockedOut,BadLogonCount,LastBadPasswordAttempt
\`\`\`
4. 在來源電腦用 Remote Command 執行 **Show Logged In Users（p13）** 確認目前登入者、疑似連線；並檢查殘留項目：
\`\`\`powershell
cmdkey /list
Get-ScheduledTask | Where {$_.Principal.UserId -like "*<帳號>*"}
Get-CimInstance Win32_Service | Where StartName -like "*<帳號>*" | Select Name,StartName
\`\`\`
5. 解鎖帳號：使用 AD Control 搜尋該使用者並點選「Unlock Account」（所有操作會被記錄於 Audit log）；或命令列：
\`\`\`powershell
Unlock-ADAccount -Identity <帳號>
\`\`\`
   解鎖前先清除來源殘留憑證，否則很快再次鎖定。
6. 若判定為攻擊：
   - 於防火牆/Fortinet 封鎖來源 IP；
   - 針對被打的高權限帳號強制重設密碼（⚠️ 先通知使用者，並同步更新使用該帳號的服務）：
\`\`\`powershell
Set-ADAccountPassword -Identity <帳號> -Reset -NewPassword (Read-Host -AsSecureString "New password")
\`\`\`
   - 檢查是否有成功登入（4624）緊接在大量失敗之後。

## 驗證
- Get-ADUser 顯示 LockedOut = False 且 15 分鐘內無新的 4740；使用者可正常登入；4625 事件速率回到基準。

## 注意事項 / 升級處理
- 疑似入侵（成功登入來自異常來源/管理帳號被打）：立即升級給資安團隊，保留 Security log，勿重灌。
- 密碼與憑證勿貼入工單或聊天。AuthSecurity 類通知可設定推送到 Telegram/Webhook。

## 相關資源
- AD Control、Live Event Viewer、Audit log、Remote Command
- sop-inc-ntp-drift（時間偏移也會造成驗證失敗）`,
        workflowId: null,
        commandIds: ['p13'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
    {
        id: 'sop-inc-ntp-drift',
        title: '主機時間偏移 / NTP 同步異常應變 SOP',
        component: 'Scout Monitor',
        tags: ['緊急應變', 'Windows', 'Linux', '系統管理', '告警排障'],
        content: `# 主機時間偏移 / NTP 同步異常應變 SOP

## 適用情境 / 觸發條件
- 時間差異導致的症狀：Kerberos/AD 驗證失敗（偏移超過預設 5 分鐘）、憑證驗證錯誤、Scout Agent 無法上線或資料時間錯亂、Log 時序對不上、TLS 錯誤。
- 虛擬機剛還原快照/vMotion 後、主機長時間休眠、NTP 來源不通。

## 影響與風險
- 網域成員登入失敗、服務間驗證失敗、稽核紀錄不可靠。

## 處理步驟
1. 於 Remote Command 對受影響主機與網域控制站各執行 **Check System Date & Time（p14）**，比較時間差。
2. Windows 檢查（網域成員應與 DC 同步，PDC Emulator 才同步外部來源）：
\`\`\`powershell
w32tm /query /status
w32tm /query /source
w32tm /query /peers
w32tm /monitor /domain:<網域名稱>
w32tm /stripchart /computer:<DC或NTP> /samples:5 /dataonly
\`\`\`
3. Windows 修復：
\`\`\`powershell
# ⚠️ 大幅跳時可能影響交易/排程，先確認離峰；僅在確認 NTP 設定正確後使用
w32tm /resync /force
net stop w32time; net start w32time
w32tm /config /syncfromflags:domhier /update      # 網域成員
\`\`\`
   PDC Emulator 設定外部來源：
\`\`\`powershell
w32tm /config /manualpeerlist:"<ntp1>,<ntp2>" /syncfromflags:manual /reliable:yes /update
\`\`\`
4. Linux（chronyd）：
\`\`\`bash
timedatectl
chronyc tracking
chronyc sources -v
systemctl status chronyd      # Debian 系可能為 chrony
# ⚠️ makestep 會直接跳時
chronyc makestep
systemctl restart chronyd
\`\`\`
   若使用 ntpd：ntpq -p。確認 /etc/chrony.conf 的 server/pool 設定與防火牆 UDP 123 可通。
5. 虛擬機：確認 hypervisor 的時間同步設定（如 VMware Tools 同步與 NTP 勿雙重管理），避免互相拉扯。
6. 時區錯誤（時間看似差整數小時）：
\`\`\`bash
timedatectl set-timezone Asia/Taipei
\`\`\`
\`\`\`powershell
tzutil /s "Taipei Standard Time"
\`\`\`
7. 修復後若 Scout Agent 仍離線，重啟 Agent 服務（參考 sop-inc-host-offline）。

## 驗證
- 偏移 < 1 秒（chronyc tracking 的 System time / w32tm stripchart）；p14 輸出與 DC 一致；AD 登入與 Scout Agent 恢復。

## 注意事項 / 升級處理
- 偏移超過數小時且 DC 本身不準：升級給 AD/基礎架構，先修 PDC Emulator 時間來源。
- 勿隨意向前/向後大幅調整 DB、叢集節點時間，需評估後再執行。

## 相關資源
- Scout Monitor、Remote Command、AD Control
- sop-inc-host-offline、sop-inc-login-failure-lockout`,
        workflowId: null,
        commandIds: ['p14'],
        updatedBy: 'SYSTEM',
        updatedAt: SEED_TIME,
    },
];
