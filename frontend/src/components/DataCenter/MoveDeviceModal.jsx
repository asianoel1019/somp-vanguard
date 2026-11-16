import { generateUs, getSplitLocation } from './rackShared';
import api from '../../api';
import { TbAlertTriangle, TbArrowsExchange, TbArrowsMove, TbCircleCheck, TbMapPin } from 'react-icons/tb';
import { isSideMounted } from './rackUtils';

// Move a device to another rack, face or U slot. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function MoveDeviceModal({ showToast, racks, selectedDC, uOrder, setShowMoveModal, moveTargetRackId, setMoveTargetRackId, moveTargetSection, setMoveTargetSection, moveTargetU, setMoveTargetU, moveTargetToBack, setMoveTargetToBack, moveLoading, setMoveLoading, moveError, setMoveError, currentDevice, targetRackId, revisionsRef, saveChainRef, closeDeviceModal, reloadRacks }) {
  return (
        <div className="modal-overlay" style={{ zIndex: 3000 }}>
          <div className="modal-content glass-panel" style={{ maxWidth: '540px', padding: '2rem', borderRadius: '16px' }}>
            <button className="modal-close" onClick={() => setShowMoveModal(false)}>×</button>
            <h2 style={{ color: 'var(--accent-primary)', marginTop: 0, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.4rem' }}>
              <TbArrowsMove /> Move Device
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: '1.4' }}>
              Migrate device "<strong style={{ color: 'var(--text-primary)' }}>{currentDevice.hostname || currentDevice.name || currentDevice.type}</strong>" ({currentDevice.sizeU}U) to a new rack and U position.
            </p>

            {moveError && (
              <div style={{ padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
                {moveError}
              </div>
            )}

            {(() => {
              const frontRacks = racks.filter(r => !r.isBack);
              const selectedBaseFrontRack = frontRacks.find(r => r.id === moveTargetRackId) || frontRacks[0];
              if (!selectedBaseFrontRack) return null;

              // Determine effective destination rack (Front or Back)
              let targetRack = selectedBaseFrontRack;
              if (moveTargetToBack) {
                const backPartner = racks.find(r => r.isBack && (r.partnerId === selectedBaseFrontRack.id || r.id === selectedBaseFrontRack.partnerId || r.id === `${selectedBaseFrontRack.id}-back`));
                if (backPartner) {
                  targetRack = backPartner;
                }
              }

              const isSplit = !!targetRack.isSplitDesign;
              const actualStartU = isSplit && moveTargetSection === 'Up'
                ? ((targetRack.lowerU || 0) + parseInt(moveTargetU || 1, 10))
                : parseInt(moveTargetU || 1, 10);
              const actualEndU = actualStartU + (parseInt(currentDevice.sizeU, 10) || 1) - 1;

              // Collision & Boundary validation
              let collisionMsg = null;
              let isCollision = false;

              if (actualEndU > targetRack.height) {
                isCollision = true;
                collisionMsg = `Device height (${currentDevice.sizeU}U) exceeds target rack height (${targetRack.height}U)`;
              } else if (isSplit && moveTargetSection === 'Down' && actualEndU > targetRack.lowerU) {
                isCollision = true;
                collisionMsg = `Device height (${currentDevice.sizeU}U) exceeds Down section limit (D${targetRack.lowerU}U)`;
              } else {
                // side-mounted (vertical) PowerBars take no U: same rule as the server
                const collidingDev = !isSideMounted(currentDevice) && (targetRack.devices || []).find(d => {
                  if ((d.id === currentDevice.id && targetRack.id === targetRackId) || isSideMounted(d)) return false;
                  const dStart = parseInt(d.startU, 10) || 1;
                  const dEnd = dStart + (parseInt(d.sizeU, 10) || 1) - 1;
                  return Math.max(actualStartU, dStart) <= Math.min(actualEndU, dEnd);
                });
                if (collidingDev) {
                  isCollision = true;
                  collisionMsg = `Space Conflict: Overlaps with "${collidingDev.hostname || collidingDev.name || collidingDev.type}" (${getSplitLocation(targetRack, collidingDev.startU)})!`;
                }
              }

              const handleExecuteMove = async () => {
                if (isCollision) return;
                setMoveLoading(true);
                setMoveError('');
                try {
                  // let queued rack saves finish first so the reload below includes them
                  await saveChainRef.current;
                  const dcId = selectedDC?.id || 'default';
                  const res = await api.post('/rack/move-device', {
                    dcId,
                    deviceId: currentDevice.id,
                    sourceRackId: targetRackId,
                    targetRackId: targetRack.id,
                    targetU: actualStartU
                  });
                  if (res.data.success) {
                    showToast(res.data.message || 'Device moved successfully!', 'success');
                    if (Number.isInteger(res.data.revision)) revisionsRef.current[dcId] = res.data.revision;
                    // Refresh rack list (and revision) from backend
                    if (selectedDC) await reloadRacks(selectedDC);
                    setShowMoveModal(false);
                    closeDeviceModal();
                  }
                } catch (err) {
                  setMoveError(err.response?.data?.error || err.message || 'Failed to move device');
                } finally {
                  setMoveLoading(false);
                }
              };

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* Current Location Info */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}><TbMapPin className="rack-ico" />Current Location:</span>
                    <span style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>
                      [{racks.find(r => r.id === targetRackId)?.name || 'Unknown'}] {getSplitLocation(racks.find(r => r.id === targetRackId), currentDevice.startU)}
                    </span>
                  </div>

                  {/* Target Rack Selection */}
                  <div className="form-group">
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                      Target Rack (目標機櫃)
                    </label>
                    <select
                      className="form-control"
                      value={moveTargetRackId}
                      onChange={e => {
                        const newRackId = e.target.value;
                        setMoveTargetRackId(newRackId);
                        setMoveTargetSection('Down');
                        setMoveTargetU(1);
                      }}
                      style={{ width: '100%', padding: '0.6rem 0.8rem', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', outline: 'none' }}
                    >
                      {frontRacks.map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name} (Row {r.rowNumber || 1}) - {r.isSplitDesign ? `Split Rack (Up ${r.upperU}U / Down ${r.lowerU}U)` : `Standard Rack (${r.height}U)`}
                        </option>
                      ))}
                    </select>

                    {/* Move to Back Checkbox */}
                    <div style={{ marginTop: '0.75rem' }}>
                      <label style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                        color: 'var(--text-primary)',
                        userSelect: 'none',
                        background: moveTargetToBack ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: `1px solid ${moveTargetToBack ? '#3b82f6' : 'var(--border-color)'}`,
                        transition: 'all 0.2s ease'
                      }}>
                        <input
                          type="checkbox"
                          checked={moveTargetToBack}
                          onChange={e => setMoveTargetToBack(e.target.checked)}
                          style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                        />
                        <span style={{ fontWeight: 700, color: moveTargetToBack ? '#60a5fa' : 'var(--text-primary)' }}>
                          <TbArrowsExchange className="rack-ico" />Move to Back (移動至機櫃背面)
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Section selection if Target Rack is Split Design */}
                  {isSplit && (
                    <div className="form-group">
                      <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                        Section (Up / Down)
                      </label>
                      <div style={{ display: 'flex', gap: '1.5rem', padding: '0.6rem 1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary)', userSelect: 'none' }}>
                          <input
                            type="radio"
                            name="moveSection"
                            checked={moveTargetSection === 'Down'}
                            onChange={() => { setMoveTargetSection('Down'); setMoveTargetU(1); }}
                            style={{ cursor: 'pointer' }}
                          />
                          <span><strong>Down</strong> (D1U ~ D{targetRack.lowerU}U)</span>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary)', userSelect: 'none' }}>
                          <input
                            type="radio"
                            name="moveSection"
                            checked={moveTargetSection === 'Up'}
                            onChange={() => { setMoveTargetSection('Up'); setMoveTargetU(1); }}
                            style={{ cursor: 'pointer' }}
                          />
                          <span><strong>Up</strong> (U1U ~ U{targetRack.upperU}U)</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Target U Selection */}
                  <div className="form-group">
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                      Target U Slot
                    </label>
                    <select
                      className="form-control"
                      value={moveTargetU}
                      onChange={e => setMoveTargetU(parseInt(e.target.value, 10))}
                      style={{ width: '100%', padding: '0.6rem 0.8rem', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', outline: 'none' }}
                    >
                      {(() => {
                        const maxU = isSplit
                          ? (moveTargetSection === 'Up' ? (targetRack.upperU || 20) : (targetRack.lowerU || 22))
                          : (targetRack.height || 42);
                        const uList = generateUs(maxU, uOrder);
                        return uList.map(u => {
                          const label = isSplit
                            ? (moveTargetSection === 'Up' ? `U${u}U (Slot ${u})` : `D${u}U (Slot ${u})`)
                            : `U${u} (Slot ${u})`;
                          return (
                            <option key={u} value={u}>
                              {label}
                            </option>
                          );
                        });
                      })()}
                    </select>
                  </div>

                  {/* Realtime Status Indicator */}
                  <div style={{
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    fontSize: '0.85rem',
                    background: isCollision ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                    border: `1px solid ${isCollision ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'}`,
                    color: isCollision ? '#ef4444' : '#10b981',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <span style={{ display: 'inline-flex' }}>{isCollision ? <TbAlertTriangle /> : <TbCircleCheck />}</span>
                    <span style={{ fontWeight: 600 }}>
                      {isCollision
                        ? collisionMsg
                        : `Target Position Available: [${targetRack.name}] ${getSplitLocation(targetRack, actualStartU)} (${currentDevice.sizeU}U)`}
                    </span>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setShowMoveModal(false)}
                      disabled={moveLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleExecuteMove}
                      disabled={isCollision || moveLoading}
                      style={{ opacity: isCollision || moveLoading ? 0.6 : 1 }}
                    >
                      {moveLoading ? 'Moving...' : 'Confirm Move'}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
  );
}
