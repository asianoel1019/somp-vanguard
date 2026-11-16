import { TbAlertTriangle, TbExternalLink, TbPencil } from 'react-icons/tb';

// What to do with a clicked device (edit, report an issue, ...). Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function DeviceActionModal({ role, targetRackId, setShowActionModal, currentActionDevice, openEditDevice, openReportForm }) {
  return (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ width: 'max-content', minWidth: '220px', height: 'auto', padding: '2rem' }}>
            <button className="modal-close" onClick={() => setShowActionModal(false)}>×</button>
            <h2 style={{ color: 'var(--accent-primary)', marginBottom: '1.5rem', fontSize: '1.2rem', textAlign: 'center' }}>
              {currentActionDevice.type === 'Reserve' ? 'Reserved Space' : (currentActionDevice.hostname || currentActionDevice.type)}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {role !== 'Viewer' && (
                <button
                  className="btn btn-outline"
                  style={{ justifyContent: 'center', fontSize: '1rem', padding: '0.8rem 1rem' }}
                  onClick={() => {
                    setShowActionModal(false);
                    openEditDevice(targetRackId, currentActionDevice);
                  }}
                >
                  <TbPencil className="rack-ico" />Edit Device
                </button>
              )}

              {currentActionDevice.type !== 'Reserve' && (
                <button
                  className="btn btn-outline"
                  style={{ justifyContent: 'center', fontSize: '1rem', padding: '0.8rem 1rem' }}
                  onClick={() => openReportForm(currentActionDevice, targetRackId)}
                >
                  <TbAlertTriangle className="rack-ico" />Report HW issue
                </button>
              )}

              {currentActionDevice.iloIp && (
                <button
                  className="btn btn-outline"
                  style={{ justifyContent: 'center', fontSize: '1rem', padding: '0.8rem 1rem' }}
                  onClick={() => window.open(`https://${currentActionDevice.iloIp}`, '_blank')}
                >
                  <TbExternalLink className="rack-ico" />Launch iLO
                </button>
              )}

              {['Nutanix', 'BladeChassis'].includes(currentActionDevice.type) && currentActionDevice.isChassis && currentActionDevice.nodes && currentActionDevice.nodes.length > 0 && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1rem' }}>
                  <h4 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Nodes</h4>
                  <ul style={{ listStyle: 'none', padding: 0, fontSize: '0.8rem' }}>
                    {currentActionDevice.nodes.map((n, i) => (
                      <li key={i} style={{ marginBottom: '0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '6px 10px', borderRadius: '6px' }}>
                        <div>
                          <div style={{ fontWeight: 600, color: '#fff' }}>Node {i + 1}: {n.hostname || 'Unknown'}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {n.ip && <span>IP: {n.ip}</span>}
                            {n.sn && <span style={{ marginLeft: 8, color: '#93c5fd' }}>SN: {n.sn}</span>}
                          </div>
                        </div>
                        <button className="btn btn-outline" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }} onClick={() => openReportForm(currentActionDevice, targetRackId, n)}><TbAlertTriangle className="rack-ico" />Report</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
  );
}
