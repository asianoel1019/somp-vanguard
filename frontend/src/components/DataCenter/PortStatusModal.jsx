import { dialogStyles } from './rackDialogStyles';

// Read-only view of the ports of a device. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function PortStatusModal({ setShowPortStatusModal, portStatusDevice }) {
  const s = dialogStyles;
  return (
        <div className="modal-overlay" onClick={() => setShowPortStatusModal(false)} style={{ zIndex: 9999 }}>
          <div className="modal-content glass-panel" style={{ width: '80%', maxWidth: '800px', height: 'auto', maxHeight: '80vh', padding: '2rem', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '1rem' }}>
              <h2 style={{ color: 'var(--accent-primary)', margin: 0, fontSize: '1.5rem' }}>
                {portStatusDevice.hostname || portStatusDevice.type} - Port Status
              </h2>
              <button onClick={() => setShowPortStatusModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '28px', lineHeight: 1 }}>&times;</button>
            </div>

            <div style={portStatusDevice && portStatusDevice._actualPorts > 0 ? s.portGrid(Math.min(Math.ceil(portStatusDevice._actualPorts / 2), 12)) : {}}>
              {Array.from({ length: portStatusDevice._actualPorts }).map((_, i) => {
                let label = `P${i + 1}`;
                let isUp = false;
                if (portStatusDevice.livePorts && portStatusDevice.livePorts[i]) {
                  isUp = portStatusDevice.livePorts[i].status === 'Up' || portStatusDevice.livePorts[i].value === '1';
                  label = portStatusDevice.livePorts[i].name || label;
                } else {
                  isUp = !!portStatusDevice.portLinks?.[i];
                }

                let tooltip = label;
                if (portStatusDevice.portLinks?.[i]) {
                  const link = portStatusDevice.portLinks[i];
                  tooltip = `Connected to: ${typeof link === 'object' ? link.target : link}`;
                }
                if (portStatusDevice.livePorts && portStatusDevice.livePorts[i]) {
                  tooltip += ` | SNMP: ${portStatusDevice.livePorts[i].status || portStatusDevice.livePorts[i].value}`;
                }

                return (
                  <div key={i} style={{
                    aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: isUp ? 'rgba(34,197,94,0.1)' : (portStatusDevice.livePorts ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)'),
                    border: `1px solid ${isUp ? 'var(--success)' : (portStatusDevice.livePorts ? 'var(--danger)' : 'rgba(255,255,255,0.2)')}`,
                    borderRadius: '4px', color: isUp ? 'var(--success)' : (portStatusDevice.livePorts ? 'var(--danger)' : '#fff'),
                    fontSize: '11px', fontWeight: 'bold'
                  }} title={tooltip}>
                    {label}
                  </div>
                )
              })}
            </div>
            {portStatusDevice.livePorts && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '1.5rem', textAlign: 'center' }}>
                * SNMP Live Status is active.
              </p>
            )}
          </div>
        </div>
  );
}
