import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEVICE_TYPE_BY_ID, getSplitLocation, ratingText } from './rackShared';

const NETWORK_TYPES = ['Switch', 'Firewall', 'Router', 'LoadBalancer', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'];
const linkCount = (links) => Object.keys(links || {}).length;

function TooltipBody({ device, rack }) {
  const isChassis = ['Nutanix', 'BladeChassis'].includes(device.type) && device.isChassis;
  return (
    <>
      <div className="tooltip-header">{DEVICE_TYPE_BY_ID.get(device.type)?.label || device.type} Info</div>
      <div className="tooltip-row"><span>Location:</span> {rack.isSplitDesign ? getSplitLocation(rack, device.startU) : `U${device.startU}`}</div>
      {['PatchPanel', 'CableManagement'].includes(device.type) && <div className="tooltip-row"><span>Model:</span> {device.model || 'N/A'}</div>}
      {device.type === 'Reserve' && <div className="tooltip-row"><span>Note:</span> {device.note || 'No note'}</div>}
      {device.type === 'KuaiKuai' && (
        <div className="tooltip-row" style={{ color: '#4ade80' }}>
          <span>Expiration:</span> {device.expiryDate ? new Date(device.expiryDate).toLocaleDateString() : 'Never'}
        </div>
      )}
      {device.type === 'Shelf' && <div className="tooltip-row"><span>Type:</span> Shelf / Tray</div>}
      {(device.type === 'Server' || device.type === 'Storage' || (['Nutanix', 'BladeChassis'].includes(device.type) && !device.isChassis)) && (
        <>
          <div className="tooltip-row"><span>Host:</span> {device.hostname || 'N/A'}</div>
          <div className="tooltip-row"><span>iLO:</span> {device.iloIp || 'N/A'}</div>
          <div className="tooltip-ports">Ports: {device.ports || 0} ({linkCount(device.portLinks)} connected)</div>
        </>
      )}
      {isChassis && (
        <div className="tooltip-nodes" style={{ marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.5rem' }}>
          {(device.nodes || []).map((node, idx) => (
            <div key={idx} style={{ marginBottom: idx === (device.nodes.length - 1) ? 0 : '0.5rem', fontSize: '0.75rem' }}>
              <div style={{ color: 'var(--accent-primary)', fontWeight: 'bold', fontSize: '0.8rem', marginBottom: '0.2rem' }}>Node {idx + 1}</div>
              <div className="tooltip-row"><span>Host:</span> {node.hostname || 'N/A'}</div>
              {node.sn && <div className="tooltip-row"><span>SN:</span> {node.sn}</div>}
              <div className="tooltip-row"><span>iLO:</span> {node.iloIp || 'N/A'}</div>
              <div className="tooltip-ports" style={{ fontSize: '0.7rem', marginTop: '0.2rem' }}>Ports: {node.ports || 0} ({linkCount(node.portLinks)} connected)</div>
            </div>
          ))}
        </div>
      )}
      {NETWORK_TYPES.includes(device.type) && (
        <>
          <div className="tooltip-row"><span>Host:</span> {device.hostname}</div>
          {device.ip && <div className="tooltip-row"><span>IP:</span> {device.ip}</div>}
          <div className="tooltip-ports">Ports: {device.ports} ({linkCount(device.portLinks)} connected)</div>
        </>
      )}
      {device.type === 'PowerBar' && (
        <>
          <div className="tooltip-row"><span>Label:</span> {device.hostname || 'PDU'}</div>
          {(device.amps || device.volts) && <div className="tooltip-row"><span>Rating:</span> {ratingText(device.amps, device.volts)}</div>}
          <div className="tooltip-ports">Ways: {device.ways} ({linkCount(device.wayLinks)} connected) {device.rows ? `[${device.rows} Rows]` : ''}</div>
        </>
      )}
    </>
  );
}

// The one device tooltip of the page. Racks call ref.show({ device, rack, rect }) / ref.hide(), so hovering re-renders
// only this component. It is placed beside the hovered icon (left of it when there is no room on the right).
const RackTooltip = forwardRef(function RackTooltip(_props, ref) {
  const [tip, setTip] = useState(null);
  useImperativeHandle(ref, () => ({
    show: (next) => setTip(next),
    hide: () => setTip(null),
  }), []);
  if (!tip) return null;
  const { rect } = tip;
  const roomRight = window.innerWidth - rect.right > 340;
  const style = {
    position: 'fixed',
    top: rect.top + rect.height / 2,
    ...(roomRight ? { left: rect.right + 12 } : { right: window.innerWidth - rect.left + 12 }),
  };
  return createPortal(
    <div className="device-tooltip rack-tooltip" style={style} role="tooltip">
      <TooltipBody device={tip.device} rack={tip.rack} />
    </div>,
    document.body
  );
});

export default RackTooltip;
