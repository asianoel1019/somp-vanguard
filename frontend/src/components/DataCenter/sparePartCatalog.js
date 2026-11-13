// Catalog of common data center spare parts, for picking instead of typing. Generic specifications only: vendor part
// numbers differ by brand and generation, so the brand and part number are filled in per item.
// Each entry: { category, name, spec, minStock } (minStock = a suggested minimum for a small to medium site).

export const DEFAULT_CATEGORIES = [
    'Memory', 'SSD', 'NVMe', 'HDD', 'Boot / Flash', 'RAID / HBA', 'Network Card', 'FC HBA', 'Transceiver', 'Cable',
    'Power Supply', 'Fan', 'Server Parts', 'UPS / Power',
];

export const VENDORS = [
    'Dell', 'HPE', 'Lenovo', 'Cisco', 'Supermicro', 'Huawei', 'Inspur', 'Juniper', 'Aruba', 'Fortinet', 'NetApp',
    'Broadcom', 'Intel', 'NVIDIA (Mellanox)', 'Samsung', 'Micron', 'Kingston', 'Seagate', 'Western Digital', 'APC', 'Eaton', 'Generic',
];

const E = (category, name, spec, minStock = 1) => ({ category, name, spec, minStock });

const memory = [
    ...[16, 32, 64].map(g => E('Memory', `${g}GB DDR4-2933 RDIMM`, `DDR4 2933 MT/s, registered ECC, ${g === 16 ? '1Rx8' : g === 32 ? '2Rx8' : '2Rx4'}, 1.2V`, 2)),
    ...[16, 32, 64].map(g => E('Memory', `${g}GB DDR4-3200 RDIMM`, `DDR4 3200 MT/s, registered ECC, ${g === 16 ? '1Rx8' : g === 32 ? '2Rx8' : '2Rx4'}, 1.2V`, 2)),
    E('Memory', '128GB DDR4-3200 LRDIMM', 'DDR4 3200 MT/s, load-reduced ECC, 4Rx4', 1),
    ...[16, 32, 64, 96].map(g => E('Memory', `${g}GB DDR5-4800 RDIMM`, `DDR5 4800 MT/s, registered ECC, ${g <= 16 ? '1Rx8' : '2Rx8 / 2Rx4'}, 1.1V`, 2)),
    ...[32, 64, 96, 128].map(g => E('Memory', `${g}GB DDR5-5600 RDIMM`, `DDR5 5600 MT/s, registered ECC, 1.1V`, 2)),
    E('Memory', '16GB DDR4-2666 UDIMM ECC', 'DDR4 2666 MT/s, unbuffered ECC (entry servers / workstations)', 1),
];

const ssd = [
    ...['480GB', '960GB', '1.92TB', '3.84TB', '7.68TB'].map(c => E('SSD', `${c} SATA SSD 2.5" read intensive`, `SATA 6Gb/s, 2.5", ~1 DWPD, hot-plug tray`, c === '7.68TB' ? 1 : 2)),
    ...['480GB', '960GB', '1.92TB', '3.84TB'].map(c => E('SSD', `${c} SATA SSD 2.5" mixed use`, `SATA 6Gb/s, 2.5", ~3 DWPD, hot-plug tray`, 1)),
    ...['800GB', '960GB', '1.6TB', '1.92TB', '3.84TB'].map(c => E('SSD', `${c} SAS SSD 2.5" 12G`, `SAS 12Gb/s, 2.5", dual port, hot-plug tray`, 1)),
];

const nvme = [
    ...['1.92TB', '3.84TB', '7.68TB', '15.36TB'].map(c => E('NVMe', `${c} NVMe U.2 read intensive`, 'PCIe Gen4 x4, U.2 2.5" 15mm, ~1 DWPD, hot-plug', c === '15.36TB' ? 1 : 2)),
    ...['1.6TB', '3.2TB', '6.4TB'].map(c => E('NVMe', `${c} NVMe U.2 mixed use`, 'PCIe Gen4 x4, U.2 2.5", ~3 DWPD, hot-plug', 1)),
    ...['1.92TB', '3.84TB', '7.68TB'].map(c => E('NVMe', `${c} NVMe U.3 Gen4`, 'PCIe Gen4 x4, U.3 (tri-mode bays), hot-plug', 1)),
    ...['3.84TB', '7.68TB'].map(c => E('NVMe', `${c} NVMe E3.S Gen5`, 'PCIe Gen5 x4, EDSFF E3.S 1T, hot-plug', 1)),
    E('NVMe', '960GB NVMe M.2 22110', 'PCIe Gen4, M.2 22110, power loss protection', 1),
];

const hdd = [
    ...['1.2TB', '1.8TB', '2.4TB'].map(c => E('HDD', `${c} SAS 10K 2.5"`, 'SAS 12Gb/s, 10,000 rpm, 2.5" (SFF), hot-plug tray', 2)),
    E('HDD', '900GB SAS 15K 2.5"', 'SAS 12Gb/s, 15,000 rpm, 2.5" (SFF), hot-plug tray', 1),
    ...['4TB', '8TB', '12TB', '16TB', '20TB', '24TB'].map(c => E('HDD', `${c} NL-SAS 7.2K 3.5"`, 'SAS 12Gb/s, 7,200 rpm, 3.5" (LFF), 512e, hot-plug tray', c === '24TB' ? 1 : 2)),
    ...['4TB', '8TB', '16TB'].map(c => E('HDD', `${c} SATA 7.2K 3.5"`, 'SATA 6Gb/s, 7,200 rpm, 3.5" (LFF), enterprise class', 1)),
];

const boot = [
    E('Boot / Flash', 'BOSS card with 2x 480GB M.2', 'Boot optimized storage, hardware RAID 1, 2x M.2 SATA/NVMe', 1),
    E('Boot / Flash', 'M.2 boot SSD 240GB', 'M.2 2280 SATA / NVMe boot drive', 2),
    E('Boot / Flash', 'M.2 boot SSD 480GB', 'M.2 2280 SATA / NVMe boot drive', 2),
    E('Boot / Flash', 'Dual SD / microSD hypervisor module', 'Mirrored SD boot module (legacy hypervisor boot)', 1),
    E('Boot / Flash', '32GB SD card (industrial)', 'Industrial-grade SD for boot modules', 2),
    E('Boot / Flash', 'USB boot drive 32GB', 'Internal USB 3.0 boot device', 1),
];

const raid = [
    E('RAID / HBA', 'RAID controller 12G SAS 8i 4GB cache', '12Gb/s SAS/SATA, 8 internal ports, RAID 0/1/5/6/10/50/60, flash-backed cache', 1),
    E('RAID / HBA', 'RAID controller 12G SAS 16i 8GB cache', '12Gb/s SAS/SATA, 16 internal ports, flash-backed cache', 1),
    E('RAID / HBA', 'Tri-mode RAID controller 24G 8i', 'SAS4 24Gb/s / SATA / NVMe, 8 internal ports', 1),
    E('RAID / HBA', 'HBA 12G SAS 8i (IT mode)', '12Gb/s SAS/SATA pass-through, 8 internal ports', 1),
    E('RAID / HBA', 'HBA 12G SAS 8e external', '12Gb/s SAS, 2x external mini-SAS HD (JBOD / tape)', 1),
    E('RAID / HBA', 'RAID cache battery / supercapacitor', 'Backup unit for the RAID cache module', 2),
    E('RAID / HBA', 'RAID cache module 4GB', 'Flash-backed write cache module', 1),
];

const nic = [
    E('Network Card', '1GbE 4-port RJ45 NIC', '4x 1000BASE-T, PCIe', 1),
    E('Network Card', '10GbE 2-port SFP+ NIC', '2x 10G SFP+, PCIe Gen3 (Intel X710 / Broadcom 57412 class)', 2),
    E('Network Card', '10GBASE-T 2-port NIC', '2x 10GBASE-T RJ45, PCIe', 1),
    E('Network Card', '25GbE 2-port SFP28 NIC', '2x 25G SFP28, PCIe Gen3/4 (ConnectX-4 Lx / -6 Lx, E810 class)', 2),
    E('Network Card', '25GbE 4-port SFP28 NIC', '4x 25G SFP28, PCIe Gen4', 1),
    E('Network Card', '100GbE 2-port QSFP28 NIC', '2x 100G QSFP28, PCIe Gen4 x16 (ConnectX-5/6 class)', 1),
    E('Network Card', 'OCP 3.0 25GbE 2-port', 'OCP NIC 3.0 SFF, 2x 25G SFP28', 1),
    E('Network Card', 'OCP 3.0 10GbE 4-port', 'OCP NIC 3.0 SFF, 4x 10G SFP+ / RJ45', 1),
    E('Network Card', 'Rack network daughter card (rNDC / FlexLOM)', 'Vendor-specific LOM, match the server model', 1),
];

const fc = [
    E('FC HBA', '16Gb FC HBA single port', '1x 16G FC SFP+, PCIe (QLogic / Emulex class)', 1),
    E('FC HBA', '16Gb FC HBA dual port', '2x 16G FC SFP+, PCIe', 1),
    E('FC HBA', '32Gb FC HBA single port', '1x 32G FC SFP28, PCIe Gen3/4', 1),
    E('FC HBA', '32Gb FC HBA dual port', '2x 32G FC SFP28, PCIe Gen3/4', 1),
    E('FC HBA', '16Gb FC SFP+ SW transceiver', '16G FC short wave 850nm, LC, MMF', 2),
    E('FC HBA', '32Gb FC SFP28 SW transceiver', '32G FC short wave 850nm, LC, MMF', 2),
];

const optics = [
    E('Transceiver', 'SFP 1G SX', '1000BASE-SX, 850nm, LC, MMF up to 550m', 4),
    E('Transceiver', 'SFP 1G LX', '1000BASE-LX, 1310nm, LC, SMF up to 10km', 2),
    E('Transceiver', 'SFP 1G RJ45 (1000BASE-T)', 'Copper SFP, RJ45, up to 100m', 2),
    E('Transceiver', 'SFP+ 10G SR', '10GBASE-SR, 850nm, LC, MMF OM3 300m / OM4 400m', 6),
    E('Transceiver', 'SFP+ 10G LR', '10GBASE-LR, 1310nm, LC, SMF up to 10km', 2),
    E('Transceiver', 'SFP+ 10GBASE-T (RJ45)', 'Copper SFP+, RJ45, up to 30m', 2),
    E('Transceiver', 'SFP28 25G SR', '25GBASE-SR, 850nm, LC, MMF OM4 100m', 6),
    E('Transceiver', 'SFP28 25G LR', '25GBASE-LR, 1310nm, LC, SMF up to 10km', 2),
    E('Transceiver', 'QSFP+ 40G SR4', '40GBASE-SR4, MPO-12, MMF OM4 150m', 2),
    E('Transceiver', 'QSFP+ 40G LR4', '40GBASE-LR4, LC, SMF up to 10km', 1),
    E('Transceiver', 'QSFP28 100G SR4', '100GBASE-SR4, MPO-12, MMF OM4 100m', 2),
    E('Transceiver', 'QSFP28 100G LR4', '100GBASE-LR4, LC, SMF up to 10km', 1),
    E('Transceiver', 'QSFP28 100G CWDM4', '100G CWDM4, LC, SMF up to 2km', 1),
    E('Transceiver', 'QSFP28 100G DR / FR', '100G single lambda, LC, SMF 500m / 2km', 1),
    E('Transceiver', 'QSFP-DD 400G DR4', '400GBASE-DR4, MPO-12, SMF 500m', 1),
    E('Transceiver', 'QSFP-DD 400G FR4', '400G FR4, LC, SMF up to 2km', 1),
];

const lens = (list) => list.map(m => (m < 1 ? `${m * 100}cm` : `${m}m`));
const cable = [
    ...lens([1, 3, 5]).map(l => E('Cable', `DAC 10G SFP+ ${l}`, `Passive direct attach copper, SFP+ to SFP+, ${l}`, 4)),
    ...lens([1, 3, 5]).map(l => E('Cable', `DAC 25G SFP28 ${l}`, `Passive direct attach copper, SFP28 to SFP28, ${l}`, 4)),
    ...lens([1, 3]).map(l => E('Cable', `DAC 100G QSFP28 ${l}`, `Passive direct attach copper, QSFP28 to QSFP28, ${l}`, 2)),
    E('Cable', 'Breakout DAC 100G QSFP28 to 4x 25G SFP28 3m', 'QSFP28 to 4x SFP28 passive copper, 3m', 1),
    E('Cable', 'Breakout DAC 40G QSFP+ to 4x 10G SFP+ 3m', 'QSFP+ to 4x SFP+ passive copper, 3m', 1),
    ...lens([3, 10]).map(l => E('Cable', `AOC 25G SFP28 ${l}`, `Active optical cable, SFP28, ${l}`, 1)),
    ...lens([3, 10]).map(l => E('Cable', `AOC 100G QSFP28 ${l}`, `Active optical cable, QSFP28, ${l}`, 1)),
    ...lens([1, 2, 3, 5, 10, 15]).map(l => E('Cable', `Fiber LC-LC OM4 duplex ${l}`, `Multimode OM4 50/125, LC/UPC to LC/UPC, duplex, ${l}`, 4)),
    ...lens([1, 3, 5, 10]).map(l => E('Cable', `Fiber LC-LC OM3 duplex ${l}`, `Multimode OM3 50/125, LC/UPC to LC/UPC, duplex, ${l}`, 2)),
    ...lens([1, 3, 5, 10]).map(l => E('Cable', `Fiber LC-LC OS2 duplex ${l}`, `Singlemode OS2 9/125, LC/UPC to LC/UPC, duplex, ${l}`, 2)),
    ...lens([3, 10]).map(l => E('Cable', `Fiber MPO-12 OM4 trunk ${l}`, `MPO-12 female to female, OM4, type B, ${l}`, 1)),
    ...lens([0.5, 1, 2, 3, 5]).map(l => E('Cable', `Cat6 patch cable ${l}`, `Cat6 UTP, RJ45, snagless, ${l}`, 10)),
    ...lens([1, 2, 3, 5]).map(l => E('Cable', `Cat6A patch cable ${l}`, `Cat6A S/FTP, RJ45, 10GBASE-T rated, ${l}`, 6)),
    ...lens([1, 2]).map(l => E('Cable', `Power cord C13-C14 ${l}`, `IEC C13 to C14, 10A, ${l}`, 6)),
    ...lens([1, 2]).map(l => E('Cable', `Power cord C19-C20 ${l}`, `IEC C19 to C20, 16A, ${l}`, 4)),
    E('Cable', 'Power cord C13 to Type B (TW/US) 1.8m', 'IEC C13 to NEMA 5-15P, 10A, 1.8m', 2),
    E('Cable', 'Console cable RJ45 to DB9', 'Rollover console cable, RJ45 to DB9 female', 2),
    E('Cable', 'USB-C / USB to RJ45 console adapter', 'USB serial console adapter for network devices', 1),
    E('Cable', 'Mini-SAS HD cable SFF-8643', 'Internal mini-SAS HD (SFF-8643) to SFF-8643, 0.8m', 1),
    E('Cable', 'External SAS cable SFF-8644 2m', 'External mini-SAS HD (SFF-8644), 2m', 1),
];

const psu = [
    ...[495, 550, 800, 1100, 1400, 1600, 2400].map(w => E('Power Supply', `Server PSU ${w}W hot-plug`, `${w}W AC hot-plug, 80 PLUS ${w >= 1400 ? 'Titanium / Platinum' : 'Platinum'}, match the server model`, 2)),
    E('Power Supply', 'Server PSU 1100W -48V DC', '1100W -48V DC hot-plug', 1),
    E('Power Supply', 'Switch PSU 350W AC (front to back)', 'Network switch power module, port-side exhaust / intake as installed', 1),
    E('Power Supply', 'Switch PSU 715W / 1100W PoE', 'PoE-capable switch power module', 1),
    E('Power Supply', 'Storage controller enclosure PSU', 'Disk array / shelf power supply, match the model', 1),
];

const fan = [
    E('Fan', 'Server system fan (standard)', 'Hot-plug fan module, match the server model', 2),
    E('Fan', 'Server system fan (high performance)', 'Hot-plug high-performance fan for GPU / dense configurations', 2),
    E('Fan', 'Switch fan tray (front to back)', 'Network switch fan module, airflow as installed', 1),
    E('Fan', 'Switch fan tray (back to front)', 'Network switch fan module, reverse airflow', 1),
    E('Fan', 'Storage shelf fan module', 'Disk array / shelf cooling module', 1),
    E('Fan', 'Chassis / blade enclosure fan', 'Blade or multi-node chassis fan', 1),
];

const serverParts = [
    E('Server Parts', '2.5" drive tray / caddy', 'Hot-plug carrier for 2.5" drives, match the server generation', 4),
    E('Server Parts', '3.5" drive tray / caddy', 'Hot-plug carrier for 3.5" drives, match the server generation', 4),
    E('Server Parts', 'Drive blank 2.5"', 'Filler for empty 2.5" bays (airflow)', 4),
    E('Server Parts', 'PCIe riser card', 'Riser for the server model (x8 / x16 slots)', 1),
    E('Server Parts', 'Rail kit (sliding)', 'Sliding ready rails for 1U / 2U servers', 1),
    E('Server Parts', 'Cable management arm', 'Arm for 1U / 2U servers', 1),
    E('Server Parts', 'CMOS battery CR2032', '3V lithium coin cell', 6),
    E('Server Parts', 'Thermal paste / pad', 'For CPU heatsink re-seating', 2),
    E('Server Parts', 'CPU heatsink', 'Standard / high-performance heatsink, match the server model', 1),
    E('Server Parts', 'TPM 2.0 module', 'Trusted platform module, match the server model', 1),
    E('Server Parts', 'Front bezel with lock', 'Server front bezel', 1),
    E('Server Parts', 'BMC / management module', 'iDRAC / iLO / XClarity daughter or chassis management module', 1),
];

const ups = [
    E('UPS / Power', 'UPS battery 12V 7Ah', 'Sealed lead acid VRLA, F2 terminals', 4),
    E('UPS / Power', 'UPS battery 12V 9Ah', 'Sealed lead acid VRLA, F2 terminals', 4),
    E('UPS / Power', 'UPS battery pack (rack)', 'Replacement battery cartridge for rack UPS, match the model', 1),
    E('UPS / Power', 'Rack PDU basic 1U 8x C13', 'Basic PDU, 8x C13, 16A', 1),
    E('UPS / Power', 'Rack PDU metered 0U 24x C13 + 6x C19', 'Metered vertical PDU, 32A', 1),
    E('UPS / Power', 'Rack automatic transfer switch (ATS)', 'Rack ATS for single-corded devices, 16A', 1),
    E('UPS / Power', 'UPS network management card', 'SNMP / web management card, match the UPS model', 1),
];

export const SPARE_CATALOG = [
    ...memory, ...ssd, ...nvme, ...hdd, ...boot, ...raid, ...nic, ...fc, ...optics, ...cable, ...psu, ...fan, ...serverParts, ...ups,
].map((e, idx) => ({ ...e, key: `cat-${idx}` }));

/** Catalog entries of a category (or all) matching the words of the search, in catalog order. */
export function searchCatalog(category = 'ALL', q = '') {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return SPARE_CATALOG.filter(e => (category === 'ALL' || e.category === category)
        && words.every(w => `${e.name} ${e.spec} ${e.category}`.toLowerCase().includes(w)));
}

/** Catalog counts per category. */
export function catalogCounts() {
    const out = {};
    for (const e of SPARE_CATALOG) out[e.category] = (out[e.category] || 0) + 1;
    return out;
}
