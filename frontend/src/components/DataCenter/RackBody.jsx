import React from 'react';
import { DEVICE_TYPE_BY_ID, generateUs, getDisplayU } from './rackShared';

// One face of a rack: rails, U slots and the devices. Pure and memoized: it re-renders only when its rack, the U
// order, its search matches (`matched`: "|id|id|" of the matching devices) or a callback changes. Callbacks: onAddDevice(rackId, u), onDeviceClick(rackId,
// device), onPortClick(device), onTipShow({ device, rack, rect }) / onTipHide() (left out in print / export).
function RackBody({ rack, uOrder, canAdd, matched = '', onAddDevice, onDeviceClick, onPortClick, onTipShow, onTipHide }) {
  const sideDevices = rack.devices || [];
  const isUOrderAsc = uOrder === 'asc'; // 1U at top, 42U at bottom
  const us = generateUs(rack.height, uOrder);
  const occupied = new Set();
  for (const d of sideDevices) for (let u = d.startU; u < d.startU + d.sizeU; u++) occupied.add(u);

  return (
    <div className="rack-body">
      {/* Left Rail */}
      <div className="rack-rail left">
        {us.map(u => (
          <React.Fragment key={u}>
            <div className="rail-u">{getDisplayU(rack, u)}</div>
            {rack.isSplitDesign && u === rack.lowerU + 1 && (
              <div className="rail-divider" style={{ background: 'linear-gradient(90deg, #1e293b, #334155, #1e293b)' }}></div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Center Slots Area */}
      <div className="rack-slots" style={{ position: 'relative', height: `${rack.height * 38 + (rack.isSplitDesign ? 24 : 0)}px` }}>
        {us.map(u => (
          <React.Fragment key={u}>
            <div
              className={`u-slot ${occupied.has(u) ? 'is-occupied' : ''}`}
              onClick={occupied.has(u) || !canAdd ? undefined : () => onAddDevice(rack.id, u)}
            >
            </div>
            {rack.isSplitDesign && u === rack.lowerU + 1 && (
              <div className="slot-divider" style={{ height: '24px', background: 'repeating-linear-gradient(45deg, #0f172a, #0f172a 10px, #1e293b 10px, #1e293b 20px)', borderTop: '2px solid #000', borderBottom: '2px solid #000', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '10px', fontWeight: 'bold', letterSpacing: '2px' }}>
                --- SPLIT DIVIDER ---
              </div>
            )}
          </React.Fragment>
        ))}

        {sideDevices.map(device => {
          const icon = DEVICE_TYPE_BY_ID.get(device.type)?.icon || '🖥️';
          
          // Positioning calculation based on uOrder:
          const posStyle = isUOrderAsc ? {
            top: `${(device.startU - 1) * 38 + (rack.isSplitDesign && device.startU > rack.lowerU ? 24 : 0)}px`,
            bottom: 'auto'
          } : {
            bottom: `${(device.startU - 1) * 38 + (rack.isSplitDesign && device.startU > rack.lowerU ? 24 : 0)}px`,
            top: 'auto'
          };

          return (
            <div
              id={`device-${rack.id}-${device.id}`}
              key={device.id}
              className={`device-block ${matched && matched.includes(`|${device.id}|`) ? 'search-highlight' : ''}`}
              style={{
                ...posStyle,
                height: `${device.sizeU * 38 + (rack.isSplitDesign && device.startU <= rack.lowerU && (device.startU + device.sizeU - 1) > rack.lowerU ? 24 : 0)}px`,
                ...(device.type === 'PowerBar' && device.orientation === 'vertical' ? {
                  width: device.side === 'both' ? '100%' : '32px',
                  left: device.side === 'right' ? 'auto' : (device.side === 'both' ? '0' : '-5px'),
                  right: device.side === 'left' ? 'auto' : (device.side === 'both' ? '0' : '-5px'),
                  zIndex: 100,
                  pointerEvents: 'none'
                } : {})
              }}
              onClick={() => onDeviceClick(rack.id, device)}
            >
              <div className={`device-inner device-type-${device.type}`}>
                {/* Kuai Kuai (乖乖) Visual Rendering */}
                {device.type === 'KuaiKuai' && (
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '140px',
                    height: '32px',
                    background: 'linear-gradient(to right, #15803d, #22c55e, #15803d)',
                    borderRadius: '6px',
                    boxShadow: '0 3px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    border: '1px solid #166534',
                    fontFamily: '"Microsoft JhengHei", sans-serif',
                    zIndex: 5,
                    gap: '8px'
                  }}>
                    {/* Jagged Left Edge */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'space-around', height: '100%', width: 4 }}>
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} style={{ width: 2, height: 2, background: 'rgba(0,0,0,0.4)', borderRadius: '50%' }} />
                      ))}
                    </div>

                    {/* Big Red "乖" Circle */}
                    <div style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background: '#ef4444',
                      border: '1.5px solid #fff',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      lineHeight: 1,
                      flexShrink: 0
                    }}>
                      乖
                    </div>

                    {/* Brand & Text */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', flex: 1 }}>
                      <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#fff', textShadow: '1px 1px 1px #000' }}>
                        乖乖 (造句包)
                      </div>
                      <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#fef08a', textShadow: '1px 1px 1px #000', marginTop: -1 }}>
                        綠色順利 • 不當機
                      </div>
                    </div>

                    {/* Jagged Right Edge */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'space-around', height: '100%', width: 4, marginLeft: 'auto' }}>
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} style={{ width: 2, height: 2, background: 'rgba(0,0,0,0.4)', borderRadius: '50%' }} />
                      ))}
                    </div>
                  </div>
                )}

                {device.type !== 'Shelf' && device.type !== 'KuaiKuai' && (
                  <div className="device-info" style={{
                    position: 'absolute',
                    right: '3.5rem',
                    textAlign: 'right',
                    zIndex: 10,
                    ...(device.sizeU >= 2 ? { top: '8px', transform: 'none' } : {})
                  }}>
                    <span className="device-name">
                      {device.type === 'Reserve' ? (device.note || 'Reserved') : (device.hostname || `Unknown ${device.type}`)}
                    </span>
                    {device.type === 'PowerBar' ? (
                      (device.amps || device.volts) ? (
                        <span className="device-ip" style={{ color: '#f59e0b', fontWeight: 800, fontSize: '11px' }}>
                          ⚡ {device.amps ? `${device.amps}${String(device.amps).toLowerCase().includes('a') ? '' : 'A'}` : ''}{device.amps && device.volts ? ' / ' : ''}{device.volts ? `${device.volts}${String(device.volts).toLowerCase().includes('v') ? '' : 'V'}` : ''}
                        </span>
                      ) : (
                        device.ip && <span className="device-ip">{device.ip}</span>
                      )
                    ) : (
                      device.type !== 'Reserve' && <span className="device-ip">{['Nutanix', 'BladeChassis'].includes(device.type) ? (device.ip || device.cvmIp) : device.ip}</span>
                    )}
                  </div>
                )}
              </div>
              {device.type === 'PowerBar' && (
                <div className={`powerbar-render-area ${device.orientation}`} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}>
                  {device.orientation === 'vertical' ? (
                    <>
                      {(device.side === 'left' || device.side === 'both') && (
                        <div
                          className={`powerbar-realistic vertical rows-${device.rows || 1} side-left`}
                          style={{ left: device.side === 'both' ? '-5px' : '0', width: (device.rows === 3 ? '52px' : (device.rows === 2 ? '42px' : '32px')), pointerEvents: 'auto', transform: 'none', top: 0 }}
                        >
                          <div className="powerbar-outlets">
                            {Array.from({ length: device.ways || 0 }).map((_, i) => (
                              <div key={i} className={`powerbar-outlet ${device.wayLinks?.[`L${i}`] || device.wayLinks?.[i] ? 'has-link' : ''}`} title={device.wayLinks?.[`L${i}`] || device.wayLinks?.[i] || `Left Way ${i + 1}`}>
                                {(device.wayLinks?.[`L${i}`] || device.wayLinks?.[i]) && <div className="led-indicator-on" />}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(device.side === 'right' || device.side === 'both') && (
                        <div
                          className={`powerbar-realistic vertical rows-${device.rows || 1} side-right`}
                          style={{ right: device.side === 'both' ? '-5px' : '0', left: 'auto', width: (device.rows === 3 ? '52px' : (device.rows === 2 ? '42px' : '32px')), pointerEvents: 'auto', transform: 'none', top: 0 }}
                        >
                          <div className="powerbar-outlets">
                            {Array.from({ length: device.ways || 0 }).map((_, i) => (
                              <div key={i} className={`powerbar-outlet ${device.wayLinks?.[`R${i}`] || (device.side === 'right' && device.wayLinks?.[i]) ? 'has-link' : ''}`} title={device.wayLinks?.[`R${i}`] || (device.side === 'right' && device.wayLinks?.[i]) || `Right Way ${i + 1}`}>
                                {(device.wayLinks?.[`R${i}`] || (device.side === 'right' && device.wayLinks?.[i])) && <div className="led-indicator-on" />}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div
                      className={`powerbar-realistic horizontal rows-${device.rows || 1}`}
                      style={{ pointerEvents: 'auto', transform: 'translateY(-50%)', left: '1%', width: '98%', top: '50%' }}
                    >
                      <div className="powerbar-outlets">
                        {Array.from({ length: device.ways || 0 }).map((_, i) => (
                          <div key={i} className={`powerbar-outlet ${device.wayLinks?.[i] || device.wayLinks?.[`L${i}`] || device.wayLinks?.[`R${i}`] ? 'has-link' : ''}`} title={device.wayLinks?.[i] || device.wayLinks?.[`L${i}`] || device.wayLinks?.[`R${i}`] || `Outlet ${i + 1}`}>
                            {(device.wayLinks?.[i] || device.wayLinks?.[`L${i}`] || device.wayLinks?.[`R${i}`]) && <div className="led-indicator-on" />}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {['Switch', 'Firewall', 'Router', 'LoadBalancer', 'Server', 'Storage', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(device.type) && device.ports > 0 && (() => {
                const actualPorts = device.ports || (['PatchPanel', 'CableManagement'].includes(device.type) ? 24 : 8);
                const autoRows = actualPorts > 10 ? 2 : (device.rows || 1);
                const displayPorts = Math.min(actualPorts, 24);
                const hasMore = actualPorts > 24;

                const handlePortClick = (e) => {
                  e.stopPropagation();
                  onPortClick({ ...device, _actualPorts: actualPorts });
                };

                return (
                  <div className={`${device.type.toLowerCase()}-realistic switch-realistic rows-${autoRows}`} style={{
                    ...(['PatchPanel', 'CableManagement'].includes(device.type) ? { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', width: '100%', ...(device.sizeU >= 2 ? { height: 'auto', padding: '10px 0' } : { height: '100%' }) } : {}),
                    ...(device.sizeU >= 2 ? { top: 'auto', bottom: '8px', transform: 'none' } : {})
                  }}>
                    <div className="port-container" onClick={handlePortClick} style={{ cursor: 'pointer' }}>
                      {Array.from({ length: displayPorts }).map((_, i) => {
                        let label = `P${i + 1}`;
                        if (autoRows === 2) {
                          const isTop = i % 2 === 0;
                          label = `P${i + 1} (${isTop ? 'Upper' : 'Lower'})`;
                        }
                        let liveClass = '';
                        if (device.livePorts && device.livePorts[i]) {
                          const isUp = device.livePorts[i].status === 'Up' || device.livePorts[i].value === '1';
                          liveClass = isUp ? ' snmp-up' : ' snmp-down';
                          if (device.livePorts[i].name) {
                            label = `${device.livePorts[i].name} (${label})`;
                          }
                        }
                        return (
                          <div key={i} className={`port-square ${device.portLinks?.[i] ? 'has-link' : ''}${liveClass}`} title={device.portLinks?.[i] || label}>
                            {device.portLinks?.[i] && !liveClass && <div className="led-indicator-on" />}
                          </div>
                        );
                      })}
                      {hasMore && (
                        <div className="port-square" title="View all ports" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '10px', fontWeight: 'bold' }}>
                          ...
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {device.type === 'Shelf' && (
                <div className="shelf-realistic" />
              )}

              {/* Always on top: Hardware Icon & Tooltip */}
              <div className="device-type-icon" style={{
                position: 'absolute',
                left: (device.type === 'PowerBar' && device.orientation === 'vertical')
                  ? (device.side === 'both' ? '50%' : (device.side === 'left' ? '45px' : 'auto'))
                  : (device.type === 'PowerBar' && device.orientation === 'horizontal' ? 'auto' : (device.type === 'PowerBar' ? '50%' : 'auto')),
                right: (device.type === 'PowerBar' && device.orientation === 'vertical')
                  ? (device.side === 'right' ? '45px' : 'auto')
                  : (device.type === 'PowerBar' && device.orientation === 'horizontal' ? '1rem' : (device.type === 'PowerBar' ? 'auto' : '1rem')),
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 2000,
                fontSize: '1.5rem',
                pointerEvents: 'auto'
              }}
                onMouseEnter={onTipShow ? (e) => onTipShow({ device, rack, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
                onMouseLeave={onTipHide}>
                {device.type !== 'Shelf' && icon}
              </div>
            </div>
          )
        })}
      </div>

      {/* Right Rail */}
      <div className="rack-rail right">
        {us.map(u => (
          <React.Fragment key={u}>
            <div className="rail-u">{getDisplayU(rack, u)}</div>
            {rack.isSplitDesign && u === rack.lowerU + 1 && (
              <div className="rail-divider" style={{ background: 'linear-gradient(-90deg, #1e293b, #334155, #1e293b)' }}></div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default React.memo(RackBody);
