// Constants and helpers shared by the Server Rack screen and its rack components.

// Device types of the rack layout; their icons are in deviceTypeIcons.js
export const DEVICE_TYPES = [
  { id: 'Server', label: 'Server', category: 'Compute' },
  { id: 'Nutanix', label: 'Nutanix', category: 'Compute' },
  { id: 'BladeChassis', label: 'Blade Chassis', category: 'Compute' },
  { id: 'Switch', label: 'Switch', category: 'Network' },
  { id: 'Router', label: 'Router', category: 'Network' },
  { id: 'Firewall', label: 'Firewall', category: 'Network' },
  { id: 'LoadBalancer', label: 'Load Balancer', category: 'Network' },
  { id: 'Proxy', label: 'Proxy', category: 'Network' },
  { id: 'ISE', label: 'ISE', category: 'Network' },
  { id: 'Storage', label: 'Storage Array', category: 'Storage' },
  { id: 'NAS', label: 'NAS', category: 'Storage' },
  { id: 'TapeLibrary', label: 'Tape Library', category: 'Storage' },
  { id: 'PatchPanel', label: 'Patch Panel', category: 'Other' },
  { id: 'PowerBar', label: 'PowerBar / PDU', category: 'Other' },
  { id: 'UPS', label: 'UPS', category: 'Other' },
  { id: 'KVM', label: 'KVM Switch', category: 'Other' },
  { id: 'CableManagement', label: 'Cable Management (理線架)', category: 'Other' },
  { id: 'Shelf', label: 'Shelf (層板)', category: 'Other' },
  { id: 'Reserve', label: 'Reserve (預留)', category: 'Other' },
  { id: 'KuaiKuai', label: 'Kuai Kuai (乖乖)', category: 'Other' }
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
