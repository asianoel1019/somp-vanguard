import { useState } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';

export function useTagManagement(monitors = [], setMonitors = () => {}) {
    const [tagInput, setTagInput] = useState('');
    const { showToast } = useToast();

    const addTagToHost = async (host, newTag) => {
        if (!host || !newTag.trim()) return;
        const tagClean = newTag.trim();
        const currentTags = Array.isArray(host.tags) ? host.tags : [];
        if (currentTags.includes(tagClean)) {
            setTagInput('');
            return;
        }
        const updatedTags = [...currentTags, tagClean];
        try {
            const res = await api.put(`/monitor/${host.id}`, { tags: updatedTags });
            setMonitors(prev => prev.map(m => m.id === res.data.id ? res.data : m));
            setTagInput('');
            showToast(`Tag "${tagClean}" added`, 'success');
            return res.data;
        } catch (err) {
            console.error('[useTagManagement] Failed to add tag:', err);
            showToast('Failed to add tag to host', 'error');
        }
    };

    const removeTagFromHost = async (host, tagToRemove) => {
        if (!host) return;
        const currentTags = Array.isArray(host.tags) ? host.tags : [];
        const updatedTags = currentTags.filter(t => t !== tagToRemove);
        try {
            const res = await api.put(`/monitor/${host.id}`, { tags: updatedTags });
            setMonitors(prev => prev.map(m => m.id === res.data.id ? res.data : m));
            showToast(`Tag "${tagToRemove}" removed`, 'info');
            return res.data;
        } catch (err) {
            console.error('[useTagManagement] Failed to remove tag:', err);
            showToast('Failed to remove tag from host', 'error');
        }
    };

    return {
        tagInput,
        setTagInput,
        addTagToHost,
        removeTagFromHost
    };
}
