import { dialogStyles } from './rackDialogStyles';

// Confirmation dialog of the Server Rack screen. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function SysConfirmModal({ sysConfirm, setSysConfirm }) {
  const s = dialogStyles;
  return (
        <div style={s.modalOverlay}>
          <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }}>
            <h3 style={{ fontSize: 18, marginBottom: 16 }}>Confirm Action</h3>
            <p style={{ marginBottom: 24, color: 'var(--text-secondary)' }}>{sysConfirm.message}</p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
              <button style={{ ...s.btnPrimary, background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }} onClick={() => setSysConfirm(null)}>Cancel</button>
              <button style={{ ...s.btnPrimary, background: 'var(--danger)' }} onClick={() => { sysConfirm.onConfirm(); setSysConfirm(null); }}>Confirm</button>
            </div>
          </div>
        </div>
  );
}
