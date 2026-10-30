import React, { useState, useEffect, useRef } from 'react';
import './ServerRack.css';
import api from '../../api';
import * as htmlToImage from 'html-to-image';
import { useToast } from '../../contexts/ToastContext';




const DEVICE_TYPES = [
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

const DEFAULT_RACK = {
  id: 'rack-1',
  name: 'Main Rack A',
  datacenter: 'HQ-DC1',
  floor: '2F',
  height: 42,
  amps: '',
  volts: '',
  devices: [],
  viewMode: 'front',
  isBack: false,
  partnerId: 'rack-1-back'
};

const DEFAULT_BACK_RACK = {
  id: 'rack-1-back',
  name: 'Main Rack A (Back)',
  datacenter: 'HQ-DC1',
  floor: '2F',
  height: 42,
  devices: [],
  viewMode: 'back',
  isBack: true,
  partnerId: 'rack-1'
};

// Racks as loaded from GET /api/rack, with the UI-only fields filled in
const normalizeLoadedRacks = (data) => data.map(r => ({
  ...r,
  viewMode: r.viewMode || (r.isBack ? 'back' : 'front'),
  devices: r.devices || []
}));

// A new DC with no racks yet starts with one front/back pair (saved on the first change)
const defaultRacksFor = (dc) => {
  const tNow = Date.now();
  return [
    { ...DEFAULT_RACK, id: `rack-${tNow}`, datacenter: dc.name, partnerId: `rack-${tNow}-back` },
    { ...DEFAULT_BACK_RACK, id: `rack-${tNow}-back`, datacenter: dc.name, partnerId: `rack-${tNow}` }
  ];
};

const revisionFromResponse = (res) => {
  const rev = Number(res?.headers?.['x-rack-revision']);
  return Number.isInteger(rev) && rev >= 0 ? rev : 0;
};

// Generates an array from max down to 1 (desc) or 1 up to max (asc)
const generateUs = (max, order = 'desc') => {
  if (order === 'asc') {
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  return Array.from({ length: max }, (_, i) => max - i);
};

const getDisplayU = (rack, u) => {
  if (rack.isSplitDesign && u > rack.lowerU) {
    return u - rack.lowerU;
  }
  return u;
};

const getSplitLocation = (rack, u) => {
  if (!rack) return `U${u}`;
  if (rack.isSplitDesign) {
    if (u > rack.lowerU) {
      return `U${u - rack.lowerU}U`;
    }
    return `D${u}U`;
  }
  return `U${u}`;
};

/**
 * ServerRack Component
 * Manages the layout, devices, network ports, and power links within datacenters and racks.
 * @component
 * @param {Object} props
 * @param {Object} props.selectedDC - The currently selected DataCenter object
 * @param {Array} props.dataCenters - Array of all DataCenters
 * @param {Function} props.setDataCenters - State setter for DataCenters
 * @param {string} props.initialTargetRackId - Optional ID of a rack to highlight initially
 * @param {Function} props.triggerRefresh - Callback to refresh related data (e.g. issues, spare parts)
 */
const DEFAULT_SNMP_FORM = { enabled: false, version: 'v2c', community: '', port: 161 };

export default function ServerRack({ selectedDCId, initialTargetRackId, editRequest, onClearEdit }) {
  const { showToast } = useToast();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const role = user.role || 'Viewer';
  const [racks, setRacks] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Data Center states
  const [dataCenters, setDataCenters] = useState([]);
  const [selectedDC, setSelectedDC] = useState(null);
  const [showDCModal, setShowDCModal] = useState(false);
  const [currentDCForm, setCurrentDCForm] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [zoomLevel, setZoomLevel] = useState(100);

  // Layout Direction & Orientation (Read-only from DataCenter settings)
  const rackOrder = selectedDC?.rackOrder || 'asc'; // 'asc' (L-to-R) | 'desc' (R-to-L)
  const rowOrder = selectedDC?.rowOrder || 'asc';   // 'asc' (1-to-N) | 'desc' (N-to-1)
  const uOrder = selectedDC?.uOrder || 'desc';       // 'desc' (42U-to-1U) | 'asc' (1U-to-42U)

  // Modal states
  const [showRackModal, setShowRackModal] = useState(false);
  const [currentRack, setCurrentRack] = useState(null); // Used for add/edit rack

  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [activeDeviceTab, setActiveDeviceTab] = useState('detail');
  const [editingPort, setEditingPort] = useState(null); // { portIndex, target, targetPort, cableColor }
  const [snmpForm, setSnmpForm] = useState(DEFAULT_SNMP_FORM);
  // SNMP query switch as saved on the server (the form checkbox applies only after Save)
  const [snmpSavedEnabled, setSnmpSavedEnabled] = useState(false);
  const [pollData, setPollData] = useState(null);
  const [pollLoading, setPollLoading] = useState(false);

  // System Modals
  const [sysAlert, setSysAlert] = useState(null); // { message: '' }
  const [sysConfirm, setSysConfirm] = useState(null); // { message: '', onConfirm: fn }

  // Port Status Modal states
  const [showPortStatusModal, setShowPortStatusModal] = useState(false);
  const [portStatusDevice, setPortStatusDevice] = useState(null);

  // Move Device Modal states
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTargetRackId, setMoveTargetRackId] = useState('');
  const [moveTargetSection, setMoveTargetSection] = useState('Down'); // 'Down' or 'Up' for split racks
  const [moveTargetU, setMoveTargetU] = useState(1);
  const [moveTargetToBack, setMoveTargetToBack] = useState(false);
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveError, setMoveError] = useState('');

  // Print selector states
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [selectedPrintRacks, setSelectedPrintRacks] = useState({});
  const [isPrinting, setIsPrinting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [expandedPrintRows, setExpandedPrintRows] = useState({});

  const CABLE_COLORS = {
    Red: '#ef4444', Blue: '#3b82f6', Yellow: '#eab308', Green: '#22c55e',
    Orange: '#f97316', Purple: '#a855f7', Black: '#1e293b', White: '#f8fafc'
  };

  const [currentDevice, setCurrentDevice] = useState(null);
  const [targetRackId, setTargetRackId] = useState(null);
  const [targetU, setTargetU] = useState(null);

  const allDevicesInDC = React.useMemo(() => {
    let devices = [];
    racks.forEach(r => {
      (r.devices || []).forEach(d => {
        if (!['Shelf', 'Reserve', 'PatchPanel', 'CableManagement'].includes(d.type) && d.id !== currentDevice?.id) {
          devices.push(d);
        }
      });
    });
    return devices.sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));
  }, [racks, currentDevice]);

  const openPortEditor = (portIndex, existingLink) => {
    let target = '';
    let targetPort = '';
    let cableColor = 'Blue';
    if (typeof existingLink === 'string') {
      target = existingLink;
    } else if (existingLink && typeof existingLink === 'object') {
      target = existingLink.target || '';
      targetPort = existingLink.targetPort || '';
      cableColor = existingLink.cableColor || 'Blue';
    }
    setEditingPort({ portIndex, target, targetPort, cableColor });
  };

  // HW Report Modal states
  const [showHWTableModal, setShowHWTableModal] = useState(false);
  const [showHWFormModal, setShowHWFormModal] = useState(false);
  const [currentHWForm, setCurrentHWForm] = useState(null);

  // Action Modal states
  const [showActionModal, setShowActionModal] = useState(false);
  const [currentActionDevice, setCurrentActionDevice] = useState(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  // Rack save bookkeeping (refs: read in async save callbacks, never during render)
  const racksRef = useRef([]);          // latest racks, also updated synchronously by saveRacks
  const revisionsRef = useRef({});      // dcId -> server rack revision (X-Rack-Revision / save responses)
  const saveEpochRef = useRef({});      // dcId -> bumped on a failed save so queued saves built on it are dropped
  const serverRackIdsRef = useRef({});  // dcId -> Set of rack ids the server has (PATCH only works for those)
  const saveChainRef = useRef(Promise.resolve()); // saves run one at a time so each sends the latest revision
  const activeDcIdRef = useRef(null);

  useEffect(() => {
    racksRef.current = racks;
  }, [racks]);

  const fetchDataCenters = () => api.get('/rack/datacenters').then(res => {
    setDataCenters(res.data);
    return res.data;
  });

  useEffect(() => {
    api.get('/rack/datacenters').then(res => {
      setDataCenters(res.data);
    }).catch(console.error);
  }, []);

  // Handle cross-tab edit requests
  useEffect(() => {
    if (editRequest && racks.length > 0) {
      let foundDevice = null;
      let foundRackId = null;
      for (let r of racks) {
        for (let d of (r.devices || [])) {
          if (d.id === editRequest.device.id) {
            foundDevice = d;
            foundRackId = r.id;
            break;
          }
        }
        if (foundDevice) break;
      }
      if (foundDevice) {
        setTargetRackId(foundRackId);
        setCurrentDevice({ ...foundDevice });
        if (editRequest.defaultTab) setActiveDeviceTab(editRequest.defaultTab);
        setShowDeviceModal(true);
      }
    }
  }, [editRequest, racks]);

  const closeDeviceModal = () => {
    setShowDeviceModal(false);
    if (onClearEdit) onClearEdit();
  };

  useEffect(() => {
    if (dataCenters.length > 0) {
      const targetDcId = selectedDCId || sessionStorage.getItem('dc_selected_dc_id') || localStorage.getItem('dc_selected_dc_id');
      if (targetDcId) {
        setSelectedDC(dataCenters.find(d => d.id === targetDcId) || dataCenters[0]);
      } else {
        setSelectedDC(dataCenters[0]);
      }
    }
  }, [selectedDCId, dataCenters]);

  useEffect(() => {
    if (selectedDC) {
      const dc = selectedDC;
      activeDcIdRef.current = dc.id;
      setInitialLoaded(false);
      api.get(`/rack?dcId=${encodeURIComponent(dc.id)}`).then(res => {
        if (activeDcIdRef.current !== dc.id) return;
        revisionsRef.current[dc.id] = revisionFromResponse(res);
        serverRackIdsRef.current[dc.id] = new Set((res.data || []).map(r => r.id));
        const next = res.data && res.data.length > 0 ? normalizeLoadedRacks(res.data) : defaultRacksFor(dc);
        racksRef.current = next;
        setRacks(next);
        setInitialLoaded(true);
      }).catch(err => {
        console.error('Failed to load DC data:', err);
        setInitialLoaded(true);
      });
    }
  }, [selectedDC]);

  // Replaces the local racks with the server copy (after a rejected save or a move)
  const reloadRacks = async (dc) => {
    try {
      const res = await api.get(`/rack?dcId=${encodeURIComponent(dc.id)}`);
      revisionsRef.current[dc.id] = revisionFromResponse(res);
      serverRackIdsRef.current[dc.id] = new Set((res.data || []).map(r => r.id));
      if (activeDcIdRef.current !== dc.id) return;
      const next = res.data && res.data.length > 0 ? normalizeLoadedRacks(res.data) : defaultRacksFor(dc);
      racksRef.current = next;
      setRacks(next);
    } catch (err) {
      console.error('Failed to reload racks:', err);
      showToast('重新載入機櫃資料失敗，請重新整理頁面', 'error');
    }
  };

  // Robust target rack locator and smooth scroll effect
  useEffect(() => {
    const targetId = initialTargetRackId || sessionStorage.getItem('dc_target_rack_id') || localStorage.getItem('dc_target_rack_id');
    if (targetId && racks.length > 0) {
      let actualId = targetId;
      const partner = racks.find(r => r.id === targetId || r.partnerId === targetId);
      if (partner && partner.isBack) {
        actualId = partner.partnerId;
      }

      let attempts = 0;
      const maxAttempts = 20;
      const interval = setInterval(() => {
        attempts++;
        const el = document.getElementById(`rack-container-${actualId}`);
        if (el) {
          clearInterval(interval);
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          
          const originalBorder = el.style.border;
          const originalBoxShadow = el.style.boxShadow;
          const originalTransform = el.style.transform;
          el.style.border = '3px solid var(--accent-primary)';
          el.style.boxShadow = '0 0 25px rgba(59, 130, 246, 0.9)';
          el.style.transform = 'scale(1.02)';
          el.style.transition = 'all 0.4s ease';

          setTimeout(() => {
            el.style.border = originalBorder;
            el.style.boxShadow = originalBoxShadow;
            el.style.transform = originalTransform;
          }, 3500);

          try {
            sessionStorage.removeItem('dc_target_rack_id');
            localStorage.removeItem('dc_target_rack_id');
          } catch (e) {}
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
        }
      }, 100);

      return () => clearInterval(interval);
    }
  }, [racks, initialTargetRackId]);

  /**
   * @param {function|Array} updater 
   */
  const saveRacks = (updater) => {
    const prev = racksRef.current;
    // Updaters may mutate nested objects (port sync), so they work on a copy and `prev` stays the diff baseline
    const working = JSON.parse(JSON.stringify(prev));
    const newRacks = typeof updater === 'function' ? updater(working) : updater;
    racksRef.current = newRacks;
    setRacks(newRacks);

    if (!selectedDC || role === 'Viewer') return;

    let patchData = null;
    if (newRacks.length === prev.length) {
      patchData = newRacks.filter(nr => {
        const old = prev.find(pr => pr.id === nr.id);
        return JSON.stringify(nr) !== JSON.stringify(old);
      });
      if (patchData.length === 0) return; // nothing changed
    }

    const dc = selectedDC;
    const epoch = saveEpochRef.current[dc.id] || 0;

    saveChainRef.current = saveChainRef.current.then(async () => {
      // a previous save of this DC was rejected and the racks reloaded: this change was built on discarded state
      if ((saveEpochRef.current[dc.id] || 0) !== epoch) return;
      // PATCH only racks the server already has (e.g. the default pair of a new DC is first saved with POST)
      const known = serverRackIdsRef.current[dc.id] || new Set();
      const method = patchData && patchData.length < newRacks.length && patchData.every(r => known.has(r.id)) ? 'patch' : 'post';
      const payload = method === 'patch' ? patchData : newRacks;
      const rev = revisionsRef.current[dc.id] || 0;
      const confirm = method === 'post' && payload.length === 0 ? '&confirm=true' : '';
      try {
        const res = await api[method](`/rack?dcId=${encodeURIComponent(dc.id)}&rev=${rev}${confirm}`, payload);
        if (Number.isInteger(res.data?.revision)) revisionsRef.current[dc.id] = res.data.revision;
        if (method === 'post') serverRackIdsRef.current[dc.id] = new Set(payload.map(r => r.id));
      } catch (err) {
        console.error('Failed to save racks:', err);
        saveEpochRef.current[dc.id] = epoch + 1;
        if (err.response?.status === 409) {
          showToast('資料已被其他人修改，請重新載入。已載入最新資料，您這次的變更未儲存。', 'error');
        } else {
          showToast(`儲存機櫃變更失敗，已重新載入伺服器資料：${err.response?.data?.error || err.message}`, 'error');
        }
        await reloadRacks(dc);
      }
    });
  };

  const openDCManager = () => {
    setCurrentDCForm({ ...selectedDC });
    setDeleteConfirmText('');
    setShowDCModal(true);
  };

  const saveDCInfo = async (e) => {
    e.preventDefault();
    const isExisting = !!currentDCForm.id && dataCenters.some(dc => dc.id === currentDCForm.id);
    // id goes in the URL; usedRacks is computed by the server on read and never saved
    const payload = { ...currentDCForm };
    delete payload.id;
    delete payload.usedRacks;
    try {
      const res = isExisting
        ? await api.put(`/rack/datacenters/${encodeURIComponent(currentDCForm.id)}`, payload)
        : await api.post('/rack/datacenters/item', payload);
      const savedId = res.data?.dataCenter?.id || currentDCForm.id;
      const fresh = await fetchDataCenters();
      setSelectedDC(fresh.find(dc => dc.id === savedId) || fresh[0] || null);
      setShowDCModal(false);
    } catch (err) {
      console.error('Failed to save DC:', err);
      showToast(`Failed to save Data Center: ${err.response?.data?.error || err.message}`, 'error');
      fetchDataCenters().catch(console.error);
    }
  };

  const addNewDC = () => {
    // no id: the server assigns one on create
    setCurrentDCForm({
      name: 'New Data Center',
      address: '',
      contact: '',
      contactNumber: '',
      acl: []
    });
  };

  const updateACL = (idx, field, val) => {
    const newACL = [...(currentDCForm.acl || [])];
    if (!newACL[idx]) newACL[idx] = { name: '', phone: '' };
    newACL[idx][field] = val;
    setCurrentDCForm({ ...currentDCForm, acl: newACL });
  };

  const addACLRow = () => {
    setCurrentDCForm({ ...currentDCForm, acl: [...(currentDCForm.acl || []), { name: '', phone: '' }] });
  };

  const removeACLRow = (idx) => {
    setCurrentDCForm({ ...currentDCForm, acl: currentDCForm.acl.filter((_, i) => i !== idx) });
  };

  const handleOpenPrintModal = () => {
    const initialSelected = {};
    racks.forEach(r => {
      if (!r.isBack) {
        initialSelected[r.id] = true;
      }
    });
    setSelectedPrintRacks(initialSelected);
    setExpandedPrintRows({}); // Collapse all rows by default
    setShowPrintModal(true);
  };

  const handleTriggerPrint = () => {
    setIsPrinting(true);
    setShowPrintModal(false);
    setTimeout(() => {
      window.print();
      setIsPrinting(false);
    }, 500);
  };

  const handleTriggerExport = () => {
    setIsExporting(true);
    setShowPrintModal(false);
    
    setTimeout(async () => {
      const el = document.getElementById('export-combined-container');
      if (el) {
        try {
          const dataUrl = await htmlToImage.toPng(el, {
            cacheBust: true,
            backgroundColor: '#0b0c13',
            style: {
              transform: 'none',
              margin: '0',
            }
          });
          
          const dcName = selectedDC ? selectedDC.name : 'DataCenter';
          const link = document.createElement('a');
          link.download = `${dcName}_ServerRacks.png`;
          link.href = dataUrl;
          link.click();
        } catch (err) {
          console.error('Failed to export combined rack image:', err);
        } finally {
          setIsExporting(false);
        }
      } else {
        setIsExporting(false);
      }
    }, 800);
  };

  const handleExportSingleRack = (rackId) => {
    setSelectedPrintRacks({ [rackId]: true });
    setIsExporting(true);
    
    setTimeout(async () => {
      const el = document.getElementById(`export-rack-${rackId}`);
      if (el) {
        try {
          const rack = racks.find(r => r.id === rackId);
          const backRack = racks.find(r => r.id === rack.partnerId) || { ...rack, name: `${rack.name} (Back)`, devices: [], isBack: true };
          const activeRack = rack.viewMode === 'back' ? backRack : rack;

          const dataUrl = await htmlToImage.toPng(el, {
            cacheBust: true,
            backgroundColor: '#0b0c13',
            style: {
              transform: 'none',
              margin: '0',
            }
          });
          
          const link = document.createElement('a');
          link.download = `${activeRack.name}.png`;
          link.href = dataUrl;
          link.click();
        } catch (err) {
          console.error('Failed to export single rack:', err);
        } finally {
          setIsExporting(false);
        }
      } else {
        setIsExporting(false);
      }
    }, 800);
  };


  // Rack Handlers
  const autofillRackFromRow = (rackObj, targetRow) => {
    const existingRack = racks.find(r => r.rowNumber === targetRow && !r.isBack);
    if (existingRack) {
      return {
        ...rackObj,
        rowNumber: targetRow,
        floor: existingRack.floor || '',
        height: existingRack.height || 42,
        isSplitDesign: existingRack.isSplitDesign || false,
        upperU: existingRack.upperU || 20,
        lowerU: existingRack.lowerU || 22,
        amps: existingRack.amps || '',
        volts: existingRack.volts || ''
      };
    }
    return { ...rackObj, rowNumber: targetRow };
  };

  const openAddRack = () => {
    const currentFrontRacks = racks.filter(r => !r.isBack).length;
    if (selectedDC && selectedDC.totalRacks > 0 && currentFrontRacks >= selectedDC.totalRacks) {
      setSysAlert({ message: `Cannot add more racks. The Data Center limit of ${selectedDC.totalRacks} has been reached.` });
      return;
    }

    const frontId = `rack-${Date.now()}`;
    const backId = `${frontId}-back`;

    let baseRack = {
      id: frontId,
      name: '',
      datacenter: selectedDC?.name || '',
      floor: '',
      height: 42,
      isSplitDesign: false,
      upperU: 20,
      lowerU: 22,
      amps: '',
      volts: '',
      devices: [],
      viewMode: 'front',
      isBack: false,
      partnerId: backId,
      rowNumber: 1
    };

    baseRack = autofillRackFromRow(baseRack, 1);
    setCurrentRack(baseRack);
    setShowRackModal(true);
  };

  const openEditRack = (rack) => {
    setCurrentRack({ ...rack });
    setShowRackModal(true);
  };

  const saveRack = (e) => {
    e.preventDefault();
    saveRacks(prev => {
      const idx = prev.findIndex(r => r.id === currentRack.id);
      if (idx !== -1) {
        // Edit existing
        return prev.map(r => {
          if (r.id === currentRack.id) return { ...currentRack };
          if (r.id === currentRack.partnerId) {
            return {
              ...r,
              name: `${currentRack.name} (Back)`,
              datacenter: currentRack.datacenter,
              floor: currentRack.floor,
              height: currentRack.height,
              amps: currentRack.amps,
              volts: currentRack.volts,
              rowNumber: currentRack.rowNumber,
              isSplitDesign: currentRack.isSplitDesign,
              upperU: currentRack.upperU,
              lowerU: currentRack.lowerU
            };
          }
          return r;
        });
      } else {
        // New rack + its back partner
        const backRack = {
          ...currentRack,
          id: currentRack.partnerId,
          name: `${currentRack.name} (Back)`,
          isBack: true,
          partnerId: currentRack.id,
          viewMode: 'back',
          devices: [],
          amps: currentRack.amps,
          volts: currentRack.volts,
          rowNumber: currentRack.rowNumber,
          isSplitDesign: currentRack.isSplitDesign,
          upperU: currentRack.upperU,
          lowerU: currentRack.lowerU
        };
        return [...prev, currentRack, backRack];
      }
    });
    setShowRackModal(false);
  };

  const removeRack = (rackId) => {
    setSysConfirm({
      message: 'Delete this rack and its partner (Back)?',
      onConfirm: () => {
        const rackToDelete = racks.find(r => r.id === rackId);
        const partnerId = rackToDelete?.partnerId;
        saveRacks(prev => prev.filter(r => r.id !== rackId && r.id !== partnerId));
        setShowRackModal(false);
      }
    });
  };

  const toggleRackView = (rackId) => {
    setRacks(prev => prev.map(r => r.id === rackId ? { ...r, viewMode: r.viewMode === 'back' ? 'front' : 'back' } : r));
  };

  // Device Handlers
  const openAddDevice = (rackId, uNumber) => {
    setActiveDeviceTab('detail');
    setTargetRackId(rackId);
    setTargetU(uNumber);
    setCurrentDevice({
      id: `dev-${Date.now()}`,
      type: 'Server',
      startU: uNumber,
      sizeU: 1,
      hostname: '',
      ip: '',
      iloIp: '',
      cvmIp: '',
      sn: '',
      model: '',
      isChassis: false,
      nodeCount: 1,
      nodes: [],
      // PowerBar specific
      rows: 1,
      ways: 8,
      amps: '',
      volts: '',
      orientation: 'horizontal',
      side: 'left',
      wayLinks: {},
      // Shared / General Hardware
      ports: 4,
      portLinks: {},
      note: ''
    });
    setSnmpForm(DEFAULT_SNMP_FORM);
    setSnmpSavedEnabled(false);
    setPollData(null);
    setShowDeviceModal(true);
  };

  const openActionModal = (rackId, device) => {
    setTargetRackId(rackId);
    setCurrentActionDevice({ ...device });
    setShowActionModal(true);
  };

  const openEditDevice = (rackId, device) => {
    setActiveDeviceTab('detail');
    setTargetRackId(rackId);
    setCurrentDevice({ ...device });

    // Check SNMP Settings
    if (['Switch', 'Router', 'Firewall', 'LoadBalancer', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(device.type)) {
      setSnmpForm(DEFAULT_SNMP_FORM);
      setSnmpSavedEnabled(false);
      api.get(`/network-device/${device.id}/snmp`).then(res => {
        const data = res.data && typeof res.data === 'object' ? res.data : {};
        setSnmpForm({ ...DEFAULT_SNMP_FORM, ...data, enabled: !!data.enabled });
        setSnmpSavedEnabled(!!data.enabled);
      }).catch(console.error);
    } else {
      setSnmpForm(DEFAULT_SNMP_FORM);
      setSnmpSavedEnabled(false);
    }
    setPollData(null);
    setShowDeviceModal(true);
  };

  // SNMP poll: the server always uses the IP saved in the rack, never one sent by the client
  const pollCurrentDevice = () => {
    if (!currentDevice?.id || !snmpSavedEnabled) return;
    const savedDevice = racks.flatMap(r => r.devices || []).find(d => d.id === currentDevice.id);
    if (!savedDevice || (savedDevice.ip || '') !== (currentDevice.ip || '')) {
      setSysAlert({ message: 'IP 位址已修改但尚未儲存，請先儲存設備後再進行 SNMP 查詢 (查詢一律使用已儲存的 IP)。' });
      return;
    }
    setPollLoading(true);
    api.get(`/network-device/${currentDevice.id}/poll`).then(res => {
      setPollData(res.data);
      if (res.data && res.data.ports) {
        setCurrentDevice(prev => ({ ...prev, ports: res.data.ports.length, livePorts: res.data.ports }));
        setRacks(prev => prev.map(r => {
          if (r.id === currentDevice.rackId || r.id === targetRackId) {
            return { ...r, devices: (r.devices || []).map(d => d.id === currentDevice.id ? { ...d, ports: res.data.ports.length, livePorts: res.data.ports } : d) };
          }
          return r;
        }));
      }
    }).catch(err => {
      setPollData(null);
      setSysAlert({ message: 'SNMP 查詢失敗: ' + (err.response?.data?.error || err.message) });
    }).finally(() => setPollLoading(false));
  };
  const snmpLive = snmpSavedEnabled && !!(snmpForm?.community || snmpForm?.v3User);

  const openMoveModal = () => {
    const srcRack = racks.find(r => r.id === targetRackId) || racks[0];
    const isSrcBack = !!srcRack?.isBack;
    setMoveTargetToBack(isSrcBack);
    const baseFrontRack = isSrcBack
      ? (racks.find(r => !r.isBack && (r.partnerId === srcRack.id || r.id === srcRack.partnerId)) || srcRack)
      : srcRack;
    setMoveTargetRackId(baseFrontRack?.id || (racks[0]?.id || ''));
    if (srcRack?.isSplitDesign) {
      if (currentDevice.startU > srcRack.lowerU) {
        setMoveTargetSection('Up');
        setMoveTargetU(currentDevice.startU - srcRack.lowerU);
      } else {
        setMoveTargetSection('Down');
        setMoveTargetU(currentDevice.startU);
      }
    } else {
      setMoveTargetSection('Down');
      setMoveTargetU(currentDevice.startU || 1);
    }
    setMoveError('');
    setShowMoveModal(true);
  };

  const saveDevice = (e) => {
    e.preventDefault();
    const newSize = parseInt(currentDevice.sizeU);
    const newStart = parseInt(currentDevice.startU);
    const newEnd = newStart + newSize - 1;

    // Clean up data before saving to state (minimizes JSON size)
    let cleaned = { ...currentDevice, sizeU: newSize, startU: newStart };

    if (cleaned.type !== 'PowerBar') {
      delete cleaned.ways;
      delete cleaned.orientation;
      delete cleaned.side;
      delete cleaned.wayLinks;
    }
    if (cleaned.type !== 'PowerBar' && cleaned.type !== 'Switch') {
      delete cleaned.rows;
    }
    if (!['Nutanix', 'BladeChassis'].includes(cleaned.type)) {
      delete cleaned.cvmIp;
      delete cleaned.isChassis;
      delete cleaned.nodeCount;
      delete cleaned.nodes;
    }

    if (cleaned.type === 'Shelf') {
      delete cleaned.hostname;
      delete cleaned.ip;
      delete cleaned.iloIp;
      delete cleaned.sn;
      delete cleaned.model;
      delete cleaned.ports;
      delete cleaned.portLinks;
      delete cleaned.note;
    }

    if (!['Nutanix', 'BladeChassis', 'Reserve'].includes(cleaned.type)) {
      delete cleaned.note;
    }

    const targetRack = racks.find(r => r.id === targetRackId);
    if (targetRack) {
      if (newEnd > targetRack.height) {
        setSysAlert({ message: 'Device cannot exceed rack height!' });
        return;
      }
      if (targetRack.isSplitDesign && newStart <= targetRack.lowerU && newEnd > targetRack.lowerU) {
        setSysAlert({ message: '設備不可跨越上下分離 (Split) 的分界！' });
        return;
      }
      const hasCollision = (targetRack.devices || []).some(dev => {
        if (dev.id === cleaned.id) return false;
        const devEnd = dev.startU + dev.sizeU - 1;
        return Math.max(newStart, dev.startU) <= Math.min(newEnd, devEnd);
      });
      if (hasCollision) {
        setSysAlert({ message: 'U slots overlap with another device!' });
        return;
      }
    }

    saveRacks(prev => {
      let updatedRacks = prev.map(rack => {
        if (rack.id === targetRackId) {
          const devicesList = rack.devices || [];
          const existingIdx = devicesList.findIndex(d => d.id === cleaned.id);
          const newDevices = [...devicesList];
          if (existingIdx !== -1) {
            newDevices[existingIdx] = cleaned;
          } else {
            newDevices.push(cleaned);
          }
          return { ...rack, devices: newDevices };
        }
        return rack;
      });

      // --- Bidirectional Port Sync ---
      const oldDeviceObj = prev.flatMap(r => r.devices || []).find(d => d.id === cleaned.id) || {};

      const updateTargetDevicePort = (targetHostname, targetPortStr, linkData) => {
        for (let r of updatedRacks) {
          for (let d of (r.devices || [])) {
            if ((d.hostname || d.name) === targetHostname) {
              if (targetPortStr.startsWith('P')) {
                const tIdx = parseInt(targetPortStr.substring(1)) - 1;
                if (!d.portLinks) d.portLinks = {};
                if (linkData) {
                  d.portLinks[tIdx] = linkData;
                } else {
                  delete d.portLinks[tIdx];
                }
              }
            }
          }
        }
      };

      const oldLinks = oldDeviceObj.portLinks || {};
      const newLinks = cleaned.portLinks || {};

      // 1. Remove obsolete reciprocal links
      Object.keys(oldLinks).forEach(portIdx => {
        const oldL = oldLinks[portIdx];
        const newL = newLinks[portIdx];

        let oldTarget = typeof oldL === 'string' ? oldL : (oldL?.target || '');
        let oldTargetPort = typeof oldL === 'string' ? '' : (oldL?.targetPort || '');

        let newTarget = typeof newL === 'string' ? newL : (newL?.target || '');
        let newTargetPort = typeof newL === 'string' ? '' : (newL?.targetPort || '');

        if (oldTarget && oldTargetPort && (oldTarget !== newTarget || oldTargetPort !== newTargetPort)) {
          updateTargetDevicePort(oldTarget, oldTargetPort, null);
        }
      });

      // 2. Add new reciprocal links
      Object.keys(newLinks).forEach(portIdx => {
        const newL = newLinks[portIdx];
        let newTarget = typeof newL === 'string' ? newL : (newL?.target || '');
        let newTargetPort = typeof newL === 'string' ? '' : (newL?.targetPort || '');
        let cableColor = typeof newL === 'string' ? 'Blue' : (newL?.cableColor || 'Blue');

        if (newTarget && newTargetPort) {
          updateTargetDevicePort(newTarget, newTargetPort, {
            target: cleaned.hostname || cleaned.name || '',
            targetPort: `P${parseInt(portIdx) + 1}`,
            cableColor
          });
        }
      });

      return updatedRacks;
    });
    closeDeviceModal();
  };

  const removeDevice = () => {
    setSysConfirm({
      message: 'Remove this device?',
      onConfirm: () => {
        saveRacks(prev => prev.map(rack => {
          if (rack.id === targetRackId) {
            return { ...rack, devices: (rack.devices || []).filter(d => d.id !== currentDevice.id) };
          }
          return rack;
        }));
        closeDeviceModal();
      }
    });
  };

  const isMatched = (device) => {
    if (!searchQuery) return false;
    const q = searchQuery.toLowerCase();

    // Check main device fields
    if (
      (device.hostname && device.hostname.toLowerCase().includes(q)) ||
      (device.ip && device.ip.includes(q)) ||
      (device.cvmIp && device.cvmIp.includes(q)) ||
      (device.sn && device.sn.toLowerCase().includes(q)) ||
      (device.model && device.model.toLowerCase().includes(q)) ||
      (device.note && device.note.toLowerCase().includes(q))
    ) return true;

    if (['Nutanix', 'BladeChassis'].includes(device.type) && device.isChassis && device.nodes) {
      return device.nodes.some(n => n && (
        (n.hostname && n.hostname.toLowerCase().includes(q)) ||
        (n.ip && n.ip.includes(q)) ||
        (n.cvmIp && n.cvmIp.includes(q)) ||
        (n.iloIp && n.iloIp.includes(q)) ||
        (n.sn && n.sn.toLowerCase().includes(q)) ||
        (n.model && n.model.toLowerCase().includes(q))
      ));
    }

    return false;
  };

  const handleNodeChange = (idx, field, val) => {
    const newNodes = [...(currentDevice.nodes || [])];
    if (!newNodes[idx]) newNodes[idx] = { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} };
    newNodes[idx][field] = val;
    setCurrentDevice({ ...currentDevice, nodes: newNodes });
  };

  const jumpToDeviceLocation = (deviceId) => {
    const foundRack = racks.find(r => r.devices?.some(d => d.id === deviceId));
    if (foundRack) {
      setShowHWTableModal(false);
      handleResultClick({ type: 'device', rack: foundRack, device: foundRack.devices.find(d => d.id === deviceId) });
    }
  };

  const searchResults = React.useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    const results = [];

    racks.forEach(rack => {
      // Check rack name
      if (!rack.isBack && rack.name && rack.name.toLowerCase().includes(q)) {
        results.push({ type: 'rack', rack });
      }

      // Check devices
      (rack.devices || []).forEach(device => {
        if (isMatched(device)) {
          results.push({ type: 'device', rack, device });
        }
      });
    });

    return results;
  }, [searchQuery, racks]);

  const handleResultClick = (res) => {
    const rackId = res.rack.id;
    const rack = racks.find(r => r.id === rackId);
    if (!rack) return;

    if (rack.isBack) {
      const parentRackId = rack.partnerId;
      setRacks(prev => prev.map(r => r.id === parentRackId ? { ...r, viewMode: 'back' } : r));
    } else {
      setRacks(prev => prev.map(r => r.id === rackId ? { ...r, viewMode: 'front' } : r));
    }

    // Wait for flip animation before scrolling
    setTimeout(() => {
      const elId = res.type === 'rack' ? `rack-container-${rackId}` : `device-${rackId}-${res.device.id}`;
      const el = document.getElementById(elId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        // Highlight effect
        const originalBorder = el.style.border;
        const originalBoxShadow = el.style.boxShadow;
        el.style.border = '2px solid var(--accent-primary)';
        el.style.boxShadow = '0 0 20px rgba(59, 130, 246, 0.8)';
        setTimeout(() => {
          el.style.border = originalBorder;
          el.style.boxShadow = originalBoxShadow;
        }, 3000);
      }
    }, 850);
  };

  const openReportForm = (device, rackId, nodeInfo = null) => {
    setShowActionModal(false);
    const rack = racks.find(r => r.id === rackId);
    let reporterName = '';
    try {
      reporterName = JSON.parse(localStorage.getItem('user'))?.username || '';
    } catch (e) { }

    const deviceNameStr = nodeInfo ? `Node: ${nodeInfo.hostname || 'Unknown'} (${device.hostname || device.type})` : (device.hostname || device.type);
    const snStr = nodeInfo && nodeInfo.sn ? nodeInfo.sn : (device.sn || '');

    setCurrentHWForm({
      id: Date.now().toString(36) + Math.random().toString(36).substring(2),
      deviceId: device.id,
      deviceName: deviceNameStr,
      sn: snStr,
      datacenter: selectedDC?.name || '',
      rackLoc: `${rack?.name || ''} (${getSplitLocation(rack, device.startU)})`,
      date: new Date().toISOString().split('T')[0],
      failedParts: '',
      partsInfo: '',
      reporter: reporterName,
      urgency: 'M',
      status: 'Open',
      processNotes: []
    });
    setShowHWFormModal(true);
  };

  const renderRackBody = (rack) => {
    const sideDevices = rack.devices || [];
    const isUOrderAsc = uOrder === 'asc'; // 1U at top, 42U at bottom

    return (
      <div className="rack-body">
        {/* Left Rail */}
        <div className="rack-rail left">
          {generateUs(rack.height, uOrder).map(u => (
            <React.Fragment key={u}>
              <div className="rail-u">
                <div className="rail-hole"></div>
                <span className="rail-u-number">{getDisplayU(rack, u)}</span>
                <div className="rail-hole"></div>
              </div>
              {rack.isSplitDesign && u === rack.lowerU + 1 && (
                <div className="rail-divider" style={{ height: '24px', background: 'linear-gradient(90deg, #1e293b, #334155, #1e293b)', borderTop: '2px solid #0f172a', borderBottom: '2px solid #0f172a' }}></div>
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Center Slots Area */}
        <div className="rack-slots" style={{ position: 'relative', height: `${rack.height * 38 + (rack.isSplitDesign ? 24 : 0)}px` }}>
          {generateUs(rack.height, uOrder).map(u => (
            <React.Fragment key={u}>
              <div
                className={`u-slot ${sideDevices.some(d => u >= d.startU && u < d.startU + d.sizeU) ? 'is-occupied' : ''}`}
                onClick={() => {
                  const isOccupied = sideDevices.some(d => u >= d.startU && u < d.startU + d.sizeU);
                  if (!isOccupied && role !== 'Viewer') openAddDevice(rack.id, u);
                }}
              >
              </div>
              {rack.isSplitDesign && u === rack.lowerU + 1 && (
                <div className="slot-divider" style={{ height: '24px', background: 'repeating-linear-gradient(45deg, #0f172a, #0f172a 10px, #1e293b 10px, #1e293b 20px)', borderTop: '2px solid #000', borderBottom: '2px solid #000', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '10px', fontWeight: 'bold', letterSpacing: '2px' }}>
                  --- SPLIT DIVIDER ---
                </div>
              )}
            </React.Fragment>
          ))}

          {sideDevices.map(device => {
            const icon = DEVICE_TYPES.find(t => t.id === device.type)?.icon || '🖥️';
            
            // Positioning calculation based on uOrder:
            const posStyle = isUOrderAsc ? {
              top: `${(device.startU - 1) * 38 + (rack.isSplitDesign && device.startU > rack.lowerU ? 24 : 0)}px`,
              bottom: 'auto'
            } : {
              bottom: `${(device.startU - 1) * 38 + (rack.isSplitDesign && device.startU > rack.lowerU ? 24 : 0)}px`,
              top: 'auto'
            };

            return (
              <div
                id={`device-${rack.id}-${device.id}`}
                key={device.id}
                className={`device-block ${isMatched(device) ? 'search-highlight' : ''}`}
                style={{
                  ...posStyle,
                  height: `${device.sizeU * 38 + (rack.isSplitDesign && device.startU <= rack.lowerU && (device.startU + device.sizeU - 1) > rack.lowerU ? 24 : 0)}px`,
                  ...(device.type === 'PowerBar' && device.orientation === 'vertical' ? {
                    width: device.side === 'both' ? '100%' : '32px',
                    left: device.side === 'right' ? 'auto' : (device.side === 'both' ? '0' : '-5px'),
                    right: device.side === 'left' ? 'auto' : (device.side === 'both' ? '0' : '-5px'),
                    zIndex: 100,
                    pointerEvents: 'none'
                  } : {})
                }}
                onClick={() => openActionModal(rack.id, device)}
              >
                <div className={`device-inner device-type-${device.type}`}>
                  {/* Kuai Kuai (乖乖) Visual Rendering */}
                  {device.type === 'KuaiKuai' && (
                    <div style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: '140px',
                      height: '32px',
                      background: 'linear-gradient(to right, #15803d, #22c55e, #15803d)',
                      borderRadius: '6px',
                      boxShadow: '0 3px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 8px',
                      border: '1px solid #166534',
                      fontFamily: '"Microsoft JhengHei", sans-serif',
                      zIndex: 5,
                      gap: '8px'
                    }}>
                      {/* Jagged Left Edge */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'space-around', height: '100%', width: 4 }}>
                        {Array.from({ length: 6 }).map((_, i) => (
                          <div key={i} style={{ width: 2, height: 2, background: 'rgba(0,0,0,0.4)', borderRadius: '50%' }} />
                        ))}
                      </div>

                      {/* Big Red "乖" Circle */}
                      <div style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        background: '#ef4444',
                        border: '1.5px solid #fff',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        lineHeight: 1,
                        flexShrink: 0
                      }}>
                        乖
                      </div>

                      {/* Brand & Text */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', flex: 1 }}>
                        <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#fff', textShadow: '1px 1px 1px #000' }}>
                          乖乖 (造句包)
                        </div>
                        <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#fef08a', textShadow: '1px 1px 1px #000', marginTop: -1 }}>
                          綠色順利 • 不當機
                        </div>
                      </div>

                      {/* Jagged Right Edge */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'space-around', height: '100%', width: 4, marginLeft: 'auto' }}>
                        {Array.from({ length: 6 }).map((_, i) => (
                          <div key={i} style={{ width: 2, height: 2, background: 'rgba(0,0,0,0.4)', borderRadius: '50%' }} />
                        ))}
                      </div>
                    </div>
                  )}

                  {device.type !== 'Shelf' && device.type !== 'KuaiKuai' && (
                    <div className="device-info" style={{
                      position: 'absolute',
                      right: '3.5rem',
                      textAlign: 'right',
                      zIndex: 10,
                      ...(device.sizeU >= 2 ? { top: '8px', transform: 'none' } : {})
                    }}>
                      <span className="device-name">
                        {device.type === 'Reserve' ? (device.note || 'Reserved') : (device.hostname || `Unknown ${device.type}`)}
                      </span>
                      {device.type === 'PowerBar' ? (
                        (device.amps || device.volts) ? (
                          <span className="device-ip" style={{ color: '#f59e0b', fontWeight: 800, fontSize: '11px' }}>
                            ⚡ {device.amps ? `${device.amps}${String(device.amps).toLowerCase().includes('a') ? '' : 'A'}` : ''}{device.amps && device.volts ? ' / ' : ''}{device.volts ? `${device.volts}${String(device.volts).toLowerCase().includes('v') ? '' : 'V'}` : ''}
                          </span>
                        ) : (
                          device.ip && <span className="device-ip">{device.ip}</span>
                        )
                      ) : (
                        device.type !== 'Reserve' && <span className="device-ip">{['Nutanix', 'BladeChassis'].includes(device.type) ? (device.ip || device.cvmIp) : device.ip}</span>
                      )}
                    </div>
                  )}
                </div>
                {device.type === 'PowerBar' && (
                  <div className={`powerbar-render-area ${device.orientation}`} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}>
                    {device.orientation === 'vertical' ? (
                      <>
                        {(device.side === 'left' || device.side === 'both') && (
                          <div
                            className={`powerbar-realistic vertical rows-${device.rows || 1} side-left`}
                            style={{ left: device.side === 'both' ? '-5px' : '0', width: (device.rows === 3 ? '52px' : (device.rows === 2 ? '42px' : '32px')), pointerEvents: 'auto', transform: 'none', top: 0 }}
                          >
                            <div className="powerbar-outlets">
                              {Array.from({ length: device.ways || 0 }).map((_, i) => (
                                <div key={i} className={`powerbar-outlet ${device.wayLinks?.[`L${i}`] || device.wayLinks?.[i] ? 'has-link' : ''}`} title={device.wayLinks?.[`L${i}`] || device.wayLinks?.[i] || `Left Way ${i + 1}`}>
                                  {(device.wayLinks?.[`L${i}`] || device.wayLinks?.[i]) && <div className="led-indicator-on" />}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {(device.side === 'right' || device.side === 'both') && (
                          <div
                            className={`powerbar-realistic vertical rows-${device.rows || 1} side-right`}
                            style={{ right: device.side === 'both' ? '-5px' : '0', left: 'auto', width: (device.rows === 3 ? '52px' : (device.rows === 2 ? '42px' : '32px')), pointerEvents: 'auto', transform: 'none', top: 0 }}
                          >
                            <div className="powerbar-outlets">
                              {Array.from({ length: device.ways || 0 }).map((_, i) => (
                                <div key={i} className={`powerbar-outlet ${device.wayLinks?.[`R${i}`] || (device.side === 'right' && device.wayLinks?.[i]) ? 'has-link' : ''}`} title={device.wayLinks?.[`R${i}`] || (device.side === 'right' && device.wayLinks?.[i]) || `Right Way ${i + 1}`}>
                                  {(device.wayLinks?.[`R${i}`] || (device.side === 'right' && device.wayLinks?.[i])) && <div className="led-indicator-on" />}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div
                        className={`powerbar-realistic horizontal rows-${device.rows || 1}`}
                        style={{ pointerEvents: 'auto', transform: 'translateY(-50%)', left: '1%', width: '98%', top: '50%' }}
                      >
                        <div className="powerbar-outlets">
                          {Array.from({ length: device.ways || 0 }).map((_, i) => (
                            <div key={i} className={`powerbar-outlet ${device.wayLinks?.[i] || device.wayLinks?.[`L${i}`] || device.wayLinks?.[`R${i}`] ? 'has-link' : ''}`} title={device.wayLinks?.[i] || device.wayLinks?.[`L${i}`] || device.wayLinks?.[`R${i}`] || `Outlet ${i + 1}`}>
                              {(device.wayLinks?.[i] || device.wayLinks?.[`L${i}`] || device.wayLinks?.[`R${i}`]) && <div className="led-indicator-on" />}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {['Switch', 'Firewall', 'Router', 'LoadBalancer', 'Server', 'Storage', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(device.type) && device.ports > 0 && (() => {
                  const actualPorts = device.ports || (['PatchPanel', 'CableManagement'].includes(device.type) ? 24 : 8);
                  const autoRows = actualPorts > 10 ? 2 : (device.rows || 1);
                  const displayPorts = Math.min(actualPorts, 24);
                  const hasMore = actualPorts > 24;

                  const handlePortClick = (e) => {
                    e.stopPropagation();
                    setPortStatusDevice({ ...device, _actualPorts: actualPorts });
                    setShowPortStatusModal(true);
                  };

                  return (
                    <div className={`${device.type.toLowerCase()}-realistic switch-realistic rows-${autoRows}`} style={{
                      ...(['PatchPanel', 'CableManagement'].includes(device.type) ? { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', width: '100%', ...(device.sizeU >= 2 ? { height: 'auto', padding: '10px 0' } : { height: '100%' }) } : {}),
                      ...(device.sizeU >= 2 ? { top: 'auto', bottom: '8px', transform: 'none' } : {})
                    }}>
                      <div className="port-container" onClick={handlePortClick} style={{ cursor: 'pointer' }}>
                        {Array.from({ length: displayPorts }).map((_, i) => {
                          let label = `P${i + 1}`;
                          if (autoRows === 2) {
                            const isTop = i % 2 === 0;
                            label = `P${i + 1} (${isTop ? 'Upper' : 'Lower'})`;
                          }
                          let liveClass = '';
                          if (device.livePorts && device.livePorts[i]) {
                            const isUp = device.livePorts[i].status === 'Up' || device.livePorts[i].value === '1';
                            liveClass = isUp ? ' snmp-up' : ' snmp-down';
                            if (device.livePorts[i].name) {
                              label = `${device.livePorts[i].name} (${label})`;
                            }
                          }
                          return (
                            <div key={i} className={`port-square ${device.portLinks?.[i] ? 'has-link' : ''}${liveClass}`} title={device.portLinks?.[i] || label}>
                              {device.portLinks?.[i] && !liveClass && <div className="led-indicator-on" />}
                            </div>
                          );
                        })}
                        {hasMore && (
                          <div className="port-square" title="View all ports" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '10px', fontWeight: 'bold' }}>
                            ...
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {device.type === 'Shelf' && (
                  <div className="shelf-realistic" />
                )}

                {/* Always on top: Hardware Icon & Tooltip */}
                <div className="device-type-icon" style={{
                  position: 'absolute',
                  left: (device.type === 'PowerBar' && device.orientation === 'vertical')
                    ? (device.side === 'both' ? '50%' : (device.side === 'left' ? '45px' : 'auto'))
                    : (device.type === 'PowerBar' && device.orientation === 'horizontal' ? 'auto' : (device.type === 'PowerBar' ? '50%' : 'auto')),
                  right: (device.type === 'PowerBar' && device.orientation === 'vertical')
                    ? (device.side === 'right' ? '45px' : 'auto')
                    : (device.type === 'PowerBar' && device.orientation === 'horizontal' ? '1rem' : (device.type === 'PowerBar' ? 'auto' : '1rem')),
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  zIndex: 2000,
                  fontSize: '1.5rem',
                  pointerEvents: 'auto'
                }}>
                  {device.type !== 'Shelf' && icon}
                  <div className="device-tooltip">
                    <div className="tooltip-header">{DEVICE_TYPES.find(t => t.id === device.type)?.label || device.type} Info</div>
                    <div className="tooltip-row"><span>Location:</span> {rack.isSplitDesign ? getSplitLocation(rack, device.startU) : `U${device.startU}`}</div>

                    {/* Patch Panel */}
                    {['PatchPanel', 'CableManagement'].includes(device.type) && (
                      <div className="tooltip-row"><span>Model:</span> {device.model || 'N/A'}</div>
                    )}

                    {/* Reserve */}
                    {device.type === 'Reserve' && (
                      <div className="tooltip-row"><span>Note:</span> {device.note || 'No note'}</div>
                    )}

                    {/* Kuai Kuai Expiration */}
                    {device.type === 'KuaiKuai' && (
                      <div className="tooltip-row" style={{ color: '#4ade80' }}>
                        <span>Expiration:</span> {device.expiryDate ? new Date(device.expiryDate).toLocaleDateString() : 'Never'}
                      </div>
                    )}

                    {/* Shelf */}
                    {device.type === 'Shelf' && (
                      <div className="tooltip-row"><span>Type:</span> Shelf / Tray</div>
                    )}

                    {/* Server, Storage Array, and Nutanix (non-chassis) */}
                    {(device.type === 'Server' || device.type === 'Storage' || (['Nutanix', 'BladeChassis'].includes(device.type) && !device.isChassis)) && (
                      <>
                        <div className="tooltip-row"><span>Host:</span> {device.hostname || 'N/A'}</div>
                        <div className="tooltip-row"><span>iLO:</span> {device.iloIp || 'N/A'}</div>
                        <div className="tooltip-ports">Ports: {device.ports || 0} ({Object.keys(device.portLinks || {}).length} connected)</div>
                      </>
                    )}

                    {/* Nutanix Chassis */}
                    {['Nutanix', 'BladeChassis'].includes(device.type) && device.isChassis && (
                      <div className="tooltip-nodes" style={{ marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.5rem' }}>
                        {(device.nodes || []).map((node, idx) => (
                          <div key={idx} style={{ marginBottom: idx === (device.nodes.length - 1) ? 0 : '0.5rem', fontSize: '0.75rem' }}>
                            <div style={{ color: 'var(--accent-primary)', fontWeight: 'bold', fontSize: '0.8rem', marginBottom: '0.2rem' }}>Node {idx + 1}</div>
                            <div className="tooltip-row"><span>Host:</span> {node.hostname || 'N/A'}</div>
                            {node.sn && <div className="tooltip-row"><span>SN:</span> {node.sn}</div>}
                            <div className="tooltip-row"><span>iLO:</span> {node.iloIp || 'N/A'}</div>
                            <div className="tooltip-ports" style={{ fontSize: '0.7rem', marginTop: '0.2rem' }}>Ports: {node.ports || 0} ({Object.keys(node.portLinks || {}).length} connected)</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Switch, Firewall, Router, LoadBalancer */}
                    {(device.type === 'Switch' || device.type === 'Firewall' || device.type === 'Router' || device.type === 'LoadBalancer' || device.type === 'Proxy' || device.type === 'ISE' || device.type === 'NAS' || device.type === 'TapeLibrary') && (
                      <>
                        <div className="tooltip-row"><span>Host:</span> {device.hostname}</div>
                        {device.ip && <div className="tooltip-row"><span>IP:</span> {device.ip}</div>}
                        <div className="tooltip-ports">Ports: {device.ports} ({Object.keys(device.portLinks || {}).length} connected)</div>
                      </>
                    )}

                    {/* PowerBar */}
                    {device.type === 'PowerBar' && (
                      <>
                        <div className="tooltip-row"><span>Label:</span> {device.hostname || 'PDU'}</div>
                        {(device.amps || device.volts) && (
                          <div className="tooltip-row">
                            <span>Rating:</span> {device.amps ? `${device.amps}${String(device.amps).toLowerCase().includes('a') ? '' : 'A'}` : ''}{device.amps && device.volts ? ' / ' : ''}{device.volts ? `${device.volts}${String(device.volts).toLowerCase().includes('v') ? '' : 'V'}` : ''}
                          </div>
                        )}
                        <div className="tooltip-ports">Ways: {device.ways} ({Object.keys(device.wayLinks || {}).length} connected) {device.rows ? `[${device.rows} Rows]` : ''}</div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Right Rail */}
        <div className="rack-rail right">
          {generateUs(rack.height, uOrder).map(u => (
            <React.Fragment key={u}>
              <div className="rail-u">
                <div className="rail-hole"></div>
                <span className="rail-u-number">{getDisplayU(rack, u)}</span>
                <div className="rail-hole"></div>
              </div>
              {rack.isSplitDesign && u === rack.lowerU + 1 && (
                <div className="rail-divider" style={{ height: '24px', background: 'linear-gradient(-90deg, #1e293b, #334155, #1e293b)', borderTop: '2px solid #0f172a', borderBottom: '2px solid #0f172a' }}></div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };

  const s = {
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    modal: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, boxShadow: '0 10px 25px rgba(0,0,0,0.5)' },
    btnPrimary: { background: 'var(--accent-primary)', color: '#000', border: 'none', padding: '8px 24px', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer' },
    portGrid: (cols) => ({ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10 })
  };

  const frontRacksOnly = racks.filter(r => !r.isBack);
  const rowsGroup = {};
  frontRacksOnly.forEach(r => {
    const rowNum = r.rowNumber || 1;
    if (!rowsGroup[rowNum]) rowsGroup[rowNum] = [];
    rowsGroup[rowNum].push(r);
  });
  const sortedRowNumbers = Object.keys(rowsGroup).map(Number).sort((a, b) => a - b);

  const getSelectedRacksList = () => {
    const list = [];
    racks.forEach(r => {
      if (!r.isBack && selectedPrintRacks[r.id]) {
        list.push(r);
      }
    });
    return list;
  };

  const chunkArray = (arr, size) => {
    const res = [];
    for (let i = 0; i < arr.length; i += size) {
      res.push(arr.slice(i, i + size));
    }
    return res;
  };

  return (
    <div className="animate-fade-in w-full h-full flex flex-col overflow-hidden p-4 server-rack-main-container" style={{ flex: 1, minHeight: 0 }}>
      <style>{`
        .action-dropdown-container:hover .action-dropdown-menu { display: flex !important; }
        .dropdown-item-btn:hover { background: rgba(255,255,255,0.1) !important; }
        
        /* Make ServerRack full viewport height to pin horizontal scrollbar */
        .main-content {
          overflow-y: hidden !important;
          padding-bottom: 0 !important;
          display: flex;
          flex-direction: column;
        }
        .content-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
      `}</style>

      {/* Header */}
      <div className="mb-6 flex justify-between items-center px-1 shrink-0">
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>
              {selectedDC ? `[${selectedDC.name}] Server Rack` : 'Server Rack'}
            </h1>
          </div>
          <div className="search-box" style={{ margin: 0 }}>
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search Racks or Devices by Name, IP, SN..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '350px' }}
            />
            {searchQuery && searchResults.length > 0 && (
              <div className="search-dropdown glass-panel">
                {searchResults.map((res, i) => (
                  <div
                    key={i}
                    className="search-result-item"
                    onClick={() => handleResultClick(res)}
                  >
                    {res.type === 'rack' ? (
                      <>
                        <span className="res-name">🖴 {res.rack.name} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>(Rack)</span></span>
                        <span className="res-loc">ROW {res.rack.rowNumber || 1}</span>
                      </>
                    ) : (
                      <>
                        <span className="res-name">{res.device.type === 'Reserve' ? (res.device.note || 'Reserved') : (res.device.hostname || res.device.type)}</span>
                        <span className="res-loc">{res.rack.name} (U{res.device.startU})</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', padding: '4px 12px', borderRadius: '24px', marginRight: '8px' }}>
            <button className="zoom-btn" onClick={() => setZoomLevel(z => Math.max(10, z - 10))} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '18px', fontWeight: 'bold' }}>-</button>
            <span style={{ fontSize: '13px', fontWeight: 'bold', minWidth: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>{zoomLevel}%</span>
            <button className="zoom-btn" onClick={() => setZoomLevel(z => Math.min(200, z + 10))} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '18px', fontWeight: 'bold' }}>+</button>
            <button onClick={() => setZoomLevel(100)} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '12px', marginLeft: '4px', fontWeight: 'bold' }}>Reset</button>
          </div>
          <button className="btn btn-outline" onClick={handleOpenPrintModal} style={{ marginRight: '8px' }}>
            Output PNG
          </button>
          {role === 'SuperAdmin' && (
            <button className="btn btn-primary" onClick={openAddRack}>
              New Rack
            </button>
          )}
        </div>
      </div>

      <div className="rack-container" style={{ display: 'flex', flexDirection: 'column', gap: '3rem', flexWrap: 'nowrap', zoom: zoomLevel / 100 }}>
        {(() => {
          const frontRacks = racks.filter(r => !r.isBack);

          // Group by rowNumber
          const rowGroups = {};
          frontRacks.forEach(rack => {
            const rowNum = rack.rowNumber || 1;
            if (!rowGroups[rowNum]) rowGroups[rowNum] = [];
            rowGroups[rowNum].push(rack);
          });

          // Sort row numbers based on rowOrder
          const sortedRowNums = Object.keys(rowGroups).map(Number).sort((a, b) => rowOrder === 'desc' ? b - a : a - b);

          return sortedRowNums.map((rowNum) => {
            const sortedRacksInRow = [...rowGroups[rowNum]].sort((a, b) => {
              const cmp = (a.name || '').localeCompare(b.name || '');
              return rackOrder === 'desc' ? -cmp : cmp;
            });

            return (
              <div key={rowNum} className="rack-layout-row-container" style={{ marginBottom: '3rem', width: 'fit-content', minWidth: '100%' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--accent-primary)', marginBottom: '1rem', fontWeight: 'bold', borderLeft: '4px solid var(--accent-primary)', paddingLeft: '0.5rem' }}>
                  ROW {rowNum}
                </div>
                <div className="rack-layout-row" style={{ display: 'flex', gap: '3rem', flexWrap: 'nowrap', paddingBottom: '1rem' }}>
                  {sortedRacksInRow.map((rack) => {
                    const backRack = racks.find(r => r.id === rack.partnerId) || { ...rack, name: `${rack.name} (Back)`, devices: [], isBack: true };

                  return (
                    <div key={rack.id} id={`rack-container-${rack.id}`} className="rack-wrapper">
                      <div className="rack-header">
                        <div className="rack-header-main">
                          <div className="rack-title-row">
                            <span className="rack-type-icon">🖴</span>
                            <h3 className="rack-name">
                              {rack.viewMode === 'back' ? (
                                <>
                                  {rack.name} <span style={{ color: 'var(--danger)' }}>(Back)</span>
                                </>
                              ) : rack.name}
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
                            <span>{rack.devices?.reduce((sum, d) => sum + d.sizeU, 0) || 0}U used</span>
                          </div>
                        </div>

                        <div className="rack-header-actions">
                          <div className="flex gap-2">
                            <button className="btn-icon" title="Flip View" onClick={() => toggleRackView(rack.id)}>
                              🔄
                            </button>
                            <button className="btn-icon" title="Export to PNG Image" onClick={() => handleExportSingleRack(rack.id)}>
                              📥
                            </button>
                            {role === 'SuperAdmin' && (
                              <button className="btn-icon" title="Edit Rack" onClick={() => openEditRack(rack.viewMode === 'back' ? backRack : rack)}>
                                🖊️
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className={`rack-body-container ${rack.viewMode === 'back' ? 'is-back' : ''}`}>
                        <div className="rack-face front">
                          {renderRackBody(rack)}
                        </div>
                        <div className="rack-face back">
                          <div className="rack-back-label">BACK VIEW</div>
                          {renderRackBody(backRack)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        });
      })()}
      </div>

      {/* Rack Modal */}
      {showRackModal && (
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
                    <button type="button" className="btn btn-danger" onClick={() => removeRack(currentRack.id)}>🗑️ Remove</button>
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
      )}

      {/* Device Modal */}
      {showDeviceModal && (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ maxWidth: '700px', height: 'auto', padding: '0', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
            <div style={{ padding: '1.5rem 2rem 0' }}>
              <button className="modal-close" onClick={() => closeDeviceModal()}>×</button>
              <h2 style={{ color: 'var(--accent-primary)', margin: 0 }}>
                {currentDevice.id.startsWith('dev-') && !currentDevice.hostname ? `Add Device at ${getSplitLocation(racks.find(r => r.id === targetRackId), targetU)}` : 'Edit Device'}
              </h2>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', padding: '1rem 2rem 0', marginTop: '1rem' }}>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: activeDeviceTab === 'detail' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'detail' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                  onClick={() => setActiveDeviceTab('detail')}
                >
                  Device Detail
                </button>
                {!['PatchPanel', 'CableManagement', 'Shelf', 'Reserve'].includes(currentDevice.type) && (
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: activeDeviceTab === 'portsCables' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'portsCables' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => {
                      setActiveDeviceTab('portsCables');
                      setEditingPort(null);
                      if (snmpLive && !pollData) pollCurrentDevice();
                    }}
                  >
                    {snmpLive ? 'Live Port Status' : 'Ports & Cables'}
                  </button>
                )}
                {currentDevice.type === 'PowerBar' && (
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: activeDeviceTab === 'powerLinks' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'powerLinks' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => setActiveDeviceTab('powerLinks')}
                  >
                    Power Links
                  </button>
                )}
                {['Switch', 'Router', 'Firewall', 'LoadBalancer', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(currentDevice.type) && (
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: activeDeviceTab === 'snmp' ? 'var(--accent-primary)' : '#94a3b8', borderBottom: activeDeviceTab === 'snmp' ? '2px solid var(--accent-primary)' : '2px solid transparent', padding: '0.5rem 1rem', cursor: 'pointer', fontWeight: 'bold' }}
                    onClick={() => setActiveDeviceTab('snmp')}
                  >
                    SNMP Config
                  </button>
                )}
              </div>

              {/* Right Aligned: Move Device Button */}
              {role !== 'Viewer' && currentDevice.id && !(currentDevice.id.startsWith('dev-') && !currentDevice.hostname) && (
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '0.85rem',
                    padding: '0.35rem 0.9rem',
                    borderColor: 'var(--accent-primary)',
                    color: 'var(--accent-primary)',
                    marginBottom: '4px',
                    fontWeight: 'bold',
                    borderRadius: '20px',
                    cursor: 'pointer'
                  }}
                  onClick={openMoveModal}
                  title="Migrate this device to another rack or U slot"
                >
                  <span>📦</span> Move Device
                </button>
              )}
            </div>

            <form onSubmit={saveDevice} style={{ padding: '2rem', overflowY: 'auto', flex: 1 }}>
              {/* --- DETAIL TAB --- */}
              {activeDeviceTab === 'detail' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Device Type</label>
                      <select value={currentDevice.type} onChange={e => {
                        const newType = e.target.value;
                        let defaultPorts = currentDevice.ports || 24;
                        if (['Firewall', 'Router', 'LoadBalancer', 'Server', 'Storage', 'Nutanix', 'BladeChassis', 'NAS', 'TapeLibrary', 'Proxy', 'ISE'].includes(newType)) {
                          defaultPorts = 4;
                        }
                        setCurrentDevice({ ...currentDevice, type: newType, ports: defaultPorts });
                      }}>
                        {['Compute', 'Network', 'Storage', 'Other'].map(cat => (
                          <optgroup key={cat} label={cat}>
                            {DEVICE_TYPES.filter(t => t.category === cat).map(t => (
                              <option key={t.id} value={t.id}>{t.icon} {t.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <div className="form-group flex gap-2">
                      <div style={{ flex: 1 }}>
                        <label>Start U</label>
                        <input required type="number" min="1" value={currentDevice.startU} onChange={e => setCurrentDevice({ ...currentDevice, startU: parseInt(e.target.value) })} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label>Size (U)</label>
                        <input
                          required
                          type="number"
                          min={currentDevice.type === 'PowerBar' && currentDevice.orientation === 'vertical' ? 5 : 1}
                          value={currentDevice.sizeU}
                          onChange={e => setCurrentDevice({ ...currentDevice, sizeU: parseInt(e.target.value) })}
                        />
                      </div>
                    </div>
                  </div>

                  {currentDevice.type === 'Shelf' ? (
                    <div style={{ padding: '2rem', textAlign: 'center', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px dashed rgba(255,255,255,0.2)' }}>
                      <p style={{ color: 'var(--accent-primary)', fontWeight: 'bold', marginBottom: '0.5rem' }}>Structural Shelf (層板)</p>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>This item represents a physical rack shelf. No configuration data is required.</p>
                    </div>
                  ) : currentDevice.type === 'KuaiKuai' ? (
                    <div className="form-group" style={{ padding: '1rem', background: 'rgba(74, 222, 128, 0.05)', borderRadius: '8px', border: '1px solid rgba(74, 222, 128, 0.2)' }}>
                      <label style={{ color: '#4ade80', fontWeight: 'bold' }}>Expiration Date (過期日)</label>
                      <input 
                        required
                        type="date" 
                        value={currentDevice.expiryDate || ''} 
                        onChange={e => setCurrentDevice({ ...currentDevice, expiryDate: e.target.value, hostname: 'Kuai Kuai (乖乖)' })} 
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#fff', padding: '8px', width: '100%' }}
                      />
                      <span style={{ fontSize: 11, color: '#4ade80', marginTop: 8, display: 'block', opacity: 0.9 }}>
                        💡 綠色椰子乖乖小提醒：過期會失去不當機法力，請務必定期更新更換唷！
                      </span>
                    </div>
                  ) : currentDevice.type === 'Reserve' ? (
                    <div className="form-group">
                      <label>Note</label>
                      <input type="text" value={currentDevice.note || ''} onChange={e => setCurrentDevice({ ...currentDevice, note: e.target.value })} placeholder="Reserved for future expansion..." />
                    </div>
                  ) : ['PatchPanel', 'CableManagement'].includes(currentDevice.type) ? (
                    <>
                      <div className="form-group">
                        <label>Device Name</label>
                        <input type="text" value={currentDevice.hostname || ''} onChange={e => setCurrentDevice({ ...currentDevice, hostname: e.target.value })} placeholder="Optional name" />
                      </div>
                      <div className="form-group">
                        <label>Model</label>
                        <input type="text" value={currentDevice.model || ''} onChange={e => setCurrentDevice({ ...currentDevice, model: e.target.value })} placeholder="e.g. APC PDU" />
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Hostname & Model / PDU specs */}
                      {currentDevice.type === 'PowerBar' ? (
                        <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: '1rem' }}>
                          <div className="form-group">
                            <label>PDU Label</label>
                            <input required type="text" value={currentDevice.hostname || ''} onChange={e => setCurrentDevice({ ...currentDevice, hostname: e.target.value })} placeholder="PDU-A-1" />
                          </div>
                          <div className="form-group">
                            <label>Model</label>
                            <input type="text" value={currentDevice.model || ''} onChange={e => setCurrentDevice({ ...currentDevice, model: e.target.value })} placeholder="e.g. APC AP8853" />
                          </div>
                          <div className="form-group">
                            <label>Current (A)</label>
                            <input type="text" value={currentDevice.amps || ''} onChange={e => setCurrentDevice({ ...currentDevice, amps: e.target.value })} placeholder="e.g. 16A / 32A" />
                          </div>
                          <div className="form-group">
                            <label>Voltage (V)</label>
                            <input type="text" value={currentDevice.volts || ''} onChange={e => setCurrentDevice({ ...currentDevice, volts: e.target.value })} placeholder="e.g. 220V / 110V" />
                          </div>
                        </div>
                      ) : (
                        <div className="form-row">
                          <div className="form-group">
                            <label>Hostname</label>
                            <input required type="text" value={currentDevice.hostname || ''} onChange={e => setCurrentDevice({ ...currentDevice, hostname: e.target.value })} placeholder="HQ-SW-01" />
                          </div>
                          <div className="form-group">
                            <label>Model</label>
                            <input type="text" value={currentDevice.model || ''} onChange={e => setCurrentDevice({ ...currentDevice, model: e.target.value })} placeholder="e.g. Cisco C9200" />
                          </div>
                          <div className="form-group">
                            <label>Serial Number</label>
                            <input type="text" value={currentDevice.sn || ''} onChange={e => setCurrentDevice({ ...currentDevice, sn: e.target.value })} placeholder="SN1234567890" />
                          </div>
                        </div>
                      )}

                      {/* IP Addresses */}
                      {currentDevice.type !== 'PowerBar' && !(['Nutanix', 'BladeChassis'].includes(currentDevice.type) && currentDevice.isChassis) && (
                        <div className="form-row" style={{ display: 'grid', gridTemplateColumns: ['Nutanix', 'BladeChassis'].includes(currentDevice.type) ? '1fr 1fr 1fr' : '1fr 1fr', gap: '1rem' }}>
                          <div className="form-group">
                            <label>IP Address</label>
                            <input type="text" value={currentDevice.ip || ''} onChange={e => setCurrentDevice({ ...currentDevice, ip: e.target.value })} placeholder="10.10.10.10" />
                          </div>
                          {['Nutanix', 'BladeChassis'].includes(currentDevice.type) && (
                            <div className="form-group">
                              <label>CVM IP</label>
                              <input type="text" value={currentDevice.cvmIp || ''} onChange={e => setCurrentDevice({ ...currentDevice, cvmIp: e.target.value })} placeholder="10.10.10.10" />
                            </div>
                          )}
                          <div className="form-group">
                            <label>iLO / OOB IP</label>
                            <input type="text" value={currentDevice.iloIp || ''} onChange={e => setCurrentDevice({ ...currentDevice, iloIp: e.target.value })} placeholder="10.10.10.10" />
                          </div>
                        </div>
                      )}

                      {/* Nutanix Chassis */}
                      {['Nutanix', 'BladeChassis'].includes(currentDevice.type) && (
                        <div className="form-row align-items-center" style={{ marginBottom: '1rem', background: 'rgba(255,255,255,0.05)', padding: '0.5rem', borderRadius: '4px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', margin: 0 }}>
                            <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={currentDevice.isChassis || false} onChange={e => setCurrentDevice({ ...currentDevice, isChassis: e.target.checked, nodes: e.target.checked ? Array.from({ length: currentDevice.nodeCount || 1 }).map((_, i) => (currentDevice.nodes && currentDevice.nodes[i]) || { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} }) : [] })} />
                            <span style={{ fontWeight: 'bold', color: 'var(--accent-primary)' }}>Is Chassis (Multi-Node)</span>
                          </label>
                          {currentDevice.isChassis && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '1.5rem' }}>
                              <label style={{ margin: 0 }}>Node Count:</label>
                              <input type="number" min="1" max="4" style={{ width: '80px', padding: '0.2rem 0.5rem', background: 'rgba(0,0,0,0.3)', border: '1px solid #444', color: '#fff' }} value={currentDevice.nodeCount || 1} onChange={e => {
                                const count = parseInt(e.target.value);
                                const nodes = Array.from({ length: count }).map((_, i) => (currentDevice.nodes && currentDevice.nodes[i]) || { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} });
                                setCurrentDevice({ ...currentDevice, nodeCount: count, nodes });
                              }} />
                            </div>
                          )}
                        </div>
                      )}

                      {['Nutanix', 'BladeChassis'].includes(currentDevice.type) && currentDevice.isChassis && (
                        <div style={{ paddingRight: '10px', marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1rem' }}>
                          <h4 style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--accent-primary)', fontSize: '1rem' }}>Chassis Nodes ({currentDevice.nodeCount || 1})</h4>
                          {Array.from({ length: currentDevice.nodeCount || 1 }).map((_, idx) => {
                            const node = (currentDevice.nodes && currentDevice.nodes[idx]) || { hostname: '', ip: '', cvmIp: '', iloIp: '', sn: '', model: '', ports: 4, portLinks: {} };
                            return (
                              <div key={idx} style={{ border: '1px solid rgba(255,255,255,0.2)', padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px', background: 'rgba(0,0,0,0.3)' }}>
                                <h4 style={{ marginTop: 0, marginBottom: '0.8rem', color: 'var(--accent-primary)', fontSize: '0.9rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.3rem' }}>Node {idx + 1}</h4>
                                <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>Hostname</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="e.g. NTNX-Node-01" value={node.hostname || ''} onChange={e => handleNodeChange(idx, 'hostname', e.target.value)} />
                                  </div>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>Serial Number (SN)</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="e.g. 19SM12345678" value={node.sn || ''} onChange={e => handleNodeChange(idx, 'sn', e.target.value)} />
                                  </div>
                                </div>
                                <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>IP Address</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="10.10.10.11" value={node.ip || ''} onChange={e => handleNodeChange(idx, 'ip', e.target.value)} />
                                  </div>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>CVM IP</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="10.10.10.21" value={node.cvmIp || ''} onChange={e => handleNodeChange(idx, 'cvmIp', e.target.value)} />
                                  </div>
                                  <div className="form-group">
                                    <label style={{ fontSize: '0.75rem' }}>iLO / OOB IP</label>
                                    <input type="text" style={{ padding: '0.4rem' }} placeholder="10.10.10.31" value={node.iloIp || ''} onChange={e => handleNodeChange(idx, 'iloIp', e.target.value)} />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* --- PORTS & CABLES TAB --- */}
              {activeDeviceTab === 'portsCables' && snmpLive ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ color: 'var(--accent-primary)', margin: 0 }}>Live Port Status (via SNMP)</h3>
                    <button type="button" className="btn btn-outline" disabled={pollLoading} onClick={pollCurrentDevice}>
                      {pollLoading ? 'Polling...' : 'Refresh'}
                    </button>
                  </div>
                  {pollLoading && <p style={{ color: 'var(--text-secondary)' }}>Querying device, please wait...</p>}
                  {!pollLoading && !pollData && <p style={{ color: 'var(--text-secondary)' }}>No data. Click refresh to poll device.</p>}

                  {pollData && (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${pollData.ports.length > 10 ? Math.ceil(pollData.ports.length / 2) : pollData.ports.length}, 1fr)`, gap: '10px' }}>
                        {pollData.ports.map((p, i) => {
                          const isUp = p.status === 'Up' || p.value === '1'; // 1=Up in SNMP
                          return (
                            <div key={i} style={{
                              aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: isUp ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                              border: `1px solid ${isUp ? 'var(--success)' : 'var(--danger)'}`,
                              borderRadius: '4px', color: isUp ? 'var(--success)' : 'var(--danger)',
                              fontSize: '11px', fontWeight: 'bold'
                            }} title={`Port ${p.name || p.port || i + 1} - ${p.speed || 'Unknown'}`}>
                              {p.name || p.port || i + 1}
                            </div>
                          )
                        })}
                      </div>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>Manual Ports & Cables are disabled because SNMP is active. Data is fetched automatically.</p>
                    </div>
                  )}
                </div>
              ) : activeDeviceTab === 'portsCables' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {editingPort ? (
                    <div style={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid var(--accent-primary)', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                      <h3 style={{ marginTop: 0, color: 'var(--accent-primary)' }}>Edit Connection for Port {editingPort.portIndex + 1}</h3>
                      <div className="form-group">
                        <label>Target Device</label>
                        <select
                          value={editingPort.target}
                          onChange={e => setEditingPort({ ...editingPort, target: e.target.value, targetPort: '' })}
                          style={{ width: '100%' }}
                        >
                          <option value="">-- Disconnected --</option>
                          {allDevicesInDC.map(d => (
                            <option key={d.id} value={d.hostname || d.name}>{d.hostname || d.name} ({d.type})</option>
                          ))}
                        </select>
                      </div>

                      {editingPort.target && (() => {
                        const targetDev = allDevicesInDC.find(d => (d.hostname || d.name) === editingPort.target);
                        const tPorts = targetDev ? (targetDev.ports || 0) : 0;
                        return (
                          <div className="form-group">
                            <label>Target Port</label>
                            {tPorts > 0 ? (
                              <select
                                value={editingPort.targetPort}
                                onChange={e => setEditingPort({ ...editingPort, targetPort: e.target.value })}
                                style={{ width: '100%' }}
                              >
                                <option value="">-- Select Port --</option>
                                {Array.from({ length: tPorts }).map((_, i) => (
                                  <option key={i} value={`P${i + 1}`}>P{i + 1}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                placeholder="e.g. Eth1/1"
                                value={editingPort.targetPort}
                                onChange={e => setEditingPort({ ...editingPort, targetPort: e.target.value })}
                                style={{ width: '100%' }}
                              />
                            )}
                          </div>
                        );
                      })()}

                      {editingPort.target && (
                        <div className="form-group">
                          <label>Cable Color</label>
                          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                            {Object.entries(CABLE_COLORS).map(([colorName, colorHex]) => (
                              <div
                                key={colorName}
                                onClick={() => setEditingPort({ ...editingPort, cableColor: colorName })}
                                style={{
                                  width: '30px', height: '30px', borderRadius: '50%', background: colorHex,
                                  cursor: 'pointer', border: editingPort.cableColor === colorName ? '3px solid #fff' : '2px solid transparent',
                                  boxShadow: editingPort.cableColor === colorName ? '0 0 10px rgba(255,255,255,0.5)' : 'none'
                                }}
                                title={colorName}
                              />
                            ))}
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                        <button type="button" className="btn btn-secondary" onClick={() => setEditingPort(null)}>Cancel</button>
                        <button type="button" className="btn btn-primary" onClick={() => {
                          const newLinks = { ...(currentDevice.portLinks || {}) };
                          if (!editingPort.target) {
                            delete newLinks[editingPort.portIndex];
                          } else {
                            newLinks[editingPort.portIndex] = {
                              target: editingPort.target,
                              targetPort: editingPort.targetPort,
                              cableColor: editingPort.cableColor
                            };
                          }
                          setCurrentDevice({ ...currentDevice, portLinks: newLinks });
                          setEditingPort(null);
                        }}>
                          Apply
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="form-group" style={{ background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px', display: 'flex', gap: '2rem' }}>
                        <div>
                          <label style={{ color: 'var(--accent-primary)', fontSize: '1rem', display: 'block', marginBottom: '0.5rem' }}>Total Ports</label>
                          <input type="number" min="0" max="96" value={currentDevice.ports || 0} onChange={e => setCurrentDevice({ ...currentDevice, ports: parseInt(e.target.value) })} style={{ maxWidth: '150px' }} />
                        </div>
                        {['Switch', 'Firewall', 'Router', 'LoadBalancer', 'PatchPanel', 'CableManagement', 'Server', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'].includes(currentDevice.type) && (
                          <div>
                            <label style={{ color: 'var(--accent-primary)', fontSize: '1rem', display: 'block', marginBottom: '0.5rem' }}>Rows (Display)</label>
                            <select value={currentDevice.rows || 1} onChange={e => setCurrentDevice({ ...currentDevice, rows: parseInt(e.target.value) })} style={{ maxWidth: '150px' }}>
                              <option value={1}>1 Row</option>
                              <option value={2}>2 Rows</option>
                            </select>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '1rem' }}>
                        {Array.from({ length: currentDevice.ports || 0 }).map((_, pi) => {
                          const link = currentDevice.portLinks?.[pi];
                          let targetHostname = '';
                          let cableColor = 'Blue';
                          let targetPort = '';
                          if (typeof link === 'string') {
                            targetHostname = link;
                          } else if (link && typeof link === 'object') {
                            targetHostname = link.target || '';
                            targetPort = link.targetPort || '';
                            cableColor = link.cableColor || 'Blue';
                          }

                          return (
                            <div key={pi} style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '0.8rem', position: 'relative' }}>
                              <div style={{ fontWeight: 'bold', fontSize: '1.1rem', marginBottom: '0.5rem', color: '#f1f5f9' }}>Port {pi + 1}</div>
                              {targetHostname ? (
                                <div style={{ fontSize: '0.8rem', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: CABLE_COLORS[cableColor] || CABLE_COLORS.Blue, display: 'inline-block' }}></span>
                                    <span>To: <strong>{targetHostname}</strong></span>
                                  </div>
                                  {targetPort && <div>Port: {targetPort}</div>}
                                  <button type="button" onClick={() => openPortEditor(pi, link)} style={{ marginTop: '0.5rem', padding: '0.2rem 0.5rem', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem' }}>Edit Connection</button>
                                </div>
                              ) : (
                                <button type="button" onClick={() => openPortEditor(pi, null)} style={{ padding: '0.4rem 0.8rem', background: 'var(--accent-primary)', border: 'none', color: '#000', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold', width: '100%' }}>+ Connect</button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {/* --- POWER LINKS TAB --- */}
              {activeDeviceTab === 'powerLinks' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {currentDevice.type === 'PowerBar' ? (
                    <>
                      <div className="form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>
                        <div className="form-group">
                          <label>Orientation</label>
                          <select value={currentDevice.orientation || 'horizontal'} onChange={e => setCurrentDevice({ ...currentDevice, orientation: e.target.value })}>
                            <option value="horizontal">Horizontal (Rack Mount)</option>
                            <option value="vertical">Vertical (Side Mount)</option>
                          </select>
                        </div>
                        {currentDevice.orientation === 'vertical' && (
                          <div className="form-group">
                            <label>Side</label>
                            <select value={currentDevice.side || 'left'} onChange={e => setCurrentDevice({ ...currentDevice, side: e.target.value })}>
                              <option value="left">Left Side</option>
                              <option value="right">Right Side</option>
                              <option value="both">Both Sides</option>
                            </select>
                          </div>
                        )}
                        <div className="form-group">
                          <label>Ways (Outlets)</label>
                          <input type="number" min="1" max="42" value={currentDevice.ways || 8} onChange={e => setCurrentDevice({ ...currentDevice, ways: parseInt(e.target.value) })} />
                        </div>
                        <div className="form-group">
                          <label>Rows</label>
                          <select value={currentDevice.rows || 1} onChange={e => setCurrentDevice({ ...currentDevice, rows: parseInt(e.target.value) })}>
                            <option value={1}>1 Row</option>
                            <option value={2}>2 Rows</option>
                            <option value={3}>3 Rows</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label>Current (A)</label>
                          <input type="text" value={currentDevice.amps || ''} onChange={e => setCurrentDevice({ ...currentDevice, amps: e.target.value })} placeholder="e.g. 16A" />
                        </div>
                        <div className="form-group">
                          <label>Voltage (V)</label>
                          <input type="text" value={currentDevice.volts || ''} onChange={e => setCurrentDevice({ ...currentDevice, volts: e.target.value })} placeholder="e.g. 220V" />
                        </div>
                      </div>

                      <div style={{ background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px' }}>
                        <label style={{ color: 'var(--accent-primary)', marginBottom: '1rem', display: 'block', fontWeight: 'bold' }}>Outlet Connections</label>
                        <div style={{ display: 'grid', gridTemplateColumns: currentDevice.rows === 3 ? '1fr 1fr 1fr' : ((currentDevice.rows === 2 || currentDevice.side === 'both') ? '1fr 1fr' : '1fr'), gap: '0.8rem' }}>
                          {(() => {
                            const items = [];
                            const wayCount = currentDevice.ways || 8;
                            if (currentDevice.orientation === 'vertical') {
                              if (currentDevice.side === 'both') {
                                for (let i = 0; i < wayCount; i++) items.push({ key: `L${i}`, label: `Left Way ${i + 1}` });
                                for (let i = 0; i < wayCount; i++) items.push({ key: `R${i}`, label: `Right Way ${i + 1}` });
                              } else if (currentDevice.side === 'right') {
                                for (let i = 0; i < wayCount; i++) items.push({ key: `R${i}`, label: `Way ${i + 1}` });
                              } else {
                                for (let i = 0; i < wayCount; i++) items.push({ key: `L${i}`, label: `Way ${i + 1}` });
                              }
                            } else {
                              for (let i = 0; i < wayCount; i++) items.push({ key: i, label: `Way ${i + 1}` });
                            }
                            return items.map((item) => {
                              const link = currentDevice.wayLinks?.[item.key];
                              let targetHostname = '';
                              if (typeof link === 'string') targetHostname = link;
                              else if (link && link.target) targetHostname = link.target;

                              return (
                                <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(0,0,0,0.3)', padding: '0.5rem', borderRadius: '6px' }}>
                                  <span style={{ fontSize: '0.8rem', width: '80px', color: '#cbd5e1' }}>{item.label}</span>
                                  <input
                                    type="text"
                                    style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.8rem', background: '#0f172a', border: '1px solid #334155' }}
                                    placeholder="Connect to..."
                                    value={targetHostname}
                                    onChange={e => {
                                      const newLinks = { ...(currentDevice.wayLinks || {}) };
                                      newLinks[item.key] = { target: e.target.value, cableColor: 'Yellow' };
                                      setCurrentDevice({ ...currentDevice, wayLinks: newLinks });
                                    }}
                                  />
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                      <p>This tab allows configuring upstream power connections (e.g. connecting PSU 1 to PDU-A).</p>
                      <p style={{ fontStyle: 'italic' }}>(Feature coming soon for non-PDU devices)</p>
                    </div>
                  )}
                </div>
              )}

              {/* --- SNMP CONFIG TAB --- */}
              {activeDeviceTab === 'snmp' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '500px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'bold', cursor: role === 'Viewer' ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={!!snmpForm.enabled} disabled={role === 'Viewer'} onChange={e => setSnmpForm({ ...snmpForm, enabled: e.target.checked })} />
                    啟用 SNMP 查詢
                  </label>
                  {!snmpForm.enabled && (
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>停用時不會對此設備進行 SNMP 查詢 (Ports &amp; Cables 改為手動維護)，下方設定可先不填。</p>
                  )}
                  <div className="form-group">
                    <label>SNMP Version</label>
                    <select value={snmpForm.version} onChange={e => setSnmpForm({ ...snmpForm, version: e.target.value })}>
                      <option value="v1">v1</option>
                      <option value="v2c">v2c</option>
                      <option value="v3">v3</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Port</label>
                    <input type="number" value={snmpForm.port} onChange={e => setSnmpForm({ ...snmpForm, port: e.target.value })} />
                  </div>
                  {(snmpForm.version === 'v2c' || snmpForm.version === 'v1') && (
                    <div className="form-group">
                      <label>Community String</label>
                      <input type="password" value={snmpForm.community || ''} onChange={e => setSnmpForm({ ...snmpForm, community: e.target.value })} />
                    </div>
                  )}
                  {snmpForm.version === 'v3' && (
                    <>
                      <div className="form-group">
                        <label>Security Name (User)</label>
                        <input type="text" value={snmpForm.v3User || ''} onChange={e => setSnmpForm({ ...snmpForm, v3User: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Auth Password (SHA)</label>
                        <input type="password" value={snmpForm.v3AuthPass || ''} onChange={e => setSnmpForm({ ...snmpForm, v3AuthPass: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Priv Password (AES)</label>
                        <input type="password" value={snmpForm.v3PrivPass || ''} onChange={e => setSnmpForm({ ...snmpForm, v3PrivPass: e.target.value })} />
                      </div>
                    </>
                  )}
                  {role !== 'Viewer' && (
                    <button type="button" className="btn btn-primary" onClick={() => {
                      const payload = { ...snmpForm, enabled: !!snmpForm.enabled };
                      api.post(`/network-device/${currentDevice.id}/snmp`, payload).then(() => {
                        setSnmpSavedEnabled(payload.enabled);
                        setPollData(null);
                        setSysAlert({ message: payload.enabled
                          ? 'SNMP Settings Saved. The Ports & Cables tab will now show live SNMP status.'
                          : 'SNMP Settings Saved. SNMP 查詢已停用，不會對此設備進行查詢。' });
                      }).catch(err => setSysAlert({ message: 'Failed: ' + (err.response?.data?.error || err.message) }));
                    }}>Save SNMP Settings</button>
                  )}
                </div>
              )}


              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
                <button type="button" className="btn btn-danger" onClick={removeDevice} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>🗑️</span> Remove
                </button>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => closeDeviceModal()}>Cancel</button>
                  <button type="submit" className="btn btn-primary">Save Device</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Action Modal */}
      {showActionModal && currentActionDevice && (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ width: 'max-content', minWidth: '220px', height: 'auto', padding: '2rem' }}>
            <button className="modal-close" onClick={() => setShowActionModal(false)}>×</button>
            <h2 style={{ color: 'var(--accent-primary)', marginBottom: '1.5rem', fontSize: '1.2rem', textAlign: 'center' }}>
              {currentActionDevice.type === 'Reserve' ? 'Reserved Space' : (currentActionDevice.hostname || currentActionDevice.type)}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {role !== 'Viewer' && (
                <button
                  className="btn btn-outline"
                  style={{ justifyContent: 'center', fontSize: '1rem', padding: '0.8rem 1rem' }}
                  onClick={() => {
                    setShowActionModal(false);
                    openEditDevice(targetRackId, currentActionDevice);
                  }}
                >
                  ✏️ Edit Device
                </button>
              )}

              {currentActionDevice.type !== 'Reserve' && (
                <button
                  className="btn btn-outline"
                  style={{ justifyContent: 'center', fontSize: '1rem', padding: '0.8rem 1rem' }}
                  onClick={() => openReportForm(currentActionDevice, targetRackId)}
                >
                  ⚠️ Report HW issue
                </button>
              )}

              {currentActionDevice.iloIp && (
                <button
                  className="btn btn-outline"
                  style={{ justifyContent: 'center', fontSize: '1rem', padding: '0.8rem 1rem' }}
                  onClick={() => window.open(`https://${currentActionDevice.iloIp}`, '_blank')}
                >
                  🚀 Launch iLO
                </button>
              )}

              {['Nutanix', 'BladeChassis'].includes(currentActionDevice.type) && currentActionDevice.isChassis && currentActionDevice.nodes && currentActionDevice.nodes.length > 0 && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1rem' }}>
                  <h4 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Nodes</h4>
                  <ul style={{ listStyle: 'none', padding: 0, fontSize: '0.8rem' }}>
                    {currentActionDevice.nodes.map((n, i) => (
                      <li key={i} style={{ marginBottom: '0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '6px 10px', borderRadius: '6px' }}>
                        <div>
                          <div style={{ fontWeight: 600, color: '#fff' }}>Node {i + 1}: {n.hostname || 'Unknown'}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {n.ip && <span>IP: {n.ip}</span>}
                            {n.sn && <span style={{ marginLeft: 8, color: '#93c5fd' }}>SN: {n.sn}</span>}
                          </div>
                        </div>
                        <button className="btn btn-outline" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }} onClick={() => openReportForm(currentActionDevice, targetRackId, n)}>⚠️ Report</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Port Status Modal (Read-only View) */}
      {showPortStatusModal && portStatusDevice && (
        <div className="modal-overlay" onClick={() => setShowPortStatusModal(false)} style={{ zIndex: 9999 }}>
          <div className="modal-content glass-panel" style={{ width: '80%', maxWidth: '800px', height: 'auto', maxHeight: '80vh', padding: '2rem', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '1rem' }}>
              <h2 style={{ color: 'var(--accent-primary)', margin: 0, fontSize: '1.5rem' }}>
                {portStatusDevice.hostname || portStatusDevice.type} - Port Status
              </h2>
              <button onClick={() => setShowPortStatusModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '28px', lineHeight: 1 }}>&times;</button>
            </div>

            <div style={portStatusDevice && portStatusDevice._actualPorts > 0 ? s.portGrid(Math.min(Math.ceil(portStatusDevice._actualPorts / 2), 12)) : {}}>
              {Array.from({ length: portStatusDevice._actualPorts }).map((_, i) => {
                let label = `P${i + 1}`;
                let liveClass = '';
                let isUp = false;
                if (portStatusDevice.livePorts && portStatusDevice.livePorts[i]) {
                  isUp = portStatusDevice.livePorts[i].status === 'Up' || portStatusDevice.livePorts[i].value === '1';
                  liveClass = isUp ? ' snmp-up' : ' snmp-down';
                  label = portStatusDevice.livePorts[i].name || label;
                } else {
                  isUp = !!portStatusDevice.portLinks?.[i];
                }

                let tooltip = label;
                if (portStatusDevice.portLinks?.[i]) {
                  const link = portStatusDevice.portLinks[i];
                  tooltip = `Connected to: ${typeof link === 'object' ? link.target : link}`;
                }
                if (portStatusDevice.livePorts && portStatusDevice.livePorts[i]) {
                  tooltip += ` | SNMP: ${portStatusDevice.livePorts[i].status || portStatusDevice.livePorts[i].value}`;
                }

                return (
                  <div key={i} style={{
                    aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: isUp ? 'rgba(34,197,94,0.1)' : (portStatusDevice.livePorts ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)'),
                    border: `1px solid ${isUp ? 'var(--success)' : (portStatusDevice.livePorts ? 'var(--danger)' : 'rgba(255,255,255,0.2)')}`,
                    borderRadius: '4px', color: isUp ? 'var(--success)' : (portStatusDevice.livePorts ? 'var(--danger)' : '#fff'),
                    fontSize: '11px', fontWeight: 'bold'
                  }} title={tooltip}>
                    {label}
                  </div>
                )
              })}
            </div>
            {portStatusDevice.livePorts && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '1.5rem', textAlign: 'center' }}>
                * SNMP Live Status is active.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Custom Alert Modal */}
      {sysAlert && (
        <div style={s.modalOverlay}>
          <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }}>
            <h3 style={{ fontSize: 18, marginBottom: 16 }}>Notice</h3>
            <p style={{ marginBottom: 24, color: 'var(--text-secondary)' }}>{sysAlert.message}</p>
            <button style={s.btnPrimary} onClick={() => setSysAlert(null)}>OK</button>
          </div>
        </div>
      )}

      {/* Custom Confirm Modal */}
      {sysConfirm && (
        <div style={s.modalOverlay}>
          <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }}>
            <h3 style={{ fontSize: 18, marginBottom: 16 }}>Confirm Action</h3>
            <p style={{ marginBottom: 24, color: 'var(--text-secondary)' }}>{sysConfirm.message}</p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
              <button style={{ ...s.btnPrimary, background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }} onClick={() => setSysConfirm(null)}>Cancel</button>
              <button style={{ ...s.btnPrimary, background: 'var(--danger)' }} onClick={() => { sysConfirm.onConfirm(); setSysConfirm(null); }}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Print Racks Modal */}
      {showPrintModal && (
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
      )}

      {/* Move Device Modal */}
      {showMoveModal && currentDevice && (
        <div className="modal-overlay" style={{ zIndex: 3000 }}>
          <div className="modal-content glass-panel" style={{ maxWidth: '540px', padding: '2rem', borderRadius: '16px' }}>
            <button className="modal-close" onClick={() => setShowMoveModal(false)}>×</button>
            <h2 style={{ color: 'var(--accent-primary)', marginTop: 0, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.4rem' }}>
              <span>📦</span> Move Device
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
                const collidingDev = (targetRack.devices || []).find(d => {
                  if (d.id === currentDevice.id && targetRack.id === targetRackId) return false;
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
                    <span style={{ color: 'var(--text-muted)' }}>📍 Current Location:</span>
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
                          🔄 Move to Back (移動至機櫃背面)
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
                    <span>{isCollision ? '⚠️' : '✅'}</span>
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
      )}

      {/* Print Only Layout */}
      {isPrinting && (
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
                      {renderRackBody(activeRack)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Off-screen Image Export Render Layout */}
      {isExporting && (
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
                            {renderRackBody(activeRack)}
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
      )}
    </div>
  );
}
