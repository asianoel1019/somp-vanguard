const express = require('express');
const router = express.Router();
const { requireAuth, checkRole } = require('../middleware/auth');
const { readDataSync } = require('../lib/db');
const { getAllSubnetData } = require('../services/inventoryStore');

router.use(requireAuth);
router.use(checkRole(['Viewer', 'Operator', 'SuperAdmin']));

router.get('/check', async (req, res) => {
    const { ip, hostname } = req.query;
    
    if (!ip && !hostname) {
        return res.status(400).json({ error: 'Missing ip or hostname query parameter' });
    }
    
    let monitorData = null;
    let inventoryData = null;
    let ipamData = null;
    
    // Check Monitor
    try {
        const db = require('../services/scoutDb');
        if (ip) {
            monitorData = db.get("SELECT * FROM monitors WHERE ip = ?", [String(ip).trim()]) || null;
        } else if (hostname) {
            monitorData = db.get("SELECT * FROM monitors WHERE name = ?", [hostname]) || null;
        }
        if (monitorData) {
            // Helper to format monitor
            const formatMonitor = (m) => {
                m.tags = parseJSON(m.tags, []);
                m.group = m.group_name;
                delete m.group_name;
                m.enabled = m.enabled === 1;
                return m;
            };
            
            // Helper to parse JSON
            function parseJSON(val, def) {
                if (!val) return def;
                try { return JSON.parse(val); } catch(e) { return def; }
            }

            // Get latest metric for this monitor
            const latestMetricRow = db.get("SELECT metrics FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [monitorData.id]);
            monitorData = formatMonitor(monitorData);
            monitorData.lastMetric = latestMetricRow ? parseJSON(latestMetricRow.metrics, null) : null;
        }
    } catch(e) {
        console.error('Error checking monitor in integration.js:', e);
    }
    
    // Check Inventory
    try {
        const inventory = getAllSubnetData() || [];
        if (ip) {
            inventoryData = inventory.find(h => String(h.ip).trim() === String(ip).trim()) || null;
        } else if (hostname) {
            inventoryData = inventory.find(h => h.hostname?.toLowerCase() === hostname.toLowerCase()) || null;
        }
    } catch(e) {}
    
    // Check IPAM
    try {
        const subnets = readDataSync('network_service/ipam/subnets.json', []);
        for (const sub of subnets) {
            if (sub.ips) {
                let rec = null;
                if (ip) {
                    rec = sub.ips.find(x => String(x.address).trim() === String(ip).trim());
                } else if (hostname) {
                    rec = sub.ips.find(x => x.hostname?.toLowerCase() === hostname.toLowerCase() || x.fqdn?.toLowerCase() === hostname.toLowerCase());
                }
                if (rec && rec.status !== 'free') {
                    ipamData = { subnetName: sub.name, cidr: sub.cidr, ...rec };
                    break;
                }
            }
        }
    } catch(e) {}
    
    // Check CMDB Meta
    let cmdbMeta = null;
    try {
        const allMeta = readDataSync('server_operation/server_cmdb_meta.json', {});
        const targetIp = ip || monitorData?.ip || inventoryData?.ip || ipamData?.address;
        if (targetIp) {
            cmdbMeta = allMeta[String(targetIp).trim()] || null;
        }
    } catch(e) {}
    
    res.json({
        monitor: monitorData,
        inventory: inventoryData,
        ipam: ipamData,
        cmdbMeta: cmdbMeta
    });
});

router.get('/summary', async (req, res) => {
    try {
        try {
            const db = require('../services/scoutDb');
            monitorHosts = db.all("SELECT ip FROM monitors") || [];
        } catch(e) {}
        try { inventoryData = getAllSubnetData() || []; } catch(e) {}
        try { ipamSubnets = readDataSync('network_service/ipam/subnets.json', []); } catch(e) {}
        
        const summary = {};
        if (Array.isArray(monitorHosts)) {
            monitorHosts.forEach(h => {
                if(h.ip) {
                    const cleanIp = String(h.ip).trim();
                    summary[cleanIp] = summary[cleanIp] || {};
                    summary[cleanIp].hasMonitor = true;
                }
            });
        }
        if (Array.isArray(inventoryData)) {
            inventoryData.forEach(h => {
                if(h.ip) {
                    const cleanIp = String(h.ip).trim();
                    summary[cleanIp] = summary[cleanIp] || {};
                    summary[cleanIp].hasInventory = true;
                }
            });
        }
        if (Array.isArray(ipamSubnets)) {
            ipamSubnets.forEach(sub => {
                if(Array.isArray(sub.ips)) {
                    sub.ips.forEach(ip => {
                        if(ip.status !== 'free' && ip.address) {
                            const cleanIp = String(ip.address).trim();
                            summary[cleanIp] = summary[cleanIp] || {};
                            summary[cleanIp].hasIpam = true;
                        }
                    });
                }
            });
        }
        res.json(summary);
    } catch(err) {
        console.error('Integration summary API error:', err);
        res.json({});
    }
});

module.exports = router;
