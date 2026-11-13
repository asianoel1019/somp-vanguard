// Colours and icons of the Contracts & Warranties page (theme variables).
import { TbShieldCheck, TbHourglassHigh, TbShieldX, TbRefresh, TbHelpCircle, TbLicense } from 'react-icons/tb';

export const CONTRACT_STATUS_META = {
    Active: { tone: 'var(--success)', icon: TbShieldCheck, label: 'Active' },
    Expiring: { tone: 'var(--warning)', icon: TbHourglassHigh, label: 'Expiring soon' },
    Expired: { tone: 'var(--danger)', icon: TbShieldX, label: 'Expired' },
    Renewed: { tone: 'var(--text-muted)', icon: TbRefresh, label: 'Renewed' },
    Unknown: { tone: 'var(--text-muted)', icon: TbHelpCircle, label: 'No end date' },
};

export const TYPE_ICON = { 'Hardware Warranties': TbShieldCheck, 'Software Licenses': TbLicense };

/** Class of the days-left chip. */
export function daysChipClass(left) {
    if (left === null || left === undefined) return 'hw-age';
    if (left < 0) return 'hw-age is-late';
    if (left <= 60) return 'hw-age is-warn';
    return 'hw-age is-good';
}
