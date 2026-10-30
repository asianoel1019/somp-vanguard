const db = require('./scoutDb');
const crypto = require('crypto');

// Native OS time polling engine to avoid timezone issues
// Runs every 60 seconds, checking if it is exactly midnight (or a specific hour) to generate reports
function initSiemScheduler() {
    console.log('[SIEM Scheduler] Initialized native local time polling engine.');
    
    setInterval(() => {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();

        // Run daily report at 23:59
        if (hours === 23 && minutes === 59) {
            generateDailyReport();
        }
    }, 60 * 1000); // Check every minute
}

function generateDailyReport() {
    console.log('[SIEM Scheduler] Generating daily SIEM report...');
    try {
        const endTime = new Date().toISOString();
        const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24 hours ago

        // LIMIT to prevent RangeError: Invalid string length when JSON.stringify on massive datasets
        const winEvents = db.all("SELECT * FROM windows_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 5000", [startTime, endTime]);
        const linLogs = db.all("SELECT * FROM linux_logs WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 5000", [startTime, endTime]);

        const reportContent = JSON.stringify({
            summary: {
                totalWindowsEvents: winEvents.length,
                totalLinuxLogs: linLogs.length
            },
            windowsEvents: winEvents,
            linuxLogs: linLogs
        });

        const id = crypto.randomUUID();
        
        db.run("INSERT INTO siem_reports (id, reportType, startTime, endTime, content, timestamp) VALUES (?,?,?,?,?,?)",
            [id, 'DailyScheduled', startTime, endTime, reportContent, new Date().toISOString()]);

        console.log(`[SIEM Scheduler] Daily report ${id} generated successfully.`);
    } catch (error) {
        console.error('[SIEM Scheduler] Failed to generate report:', error);
    }
}

module.exports = { initSiemScheduler };
