// Inline styles of the small Server Rack dialogs (alert, confirm, port status).
export const dialogStyles = {
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, boxShadow: '0 10px 25px rgba(0,0,0,0.5)' },
  btnPrimary: { background: 'var(--accent-primary)', color: '#000', border: 'none', padding: '8px 24px', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer' },
  portGrid: (cols) => ({ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10 })
};
