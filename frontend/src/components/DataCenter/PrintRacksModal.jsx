// Pick the racks to print or export as PNG. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function PrintRacksModal({ racks, setShowPrintModal, selectedPrintRacks, setSelectedPrintRacks, expandedPrintRows, setExpandedPrintRows, handleTriggerExport, rowsGroup, sortedRowNumbers }) {
  return (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ maxWidth: '600px', width: '90%', height: 'auto', maxHeight: '85vh', padding: '2.5rem', overflowY: 'auto' }}>
            <button className="modal-close" onClick={() => setShowPrintModal(false)}>×</button>
            <h2 style={{ color: 'var(--accent-primary)', marginBottom: '1.5rem', fontSize: '1.4rem' }}>
              Output PNG
            </h2>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
              <button className="btn btn-outline" type="button" style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }} onClick={() => {
                const allSel = {};
                racks.forEach(r => { if(!r.isBack) allSel[r.id] = true; });
                setSelectedPrintRacks(allSel);
              }}>Select All</button>
              <button className="btn btn-outline" type="button" style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }} onClick={() => setSelectedPrintRacks({})}>Clear All</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
              {sortedRowNumbers.map(rowNum => {
                const rowRacks = rowsGroup[rowNum];
                const isExpanded = !!expandedPrintRows[rowNum];
                const isRowAllSelected = rowRacks.every(r => selectedPrintRacks[r.id]);
                const isRowAnySelected = rowRacks.some(r => selectedPrintRacks[r.id]);
                const isRowPartiallySelected = isRowAnySelected && !isRowAllSelected;

                return (
                  <div key={rowNum} style={{ background: 'rgba(255,255,255,0.02)', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div 
                      onClick={() => setExpandedPrintRows(prev => ({ ...prev, [rowNum]: !prev[rowNum] }))}
                      style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'space-between', 
                        cursor: 'pointer',
                        userSelect: 'none'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <input 
                          type="checkbox"
                          checked={isRowAllSelected}
                          ref={el => {
                            if (el) el.indeterminate = isRowPartiallySelected;
                          }}
                          onChange={e => {
                            const checked = e.target.checked;
                            setSelectedPrintRacks(prev => {
                              const next = { ...prev };
                              rowRacks.forEach(r => { next[r.id] = checked; });
                              return next;
                            });
                          }}
                          onClick={e => e.stopPropagation()}
                          style={{ cursor: 'pointer', width: '15px', height: '15px', marginRight: '8px' }}
                        />
                        <span style={{ fontWeight: 'bold', color: 'var(--accent-primary)', fontSize: '0.9rem' }}>
                          ROW {rowNum}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '8px' }}>
                          ({rowRacks.filter(r => selectedPrintRacks[r.id]).length}/{rowRacks.length} selected)
                        </span>
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', 
                        gap: '6px 12px', 
                        marginTop: '12px',
                        borderTop: '1px solid rgba(255,255,255,0.05)',
                        paddingTop: '10px'
                      }}>
                        {rowRacks.map(rack => (
                          <label key={rack.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.85rem', userSelect: 'none' }}>
                            <input 
                              type="checkbox" 
                              checked={!!selectedPrintRacks[rack.id]} 
                              onChange={e => {
                                setSelectedPrintRacks(prev => ({ ...prev, [rack.id]: e.target.checked }));
                              }}
                              style={{ width: '13px', height: '13px', cursor: 'pointer', margin: 0 }}
                            />
                            <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={rack.name}>
                              {rack.name}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button className="btn btn-outline" onClick={() => setShowPrintModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleTriggerExport} disabled={!Object.values(selectedPrintRacks).some(Boolean)}>
                Output PNG
              </button>
            </div>
          </div>
        </div>
  );
}
