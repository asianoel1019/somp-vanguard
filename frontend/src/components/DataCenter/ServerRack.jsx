import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import './ServerRack.css';
import RackCard from './RackCard';
import RackBody from './RackBody';
import RackTooltip from './RackTooltip';
import RackToolbar from './RackToolbar';
import RackFormModal from './RackFormModal';
import DeviceModal from './DeviceModal';
import DeviceActionModal from './DeviceActionModal';
import PortStatusModal from './PortStatusModal';
import SysAlertModal from './SysAlertModal';
import SysConfirmModal from './SysConfirmModal';
import PrintRacksModal from './PrintRacksModal';
import MoveDeviceModal from './MoveDeviceModal';
import RackPrintLayout from './RackPrintLayout';
import RackExportLayout from './RackExportLayout';
import { capacitySummary, findFreeSpace, isSideMounted, shareUnchanged, stepIndex, typeFilterKey } from './rackUtils';
import { DEVICE_TYPES, getSplitLocation } from './rackShared';
import api from '../../api';
import * as htmlToImage from 'html-to-image';
import { useToast } from '../../contexts/ToastContext';
import { TbSearch, TbServer2 } from 'react-icons/tb';




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
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set()); // device types dimmed in the layout
  const [fitSize, setFitSize] = useState(0);        // free-space finder: U height looked for (0 = off)
  const [searchIndex, setSearchIndex] = useState(-1); // search result picked with Enter / Shift+Enter

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
      const loaded = res.data && res.data.length > 0 ? normalizeLoadedRacks(res.data) : defaultRacksFor(dc);
      const next = shareUnchanged(racksRef.current, loaded).racks; // racks the reload did not change are not redrawn
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
    // Unchanged racks keep their previous object, so only the racks this change touched re-render
    const { racks: newRacks, changed } = shareUnchanged(prev, typeof updater === 'function' ? updater(working) : updater);
    racksRef.current = newRacks;
    setRacks(newRacks);

    if (!selectedDC || role === 'Viewer') return;

    let patchData = null;
    if (newRacks.length === prev.length) {
      patchData = changed;
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
  const openAddDevice = (rackId, uNumber, sizeU = 1) => {
    setActiveDeviceTab('detail');
    setTargetRackId(rackId);
    setTargetU(uNumber);
    setCurrentDevice({
      id: `dev-${Date.now()}`,
      type: 'Server',
      startU: uNumber,
      sizeU,
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
      // side-mounted (vertical) PowerBars take no U: same rule as the server
      const hasCollision = !isSideMounted(cleaned) && (targetRack.devices || []).some(dev => {
        if (dev.id === cleaned.id || isSideMounted(dev)) return false;
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

  const isMatched = useCallback((device) => {
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
  }, [searchQuery]);

  // Racks are memoized (RackCard / RackBody): they get one stable `actions` object whose functions call the latest
  // handlers through a ref, so a re-render of this screen (typing in a dialog, zoom, toasts) does not redraw them.
  const tipRef = useRef(null);
  const handlersRef = useRef({});
  useLayoutEffect(() => {
    handlersRef.current = {
      toggleView: (rackId) => toggleRackView(rackId),
      exportRack: (rackId) => handleExportSingleRack(rackId),
      editRack: (rack) => openEditRack(rack),
      addDevice: (rackId, u, sizeU) => openAddDevice(rackId, u, sizeU),
      deviceClick: (rackId, device) => openActionModal(rackId, device),
      portClick: (device) => { setPortStatusDevice(device); setShowPortStatusModal(true); },
    };
  });
  const rackActions = useMemo(() => ({
    toggleView: (...a) => handlersRef.current.toggleView(...a),
    exportRack: (...a) => handlersRef.current.exportRack(...a),
    editRack: (...a) => handlersRef.current.editRack(...a),
    addDevice: (...a) => handlersRef.current.addDevice(...a),
    deviceClick: (...a) => handlersRef.current.deviceClick(...a),
    portClick: (...a) => handlersRef.current.portClick(...a),
    tipShow: (tip) => tipRef.current?.show(tip),
    tipHide: () => tipRef.current?.hide(),
  }), []);
  // Search matches per rack as "|deviceId|...|" text: a rack re-renders only when its own matches change
  const matchedByRack = useMemo(() => {
    const out = new Map();
    if (!searchQuery) return out;
    for (const r of racks) {
      const ids = (r.devices || []).filter(isMatched).map(d => d.id);
      if (ids.length) out.set(r.id, `|${ids.join('|')}|`);
    }
    return out;
  }, [racks, searchQuery, isMatched]);
  const noop = useCallback(() => {}, []);

  // Capacity, free-space finder, type filter, overview mode (see RackToolbar)
  const capacity = useMemo(() => capacitySummary(racks), [racks]);
  const freeList = useMemo(() => (fitSize ? findFreeSpace(racks, fitSize) : []), [racks, fitSize]);
  const typeKey = useMemo(() => typeFilterKey(hiddenTypes, DEVICE_TYPES.map(t => t.id)), [hiddenTypes]);
  const simpleView = zoomLevel <= 50;
  const jumpToFreeSpace = (entry) => {
    setRacks(prev => prev.map(r => r.id === entry.rack.id && r.viewMode === 'back' ? { ...r, viewMode: 'front' } : r));
    const turns = racks.find(r => r.id === entry.rack.id)?.viewMode === 'back';
    setTimeout(() => {
      const el = document.getElementById(`rack-container-${entry.rack.id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, turns ? 500 : 0);
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
  }, [searchQuery, racks, isMatched]);

  const handleResultClick = (res) => {
    const rackId = res.rack.id;
    const rack = racks.find(r => r.id === rackId);
    if (!rack) return;

    const frontId = rack.isBack ? rack.partnerId : rack.id;
    const turns = (racks.find(r => r.id === frontId)?.viewMode === 'back') !== !!rack.isBack;
    if (rack.isBack) {
      const parentRackId = rack.partnerId;
      setRacks(prev => prev.map(r => r.id === parentRackId && r.viewMode !== 'back' ? { ...r, viewMode: 'back' } : r));
    } else {
      setRacks(prev => prev.map(r => r.id === rackId && r.viewMode === 'back' ? { ...r, viewMode: 'front' } : r));
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
    }, turns ? 500 : 0);
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
            <span className="search-icon"><TbSearch /></span>
            <input
              type="text"
              placeholder="Search Racks or Devices by Name, IP, SN..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchIndex(-1); }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !searchResults.length) return;
                e.preventDefault();
                const next = stepIndex(searchIndex, searchResults.length, e.shiftKey ? -1 : 1);
                setSearchIndex(next);
                handleResultClick(searchResults[next]);
              }}
              title="Enter: next result, Shift+Enter: previous"
              style={{ width: '350px', paddingRight: searchQuery ? '84px' : undefined }}
            />
            {searchQuery && (
              <span className="rack-search-count">
                {searchResults.length ? `${searchIndex >= 0 ? searchIndex + 1 : '–'} / ${searchResults.length}` : '0 found'}
              </span>
            )}
            {searchQuery && searchResults.length > 0 && (
              <div className="search-dropdown glass-panel">
                {searchResults.map((res, i) => (
                  <div
                    key={i}
                    className={`search-result-item${i === searchIndex ? ' is-current' : ''}`}
                    onClick={() => { setSearchIndex(i); handleResultClick(res); }}
                  >
                    {res.type === 'rack' ? (
                      <>
                        <span className="res-name"><TbServer2 className="rack-ico" />{res.rack.name} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>(Rack)</span></span>
                        <span className="res-loc">ROW {res.rack.rowNumber || 1}</span>
                      </>
                    ) : (
                      <>
                        <span className="res-name">{res.device.type === 'Reserve' ? (res.device.note || 'Reserved') : (res.device.hostname || res.device.type)}</span>
                        <span className="res-loc">{res.rack.name} ({getSplitLocation(res.rack, res.device.startU)})</span>
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

      <RackToolbar
        summary={capacity} simple={simpleView} fitSize={fitSize} onFitSize={setFitSize} freeList={freeList}
        onJump={jumpToFreeSpace} hiddenTypes={hiddenTypes} onHiddenTypes={setHiddenTypes}
      />
      <RackTooltip ref={tipRef} />
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
                  {sortedRacksInRow.map((rack) => (
                    <RackCard
                      key={rack.id} rack={rack} partner={rack.partnerId ? racks.find(r => r.id === rack.partnerId) || null : null}
                      uOrder={uOrder} role={role} actions={rackActions} simple={simpleView} typeKey={typeKey} fitSize={fitSize}
                      matchedFront={matchedByRack.get(rack.id) || ''} matchedBack={matchedByRack.get(rack.partnerId) || ''}
                    />
                  ))}
              </div>
            </div>
          );
        });
      })()}
      </div>

      {/* Rack Modal */}
      {showRackModal && (
        <RackFormModal
          racks={racks}
          setShowRackModal={setShowRackModal}
          currentRack={currentRack}
          setCurrentRack={setCurrentRack}
          autofillRackFromRow={autofillRackFromRow}
          saveRack={saveRack}
          removeRack={removeRack}
        />
      )}

      {/* Device Modal */}
      {showDeviceModal && (
        <DeviceModal
          role={role}
          racks={racks}
          activeDeviceTab={activeDeviceTab}
          setActiveDeviceTab={setActiveDeviceTab}
          editingPort={editingPort}
          setEditingPort={setEditingPort}
          snmpForm={snmpForm}
          setSnmpForm={setSnmpForm}
          setSnmpSavedEnabled={setSnmpSavedEnabled}
          pollData={pollData}
          setPollData={setPollData}
          pollLoading={pollLoading}
          setSysAlert={setSysAlert}
          CABLE_COLORS={CABLE_COLORS}
          currentDevice={currentDevice}
          setCurrentDevice={setCurrentDevice}
          targetRackId={targetRackId}
          targetU={targetU}
          allDevicesInDC={allDevicesInDC}
          openPortEditor={openPortEditor}
          closeDeviceModal={closeDeviceModal}
          pollCurrentDevice={pollCurrentDevice}
          snmpLive={snmpLive}
          openMoveModal={openMoveModal}
          saveDevice={saveDevice}
          removeDevice={removeDevice}
          handleNodeChange={handleNodeChange}
        />
      )}

      {/* Action Modal */}
      {showActionModal && currentActionDevice && (
        <DeviceActionModal
          role={role}
          targetRackId={targetRackId}
          setShowActionModal={setShowActionModal}
          currentActionDevice={currentActionDevice}
          openEditDevice={openEditDevice}
          openReportForm={openReportForm}
        />
      )}

      {/* Port Status Modal (Read-only View) */}
      {showPortStatusModal && portStatusDevice && (
        <PortStatusModal
          setShowPortStatusModal={setShowPortStatusModal}
          portStatusDevice={portStatusDevice}
        />
      )}

      {/* Custom Alert Modal */}
      {sysAlert && (
        <SysAlertModal
          sysAlert={sysAlert}
          setSysAlert={setSysAlert}
        />
      )}

      {/* Custom Confirm Modal */}
      {sysConfirm && (
        <SysConfirmModal
          sysConfirm={sysConfirm}
          setSysConfirm={setSysConfirm}
        />
      )}

      {/* Print Racks Modal */}
      {showPrintModal && (
        <PrintRacksModal
          racks={racks}
          setShowPrintModal={setShowPrintModal}
          selectedPrintRacks={selectedPrintRacks}
          setSelectedPrintRacks={setSelectedPrintRacks}
          expandedPrintRows={expandedPrintRows}
          setExpandedPrintRows={setExpandedPrintRows}
          handleTriggerExport={handleTriggerExport}
          rowsGroup={rowsGroup}
          sortedRowNumbers={sortedRowNumbers}
        />
      )}

      {/* Move Device Modal */}
      {showMoveModal && currentDevice && (
        <MoveDeviceModal
          showToast={showToast}
          racks={racks}
          selectedDC={selectedDC}
          uOrder={uOrder}
          setShowMoveModal={setShowMoveModal}
          moveTargetRackId={moveTargetRackId}
          setMoveTargetRackId={setMoveTargetRackId}
          moveTargetSection={moveTargetSection}
          setMoveTargetSection={setMoveTargetSection}
          moveTargetU={moveTargetU}
          setMoveTargetU={setMoveTargetU}
          moveTargetToBack={moveTargetToBack}
          setMoveTargetToBack={setMoveTargetToBack}
          moveLoading={moveLoading}
          setMoveLoading={setMoveLoading}
          moveError={moveError}
          setMoveError={setMoveError}
          currentDevice={currentDevice}
          targetRackId={targetRackId}
          revisionsRef={revisionsRef}
          saveChainRef={saveChainRef}
          closeDeviceModal={closeDeviceModal}
          reloadRacks={reloadRacks}
        />
      )}

      {/* Print Only Layout */}
      {isPrinting && (
        <RackPrintLayout
          racks={racks}
          selectedDC={selectedDC}
          uOrder={uOrder}
          noop={noop}
          getSelectedRacksList={getSelectedRacksList}
        />
      )}

      {/* Off-screen Image Export Render Layout */}
      {isExporting && (
        <RackExportLayout
          racks={racks}
          selectedDC={selectedDC}
          uOrder={uOrder}
          noop={noop}
          getSelectedRacksList={getSelectedRacksList}
        />
      )}
    </div>
  );
}
