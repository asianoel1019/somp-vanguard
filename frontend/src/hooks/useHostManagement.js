import { useState, useEffect } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';

export function useHostManagement() {
    const [monitors, setMonitors] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedHostIds, setSelectedHostIds] = useState([]);
    const { showToast } = useToast();

    const fetchMonitors = async () => {
        try {
            setLoading(true);
            const res = await api.get('/monitor/data/dashboard');
            setMonitors(res.data.monitors || []);
            const envRes = await api.get('/environments');
            setEnvironments(envRes.data || []);
        } catch (err) {
            console.error('[useHostManagement] Error fetching monitors:', err);
            showToast('Failed to load host monitors', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchMonitors();
    }, []);

    const toggleSelectHost = (hostId) => {
        setSelectedHostIds(prev => 
            prev.includes(hostId) ? prev.filter(id => id !== hostId) : [...prev, hostId]
        );
    };

    const selectAllHosts = (hostIdsList) => {
        setSelectedHostIds(hostIdsList);
    };

    const clearSelectedHosts = () => {
        setSelectedHostIds([]);
    };

    return {
        monitors,
        setMonitors,
        environments,
        loading,
        selectedHostIds,
        toggleSelectHost,
        selectAllHosts,
        clearSelectedHosts,
        refreshHosts: fetchMonitors
    };
}
