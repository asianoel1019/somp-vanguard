import React, { useState } from 'react';
import { TbKey } from 'react-icons/tb';
import { reminderKey, shouldShowReminder, markReminderShown } from '../../utils/licenseUtils.js';
import { LICENSE_CONTACT } from '../../constants/license.js';

const storage = () => { try { return window.localStorage; } catch { return null; } };

// SuperAdmin reminder when the paid license is within 30 days of expiry; shown once per license and threshold.
// Both buttons hide it until the next threshold (Dismiss) or open the License page.
export default function LicenseExpiryReminder({ license, onOpenLicense }) {
    const key = reminderKey(license);
    const [dismissedKey, setDismissedKey] = useState('');
    if (!key || dismissedKey === key || !shouldShowReminder(license, storage())) return null;

    const close = (open) => {
        markReminderShown(license, storage());
        setDismissedKey(key);
        if (open) onOpenLicense();
    };
    const n = license.daysLeft;
    const left = n === 0 ? 'expires today' : n === 1 ? '1 day left' : `${n} days left`;
    return (
        <div role="dialog" aria-modal="true" aria-label="License expiry reminder"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="glass-panel" style={{ width: 460, maxWidth: '90vw', padding: 24, borderRadius: 16 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>License expiring soon</h3>
                <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                    This license ({license.licenseId}, {license.customer}) expires on {license.expiresAt} — {left}. After that date the system switches to the free edition. Contact {LICENSE_CONTACT.vendor} ({LICENSE_CONTACT.email}) to renew.
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-outline" onClick={() => close(false)} title="Hide this reminder until the next one">Dismiss</button>
                    <button type="button" className="btn btn-primary" onClick={() => close(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <TbKey /> Go to License page
                    </button>
                </div>
            </div>
        </div>
    );
}
