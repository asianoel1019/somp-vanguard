/**
 * Registry of every document_store key the backend writes, and HOW it may be written.
 *
 *   mode 'mutate'  several writers (both processes) or a read -> await -> write gap: every change MUST go through
 *                  lib/docStore.js mutateDocument (or a store module built on it: ipamStore, cmdbMetaStore,
 *                  schedulerStore, dnsDataStore, ...). Never readDataSync -> modify -> writeDataSync.
 *   mode 'replace' one owner writes a whole snapshot / cache / flag / settings document, or a synchronous
 *                  read-modify-write in a single process: writeDataSync is fine.
 *   mode 'log'     append-only history / log arrays still stored as a document. Appends go through
 *                  mutateDocument (atomic, capped), never writeDataSync. (None left: they moved to SQL tables.)
 *   mode 'legacy'  a document nothing writes any more; it is only READ by a one-time migration / legacy import
 *                  (e.g. the log documents now stored in the services/logTables.js tables, kept untouched as the
 *                  rollback path). test/lib/docAccessGuard.test.js forbids writing it and names the allowed readers.
 *
 *   owner          which process writes it at runtime: 'web' (index.js), 'worker' (worker.js) or 'both'.
 *   writers        the modules that write it (verified call paths, see the Phase 0 report).
 *
 * test/lib/docAccessGuard.test.js enforces this: a writeDataSync( on a 'mutate' / 'log' key outside lib/db.js and
 * lib/docStore.js, or a written key without an entry here, fails the suite. New documents must be registered.
 */

const ENTRIES = [
    // ---- multi-writer / async-gap documents: docStore.mutateDocument only --------------------------------------
    { key: 'server_operation/server_cmdb_meta.json', mode: 'mutate', owner: 'both', description: 'Server List CMDB metadata per IP',
        writers: ['lib/cmdbMetaStore.js (routes/serverList.js, lib/vipLinkageHelper.js, services/cmdbModel.js, services/dnsScheduler.js, services/serverDeletion.js, services/environmentMigration.js, services/environmentUsage.js)'],
        notes: 'worker: DNS export FQDN sync, post-scan VIP reconcile, deleted-IP revive inside bulkUpsertCmdbServers; web: every Server List edit' },
    { key: 'server_operation/cmdb_field_authority.json', mode: 'mutate', owner: 'web', description: 'CMDB field authority / sync rules',
        writers: ['services/cmdbModel.js'], notes: 'single writer today; validated whole-object replacement under the document lock' },
    { key: 'server_operation/scheduler_tasks.json', mode: 'mutate', owner: 'both', description: 'Task Scheduler task list',
        writers: ['lib/schedulerStore.js (routes/scheduler.js, services/taskSchedulerService.js)'],
        notes: 'worker cron runs and web "Run now" both record lastRunTime / lastRunStatus' },
    { key: 'prometheus_targets.json', mode: 'mutate', owner: 'both', description: 'Prometheus file_sd targets',
        writers: ['lib/prometheusTargetHelper.js'], notes: 'in-process queue + cross-process mutateDocument; health scan merges probe fields only' },
    { key: 'prometheus_health_check.json', mode: 'mutate', owner: 'both', description: 'Prometheus health check schedule + lastRun',
        writers: ['services/prometheusScheduler.js'], notes: 'web edits the schedule, scans in web and worker set lastRun' },
    { key: 'service_platform/webhooks.json', mode: 'mutate', owner: 'web', description: 'Integration Hub webhooks',
        writers: ['services/webhookService.js', 'routes/webhooks.js'], notes: 'single writer today (worker only reads); converted as defence' },
    { key: 'system/rbac.json', mode: 'mutate', owner: 'both', description: 'RBAC config (encrypted string document)',
        writers: ['lib/rbac.js', 'routes/rbac.js'], notes: 'routes in web; the built-in SuperAdmin upgrade write can happen in any process that reads it; docStore codec (decode/encode)' },
    { key: 'server_operation/inventory_credential_profiles.json', mode: 'mutate', owner: 'web', description: 'Inventory credential profiles (encrypted passwords)',
        writers: ['lib/inventoryCredentials.js'], notes: 'single writer (web, serialised by runExclusive); converted as defence' },
    { key: 'server_operation/ssh_known_hosts.json', mode: 'mutate', owner: 'both', description: 'SSH host key pins (TOFU)',
        writers: ['lib/sshHostKeys.js'], notes: 'pins on first sight in whichever process connects (worker scans, web deploy / remote)' },
    { key: 'system/alert_quality.json', mode: 'mutate', owner: 'web', description: 'Alert quality settings',
        writers: ['services/alertQualityConfig.js'], notes: 'single writer (web); validated whole-object replacement under the document lock' },
    { key: 'network_service/snmp_settings.json', mode: 'mutate', owner: 'web', description: 'SNMP settings per network device (encrypted secrets)',
        writers: ['routes/networkDevice.js', 'lib/rackDeviceSync.js'], notes: 'two web modules; per-device changes on the current document' },
    { key: 'dns_data.json', mode: 'mutate', owner: 'web', description: 'DNS Hub servers + export schedule',
        writers: ['lib/dnsDataStore.js (routes/servers.js, routes/records.js)'], notes: 'async gap: zone cache update awaited PowerShell between read and whole-document write' },
    { key: 'service_platform_elk_violations.json', mode: 'mutate', owner: 'both', description: 'ELK lifecycle violation scan state + config',
        writers: ['services/elkLifecycleScheduler.js', 'routes/elk.js'], notes: 'worker scheduled scan, web on-demand scan / config / delete; scan results merged after the awaited ES queries' },
    { key: 'server_operation/oscheck/config.json', mode: 'mutate', owner: 'both', description: 'Server Inventory settings',
        writers: ['services/inventoryScheduler.js (mutateConfig, writeJson)', 'routes/inventory.js'], notes: 'web settings save had a read -> await -> write gap; worker writes lastScan / lastDiscovered' },
    { key: 'data_center/contracts.json', mode: 'mutate', owner: 'web', description: 'Contracts & warranties',
        writers: ['routes/rack.js'], notes: 'async gap: upload awaited the ClamAV scan between read and write' },
    { key: 'network_service/ipam/subnets.json', mode: 'mutate', owner: 'both', description: 'IPAM subnets', writers: ['lib/ipamStore.js'], notes: 'converted earlier' },
    { key: 'network_service/ssl_certificates.json', mode: 'mutate', owner: 'both', description: 'SSL monitor certificates', writers: ['services/sslMonitorService.js'], notes: 'converted earlier' },
    { key: 'network_service/ssl_scan_lock.json', mode: 'mutate', owner: 'both', description: 'SSL scan lease', writers: ['services/sslMonitorService.js'], notes: 'converted earlier' },

    // ---- former append-only log documents: now SQL tables (services/logTables.js); read only by its migration ----
    { key: 'server_operation/server_cmdb_history.json', mode: 'legacy', owner: 'both', description: 'CMDB change history (newest first) -> table cmdb_history',
        writers: [], readers: ['services/logTables.js'], notes: 'table writers: lib/cmdbMetaStore.js appendHistory' },
    { key: 'server_operation/scheduler_logs.json', mode: 'legacy', owner: 'both', description: 'Task Scheduler execution log (oldest first) -> table scheduler_logs',
        writers: [], readers: ['services/logTables.js'], notes: 'table writers: lib/schedulerStore.js appendLog' },
    { key: 'dns_changes.json', mode: 'legacy', owner: 'web', description: 'DNS record change log (newest first) -> table dns_changes',
        writers: [], readers: ['services/logTables.js'], notes: 'table writers: lib/dnsDataStore.js appendDnsChanges' },
    { key: 'workflow_executions.json', mode: 'legacy', owner: 'web', description: 'Workflow executions -> table workflow_executions',
        writers: [], readers: ['services/logTables.js'], notes: 'table writers: lib/workflow.js saveExecution' },
    { key: 'workflow_history.json', mode: 'legacy', owner: 'web', description: 'Workflow version history -> table workflow_history',
        writers: [], readers: ['services/logTables.js'], notes: 'table writers: lib/workflow.js' },
    { key: 'system/log_tables_migration.json', mode: 'replace', owner: 'both', description: 'Log document -> table migration marker (informational: per table migratedAt / count)',
        writers: ['services/logTables.js'], notes: 'merged per table through docStore.mutateDocument; the authoritative marker is log_table_meta in the same database as the tables' },

    // ---- other documents nothing writes any more (read by legacy imports / fallbacks only) ----------------------
    { key: 'server_operation/status_changes.json', mode: 'legacy', owner: 'web', description: 'Old inventory status change list', writers: [], readers: ['services/inventoryHistory.js'], notes: 'read-only' },
    { key: 'server_operation/oscheck/status_changes.json', mode: 'legacy', owner: 'web', description: 'Old inventory status change list (older location)', writers: [], readers: ['services/inventoryHistory.js'], notes: 'read-only' },
    { pattern: 'server_operation/oscheck/data_*.json', mode: 'legacy', owner: 'worker', description: 'Old per-subnet inventory host documents', writers: [], readers: ['services/inventoryStore.js'], notes: 'imported once into inventory_hosts' },
    { key: 'network_service/nas/config.json', mode: 'legacy', owner: 'web', description: 'Old NAS config location', writers: [], readers: ['services/nasDevices.js'], notes: 'read-only fallback' },

    // ---- single-owner snapshots / caches / flags / settings: writeDataSync is fine --------------------------------
    { key: 'workflows.json', mode: 'replace', owner: 'web', description: 'Workflow definitions', writers: ['lib/workflow.js'], notes: 'synchronous read-modify-write, web only' },
    { key: 'workflow_templates.json', mode: 'replace', owner: 'web', description: 'Workflow templates', writers: ['routes/workflow.js'], notes: 'synchronous, web only' },
    { key: 'runbooks.json', mode: 'replace', owner: 'web', description: 'Runbooks', writers: ['routes/runbook.js'], notes: 'synchronous, web only' },
    { key: 'data_center/datacenters.json', mode: 'replace', owner: 'web', description: 'Data centers', writers: ['routes/rack.js'], notes: 'synchronous, web only' },
    { key: 'data_center/hw_issues.json', mode: 'replace', owner: 'web', description: 'Hardware issues', writers: ['routes/rack.js'], notes: 'synchronous, web only' },
    { key: 'data_center/spare_parts.json', mode: 'replace', owner: 'web', description: 'Spare parts', writers: ['routes/rack.js'], notes: 'synchronous, web only' },
    { pattern: 'data_center/server_rack*.json', mode: 'replace', owner: 'web', description: 'Server racks per data center',
        writers: ['lib/rackStore.js'], notes: 'own optimistic revision scheme (rack_revisions.json); synchronous, web only' },
    { key: 'data_center/rack_revisions.json', mode: 'replace', owner: 'web', description: 'Rack document revisions', writers: ['lib/rackStore.js'], notes: 'synchronous, web only' },
    { key: 'service_platform/cmd_library.json', mode: 'replace', owner: 'web', description: 'Command library', writers: ['routes/cmdLibrary.js'], notes: '' },
    { key: 'service_platform/database_clusters.json', mode: 'replace', owner: 'web', description: 'DB inventory',
        writers: ['routes/database.js', 'services/environmentMigration.js', 'services/environmentUsage.js'], notes: 'synchronous, web only' },
    { key: 'service_platform/database_requests.json', mode: 'replace', owner: 'web', description: 'DB requests',
        writers: ['routes/database.js', 'services/environmentMigration.js', 'services/environmentUsage.js'], notes: 'synchronous, web only' },
    { key: 'service_platform/database_backups.json', mode: 'replace', owner: 'web', description: 'DB backup records', writers: ['routes/database.js'], notes: 'read happens after the awaited backup command (no gap)' },
    { key: 'service_platform/k8s_clusters.json', mode: 'replace', owner: 'web', description: 'Kubernetes clusters', writers: ['routes/kubernetes.js'], notes: '' },
    { key: 'service_platform/redis_connections.json', mode: 'replace', owner: 'web', description: 'Redis connections', writers: ['routes/redis.js'], notes: '' },
    { key: 'service_platform/nas_config.json', mode: 'replace', owner: 'web', description: 'NAS devices',
        writers: ['services/nasDevices.js'], notes: 'async fn inside an in-process promise chain (serialised); web only' },
    { key: 'system/ai_config.json', mode: 'replace', owner: 'web', description: 'AI settings', writers: ['routes/ai.js'], notes: '' },
    { key: 'elk_siem_config', mode: 'replace', owner: 'web', description: 'SIEM config', writers: ['routes/siem.js'], notes: '' },
    { key: 'server_operation/ip_switch_map.json', mode: 'replace', owner: 'web', description: 'Nutanix IP -> switch map', writers: ['routes/nutanix.js'], notes: '' },
    { key: 'server_operation/template_bu_map.json', mode: 'replace', owner: 'web', description: 'Nutanix template -> BU map', writers: ['routes/nutanix.js'], notes: '' },
    { key: 'system/environments.json', mode: 'replace', owner: 'web', description: 'Global environments',
        writers: ['routes/environments.js'], notes: 'awaits inside handlers, but every write runs inside the in-process withEnvLock; web only' },
    { key: 'server_operation/hm_checker_config.json', mode: 'replace', owner: 'web', description: 'HM checker settings', writers: ['services/hostMonitorCheckerService.js'], notes: '' },
    { key: 'server_operation/hm_checker_today_cache.json', mode: 'replace', owner: 'web', description: 'HM checker daily result cache', writers: ['services/hostMonitorCheckerService.js'], notes: 'snapshot' },
    { key: 'network_service/netsearch_cache.json', mode: 'replace', owner: 'both', description: 'NetSearch parsed config cache',
        writers: ['services/netsearchScheduler.js'], notes: 'whole-cache snapshot of in-memory state; last writer wins by design' },
    { key: 'server_operation/inventory_scan_status.json', mode: 'replace', owner: 'worker', description: 'Inventory scan status',
        writers: ['services/inventoryStatus.js'], notes: 'status snapshot written by the scanning worker; web reads the shared DB' },
    { key: 'system/last_backup_result.json', mode: 'replace', owner: 'both', description: 'Last backup status',
        writers: ['services/backupService.js', 'routes/apiSettings.js', 'lib/workerExitHandler.js'], notes: 'status snapshot handed over by requestId (web request -> worker run -> web close-out when the worker died)' },
    { key: 'system/startup_notice.json', mode: 'replace', owner: 'web', description: 'Startup notification throttle', writers: ['lib/startupNotice.js'], notes: 'startup only; the awaited Telegram send precedes a whole-state write' },
    { key: 'system/legacy_targets_import.json', mode: 'replace', owner: 'web', description: 'Legacy targets import marker', writers: ['lib/prometheusTargetHelper.js'], notes: 'startup, before the worker is forked' },
    { key: 'system/cmdb_deleted_flag_migration.json', mode: 'replace', owner: 'web', description: 'Deleted-flag migration marker', writers: ['services/serverDeletion.js'], notes: 'startup marker' },
    { key: 'system/environment_id_migration.json', mode: 'replace', owner: 'web', description: 'Environment id migration marker', writers: ['services/environmentMigration.js'], notes: 'startup marker' },
    { key: 'server_operation/inventory_hosts_migrated.json', mode: 'replace', owner: 'worker', description: 'Inventory hosts migration marker (informational)', writers: ['services/inventoryStore.js'], notes: 'one-time' },
    { pattern: 'agent/conversations/*.json', mode: 'replace', owner: 'web', description: 'AI agent conversations per user', writers: ['lib/agent/conversationStore.js'], notes: 'synchronous, web only' },
    { pattern: '*.revision.json', mode: 'replace', owner: 'both', description: 'docStore fallback revision counters (VFS JSON mode only)',
        writers: ['lib/docStore.js'], notes: 'written only by docStore when there is no local SQLite' },
];

function globToRegExp(glob) {
    return new RegExp('^' + glob.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
}

const BY_KEY = new Map();
const PATTERNS = [];
for (const e of ENTRIES) {
    if (e.key) BY_KEY.set(e.key, e);
    else PATTERNS.push({ re: globToRegExp(e.pattern), entry: e });
}

/** The registry entry of a document key (exact key first, then patterns), or null. */
function getEntry(key) {
    if (typeof key !== 'string' || !key) return null;
    if (BY_KEY.has(key)) return BY_KEY.get(key);
    const hit = PATTERNS.find(p => p.re.test(key));
    return hit ? hit.entry : null;
}

/** 'mutate' | 'replace' | 'log' | 'legacy' for a registered key, null otherwise. */
function modeOf(key) {
    const e = getEntry(key);
    return e ? e.mode : null;
}

// ---- alias keys -------------------------------------------------------------------------------------------------
// Databases imported from the old flat-file layout can hold a document twice: the canonical key
// (network_service/ipam/subnets.json) and a stale alias that differs only in '/' vs '_' (network/service/ipam/subnets.json,
// or the flattened file name network_service_ipam_subnets.json written by the old fs intercept). The app reads only the
// canonical key. Two keys are aliases of each other when they are equal after every '/' and '\' became '_'.

/** The key with every '/' and '\' turned into '_' (the flat file name of a document). */
function flattenKey(key) {
    return String(key).replace(/[\/\\]/g, '_');
}

const FLAT_EXACT = new Map(); // flattened registered key -> registered key
for (const e of ENTRIES) if (e.key) FLAT_EXACT.set(flattenKey(e.key), e.key);
const FLAT_PATTERNS = ENTRIES.filter(e => e.pattern)
    .map(e => new RegExp('^' + flattenKey(e.pattern).split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));

/** true when `key` is a known canonical document key (registered exactly or by pattern). */
function isCanonicalKey(key) {
    return !!getEntry(key);
}

/**
 * true when `key` is NOT registered itself but is a '/' <-> '_' variant of a registered key or pattern, e.g.
 * 'network/service/ipam/subnets.json' or 'network_service_ipam_subnets.json'. Such keys must never be read or written
 * as documents (index.js VFS intercept, scripts/cleanup_doc_aliases.js).
 */
function isAliasKey(key) {
    if (typeof key !== 'string' || !key || getEntry(key)) return false;
    // docStore's VFS revision counters ('<key>.revision.json', any depth) are canonical keys of their own
    if (/\.revision\.json$/i.test(key)) return false;
    const flat = flattenKey(key);
    if (FLAT_EXACT.has(flat)) return true;
    return FLAT_PATTERNS.some(re => re.test(flat));
}

module.exports = { ENTRIES, getEntry, modeOf, flattenKey, isCanonicalKey, isAliasKey };
