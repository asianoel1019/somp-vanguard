// Constants and helpers shared by the Server Rack screen and its rack components.

export const DEVICE_TYPES = [
  { id: 'Server', label: 'Server', icon: '🖥️', category: 'Compute' },
  { id: 'Nutanix', label: 'Nutanix', icon: '🏢', category: 'Compute' },
  { id: 'BladeChassis', label: 'Blade Chassis', icon: '🗄️', category: 'Compute' },
  { id: 'Switch', label: 'Switch', icon: '🔀', category: 'Network' },
  { id: 'Router', label: 'Router', icon: '🌐', category: 'Network' },
  { id: 'Firewall', label: 'Firewall', icon: '🔥', category: 'Network' },
  { id: 'LoadBalancer', label: 'Load Balancer', icon: '🖧', category: 'Network' },
  { id: 'Proxy', label: 'Proxy', icon: '🛡️', category: 'Network' },
  { id: 'ISE', label: 'ISE', icon: '🔑', category: 'Network' },
  { id: 'Storage', label: 'Storage Array', icon: '💽', category: 'Storage' },
  { id: 'NAS', label: 'NAS', icon: '💾', category: 'Storage' },
  { id: 'TapeLibrary', label: 'Tape Library', icon: '📼', category: 'Storage' },
  { id: 'PatchPanel', label: 'Patch Panel', icon: '🎛️', category: 'Other' },
  { id: 'PowerBar', label: 'PowerBar / PDU', icon: '🔌', category: 'Other' },
  { id: 'UPS', label: 'UPS', icon: '🔋', category: 'Other' },
  { id: 'KVM', label: 'KVM Switch', icon: '⌨️', category: 'Other' },
  { id: 'CableManagement', label: 'Cable Management (理線架)', icon: '⇄', category: 'Other' },
  { id: 'Shelf', label: 'Shelf (層板)', icon: '📥', category: 'Other' },
  { id: 'Reserve', label: 'Reserve (預留)', icon: '🚧', category: 'Other' },
  { id: 'KuaiKuai', label: 'Kuai Kuai (乖乖)', icon: '💚', category: 'Other' }
];

export const DEVICE_TYPE_BY_ID = new Map(DEVICE_TYPES.map(t => [t.id, t]));

/** Height of one U and of the split divider, in px (ServerRack.css uses the same values). */
export const U_PX = 38;
export const SPLIT_GAP_PX = 24;

// Generates an array from max down to 1 (desc) or 1 up to max (asc)
export const generateUs = (max, order = 'desc') => {
  if (order === 'asc') {
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  return Array.from({ length: max }, (_, i) => max - i);
};

export const getDisplayU = (rack, u) => {
  if (rack.isSplitDesign && u > rack.lowerU) {
    return u - rack.lowerU;
  }
  return u;
};

export const getSplitLocation = (rack, u) => {
  if (!rack) return `U${u}`;
  if (rack.isSplitDesign) {
    if (u > rack.lowerU) {
      return `U${u - rack.lowerU}U`;
    }
    return `D${u}U`;
  }
  return `U${u}`;
};

/** Height in px of a rack body's slot area (U rows plus the split divider). */
export const rackBodyHeight = (rack) => (Number(rack.height) || 42) * U_PX + (rack.isSplitDesign ? SPLIT_GAP_PX : 0);

/** Amps / volts text of a power rating, e.g. "16A / 220V". */
export const ratingText = (amps, volts) => {
  const a = amps ? `${amps}${String(amps).toLowerCase().includes('a') ? '' : 'A'}` : '';
  const v = volts ? `${volts}${String(volts).toLowerCase().includes('v') ? '' : 'V'}` : '';
  return `${a}${a && v ? ' / ' : ''}${v}`;
};
