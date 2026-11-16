import { DEVICE_TYPES, getSplitLocation } from './rackShared';
import api from '../../api';
import { canOpenInNetworkDevice, openInNetworkDevice } from '../../utils/networkDeviceLink.js';
import { TbArrowsMove, TbNetwork, TbTrash } from 'react-icons/tb';

// Add / edit a device: detail, ports & cables, power links and SNMP tabs. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function DeviceModal({ role, racks, activeDeviceTab, setActiveDeviceTab, editingPort, setEditingPort, snmpForm, setSnmpForm, setSnmpSavedEnabled, pollData, setPollData, pollLoading, setSysAlert, CABLE_COLORS, currentDevice, setCurrentDevice, targetRackId, targetU, allDevicesInDC, openPortEditor, closeDeviceModal, pollCurrentDevice, snmpLive, openMoveModal, saveDevice, removeDevice, handleNodeChange }) {
  return (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ maxWidth: '700px', height: 'auto', padding: '0', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
            <div style={{ padding: '1.5rem 2rem 0' }}>
              <button className="modal-close" onClick={() => closeDeviceModal()}>×</button>
              <h2 style={{ color: 'var(--accent-primary)', margin: 0 }}>
                {currentDevice.id.startsWith('dev-') && !currentDevice.hostname ? `Add Device at ${getSplitLocation(racks.find(r => r.id === targetRackId), targetU)}` : 'Edit Device'}
              </h2>
              {!(currentDevice.id.startsWith('dev-') && !currentDevice.hostname) && canOpenInNetworkDevice(currentDevice) && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: '0.75rem', padding: '6px 12px', fontSize: '0.85rem' }}
                  title="Status, interfaces, policies and backups of this device (changes not saved here are discarded)"
                  onClick={() => openInNetworkDevice(currentDevice.id)}
                >
                  <TbNetwork className="rack-ico" />Open in Network Device
                </button>
              )}
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', padding: '1rem 2rem 0', marginTop: '1rem' }}>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: activeDeviceTab === 'detail' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'detail' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                  onClick={() => setActiveDeviceTab('detail')}
                >
                  Device Detail
                </button>
                {!['PatchPanel', 'CableManagement', 'Shelf', 'Reserve'].includes(currentDevice.type) && (
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: activeDeviceTab === 'portsCables' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'portsCables' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => {
                      setActiveDeviceTab('portsCables');
                      setEditingPort(null);
                      if (snmpLive && !pollData) pollCurrentDevice();
                    }}
                  >
                    {snmpLive ? 'Live Port Status' : 'Ports & Cables'}
                  </button>
                )}
                {currentDevice.type === 'PowerBar' && (
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: activeDeviceTab === 'powerLinks' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'powerLinks' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => setActiveDeviceTab('powerLinks')}
                  >
                    Power Links
                  </button>
                )}
                {['Switch', 'Router', 'Firewall', 'LoadBalancer', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(currentDevice.type) && (
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: activeDeviceTab === 'snmp' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'snmp' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => setActiveDeviceTab('snmp')}
                  >
                    SNMP Config
                  </button>
                )}
              </div>

              {/* Right Aligned: Move Device Button */}
              {role !== 'Viewer' && currentDevice.id && !(currentDevice.id.startsWith('dev-') && !currentDevice.hostname) && (
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '0.85rem',
                    padding: '0.35rem 0.9rem',
                    borderColor: 'var(--accent-primary)',
                    color: 'var(--accent-primary)',
                    marginBottom: '4px',
                    fontWeight: 'bold',
                    borderRadius: '20px',
                    cursor: 'pointer'
                  }}
                  onClick={openMoveModal}
                  title="Migrate this device to another rack or U slot"
                >
                  <TbArrowsMove /> Move Device
                </button>
              )}
            </div>

            <form onSubmit={saveDevice} style={{ padding: '2rem', overflowY: 'auto', flex: 1 }}>
              {/* --- DETAIL TAB --- */}
              {activeDeviceTab === 'detail' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Device Type</label>
                      <select value={currentDevice.type} onChange={e => {
                        const newType = e.target.value;
                        let defaultPorts = currentDevice.ports || 24;
                        if (['Firewall', 'Router', 'LoadBalancer', 'Server', 'Storage', 'Nutanix', 'BladeChassis', 'NAS', 'TapeLibrary', 'Proxy', 'ISE'].includes(newType)) {
                          defaultPorts = 4;
                        }
                        setCurrentDevice({ ...currentDevice, type: newType, ports: defaultPorts });
                      }}>
                        {['Compute', 'Network', 'Storage', 'Other'].map(cat => (
                          <optgroup key={cat} label={cat}>
                            {DEVICE_TYPES.filter(t => t.category === cat).map(t => (
                              <option key={t.id} value={t.id}>{t.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <div className="form-group flex gap-2">
                      <div style={{ flex: 1 }}>
                        <label>Start U</label>
                        <input required type="number" min="1" value={currentDevice.startU} onChange={e => setCurrentDevice({ ...currentDevice, startU: parseInt(e.target.value) })} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label>Size (U)</label>
                        <input
                          required
                          type="number"
                          min={currentDevice.type === 'PowerBar' && currentDevice.orientation === 'vertical' ? 5 : 1}
                          value={currentDevice.sizeU}
                          onChange={e => setCurrentDevice({ ...currentDevice, sizeU: parseInt(e.target.value) })}
                        />
                      </div>
                    </div>
                  </div>

                  {currentDevice.type === 'Shelf' ? (
                    <div style={{ padding: '2rem', textAlign: 'center', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px dashed rgba(255,255,255,0.2)' }}>
                      <p style={{ color: 'var(--accent-primary)', fontWeight: 'bold', marginBottom: '0.5rem' }}>Structural Shelf (層板)</p>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>This item represents a physical rack shelf. No configuration data is required.</p>
                    </div>
                  ) : currentDevice.type === 'KuaiKuai' ? (
                    <div className="form-group" style={{ padding: '1rem', background: 'rgba(74, 222, 128, 0.05)', borderRadius: '8px', border: '1px solid rgba(74, 222, 128, 0.2)' }}>
                      <label style={{ color: '#4ade80', fontWeight: 'bold' }}>Expiration Date (過期日)</label>
                      <input 
                        required
                        type="date" 
                        value={currentDevice.expiryDate || ''} 
                        onChange={e => setCurrentDevice({ ...currentDevice, expiryDate: e.target.value, hostname: 'Kuai Kuai (乖乖)' })} 
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', padding: '8px', width: '100%' }}
                      />
                      <span style={{ fontSize: 11, color: '#4ade80', marginTop: 8, display: 'block', opacity: 0.9 }}>
                        💡 綠色椰子乖乖小提醒：過期會失去不當機法力，請務必定期更新更換唷！
                      </span>
                    </div>
                  ) : currentDevice.type === 'Reserve' ? (
                    <div className="form-group">
                      <label>Note</label>
                      <input type="text" value={currentDevice.note || ''} onChange={e => setCurrentDevice({ ...currentDevice, note: e.target.value })} placeholder="Reserved for future expansion..." />
                    </div>
                  ) : ['PatchPanel', 'CableManagement'].includes(currentDevice.type) ? (
                    <>
                      <div className="form-group">
                        <label>Device Name</label>
                        <input type="text" value={currentDevice.hostname || ''} onChange={e => setCurrentDevice({ ...currentDevice, hostname: e.target.value })} placeholder="Optional name" />
                      </div>
                      <div className="form-group">
                        <label>Model</label>
                        <input type="text" value={currentDevice.model || ''} onChange={e => setCurrentDevice({ ...currentDevice, model: e.target.value })} placeholder="e.g. APC PDU" />
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Hostname & Model / PDU specs */}
                      {currentDevice.type === 'PowerBar' ? (
                        <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: '1rem' }}>
                          <div className="form-group">
                            <label>PDU Label</label>
                            <input required type="text" value={currentDevice.hostname || ''} onChange={e => setCurrentDevice({ ...currentDevice, hostname: e.target.value })} placeholder="PDU-A-1" />
                          </div>
                          <div className="form-group">
                            <label>Model</label>
                            <input type="text" value={currentDevice.model || ''} onChange={e => setCurrentDevice({ ...currentDevice, model: e.target.value })} placeholder="e.g. APC AP8853" />
                          </div>
                          <div className="form-group">
                            <label>Current (A)</label>
                            <input type="text" value={currentDevice.amps || ''} onChange={e => setCurrentDevice({ ...currentDevice, amps: e.target.value })} placeholder="e.g. 16A / 32A" />
                          </div>
                          <div className="form-group">
                            <label>Voltage (V)</label>
                            <input type="text" value={currentDevice.volts || ''} onChange={e => setCurrentDevice({ ...currentDevice, volts: e.target.value })} placeholder="e.g. 220V / 110V" />
                          </div>
                        </div>
                      ) : (
                        <div className="form-row">
                          <div className="form-group">
                            <label>Hostname</label>
                            <input required type="text" value={currentDevice.hostname || ''} onChange={e => setCurrentDevice({ ...currentDevice, hostname: e.target.value })} placeholder="HQ-SW-01" />
                          </div>
                          <div className="form-group">
                            <label>Model</label>
                            <input type="text" value={currentDevice.model || ''} onChange={e => setCurrentDevice({ ...currentDevice, model: e.target.value })} placeholder="e.g. Cisco C9200" />
                          </div>
                          <div className="form-group">
                            <label>Serial Number</label>
                            <input type="text" value={currentDevice.sn || ''} onChange={e => setCurrentDevice({ ...currentDevice, sn: e.target.value })} placeholder="SN1234567890" />
                          </div>
                        </div>
                      )}

                      {/* IP Addresses */}
                      {currentDevice.type !== 'PowerBar' && !(['Nutanix', 'BladeChassis'].includes(currentDevice.type) && currentDevice.isChassis) && (
                        <div className="form-row" style={{ display: 'grid', gridTemplateColumns: ['Nutanix', 'BladeChassis'].includes(currentDevice.type) ? '1fr 1fr 1fr' : '1fr 1fr', gap: '1rem' }}>
                          <div className="form-group">
                            <label>IP Address</label>
                            <input type="text" value={currentDevice.ip || ''} onChange={e => setCurrentDevice({ ...currentDevice, ip: e.target.value })} placeholder="10.10.10.10" />
                          </div>
                          {['Nutanix', 'BladeChassis'].includes(currentDevice.type) && (
                            <div className="form-group">
                              <label>CVM IP</label>
                              <input type="text" value={currentDevice.cvmIp || ''} onChange={e => setCurrentDevice({ ...currentDevice, cvmIp: e.target.value })} placeholder="10.10.10.10" />
                            </div>
                          )}
                          <div className="form-group">
                            <label>iLO / OOB IP</label>
                            <input type="text" value={currentDevice.iloIp || ''} onChange={e => setCurrentDevice({ ...currentDevice, iloIp: e.target.value })} placeholder="10.10.10.10" />
                          </div>
                        </div>
                      )}

                      {/* Nutanix Chassis */}
                      {['Nutanix', 'BladeChassis'].includes(currentDevice.type) && (
                        <div className="form-row align-items-center" style={{ marginBottom: '1rem', background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '4px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', margin: 0 }}>
                            <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={currentDevice.isChassis || false} onChange={e => setCurrentDevice({ ...currentDevice, isChassis: e.target.checked, nodes: e.target.checked ? Array.from({ length: currentDevice.nodeCount || 1 }).map((_, i) => (currentDevice.nodes && currentDevice.nodes[i]) || { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} }) : [] })} />
                            <span style={{ fontWeight: 'bold', color: 'var(--accent-primary)' }}>Is Chassis (Multi-Node)</span>
                          </label>
                          {currentDevice.isChassis && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '1.5rem' }}>
                              <label style={{ margin: 0 }}>Node Count:</label>
                              <input type="number" min="1" max="4" style={{ width: '80px', padding: '0.2rem 0.5rem', background: 'rgba(0,0,0,0.3)', border: '1px solid #444', color: '#fff' }} value={currentDevice.nodeCount || 1} onChange={e => {
                                const count = parseInt(e.target.value);
                                const nodes = Array.from({ length: count }).map((_, i) => (currentDevice.nodes && currentDevice.nodes[i]) || { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} });
                                setCurrentDevice({ ...currentDevice, nodeCount: count, nodes });
                              }} />
                            </div>
                          )}
                        </div>
                      )}

                      {['Nutanix', 'BladeChassis'].includes(currentDevice.type) && currentDevice.isChassis && (
                        <div style={{ paddingRight: '10px', marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1rem' }}>
                          <h4 style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--accent-primary)', fontSize: '1rem' }}>Chassis Nodes ({currentDevice.nodeCount || 1})</h4>
                          {Array.from({ length: currentDevice.nodeCount || 1 }).map((_, idx) => {
                            const node = (currentDevice.nodes && currentDevice.nodes[idx]) || { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} };
                            return (
                              <div key={idx} style={{ border: '1px solid rgba(255,255,255,0.2)', padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px', background: 'rgba(0,0,0,0.3)' }}>
                                <h4 style={{ marginTop: 0, marginBottom: '0.8rem', color: 'var(--accent-primary)', fontSize: '0.9rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.3rem' }}>Node {idx + 1}</h4>
                                <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>Hostname</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="e.g. NTNX-Node-01" value={node.hostname || ''} onChange={e => handleNodeChange(idx, 'hostname', e.target.value)} />
                                  </div>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>Serial Number (SN)</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="e.g. 19SM12345678" value={node.sn || ''} onChange={e => handleNodeChange(idx, 'sn', e.target.value)} />
                                  </div>
                                </div>
                                <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>IP Address</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="10.10.10.11" value={node.ip || ''} onChange={e => handleNodeChange(idx, 'ip', e.target.value)} />
                                  </div>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>CVM IP</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="10.10.10.21" value={node.cvmIp || ''} onChange={e => handleNodeChange(idx, 'cvmIp', e.target.value)} />
                                  </div>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>iLO / OOB IP</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="10.10.10.31" value={node.iloIp || ''} onChange={e => handleNodeChange(idx, 'iloIp', e.target.value)} />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* --- PORTS & CABLES TAB --- */}
              {activeDeviceTab === 'portsCables' && snmpLive ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ color: 'var(--accent-primary)', margin: 0 }}>Live Port Status (via SNMP)</h3>
                    <button type="button" className="btn btn-outline" disabled={pollLoading} onClick={pollCurrentDevice}>
                      {pollLoading ? 'Polling...' : 'Refresh'}
                    </button>
                  </div>
                  {pollLoading && <p style={{ color: 'var(--text-secondary)' }}>Querying device, please wait...</p>}
                  {!pollLoading && !pollData && <p style={{ color: 'var(--text-secondary)' }}>No data. Click refresh to poll device.</p>}

                  {pollData && (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${pollData.ports.length > 10 ? Math.ceil(pollData.ports.length / 2) : pollData.ports.length}, 1fr)`, gap: '10px' }}>
                        {pollData.ports.map((p, i) => {
                          const isUp = p.status === 'Up' || p.value === '1'; // 1=Up in SNMP
                          return (
                            <div key={i} style={{
                              aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: isUp ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                              border: `1px solid ${isUp ? 'var(--success)' : 'var(--danger)'}`,
                              borderRadius: '4px', color: isUp ? 'var(--success)' : 'var(--danger)',
                              fontSize: '11px', fontWeight: 'bold'
                            }} title={`Port ${p.name || p.port || i + 1} - ${p.speed || 'Unknown'}`}>
                              {p.name || p.port || i + 1}
                            </div>
                          )
                        })}
                      </div>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>Manual Ports & Cables are disabled because SNMP is active. Data is fetched automatically.</p>
                    </div>
                  )}
                </div>
              ) : activeDeviceTab === 'portsCables' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {editingPort ? (
                    <div style={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid var(--accent-primary)', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                      <h3 style={{ marginTop: 0, color: 'var(--accent-primary)' }}>Edit Connection for Port {editingPort.portIndex + 1}</h3>
                      <div className="form-group">
                        <label>Target Device</label>
                        <select
                          value={editingPort.target}
                          onChange={e => setEditingPort({ ...editingPort, target: e.target.value, targetPort: '' })}
                          style={{ width: '100%' }}
                        >
                          <option value="">-- Disconnected --</option>
                          {allDevicesInDC.map(d => (
                            <option key={d.id} value={d.hostname || d.name}>{d.hostname || d.name} ({d.type})</option>
                          ))}
                        </select>
                      </div>

                      {editingPort.target && (() => {
                        const targetDev = allDevicesInDC.find(d => (d.hostname || d.name) === editingPort.target);
                        const tPorts = targetDev ? (targetDev.ports || 0) : 0;
                        return (
                          <div className="form-group">
                            <label>Target Port</label>
                            {tPorts > 0 ? (
                              <select
                                value={editingPort.targetPort}
                                onChange={e => setEditingPort({ ...editingPort, targetPort: e.target.value })}
                                style={{ width: '100%' }}
                              >
                                <option value="">-- Select Port --</option>
                                {Array.from({ length: tPorts }).map((_, i) => (
                                  <option key={i} value={`P${i + 1}`}>P{i + 1}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                placeholder="e.g. Eth1/1"
                                value={editingPort.targetPort}
                                onChange={e => setEditingPort({ ...editingPort, targetPort: e.target.value })}
                                style={{ width: '100%' }}
                              />
                            )}
                          </div>
                        );
                      })()}

                      {editingPort.target && (
                        <div className="form-group">
                          <label>Cable Color</label>
                          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                            {Object.entries(CABLE_COLORS).map(([colorName, colorHex]) => (
                              <div
                                key={colorName}
                                onClick={() => setEditingPort({ ...editingPort, cableColor: colorName })}
                                style={{
                                  width: '30px', height: '30px', borderRadius: '50%', background: colorHex,
                                  cursor: 'pointer', border: editingPort.cableColor === colorName ? '3px solid #fff' : '2px solid transparent',
                                  boxShadow: editingPort.cableColor === colorName ? '0 0 10px rgba(255,255,255,0.5)' : 'none'
                                }}
                                title={colorName}
                              />
                            ))}
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                        <button type="button" className="btn btn-secondary" onClick={() => setEditingPort(null)}>Cancel</button>
                        <button type="button" className="btn btn-primary" onClick={() => {
                          const newLinks = { ...(currentDevice.portLinks || {}) };
                          if (!editingPort.target) {
                            delete newLinks[editingPort.portIndex];
                          } else {
                            newLinks[editingPort.portIndex] = {
                              target: editingPort.target,
                              targetPort: editingPort.targetPort,
                              cableColor: editingPort.cableColor
                            };
                          }
                          setCurrentDevice({ ...currentDevice, portLinks: newLinks });
                          setEditingPort(null);
                        }}>
                          Apply
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="form-group" style={{ background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px', display: 'flex', gap: '2rem' }}>
                        <div>
                          <label style={{ color: 'var(--accent-primary)', fontSize: '1rem', display: 'block', marginBottom: '0.5rem' }}>Total Ports</label>
                          <input type="number" min="0" max="96" value={currentDevice.ports || 0} onChange={e => setCurrentDevice({ ...currentDevice, ports: parseInt(e.target.value) })} style={{ maxWidth: '150px' }} />
                        </div>
                        {['Switch', 'Firewall', 'Router', 'LoadBalancer', 'PatchPanel', 'CableManagement', 'Server', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(currentDevice.type) && (
                          <div>
                            <label style={{ color: 'var(--accent-primary)', fontSize: '1rem', display: 'block', marginBottom: '0.5rem' }}>Rows (Display)</label>
                            <select value={currentDevice.rows || 1} onChange={e => setCurrentDevice({ ...currentDevice, rows: parseInt(e.target.value) })} style={{ maxWidth: '150px' }}>
                              <option value={1}>1 Row</option>
                              <option value={2}>2 Rows</option>
                            </select>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '1rem' }}>
                        {Array.from({ length: currentDevice.ports || 0 }).map((_, pi) => {
                          const link = currentDevice.portLinks?.[pi];
                          let targetHostname = '';
                          let cableColor = 'Blue';
                          let targetPort = '';
                          if (typeof link === 'string') {
                            targetHostname = link;
                          } else if (link && typeof link === 'object') {
                            targetHostname = link.target || '';
                            targetPort = link.targetPort || '';
                            cableColor = link.cableColor || 'Blue';
                          }

                          return (
                            <div key={pi} style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '0.8rem', position: 'relative' }}>
                              <div style={{ fontWeight: 'bold', fontSize: '1.1rem', marginBottom: '0.5rem', color: '#f1f5f9' }}>Port {pi + 1}</div>
                              {targetHostname ? (
                                <div style={{ fontSize: '0.8rem', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: CABLE_COLORS[cableColor] || CABLE_COLORS.Blue, display: 'inline-block' }}></span>
                                    <span>To: <strong>{targetHostname}</strong></span>
                                  </div>
                                  {targetPort && <div>Port: {targetPort}</div>}
                                  <button type="button" onClick={() => openPortEditor(pi, link)} style={{ marginTop: '0.5rem', padding: '0.2rem 0.5rem', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem' }}>Edit Connection</button>
                                </div>
                              ) : (
                                <button type="button" onClick={() => openPortEditor(pi, null)} style={{ padding: '0.4rem 0.8rem', background: 'var(--accent-primary)', border: 'none', color: '#000', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold', width: '100%' }}>+ Connect</button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {/* --- POWER LINKS TAB --- */}
              {activeDeviceTab === 'powerLinks' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {currentDevice.type === 'PowerBar' ? (
                    <>
                      <div className="form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>
                        <div className="form-group">
                          <label>Orientation</label>
                          <select value={currentDevice.orientation || 'horizontal'} onChange={e => setCurrentDevice({ ...currentDevice, orientation: e.target.value })}>
                            <option value="horizontal">Horizontal (Rack Mount)</option>
                            <option value="vertical">Vertical (Side Mount)</option>
                          </select>
                        </div>
                        {currentDevice.orientation === 'vertical' && (
                          <div className="form-group">
                            <label>Side</label>
                            <select value={currentDevice.side || 'left'} onChange={e => setCurrentDevice({ ...currentDevice, side: e.target.value })}>
                              <option value="left">Left Side</option>
                              <option value="right">Right Side</option>
                              <option value="both">Both Sides</option>
                            </select>
                          </div>
                        )}
                        <div className="form-group">
                          <label>Ways (Outlets)</label>
                          <input type="number" min="1" max="42" value={currentDevice.ways || 8} onChange={e => setCurrentDevice({ ...currentDevice, ways: parseInt(e.target.value) })} />
                        </div>
                        <div className="form-group">
                          <label>Rows</label>
                          <select value={currentDevice.rows || 1} onChange={e => setCurrentDevice({ ...currentDevice, rows: parseInt(e.target.value) })}>
                            <option value={1}>1 Row</option>
                            <option value={2}>2 Rows</option>
                            <option value={3}>3 Rows</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label>Current (A)</label>
                          <input type="text" value={currentDevice.amps || ''} onChange={e => setCurrentDevice({ ...currentDevice, amps: e.target.value })} placeholder="e.g. 16A" />
                        </div>
                        <div className="form-group">
                          <label>Voltage (V)</label>
                          <input type="text" value={currentDevice.volts || ''} onChange={e => setCurrentDevice({ ...currentDevice, volts: e.target.value })} placeholder="e.g. 220V" />
                        </div>
                      </div>

                      <div style={{ background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px' }}>
                        <label style={{ color: 'var(--accent-primary)', marginBottom: '1rem', display: 'block', fontWeight: 'bold' }}>Outlet Connections</label>
                        <div style={{ display: 'grid', gridTemplateColumns: currentDevice.rows === 3 ? '1fr 1fr 1fr' : ((currentDevice.rows === 2 || currentDevice.side === 'both') ? '1fr 1fr' : '1fr'), gap: '0.8rem' }}>
                          {(() => {
                            const items = [];
                            const wayCount = currentDevice.ways || 8;
                            if (currentDevice.orientation === 'vertical') {
                              if (currentDevice.side === 'both') {
                                for (let i = 0; i < wayCount; i++) items.push({ key: `L${i}`, label: `Left Way ${i + 1}` });
                                for (let i = 0; i < wayCount; i++) items.push({ key: `R${i}`, label: `Right Way ${i + 1}` });
                              } else if (currentDevice.side === 'right') {
                                for (let i = 0; i < wayCount; i++) items.push({ key: `R${i}`, label: `Way ${i + 1}` });
                              } else {
                                for (let i = 0; i < wayCount; i++) items.push({ key: `L${i}`, label: `Way ${i + 1}` });
                              }
                            } else {
                              for (let i = 0; i < wayCount; i++) items.push({ key: i, label: `Way ${i + 1}` });
                            }
                            return items.map((item) => {
                              const link = currentDevice.wayLinks?.[item.key];
                              let targetHostname = '';
                              if (typeof link === 'string') targetHostname = link;
                              else if (link && link.target) targetHostname = link.target;

                              return (
                                <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(0,0,0,0.3)', padding: '0.5rem', borderRadius: '6px' }}>
                                  <span style={{ fontSize: '0.8rem', width: '80px', color: '#cbd5e1' }}>{item.label}</span>
                                  <input
                                    type="text"
                                    style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.8rem', background: '#0f172a', border: '1px solid #334155' }}
                                    placeholder="Connect to..."
                                    value={targetHostname}
                                    onChange={e => {
                                      const newLinks = { ...(currentDevice.wayLinks || {}) };
                                      newLinks[item.key] = { target: e.target.value, cableColor: 'Yellow' };
                                      setCurrentDevice({ ...currentDevice, wayLinks: newLinks });
                                    }}
                                  />
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                      <p>This tab allows configuring upstream power connections (e.g. connecting PSU 1 to PDU-A).</p>
                      <p style={{ fontStyle: 'italic' }}>(Feature coming soon for non-PDU devices)</p>
                    </div>
                  )}
                </div>
              )}

              {/* --- SNMP CONFIG TAB --- */}
              {activeDeviceTab === 'snmp' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '500px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'bold', cursor: role === 'Viewer' ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={!!snmpForm.enabled} disabled={role === 'Viewer'} onChange={e => setSnmpForm({ ...snmpForm, enabled: e.target.checked })} />
                    啟用 SNMP 查詢
                  </label>
                  {!snmpForm.enabled && (
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>停用時不會對此設備進行 SNMP 查詢 (Ports &amp; Cables 改為手動維護)，下方設定可先不填。</p>
                  )}
                  <div className="form-group">
                    <label>SNMP Version</label>
                    <select value={snmpForm.version} onChange={e => setSnmpForm({ ...snmpForm, version: e.target.value })}>
                      <option value="v1">v1</option>
                      <option value="v2c">v2c</option>
                      <option value="v3">v3</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Port</label>
                    <input type="number" value={snmpForm.port} onChange={e => setSnmpForm({ ...snmpForm, port: e.target.value })} />
                  </div>
                  {(snmpForm.version === 'v2c' || snmpForm.version === 'v1') && (
                    <div className="form-group">
                      <label>Community String</label>
                      <input type="password" value={snmpForm.community || ''} onChange={e => setSnmpForm({ ...snmpForm, community: e.target.value })} />
                    </div>
                  )}
                  {snmpForm.version === 'v3' && (
                    <>
                      <div className="form-group">
                        <label>Security Name (User)</label>
                        <input type="text" value={snmpForm.v3User || ''} onChange={e => setSnmpForm({ ...snmpForm, v3User: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Auth Password (SHA)</label>
                        <input type="password" value={snmpForm.v3AuthPass || ''} onChange={e => setSnmpForm({ ...snmpForm, v3AuthPass: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Priv Password (AES)</label>
                        <input type="password" value={snmpForm.v3PrivPass || ''} onChange={e => setSnmpForm({ ...snmpForm, v3PrivPass: e.target.value })} />
                      </div>
                    </>
                  )}
                  {role !== 'Viewer' && (
                    <button type="button" className="btn btn-primary" onClick={() => {
                      const payload = { ...snmpForm, enabled: !!snmpForm.enabled };
                      api.post(`/network-device/${currentDevice.id}/snmp`, payload).then(() => {
                        setSnmpSavedEnabled(payload.enabled);
                        setPollData(null);
                        setSysAlert({ message: payload.enabled
                          ? 'SNMP Settings Saved. The Ports & Cables tab will now show live SNMP status.'
                          : 'SNMP Settings Saved. SNMP 查詢已停用，不會對此設備進行查詢。' });
                      }).catch(err => setSysAlert({ message: 'Failed: ' + (err.response?.data?.error || err.message) }));
                    }}>Save SNMP Settings</button>
                  )}
                </div>
              )}


              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
                <button type="button" className="btn btn-danger" onClick={removeDevice} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <TbTrash /> Remove
                </button>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => closeDeviceModal()}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Save Device</button>
                </div>
              </div>
            </form>
          </div>
        </div>
  );
}
