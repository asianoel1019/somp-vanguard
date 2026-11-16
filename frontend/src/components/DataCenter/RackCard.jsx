import React, { useEffect, useState } from 'react';
import RackBody from './RackBody';
import { rackBodyHeight } from './rackShared';
import { rackUsage, usageLevel } from './rackUtils';
import { TbArrowsExchange, TbBolt, TbDownload, TbPencil, TbServer2 } from 'react-icons/tb';

// One rack of the layout: header and the face being viewed. Only that face is rendered (the other one is not in the
// page); a flip plays a short 2D turn on this rack alone, swapping the face half way. Memoized: typing in a dialog
// or hovering does not re-render the racks. `actions` must be a stable object (see ServerRack).
// simple / typeKey / fitSize: see RackBody (free space is looked for on front faces only).
function RackCard({ rack, partner, uOrder, role, matchedFront, matchedBack, simple, typeKey, fitSize, actions }) {
  const view = rack.viewMode === 'back' ? 'back' : 'front';
  const [shown, setShown] = useState(view);
  const [turningIn, setTurningIn] = useState(false);
  const turningOut = shown !== view;

  const backRack = partner || { ...rack, name: `${rack.name} (Back)`, devices: [], isBack: true };
  const faceRack = shown === 'back' ? backRack : rack;
  const usage = rackUsage(faceRack);
  const level = usageLevel(usage.pct);

  // A rack out of view is not rendered (content-visibility), so its animation does not run and animationend never
  // comes: finish the turn after the animation time anyway (search jumps to a device on a face being turned to).
  useEffect(() => {
    if (!turningOut && !turningIn) return undefined;
    const t = setTimeout(() => { setShown(view); setTurningIn(false); }, 450);
    return () => clearTimeout(t);
  }, [turningOut, turningIn, view]);

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
            <span className="rack-type-icon"><TbServer2 /></span>
            <h3 className="rack-name">
              {view === 'back' ? (<>{rack.name} <span style={{ color: 'var(--danger)' }}>(Back)</span></>) : rack.name}
            </h3>
            <div className="rack-power-badge">
              <span className={`lightning-icon ${(rack.amps || rack.volts) ? 'active' : ''}`} title={(rack.amps || rack.volts) ? 'Power configured' : 'No power info'}><TbBolt /></span>
              {(rack.amps || rack.volts) && (
                <span className="rack-power-text">
                  {rack.amps && <span>{rack.amps}A</span>}
                  {rack.volts && <span>{rack.volts}V</span>}
                </span>
              )}
            </div>
          </div>
          <div className="rack-info-row">
            <span>{faceRack.devices?.length || 0} devices</span>
            <span className="dot-separator">•</span>
            <span title={`${usage.used}U used, ${usage.free}U free of ${usage.total}U${shown === 'back' ? ' (back)' : ''}`}>
              {usage.used} / {usage.total}U
            </span>
            <span className={`rack-usage-bar is-${level}`} aria-hidden="true"><span style={{ width: `${usage.pct}%` }} /></span>
            <span className={`rack-cap-pct is-${level}`}>{usage.free}U free</span>
          </div>
        </div>
        <div className="rack-header-actions">
          <div className="flex gap-2">
            <button className="btn-icon" title="Flip View" onClick={() => actions.toggleView(rack.id)}><TbArrowsExchange /></button>
            <button className="btn-icon" title="Export to PNG Image" onClick={() => actions.exportRack(rack.id)}><TbDownload /></button>
            {role === 'SuperAdmin' && (
              <button className="btn-icon" title="Edit Rack" onClick={() => actions.editRack(view === 'back' ? backRack : rack)}><TbPencil /></button>
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
            simple={simple} typeKey={typeKey} fitSize={shown === 'back' ? 0 : fitSize}
            onAddDevice={actions.addDevice} onDeviceClick={actions.deviceClick} onPortClick={actions.portClick}
            onTipShow={actions.tipShow} onTipHide={actions.tipHide}
          />
        </div>
      </div>
    </div>
  );
}

export default React.memo(RackCard);
