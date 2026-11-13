import React, { useState } from 'react';
import RackBody from './RackBody';
import { rackBodyHeight } from './rackShared';

// One rack of the layout: header and the face being viewed. Only that face is rendered (the other one is not in the
// page); a flip plays a short 2D turn on this rack alone, swapping the face half way. Memoized: typing in a dialog
// or hovering does not re-render the racks. `actions` must be a stable object (see ServerRack).
function RackCard({ rack, partner, uOrder, role, matchedFront, matchedBack, actions }) {
  const view = rack.viewMode === 'back' ? 'back' : 'front';
  const [shown, setShown] = useState(view);
  const [turningIn, setTurningIn] = useState(false);
  const turningOut = shown !== view;

  const backRack = partner || { ...rack, name: `${rack.name} (Back)`, devices: [], isBack: true };
  const faceRack = shown === 'back' ? backRack : rack;
  const usedU = (rack.devices || []).reduce((sum, d) => sum + (Number(d.sizeU) || 0), 0);

  const onAnimationEnd = (e) => {
    if (e.target !== e.currentTarget) return;
    if (turningOut) { setShown(view); setTurningIn(true); }
    else if (turningIn) setTurningIn(false);
  };

  return (
    <div
      id={`rack-container-${rack.id}`}
      className="rack-wrapper"
      style={{ containIntrinsicSize: `auto 470px auto ${rackBodyHeight(rack) + 110}px` }}
    >
      <div className="rack-header">
        <div className="rack-header-main">
          <div className="rack-title-row">
            <span className="rack-type-icon">🖴</span>
            <h3 className="rack-name">
              {view === 'back' ? (<>{rack.name} <span style={{ color: 'var(--danger)' }}>(Back)</span></>) : rack.name}
            </h3>
            <div className="rack-power-badge">
              <span className={`lightning-icon ${(rack.amps || rack.volts) ? 'active' : ''}`} title={(rack.amps || rack.volts) ? 'Power configured' : 'No power info'}>⚡</span>
              {(rack.amps || rack.volts) && (
                <span className="rack-power-text">
                  {rack.amps && <span>{rack.amps}A</span>}
                  {rack.volts && <span>{rack.volts}V</span>}
                </span>
              )}
            </div>
          </div>
          <div className="rack-info-row">
            <span>{rack.height}U</span>
            <span className="dot-separator">•</span>
            <span>{rack.devices?.length || 0} devices</span>
            <span className="dot-separator">•</span>
            <span>{usedU}U used</span>
          </div>
        </div>
        <div className="rack-header-actions">
          <div className="flex gap-2">
            <button className="btn-icon" title="Flip View" onClick={() => actions.toggleView(rack.id)}>🔄</button>
            <button className="btn-icon" title="Export to PNG Image" onClick={() => actions.exportRack(rack.id)}>📥</button>
            {role === 'SuperAdmin' && (
              <button className="btn-icon" title="Edit Rack" onClick={() => actions.editRack(view === 'back' ? backRack : rack)}>🖊️</button>
            )}
          </div>
        </div>
      </div>

      <div
        className={`rack-body-container${turningOut ? ' is-turning-out' : ''}${turningIn ? ' is-turning-in' : ''}`}
        onAnimationEnd={onAnimationEnd}
      >
        <div className={`rack-face ${shown}`}>
          {shown === 'back' && <div className="rack-back-label">BACK VIEW</div>}
          <RackBody
            rack={faceRack} uOrder={uOrder} canAdd={role !== 'Viewer'} matched={shown === 'back' ? matchedBack : matchedFront}
            onAddDevice={actions.addDevice} onDeviceClick={actions.deviceClick} onPortClick={actions.portClick}
            onTipShow={actions.tipShow} onTipHide={actions.tipHide}
          />
        </div>
      </div>
    </div>
  );
}

export default React.memo(RackCard);
