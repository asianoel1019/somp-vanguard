// License state on the client (free / paid edition). The server enforces everything; this only decides what the UI
// shows as locked. Source of truth: `license` in the login / /auth/config responses (backend lib/license.js).

export const LICENSE_EVENT = 'somp:license';

export const PAID_FEATURE_INFO = {
    aiAgent: { name: 'AI Ops Agent', desc: '用自然語言調查告警：自動查詢主機、指標、日誌與最近變更，整理成可能原因與建議動作。' },
    workflow: { name: 'Workflow Editor', desc: '以拖拉方式設計維運流程（SSH、PowerShell、HTTP、核准節點），一鍵執行並保留每次執行紀錄。' },
    scheduler: { name: 'Task Scheduler', desc: '依 cron 排程在本機或遠端主機執行指令與腳本，記錄每次結果並在失敗時提醒。' },
    remoteCmd: { name: 'Remote Command', desc: '對多台 Windows / Linux 主機同時下指令，搭配指令庫重複使用常用命令。' },
    install: { name: 'Server Provision', desc: '批次遠端部署軟體：預檢、並行安裝、即時進度與完整的部署歷史。' },
    manage_self_healing: { name: '自動自癒', desc: '告警觸發時由 Scout Agent 在主機上自動執行修復腳本，並回報結果。' },
    networkDevice: { name: 'Network Device', desc: '整合 Firewall、Switch、Load Balancer：介面、政策、VLAN、MAC 與每日設定備份。' },
    ipam: { name: 'IPAM', desc: 'IP 位址與子網路管理、網段掃描、DNS 同步，並自動登記其他功能使用中的 IP。' },
    netSearch: { name: 'NetSearch', desc: '搜尋所有網路設備的設定備份，快速找出 IP、VLAN、ACL 出現在哪些設備。' },
    dataCenter: { name: 'Data Center', desc: '機房與機櫃配置、拓撲圖、硬體報修、備品庫存、合約與保固到期提醒。' },
};

export function readStoredLicense(storage = globalThis.localStorage) {
    try {
        const user = JSON.parse(storage.getItem('user') || 'null');
        return user && user.license && typeof user.license === 'object' ? user.license : null;
    } catch {
        return null;
    }
}

export function storeLicense(license, storage = globalThis.localStorage) {
    try {
        const user = JSON.parse(storage.getItem('user') || 'null');
        if (!user || typeof user !== 'object') return;
        storage.setItem('user', JSON.stringify({ ...user, license }));
    } catch { /* storage unavailable */ }
}

export const isLockedFlag = (flag, license) => !!(license && Array.isArray(license.locked) && license.locked.includes(flag));
export const isFree = (license) => !!(license && license.edition === 'free');

export function licenseLabel(license) {
    if (!license) return '';
    if (license.edition === 'paid') return license.customer ? `Licensed to ${license.customer}` : 'Licensed';
    return license.edition === 'free' ? 'Free' : '';
}

export const isLicenseError = (err) => !!(err && err.response && err.response.data && err.response.data.code === 'LICENSE_REQUIRED');
