import RackBody from './RackBody';

// The layout window.print() prints (only shown while printing). Moved out of ServerRack.jsx unchanged; the state and handlers stay there and come in as props.
export default function RackPrintLayout({ racks, selectedDC, uOrder, noop, getSelectedRacksList }) {
  return (
        <div className="print-only-layout">
          {getSelectedRacksList().map((rack, pageIdx) => {
            const backRack = racks.find(r => r.id === rack.partnerId) || { ...rack, name: `${rack.name} (Back)`, devices: [], isBack: true };
            const activeRack = rack.viewMode === 'back' ? backRack : rack;

            // Calculate dynamic scale factor to make any height rack fit on one A4 page
            const rackHeightU = activeRack.height || 42;
            const unscaledHeight = (rackHeightU * 38) + 120; // 38px per U + header/padding padding
            const maxPrintHeight = 800; // Comfortable height space in A4 format (297mm height minus margins/headers)
            
            let scaleFactor = maxPrintHeight / unscaledHeight;
            if (scaleFactor > 0.95) scaleFactor = 0.95;
            if (scaleFactor < 0.25) scaleFactor = 0.25;
            
            const scaledHeight = unscaledHeight * scaleFactor;
            
            const scaleStyle = {
              transform: `scale(${scaleFactor})`,
              transformOrigin: 'top center',
              height: `${scaledHeight}px`
            };

            return (
              <div key={rack.id} className="print-a4-page">
                <div className="print-page-header">
                  <h2>{selectedDC ? `[${selectedDC.name}] Server Rack Report` : 'Server Rack Report'}</h2>
                  <span>Page {pageIdx + 1} of {getSelectedRacksList().length}</span>
                </div>
                <div className="print-page-racks">
                  <div className="print-rack-wrapper-box">
                    <div className="print-rack-title">
                      <h3>{activeRack.name}</h3>
                      <span style={{ fontSize: '11px', color: '#888' }}>
                        {activeRack.height}U | {activeRack.devices?.length || 0} devices ({activeRack.viewMode === 'back' ? 'Back' : 'Front'})
                      </span>
                    </div>
                    <div className="print-rack-scale-wrapper" style={scaleStyle}>
                      <RackBody rack={activeRack} uOrder={uOrder} canAdd={false} onAddDevice={noop} onDeviceClick={noop} onPortClick={noop} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
  );
}
