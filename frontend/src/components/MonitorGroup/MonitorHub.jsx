import React from 'react';
import ScoutMonitor from './ScoutMonitor';
import Alerts from './Alerts';
import Agents from './Agents';
import LiveEventViewer from './LiveEventViewer';
import LogSettings from './LogSettings';

const MonitorHub = ({ activeTab = 'scout-monitor', setActiveView }) => {
    const renderContent = () => {
        switch (activeTab) {
            case 'scout-monitor':
                return <ScoutMonitor setActiveView={setActiveView} />;
            case 'alerts':
                return <Alerts setActiveView={setActiveView} />;
            case 'live-viewer':
                return <LiveEventViewer />;
            case 'log-settings':
                return <LogSettings />;
            case 'agents':
                return <Agents setActiveView={setActiveView} />;
            default:
                return <ScoutMonitor setActiveView={setActiveView} />;
        }
    };

    return (
        <div style={{ minHeight: '100%', position: 'relative', overflow: 'hidden' }}>
            <div className="animate-fade-in" style={{ height: '100%', position: 'relative', zIndex: 1 }}>
                {renderContent()}
            </div>
        </div>
    );
};

export default MonitorHub;
