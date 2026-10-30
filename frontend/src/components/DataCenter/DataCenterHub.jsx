import React, { useState } from 'react';
import DataCenters from './DataCenters';
import ServerRack from './ServerRack';
import TopologyMap from './TopologyMap';
import SpareParts from './SpareParts';
import HardwareIssues from './HardwareIssues';
import ContractsWarranties from './ContractsWarranties';

const DataCenterHub = ({ activeTab = 'server-rack', setActiveView }) => {
    const [selectedDCId, setSelectedDCId] = useState(() => {
        return sessionStorage.getItem('dc_selected_dc_id') || localStorage.getItem('dc_selected_dc_id') || null;
    });
    const [targetRackId, setTargetRackId] = useState(() => {
        return sessionStorage.getItem('dc_target_rack_id') || localStorage.getItem('dc_target_rack_id') || null;
    });
    const [editRequest, setEditRequest] = useState(() => {
        try {
            const saved = sessionStorage.getItem('dc_edit_request') || localStorage.getItem('dc_edit_request');
            return saved ? JSON.parse(saved) : null;
        } catch { return null; }
    });

    const handleSelectDC = (id, rId) => {
        if (id) {
            sessionStorage.setItem('dc_selected_dc_id', id);
            localStorage.setItem('dc_selected_dc_id', id);
        }
        if (rId) {
            sessionStorage.setItem('dc_target_rack_id', rId);
            localStorage.setItem('dc_target_rack_id', rId);
        }
        setSelectedDCId(id);
        setTargetRackId(rId);
        if (setActiveView) setActiveView('DC_RACK');
    };

    // Handle cross-tab edit requests
    // dcId (optional): the device lives in another DC (e.g. a cross-DC node of the topology map)
    const handleEditDevice = (device, defaultTab, returnTab, dcId) => {
        if (dcId && dcId !== selectedDCId) {
            sessionStorage.setItem('dc_selected_dc_id', dcId);
            localStorage.setItem('dc_selected_dc_id', dcId);
            setSelectedDCId(dcId);
        }
        const payload = { device, defaultTab, returnTab };
        sessionStorage.setItem('dc_edit_request', JSON.stringify(payload));
        localStorage.setItem('dc_edit_request', JSON.stringify(payload));
        setEditRequest(payload);
        if (setActiveView) setActiveView('DC_RACK');
    };

    const handleClearEdit = () => {
        if (editRequest && editRequest.returnTab) {
            if (setActiveView) {
                setActiveView(editRequest.returnTab === 'topology-map' ? 'DC_TOPOLOGY' : 'DC_RACK');
            }
        }
        sessionStorage.removeItem('dc_edit_request');
        localStorage.removeItem('dc_edit_request');
        setEditRequest(null);
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'data-centers':
                return <DataCenters onSelectDC={handleSelectDC} />;
            case 'server-rack':
                return <ServerRack selectedDCId={selectedDCId} initialTargetRackId={targetRackId} editRequest={editRequest} onClearEdit={handleClearEdit} />;
            case 'topology-map':
                return <TopologyMap selectedDCId={selectedDCId} onEditDevice={(device, defaultTab, opts) => handleEditDevice(device, defaultTab, 'topology-map', opts && opts.dcId)} />;
            case 'spare-parts':
                return <SpareParts />;
            case 'hardware-issues':
                return <HardwareIssues />;
            case 'contracts':
                return <ContractsWarranties />;
            default:
                return <ServerRack selectedDCId={selectedDCId} />;
        }
    };

    return (
        <div style={{ padding: '24px 32px', minHeight: '100%', fontFamily: "'Inter', sans-serif", position: 'relative', overflow: 'hidden' }}>
            <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundImage: "url('/datacenter-bg.jpg')",
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                opacity: 0.15,
                pointerEvents: 'none',
                zIndex: 0
            }} />
            {/* Content Area */}
            <div className="animate-fade-in" style={{ height: '100%', position: 'relative', zIndex: 1 }}>
                {renderContent()}
            </div>
        </div>
    );
};

export default DataCenterHub;
