import RackBody from './RackBody';

// Off-screen layout rendered to PNG by html-to-image. Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function RackExportLayout({ racks, selectedDC, uOrder, noop, getSelectedRacksList }) {
  return (
        <div className="export-offscreen-container">
          <div id="export-combined-container" style={{ display: 'flex', flexDirection: 'column', gap: '3rem', padding: '30px', background: '#0b0c13', width: 'max-content' }}>
            <h2 style={{ color: '#3b82f6', margin: '0 0 1rem 0', fontFamily: 'sans-serif' }}>
              {selectedDC ? `[${selectedDC.name}] Server Rack Report` : 'Server Rack Report'}
            </h2>
            {(() => {
              const selectedList = getSelectedRacksList();
              const rowGroups = {};
              selectedList.forEach(rack => {
                const rowNum = rack.rowNumber || 1;
                if (!rowGroups[rowNum]) rowGroups[rowNum] = [];
                rowGroups[rowNum].push(rack);
              });
              
              const sortedRowNums = Object.keys(rowGroups).map(Number).sort((a, b) => a - b);
              
              return sortedRowNums.map(rowNum => (
                <div key={rowNum} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ fontSize: '0.9rem', color: '#3b82f6', fontWeight: 'bold', borderLeft: '4px solid #3b82f6', paddingLeft: '0.5rem', fontFamily: 'sans-serif' }}>
                    ROW {rowNum}
                  </div>
                  <div style={{ display: 'flex', gap: '3rem', flexWrap: 'nowrap' }}>
                    {rowGroups[rowNum].map(rack => {
                      const backRack = racks.find(r => r.id === rack.partnerId) || { ...rack, name: `${rack.name} (Back)`, devices: [], isBack: true };
                      const activeRack = rack.viewMode === 'back' ? backRack : rack;
                      return (
                        <div key={rack.id} className="export-rack-box" style={{ padding: '0', background: 'transparent' }}>
                          <div className="export-rack-title">
                            <h3>{activeRack.name}</h3>
                            <span style={{ fontSize: '12px', color: '#888' }}>
                              {activeRack.height}U | {activeRack.devices?.length || 0} devices ({activeRack.viewMode === 'back' ? 'Back' : 'Front'})
                            </span>
                          </div>
                          <div className="export-rack-body-wrapper">
                            <RackBody rack={activeRack} uOrder={uOrder} canAdd={false} onAddDevice={noop} onDeviceClick={noop} onPortClick={noop} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
  );
}
