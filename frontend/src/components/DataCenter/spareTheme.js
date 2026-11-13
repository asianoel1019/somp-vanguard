// Colours and icons of the Spare Parts page (theme variables).
import {
    TbCircleCheck, TbAlertTriangle, TbCircleX, TbCpu, TbDeviceSdCard, TbDatabase, TbDisc, TbStack2, TbServer, TbNetwork,
    TbRoute, TbPlug, TbBolt, TbPropeller, TbTool, TbBattery3, TbBox, TbPackageImport, TbPackageExport, TbClipboardCheck,
} from 'react-icons/tb';

export const SPARE_STATUS_META = {
    OK: { tone: 'var(--success)', icon: TbCircleCheck, label: 'In stock' },
    Low: { tone: 'var(--warning)', icon: TbAlertTriangle, label: 'Low' },
    Out: { tone: 'var(--danger)', icon: TbCircleX, label: 'Out of stock' },
};

const CATEGORY_ICONS = {
    Memory: TbCpu, RAM: TbCpu, SSD: TbDeviceSdCard, NVMe: TbDeviceSdCard, HDD: TbDisc, 'Boot / Flash': TbDeviceSdCard,
    'RAID / HBA': TbStack2, 'Network Card': TbNetwork, 'FC HBA': TbRoute, Transceiver: TbRoute, Cable: TbPlug,
    'Power Supply': TbBolt, Fan: TbPropeller, 'Server Parts': TbServer, 'UPS / Power': TbBattery3, Storage: TbDatabase,
};

/** Icon of a category (a box for categories of the user's own). */
export const categoryIcon = (name) => CATEGORY_ICONS[name] || TbBox;

/** Look of a history entry: IN green, OUT by reason, COUNT accent. */
export function movementMeta(h) {
    if (h.type === 'IN') return { tone: 'var(--success)', icon: TbPackageImport, label: `In · ${h.reason || 'Purchase'}` };
    if (h.type === 'COUNT') return { tone: 'var(--accent-primary)', icon: TbClipboardCheck, label: 'Stock count' };
    const tone = h.reason === 'Scrapped' ? 'var(--danger)' : h.reason === 'Sent for RMA' ? 'var(--warning)' : 'var(--text-secondary)';
    return { tone, icon: TbPackageExport, label: `Out · ${h.reason || 'Other'}` };
}
