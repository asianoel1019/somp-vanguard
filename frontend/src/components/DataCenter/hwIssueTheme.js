// Colours and icons of the Hardware Issues page (theme variables).
import { TbAlertTriangle, TbProgress, TbCircleCheck } from 'react-icons/tb';

export const URGENCY_TONE = { H: 'var(--danger)', M: 'var(--warning)', L: 'var(--success)' };

export const STATUS_META = {
    Open: { tone: 'var(--danger)', icon: TbAlertTriangle },
    Processing: { tone: 'var(--accent-primary)', icon: TbProgress },
    Closed: { tone: 'var(--success)', icon: TbCircleCheck },
};

/** Colour of a timeline entry by its status label. */
export function entryTone(status) {
    return (STATUS_META[status] && STATUS_META[status].tone) || 'var(--text-secondary)';
}
