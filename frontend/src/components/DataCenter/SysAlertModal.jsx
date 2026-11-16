import { dialogStyles } from './rackDialogStyles';

// Message dialog of the Server Rack screen. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function SysAlertModal({ sysAlert, setSysAlert }) {
  const s = dialogStyles;
  return (
        <div style={s.modalOverlay}>
          <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }}>
            <h3 style={{ fontSize: 18, marginBottom: 16 }}>Notice</h3>
            <p style={{ marginBottom: 24, color: 'var(--text-secondary)' }}>{sysAlert.message}</p>
            <button style={s.btnPrimary} onClick={() => setSysAlert(null)}>OK</button>
          </div>
        </div>
  );
}
