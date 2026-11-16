import { TbTrash } from 'react-icons/tb';

// Add / edit a rack (name, height or split sections, row, floor, power). Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function RackFormModal({ racks, setShowRackModal, currentRack, setCurrentRack, autofillRackFromRow, saveRack, removeRack }) {
  return (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ maxWidth: '500px', height: 'auto', padding: '2rem' }}>
            <button className="modal-close" onClick={() => setShowRackModal(false)}>×</button>
            <h2 style={{ color: 'var(--accent-primary)', marginBottom: '1.5rem' }}>
              {currentRack.id.startsWith('rack-') && currentRack.name === '' ? 'Add Server Rack' : 'Edit Server Rack'}
            </h2>
            <form onSubmit={saveRack}>
              <div className="form-grid-3">
                <div className="form-group span-2">
                  <label>Rack Name</label>
                  <input required type="text" value={currentRack.name} onChange={e => setCurrentRack({ ...currentRack, name: e.target.value })} placeholder="e.g. Rack-A01" />
                </div>

                <div className="form-group span-3" style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px dashed var(--border-color)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: currentRack.isSplitDesign ? '12px' : '0' }}>
                    <div style={{ position: 'relative', width: '40px', height: '22px' }}>
                      <input type="checkbox" checked={currentRack.isSplitDesign || false} onChange={e => {
                        const isSplit = e.target.checked;
                        if (isSplit) {
                          setCurrentRack({ ...currentRack, isSplitDesign: true, upperU: 20, lowerU: 22, height: 42 });
                        } else {
                          setCurrentRack({ ...currentRack, isSplitDesign: false });
                        }
                      }} style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }} />
                      <span style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: currentRack.isSplitDesign ? 'var(--accent-primary)' : 'rgba(255,255,255,0.2)',
                        transition: '.4s', borderRadius: '34px'
                      }}>
                        <span style={{
                          position: 'absolute', height: '16px', width: '16px', left: '3px', bottom: '3px',
                          backgroundColor: 'white', transition: '.4s', borderRadius: '50%',
                          transform: currentRack.isSplitDesign ? 'translateX(18px)' : 'none'
                        }}></span>
                      </span>
                    </div>
                    <span style={{ fontWeight: 'bold', color: 'var(--accent-primary)' }}>Top/Bottom Split Design (上下櫃)</span>
                  </label>

                  {currentRack.isSplitDesign ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      <div className="form-group">
                        <label>Upper Section (U)</label>
                        <input required type="number" min="1" max="100" value={currentRack.upperU || ''} onChange={e => setCurrentRack({ ...currentRack, upperU: parseInt(e.target.value), height: parseInt(e.target.value) + (currentRack.lowerU || 0) })} />
                      </div>
                      <div className="form-group">
                        <label>Lower Section (U)</label>
                        <input required type="number" min="1" max="100" value={currentRack.lowerU || ''} onChange={e => setCurrentRack({ ...currentRack, lowerU: parseInt(e.target.value), height: (currentRack.upperU || 0) + parseInt(e.target.value) })} />
                      </div>
                    </div>
                  ) : (
                    <div className="form-group" style={{ marginTop: '12px' }}>
                      <label>Rack Height (U)</label>
                      <input required type="number" min="1" max="100" value={currentRack.height} onChange={e => setCurrentRack({ ...currentRack, height: parseInt(e.target.value) })} />
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label>Assign to Row</label>
                  <select
                    className="input-field"
                    style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'white', padding: '0.75rem', borderRadius: '4px', width: '100%', height: '42px' }}
                    value={currentRack.rowNumber || 1}
                    onChange={e => {
                      const val = e.target.value;
                      if (val === 'new') {
                        const existingRows = Array.from(new Set(racks.map(r => r.rowNumber || 1)));
                        const maxRow = Math.max(0, ...existingRows);
                        setCurrentRack({ ...currentRack, rowNumber: maxRow + 1 });
                      } else {
                        const targetRow = parseInt(val);
                        // If it's a new rack, autofill settings from the target row
                        if (currentRack.id.startsWith('rack-') && currentRack.name === '') {
                          setCurrentRack(autofillRackFromRow(currentRack, targetRow));
                        } else {
                          setCurrentRack({ ...currentRack, rowNumber: targetRow });
                        }
                      }
                    }}
                  >
                    {(() => {
                      const existingRows = Array.from(new Set(racks.map(r => r.rowNumber || 1)));
                      if (currentRack.rowNumber && !existingRows.includes(currentRack.rowNumber)) {
                        existingRows.push(currentRack.rowNumber);
                      }
                      return existingRows.sort((a, b) => a - b).map(num => (
                        <option key={num} value={num}>Row {num}</option>
                      ));
                    })()}
                    <option value="new">+ Create New Row</option>
                  </select>
                </div>
                <div className="form-group span-2">
                  <label>Floor (樓層)</label>
                  <input type="text" value={currentRack.floor} onChange={e => setCurrentRack({ ...currentRack, floor: e.target.value })} placeholder="e.g. 2F" />
                </div>

                <div className="form-group">
                  <label>Amps (A)</label>
                  <input type="text" value={currentRack.amps || ''} onChange={e => setCurrentRack({ ...currentRack, amps: e.target.value })} placeholder="e.g. 40" />
                </div>
                <div className="form-group">
                  <label>Volts (V)</label>
                  <input type="text" value={currentRack.volts || ''} onChange={e => setCurrentRack({ ...currentRack, volts: e.target.value })} placeholder="e.g. 220" />
                </div>
              </div>
              <div className="flex justify-between mt-4">
                <div className="flex gap-2">
                  {!currentRack.id.startsWith('rack-') || currentRack.name !== '' ? (
                    <button type="button" className="btn btn-danger" onClick={() => removeRack(currentRack.id)}><TbTrash className="rack-ico" />Remove</button>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-outline" onClick={() => setShowRackModal(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Save Rack</button>
                </div>
              </div>
            </form>
          </div>
        </div>
  );
}
