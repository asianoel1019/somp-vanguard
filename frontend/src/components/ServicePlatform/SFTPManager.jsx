import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 16 },
    title: { fontSize: 22, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 10 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 4 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, marginBottom: 20 },
    grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 },
    metricBox: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '18px 20px' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16 },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 15, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 8 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 20px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 20px', verticalAlign: 'middle', fontSize: 13 },
    input: { width: '100%', borderRadius: 12, padding: '10px 14px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    select: { background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 12, padding: '9px 16px', fontSize: 13, outline: 'none', fontFamily: 'inherit', fontWeight: 800, cursor: 'pointer' },
    btnP: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'transform 0.1s' },
    btnO: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '9px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' },
    btnDanger: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 14px', background: 'rgba(255,59,48,0.15)', color: '#ff3b30', border: '1px solid rgba(255,59,48,0.3)', borderRadius: 14, fontSize: 12, fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s' },
    badge: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 800 },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 540, boxShadow: '0 30px 60px rgba(0,0,0,0.4)', overflow: 'hidden', backdropFilter: 'blur(16px)', padding: 28 },
    dropdownMenu: { position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: '0 12px 28px rgba(0,0,0,0.4)', minWidth: 130, zIndex: 100, padding: 6, display: 'flex', flexDirection: 'column', gap: 2 },
    dropdownItem: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', borderRadius: 8, color: 'var(--text-primary)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s' }
};

const SFTPManager = ({ setActiveView }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();

    const [servers, setServers] = useState([]);
    const [selectedServerId, setSelectedServerId] = useState('');
    const [loadingServers, setLoadingServers] = useState(true);

    const [status, setStatus] = useState(null);
    const [users, setUsers] = useState([]);
    const [groups, setGroups] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(false);
    const [activeTab, setActiveTab] = useState('users');
    const [userSearch, setUserSearch] = useState('');
    const [groupFilter, setGroupFilter] = useState('ALL');
    const [logSearch, setLogSearch] = useState('');
    const [logFilterType, setLogFilterType] = useState('ALL');

    // User Modal state
    const [showUserModal, setShowUserModal] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [isCloning, setIsCloning] = useState(false);
    const [selectedUsers, setSelectedUsers] = useState([]);
    const [actionDropdownUser, setActionDropdownUser] = useState(null);

    // Bulk Edit Modal state
    const [showBulkEditModal, setShowBulkEditModal] = useState(false);
    const [savingBulkEdit, setSavingBulkEdit] = useState(false);
    const [bulkEditForm, setBulkEditForm] = useState({
        applyGroup: false,
        group: 'General',
        applyEnabled: false,
        enabled: true,
        applyReadOnly: false,
        read_only: false,
        applyRateLimit: false,
        rate_limit_kbps: 0,
        applyMaxConnections: false,
        max_connections: 0,
        applyIdleTimeout: false,
        idle_timeout_seconds: 0
    });
    const [userForm, setUserForm] = useState({
        username: '',
        group: 'General',
        auth_type: 'LOCAL',
        domain: '',
        home_dir: '',
        rate_limit_kbps: 0,
        max_connections: 0,
        idle_timeout_seconds: 0,
        read_only: false,
        enabled: true,
        password: ''
    });
    const [savingUser, setSavingUser] = useState(false);
    const [restarting, setRestarting] = useState(false);

    // Group Modal state
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [isEditingGroup, setIsEditingGroup] = useState(false);
    const [groupForm, setGroupForm] = useState({
        name: '',
        description: '',
        home_dir_template: 'C:\\SFTP_Data\\Groups\\{username}',
        read_only: false,
        rate_limit_kbps: 0,
        max_connections: 0,
        idle_timeout_seconds: 0
    });
    const [savingGroup, setSavingGroup] = useState(false);

    // Server Config state
    const [serverConfig, setServerConfig] = useState(null);
    const [savingServerConfig, setSavingServerConfig] = useState(false);

    // Test AD inside Modal state
    const [testingAd, setTestingAd] = useState(false);
    const [testAdResult, setTestAdResult] = useState(null);

    // Folder Browser Modal state
    const [showBrowseModal, setShowBrowseModal] = useState(false);
    const [browseData, setBrowseData] = useState({ current_path: '', parent_path: null, items: [] });
    const [browseTargetField, setBrowseTargetField] = useState('');
    const [selectedBrowsePath, setSelectedBrowsePath] = useState('');
    const [loadingBrowse, setLoadingBrowse] = useState(false);

    // 1. Initial load of configured servers
    useEffect(() => {
        loadServers();
    }, []);

    const loadServers = async () => {
        try {
            setLoadingServers(true);
            const res = await api.get('/sftp/servers');
            const list = res.data.servers || [];
            setServers(list);
            if (list.length > 0) {
                const active = list.find(s => s.enabled) || list[0];
                setSelectedServerId(active.id);
            } else {
                setSelectedServerId('');
            }
        } catch (err) {
            console.error('Failed to load SFTP servers list:', err);
            setServers([]);
        } finally {
            setLoadingServers(false);
        }
    };

    // Track consecutive status check failures to prevent transient network flicker
    const statusFailuresRef = useRef(0);

    // 2. Fetch server data whenever selected server or tab changes
    useEffect(() => {
        if (!selectedServerId) return;

        statusFailuresRef.current = 0;
        setSelectedUsers([]);
        setActionDropdownUser(null);

        fetchStatus();
        fetchUsers();
        fetchGroups();
        fetchSessions();
        fetchLogs();
        if (activeTab === 'server') fetchServerConfig();

        const interval = setInterval(() => {
            fetchStatus(true);
            if (activeTab === 'sessions') fetchSessions(true);
            if (activeTab === 'logs') fetchLogs(true);
        }, 10000);

        return () => clearInterval(interval);
    }, [selectedServerId, activeTab]);

    const fetchStatus = async (silent = false) => {
        if (!selectedServerId) return;
        try {
            if (!silent) setLoading(true);
            const res = await api.get(`/sftp/status?serverId=${selectedServerId}`);
            if (res.data && res.data.status !== 'offline') {
                statusFailuresRef.current = 0;
                setStatus(res.data);
            } else if (res.data && res.data.status === 'offline') {
                statusFailuresRef.current += 1;
                if (statusFailuresRef.current >= 3 || !silent) {
                    setStatus(res.data);
                }
            } else {
                statusFailuresRef.current = 0;
                setStatus(res.data);
            }
        } catch (err) {
            statusFailuresRef.current += 1;
            // Only flip status to offline if failed 3 consecutive times, or on initial explicit manual load
            if (statusFailuresRef.current >= 3 || !silent) {
                setStatus({ status: 'offline', error: err.response?.data?.message || err.message });
            }
        } finally {
            if (!silent) setLoading(false);
        }
    };

    const fetchUsers = async () => {
        if (!selectedServerId) return;
        try {
            const res = await api.get(`/sftp/users?serverId=${selectedServerId}`);
            const fetched = res.data || [];
            setUsers(fetched);
            const fetchedNames = new Set(fetched.map(u => u.username));
            setSelectedUsers(prev => prev.filter(name => fetchedNames.has(name)));
        } catch (err) {
            console.error('Failed to fetch SFTP users:', err);
            setUsers([]);
            setSelectedUsers([]);
        }
    };

    const fetchGroups = async () => {
        if (!selectedServerId) return;
        try {
            const res = await api.get(`/sftp/groups?serverId=${selectedServerId}`);
            setGroups(res.data || []);
        } catch (err) {
            console.error('Failed to fetch SFTP groups:', err);
            setGroups([]);
        }
    };

    const fetchSessions = async (silent = false) => {
        if (!selectedServerId) return;
        try {
            const res = await api.get(`/sftp/sessions?serverId=${selectedServerId}`);
            setSessions(res.data || []);
        } catch (err) {
            console.error('Failed to fetch active SFTP sessions:', err);
            setSessions([]);
        }
    };

    const fetchLogs = async (silent = false) => {
        if (!selectedServerId) return;
        try {
            const res = await api.get(`/sftp/logs?limit=250&serverId=${selectedServerId}`);
            setLogs(res.data || []);
        } catch (err) {
            console.error('Failed to fetch SFTP logs:', err);
            setLogs([]);
        }
    };

    const fetchServerConfig = async () => {
        if (!selectedServerId) return;
        try {
            const res = await api.get(`/sftp/config?serverId=${selectedServerId}`);
            setServerConfig(res.data || null);
        } catch (err) {
            console.error('Failed to fetch server config:', err);
        }
    };

    // User Handlers
    const handleOpenAddUser = () => {
        setIsEditing(false);
        setIsCloning(false);
        setTestAdResult(null);
        setUserForm({
            username: '',
            group: groups[0]?.name || 'General',
            auth_type: 'LOCAL',
            domain: '',
            home_dir: '',
            rate_limit_kbps: 0,
            max_connections: 0,
            idle_timeout_seconds: 0,
            read_only: false,
            enabled: true,
            password: ''
        });
        setShowUserModal(true);
    };

    const handleOpenEditUser = (u) => {
        setIsEditing(true);
        setIsCloning(false);
        setTestAdResult(null);
        setUserForm({
            username: u.username,
            group: u.group || 'General',
            auth_type: u.auth_type || 'LOCAL',
            domain: u.domain || '',
            home_dir: u.home_dir || '',
            rate_limit_kbps: u.rate_limit_kbps || 0,
            max_connections: u.max_connections || 0,
            idle_timeout_seconds: u.idle_timeout_seconds || 0,
            read_only: !!u.read_only,
            enabled: u.enabled !== false,
            password: ''
        });
        setShowUserModal(true);
    };

    const handleCloneUser = (u) => {
        setIsEditing(false);
        setIsCloning(true);
        setTestAdResult(null);
        setUserForm({
            username: `${u.username}_copy`,
            group: u.group || 'General',
            auth_type: u.auth_type || 'LOCAL',
            domain: u.domain || '',
            home_dir: u.home_dir || '',
            rate_limit_kbps: u.rate_limit_kbps || 0,
            max_connections: u.max_connections || 0,
            idle_timeout_seconds: u.idle_timeout_seconds || 0,
            read_only: !!u.read_only,
            enabled: true,
            password: ''
        });
        setShowUserModal(true);
        showToast(`Cloning settings from user "${u.username}". Enter a new unique username and password.`, 'info');
    };

    const handleToggleSelectAll = () => {
        if (selectedUsers.length === filteredUsers.length && filteredUsers.length > 0) {
            setSelectedUsers([]);
        } else {
            setSelectedUsers(filteredUsers.map(u => u.username));
        }
    };

    const handleToggleSelectUser = (username) => {
        setSelectedUsers(prev =>
            prev.includes(username) ? prev.filter(u => u !== username) : [...prev, username]
        );
    };

    const handleBulkDelete = async () => {
        if (selectedUsers.length === 0) return;
        const confirmed = await showConfirm(
            `Are you sure you want to delete ${selectedUsers.length} user(s) from ${currentServer?.name || 'server'}?\n\nTarget accounts: ${selectedUsers.slice(0, 8).join(', ')}${selectedUsers.length > 8 ? ` and ${selectedUsers.length - 8} more...` : ''}\n\nThey will lose SFTP access immediately.`,
            `Bulk Delete SFTP Users (${selectedUsers.length})`
        );
        if (!confirmed) return;

        try {
            const res = await api.post(`/sftp/users/bulk-delete?serverId=${selectedServerId}`, {
                usernames: selectedUsers
            });
            showToast(`Successfully deleted ${res.data.deleted} user(s)`, 'success');
            setSelectedUsers([]);
            fetchUsers();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to bulk delete users', 'error');
        }
    };

    const handleOpenBulkEdit = () => {
        if (selectedUsers.length === 0) {
            showToast('Please select at least one user to bulk edit', 'warning');
            return;
        }
        setBulkEditForm({
            applyGroup: false,
            group: groups[0]?.name || 'General',
            applyEnabled: false,
            enabled: true,
            applyReadOnly: false,
            read_only: false,
            applyRateLimit: false,
            rate_limit_kbps: 0,
            applyMaxConnections: false,
            max_connections: 0,
            applyIdleTimeout: false,
            idle_timeout_seconds: 0
        });
        setShowBulkEditModal(true);
    };

    const handleSaveBulkEdit = async (e) => {
        e.preventDefault();
        const updates = {};
        if (bulkEditForm.applyGroup) updates.group = bulkEditForm.group;
        if (bulkEditForm.applyEnabled) updates.enabled = bulkEditForm.enabled;
        if (bulkEditForm.applyReadOnly) updates.read_only = bulkEditForm.read_only;
        if (bulkEditForm.applyRateLimit) updates.rate_limit_kbps = bulkEditForm.rate_limit_kbps;
        if (bulkEditForm.applyMaxConnections) updates.max_connections = bulkEditForm.max_connections;
        if (bulkEditForm.applyIdleTimeout) updates.idle_timeout_seconds = bulkEditForm.idle_timeout_seconds;

        if (Object.keys(updates).length === 0) {
            showToast('Please check and select at least one attribute to update', 'warning');
            return;
        }

        try {
            setSavingBulkEdit(true);
            const res = await api.post(`/sftp/users/bulk-update?serverId=${selectedServerId}`, {
                usernames: selectedUsers,
                updates
            });
            showToast(`Successfully batch updated ${res.data.updated} of ${selectedUsers.length} user(s)!`, 'success');
            setShowBulkEditModal(false);
            setSelectedUsers([]);
            fetchUsers();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to bulk update users', 'error');
        } finally {
            setSavingBulkEdit(false);
        }
    };

    const handleUserGroupChange = (grpName) => {
        const matched = groups.find(g => g.name === grpName);
        setUserForm(prev => ({
            ...prev,
            group: grpName,
            read_only: matched ? !!matched.read_only : prev.read_only,
            rate_limit_kbps: matched ? (matched.rate_limit_kbps || 0) : prev.rate_limit_kbps,
            max_connections: matched ? (matched.max_connections || 0) : prev.max_connections,
            idle_timeout_seconds: matched ? (matched.idle_timeout_seconds || 0) : prev.idle_timeout_seconds
        }));
    };

    const handleSaveUser = async (e) => {
        e.preventDefault();
        if (!userForm.username.trim()) {
            showToast('Username cannot be empty', 'error');
            return;
        }

        try {
            setSavingUser(true);
            const res = await api.post(`/sftp/users?serverId=${selectedServerId}`, userForm);
            showToast(res.data.message || 'User saved successfully!', 'success');
            setShowUserModal(false);
            fetchUsers();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to save user', 'error');
        } finally {
            setSavingUser(false);
        }
    };

    const handleDeleteUser = async (username) => {
        const confirmed = await showConfirm(
            `Are you sure you want to delete user mapping "${username}" from ${currentServer?.name || 'server'}? They will lose SFTP access immediately.`,
            'Delete SFTP User'
        );
        if (!confirmed) return;

        try {
            await api.delete(`/sftp/users/${encodeURIComponent(username)}?serverId=${selectedServerId}`);
            showToast(`User ${username} deleted successfully`, 'success');
            fetchUsers();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to delete user', 'error');
        }
    };

    // Group Handlers
    const handleOpenAddGroup = () => {
        setIsEditingGroup(false);
        setGroupForm({
            name: '',
            description: '',
            home_dir_template: 'C:\\SFTP_Data\\Groups\\{username}',
            read_only: false,
            rate_limit_kbps: 0,
            max_connections: 0,
            idle_timeout_seconds: 0
        });
        setShowGroupModal(true);
    };

    const handleOpenEditGroup = (g) => {
        setIsEditingGroup(true);
        setGroupForm({
            name: g.name,
            description: g.description || '',
            home_dir_template: g.home_dir_template || '',
            read_only: !!g.read_only,
            rate_limit_kbps: g.rate_limit_kbps || 0,
            max_connections: g.max_connections || 0,
            idle_timeout_seconds: g.idle_timeout_seconds || 0
        });
        setShowGroupModal(true);
    };

    const handleSaveGroup = async (e) => {
        e.preventDefault();
        if (!groupForm.name.trim()) {
            showToast('Group name cannot be empty', 'error');
            return;
        }
        try {
            setSavingGroup(true);
            const res = await api.post(`/sftp/groups?serverId=${selectedServerId}`, groupForm);
            showToast(res.data.message || 'Group saved successfully!', 'success');
            setShowGroupModal(false);
            fetchGroups();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to save group', 'error');
        } finally {
            setSavingGroup(false);
        }
    };

    const handleDeleteGroup = async (groupName) => {
        const confirmed = await showConfirm(
            `Are you sure you want to delete group "${groupName}"? Users must not be assigned to this group.`,
            'Delete User Group'
        );
        if (!confirmed) return;

        try {
            await api.delete(`/sftp/groups/${encodeURIComponent(groupName)}?serverId=${selectedServerId}`);
            showToast(`Group ${groupName} deleted successfully`, 'success');
            fetchGroups();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to delete group', 'error');
        }
    };

    // Server Config & Controls Handlers
    const handleSaveServerConfig = async (e) => {
        e.preventDefault();
        try {
            setSavingServerConfig(true);
            const res = await api.post(`/sftp/config?serverId=${selectedServerId}`, serverConfig);
            showToast(res.data.message || 'Server configuration saved!', 'success');
            fetchStatus(true);
            fetchServerConfig();
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to save server config', 'error');
        } finally {
            setSavingServerConfig(false);
        }
    };

    const handleServiceControl = async (action) => {
        const actionLabels = { start: 'Start', stop: 'Stop', restart: 'Restart' };
        const confirmed = await showConfirm(
            `Are you sure you want to ${action} the SFTP server engine listener on ${currentServer?.name}?`,
            `${actionLabels[action] || action} SFTP Listener`
        );
        if (!confirmed) return;

        try {
            setRestarting(true);
            await api.post(`/sftp/service/${action}?serverId=${selectedServerId}`);
            showToast(`SFTP listener ${action}ed successfully`, 'success');
            setTimeout(() => fetchStatus(), 1000);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || `Failed to ${action} SFTP service`, 'error');
        } finally {
            setRestarting(false);
        }
    };

    const handlePurgeLogs = async () => {
        const confirmed = await showConfirm(
            `Scan log directory on ${currentServer?.name} and delete audit files older than the retention threshold?`,
            'Purge Expired Logs'
        );
        if (!confirmed) return;

        try {
            const res = await api.post(`/sftp/logs/purge?serverId=${selectedServerId}`, {});
            showToast(`Purged ${res.data.purged_count} expired log file(s). Freed ${(res.data.freed_bytes / 1024).toFixed(1)} KB.`, 'success');
            fetchLogs();
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to purge logs', 'error');
        }
    };

    // Remote Folder Browser Handlers
    const openFolderBrowser = (targetField, initialPath = '') => {
        setBrowseTargetField(targetField);
        setSelectedBrowsePath(initialPath);
        setShowBrowseModal(true);
        loadBrowsePath(initialPath);
    };

    const loadBrowsePath = async (targetPath = '') => {
        try {
            setLoadingBrowse(true);
            const pathQuery = targetPath ? `&path=${encodeURIComponent(targetPath)}` : '';
            const res = await api.get(`/sftp/browse?serverId=${selectedServerId}${pathQuery}`);
            setBrowseData(res.data);
            setSelectedBrowsePath(res.data.current_path || '');
        } catch (err) {
            showToast('Cannot browse folder on remote server', 'error');
        } finally {
            setLoadingBrowse(false);
        }
    };

    const confirmFolderSelection = () => {
        if (!selectedBrowsePath) {
            setShowBrowseModal(false);
            return;
        }
        if (browseTargetField === 'userForm.home_dir') {
            setUserForm(prev => ({ ...prev, home_dir: selectedBrowsePath }));
        } else if (browseTargetField === 'groupForm.home_dir_template') {
            setGroupForm(prev => ({ ...prev, home_dir_template: selectedBrowsePath + '\\{username}' }));
        } else if (browseTargetField === 'serverConfig.default_root_dir') {
            setServerConfig(prev => ({ ...prev, default_root_dir: selectedBrowsePath }));
        } else if (browseTargetField === 'serverConfig.log_dir') {
            setServerConfig(prev => ({ ...prev, log_dir: selectedBrowsePath }));
        }
        setShowBrowseModal(false);
    };

    const handleKickSession = async (sessionId, username) => {
        const confirmed = await showConfirm(
            `Forcefully disconnect active connection for user "${username}" (Session: ${sessionId.substring(0, 8)}...)?`,
            'Terminate SFTP Session'
        );
        if (!confirmed) return;

        try {
            await api.post(`/sftp/sessions/${sessionId}/kick?serverId=${selectedServerId}`);
            showToast(`Session for ${username} disconnected`, 'success');
            fetchSessions();
            fetchStatus(true);
        } catch (err) {
            showToast(err.response?.data?.error || err.message || 'Failed to terminate session', 'error');
        }
    };

    const handleTestAd = async () => {
        if (!userForm.username.trim() || !userForm.password) {
            showToast('Please enter both AD username and password to test', 'warning');
            return;
        }
        try {
            setTestingAd(true);
            setTestAdResult(null);
            const res = await api.post(`/sftp/test-ad?serverId=${selectedServerId}`, {
                username: userForm.username,
                password: userForm.password,
                domain: userForm.domain
            });
            setTestAdResult(res.data);
            if (res.data.success) {
                showToast('Windows AD authentication verified successfully!', 'success');
            } else {
                showToast(res.data.message || 'AD verification failed', 'error');
            }
        } catch (err) {
            setTestAdResult({ success: false, message: err.response?.data?.error || err.message });
            showToast('AD verification request error', 'error');
        } finally {
            setTestingAd(false);
        }
    };

    const formatUptime = (sec) => {
        if (!sec) return '0s';
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        return `${m}m ${s}s`;
    };

    const formatBytes = (bytes) => {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const currentServer = servers.find(s => s.id === selectedServerId);

    // --- Loading State ---
    if (loadingServers) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}><span>📁</span> SFTP Service Management</h1>
                        <p style={S.subtitle}>Pure Python AsyncSSH SFTP Server & Windows AD Domain Integration</p>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', color: 'var(--text-muted)' }}>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                        <div>Loading SFTP servers configuration...</div>
                    </div>
                </div>
            </div>
        );
    }

    // --- Empty State ---
    if (servers.length === 0) {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={S.header}>
                    <div>
                        <h1 style={S.title}><span>📁</span> SFTP Service Management</h1>
                        <p style={S.subtitle}>Pure Python AsyncSSH SFTP Server with native Windows Active Directory authentication & sandboxed VFS</p>
                    </div>
                </div>
                <div style={{ ...S.card, textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 8 }}>
                        尚未設定 SFTP 伺服器 (No SFTP Servers Configured)
                    </div>
                    <p style={{ fontSize: 13, marginBottom: 24, maxWidth: 500, margin: '0 auto 24px auto', lineHeight: 1.6 }}>
                        Please configure SFTP servers in <strong>Settings → File Services → SFTP Servers</strong> first to enable centralized multi-server management.
                    </p>
                    {setActiveView && (
                        <button style={S.btnP} onClick={() => {
                            try { sessionStorage.setItem('somp.settings.category', 'fileservices'); sessionStorage.setItem('somp.settings.tab', 'sftp'); } catch { /* storage unavailable */ }
                            setActiveView('SYS_SETTINGS');
                        }}>
                            ⚙️ Go to Settings
                        </button>
                    )}
                </div>
            </div>
        );
    }

    const filteredUsers = users.filter(u => {
        if (groupFilter !== 'ALL' && (u.group || 'General') !== groupFilter) return false;
        if (!userSearch) return true;
        const q = userSearch.toLowerCase();
        return (u.username && u.username.toLowerCase().includes(q)) ||
               (u.home_dir && u.home_dir.toLowerCase().includes(q)) ||
               (u.auth_type && u.auth_type.toLowerCase().includes(q));
    });

    const filteredLogs = logs.filter(l => {
        if (logFilterType !== 'ALL' && l.type !== logFilterType) return false;
        if (!logSearch) return true;
        const q = logSearch.toLowerCase();
        return (l.username && l.username.toLowerCase().includes(q)) ||
               (l.client_ip && l.client_ip.toLowerCase().includes(q)) ||
               (l.details && l.details.toLowerCase().includes(q)) ||
               (l.type && l.type.toLowerCase().includes(q));
    });

    return (
        <div style={S.page} className="animate-fade-in">
            {/* Header with Server Switcher */}
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>
                        <span>📁</span> SFTP Service Management
                    </h1>
                    <p style={S.subtitle}>
                        Pure Python AsyncSSH SFTP Server with native Windows Active Directory authentication & sandboxed VFS
                    </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {/* Server Switcher Dropdown */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: '4px 12px' }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SERVER:</span>
                        <select
                            style={{ ...S.select, border: 'none', background: 'transparent', padding: '6px 8px', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}
                            value={selectedServerId}
                            onChange={e => setSelectedServerId(e.target.value)}
                        >
                            {servers.map(s => (
                                <option key={s.id} value={s.id} style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
                                    {s.name} ({s.host}) {!s.enabled ? ' [Disabled]' : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button style={S.btnO} onClick={() => { fetchStatus(); fetchUsers(); fetchGroups(); fetchSessions(); fetchLogs(); if (activeTab === 'server') fetchServerConfig(); }}>
                        🔄 Refresh
                    </button>
                    {activeTab === 'users' && (
                        <button style={S.btnP} onClick={handleOpenAddUser} disabled={!currentServer?.enabled}>
                            ➕ Add SFTP User
                        </button>
                    )}
                    {activeTab === 'groups' && (
                        <button style={S.btnP} onClick={handleOpenAddGroup} disabled={!currentServer?.enabled}>
                            ➕ Add User Group
                        </button>
                    )}
                </div>
            </div>

            {/* Metrics Row */}
            <div style={S.grid4}>
                <div style={S.metricBox}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Service Status</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <span style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: status?.status === 'online' ? '#34c759' : '#ff3b30',
                            boxShadow: status?.status === 'online' ? '0 0 10px #34c759' : 'none'
                        }}></span>
                        <span style={{ fontSize: 18, fontWeight: 900, textTransform: 'uppercase', color: status?.status === 'online' ? '#34c759' : '#ff3b30' }}>
                            {status?.status || 'OFFLINE'}
                        </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        {status?.status === 'online' ? `Port ${status.sftp_port} on ${currentServer?.host}` : (status?.message || 'Server unreachable')}
                    </div>
                </div>

                <div style={S.metricBox}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Active Connections</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: '#38bdf8', marginTop: 4 }}>
                        {status?.active_connections || 0}
                        {status?.max_connections > 0 && (
                            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-muted)', marginLeft: 6 }}>
                                / {status.max_connections} max
                            </span>
                        )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        {status?.max_connections > 0 ? `Server limit: ${status.max_connections} concurrent` : 'Unlimited concurrent capacity'}
                    </div>
                </div>

                <div style={S.metricBox}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Users & Groups</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: '#a855f7', marginTop: 4 }}>
                        {users.length} <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>/ {groups.length} Groups</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        {users.filter(u => u.auth_type === 'AD').length} AD / {users.filter(u => u.auth_type === 'LOCAL').length} Local
                    </div>
                </div>

                <div style={S.metricBox}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Global Rate Limit</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: '#f472b6', marginTop: 4 }}>
                        {status?.rate_limit_kbps > 0 ? `${status.rate_limit_kbps} KB/s` : 'Unlimited'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Token-bucket bandwidth throttle
                    </div>
                </div>
            </div>

            {/* Tab Navigation */}
            <div style={{ display: 'flex', gap: 10, borderBottom: '1px solid var(--border-color)', paddingBottom: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                    { id: 'users', label: '👥 Users & Directory Mappings', count: users.length },
                    { id: 'groups', label: '📁 Classification Groups', count: groups.length },
                    { id: 'sessions', label: '⚡ Active Connections', count: sessions.length },
                    { id: 'logs', label: '📋 Audit & Transfer Logs', count: logs.length },
                    { id: 'server', label: '⚙️ Server Settings & Whitelist', count: null }
                ].map(t => (
                    <button
                        key={t.id}
                        onClick={() => {
                            setActiveTab(t.id);
                            if (t.id === 'server') fetchServerConfig();
                        }}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '10px 18px',
                            borderRadius: 14,
                            fontSize: 13,
                            fontWeight: 800,
                            border: activeTab === t.id ? '1px solid var(--accent-primary)' : '1px solid transparent',
                            background: activeTab === t.id ? 'rgba(139,92,246,0.15)' : 'transparent',
                            color: activeTab === t.id ? 'var(--accent-primary)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                        }}
                    >
                        <span>{t.label}</span>
                        {t.count !== null && (
                            <span style={{
                                padding: '2px 8px',
                                borderRadius: 10,
                                fontSize: 10,
                                background: activeTab === t.id ? 'var(--accent-primary)' : 'rgba(255,255,255,0.08)',
                                color: '#fff'
                            }}>
                                {t.count}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* TAB 1: USERS */}
            {activeTab === 'users' && (
                <div style={S.tblWrap}>
                    <div style={S.tblHead}>
                        <div style={S.tblTitle}>
                            <span>👥</span> User Account Mappings ({filteredUsers.length}) on {currentServer?.name}
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <select
                                style={{ ...S.select, padding: '7px 12px', fontSize: 12 }}
                                value={groupFilter}
                                onChange={e => setGroupFilter(e.target.value)}
                            >
                                <option value="ALL">All Groups</option>
                                {groups.map(g => (
                                    <option key={g.name} value={g.name}>{g.name}</option>
                                ))}
                            </select>
                            <input
                                type="text"
                                placeholder="🔍 Filter username, auth type, or path..."
                                value={userSearch}
                                onChange={e => setUserSearch(e.target.value)}
                                style={{ ...S.input, maxWidth: 260, margin: 0 }}
                            />
                        </div>
                    </div>

                    {/* Bulk Action Toolbar */}
                    {selectedUsers.length > 0 && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 24px',
                            background: 'rgba(139,92,246,0.12)',
                            borderBottom: '1px solid rgba(139,92,246,0.25)',
                            flexWrap: 'wrap',
                            gap: 12
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ fontSize: 13, fontWeight: 800, color: '#c084fc' }}>
                                    ✓ {selectedUsers.length} of {filteredUsers.length} user(s) selected
                                </span>
                                <button
                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
                                    onClick={() => setSelectedUsers([])}
                                >
                                    Clear selection
                                </button>
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    style={{ ...S.btnP, padding: '7px 16px', fontSize: 12 }}
                                    onClick={handleOpenBulkEdit}
                                >
                                    ✏️ Bulk Edit ({selectedUsers.length})
                                </button>
                                <button
                                    style={{ ...S.btnDanger, padding: '7px 16px', fontSize: 12 }}
                                    onClick={handleBulkDelete}
                                >
                                    🗑️ Bulk Delete ({selectedUsers.length})
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Click outside backdrop for Action Dropdown */}
                    {actionDropdownUser && (
                        <div
                            style={{ position: 'fixed', inset: 0, zIndex: 90 }}
                            onClick={() => setActionDropdownUser(null)}
                        />
                    )}

                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={{ ...S.th, width: 44, textAlign: 'center' }}>
                                    <input
                                        type="checkbox"
                                        checked={filteredUsers.length > 0 && selectedUsers.length === filteredUsers.length}
                                        onChange={handleToggleSelectAll}
                                        style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.15)' }}
                                        title="Select all"
                                    />
                                </th>
                                <th style={S.th}>USERNAME</th>
                                <th style={S.th}>GROUP</th>
                                <th style={S.th}>AUTH TYPE</th>
                                <th style={S.th}>HOME DIRECTORY (SANDBOX ROOT)</th>
                                <th style={S.th}>RATE LIMIT</th>
                                <th style={S.th}>PERMISSION</th>
                                <th style={S.th}>STATUS</th>
                                <th style={{ ...S.th, textAlign: 'right', width: 110 }}>ACTION</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredUsers.map((u, idx) => {
                                const isNearBottom = filteredUsers.length > 2 && idx >= filteredUsers.length - 2;
                                const isDropdownOpen = actionDropdownUser === u.username;
                                return (
                                    <tr
                                        key={u.username}
                                        style={{
                                            ...S.tr,
                                            background: selectedUsers.includes(u.username) ? 'rgba(139,92,246,0.06)' : undefined,
                                            position: isDropdownOpen ? 'relative' : undefined,
                                            zIndex: isDropdownOpen ? 102 : undefined
                                        }}
                                    >
                                        <td style={{ ...S.td, textAlign: 'center' }}>
                                            <input
                                                type="checkbox"
                                                checked={selectedUsers.includes(u.username)}
                                                onChange={() => handleToggleSelectUser(u.username)}
                                                style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.15)' }}
                                            />
                                        </td>
                                        <td style={{ ...S.td, fontWeight: 800, color: 'var(--text-primary)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <span style={{ fontSize: 16 }}>{u.auth_type === 'AD' ? '🏢' : '👤'}</span>
                                                <span>{u.username}</span>
                                            </div>
                                        </td>
                                        <td style={S.td}>
                                            <span style={{ ...S.badge, background: 'rgba(168,85,247,0.15)', color: '#c084fc', border: '1px solid rgba(168,85,247,0.3)' }}>
                                                {u.group || 'General'}
                                            </span>
                                        </td>
                                        <td style={S.td}>
                                            <span style={{
                                                ...S.badge,
                                                background: u.auth_type === 'AD' ? 'rgba(99,102,241,0.15)' : 'rgba(52,199,89,0.15)',
                                                color: u.auth_type === 'AD' ? '#818cf8' : '#34c759',
                                                border: `1px solid ${u.auth_type === 'AD' ? 'rgba(99,102,241,0.3)' : 'rgba(52,199,89,0.3)'}`
                                            }}>
                                                {u.auth_type === 'AD' ? 'Windows AD' : 'Local Hashed'}
                                            </span>
                                        </td>
                                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>
                                            {u.home_dir}
                                        </td>
                                        <td style={S.td}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                <span style={{ ...S.badge, background: 'rgba(244,114,182,0.15)', color: '#f472b6', border: '1px solid rgba(244,114,182,0.3)', width: 'fit-content' }}>
                                                    {u.rate_limit_kbps > 0 ? `${u.rate_limit_kbps} KB/s` : '⚡ Unlimited'}
                                                </span>
                                                {u.max_connections > 0 && (
                                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                        Max: {u.max_connections} sessions
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td style={S.td}>
                                            <span style={{
                                                ...S.badge,
                                                background: u.read_only ? 'rgba(245,158,11,0.15)' : 'rgba(56,189,248,0.15)',
                                                color: u.read_only ? '#fbbf24' : '#38bdf8',
                                                border: `1px solid ${u.read_only ? 'rgba(245,158,11,0.3)' : 'rgba(56,189,248,0.3)'}`
                                            }}>
                                                {u.read_only ? '🔒 Read-Only' : '✏️ Read-Write'}
                                            </span>
                                        </td>
                                        <td style={S.td}>
                                            <span style={{
                                                ...S.badge,
                                                background: u.enabled ? 'rgba(52,199,89,0.15)' : 'rgba(255,255,255,0.08)',
                                                color: u.enabled ? '#34c759' : 'var(--text-muted)'
                                            }}>
                                                {u.enabled ? '🟢 Enabled' : '⚪ Disabled'}
                                            </span>
                                        </td>
                                        <td style={{ ...S.td, textAlign: 'right', position: 'relative' }}>
                                            <div style={{ position: 'relative', display: 'inline-block' }}>
                                                <button
                                                    style={{
                                                        ...S.btnO,
                                                        padding: '5px 12px',
                                                        fontSize: 12,
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: 6,
                                                        fontWeight: 700
                                                    }}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setActionDropdownUser(actionDropdownUser === u.username ? null : u.username);
                                                    }}
                                                >
                                                    <span>Action</span>
                                                    <span style={{ fontSize: 9, opacity: 0.8 }}>▼</span>
                                                </button>

                                                {isDropdownOpen && (
                                                    <div
                                                        style={{
                                                            ...S.dropdownMenu,
                                                            top: isNearBottom ? 'auto' : 'calc(100% + 4px)',
                                                            bottom: isNearBottom ? 'calc(100% + 4px)' : 'auto',
                                                            zIndex: 1000
                                                        }}
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <button
                                                            style={S.dropdownItem}
                                                            onClick={() => {
                                                                setActionDropdownUser(null);
                                                                handleOpenEditUser(u);
                                                            }}
                                                            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                                                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            <span style={{ fontSize: 14 }}>✏️</span>
                                                            <span>Edit</span>
                                                        </button>
                                                        <button
                                                            style={S.dropdownItem}
                                                            onClick={() => {
                                                                setActionDropdownUser(null);
                                                                handleCloneUser(u);
                                                            }}
                                                            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                                                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            <span style={{ fontSize: 14 }}>📋</span>
                                                            <span>Clone</span>
                                                        </button>
                                                        <div style={{ height: 1, background: 'var(--border-color)', margin: '4px 0' }} />
                                                        <button
                                                            style={{ ...S.dropdownItem, color: '#ff3b30' }}
                                                            onClick={() => {
                                                                setActionDropdownUser(null);
                                                                handleDeleteUser(u.username);
                                                            }}
                                                            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,59,48,0.1)'}
                                                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            <span style={{ fontSize: 14 }}>🗑️</span>
                                                            <span>Delete</span>
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                            {filteredUsers.length === 0 && (
                                <tr>
                                    <td colSpan="9" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No SFTP user mappings found on {currentServer?.name}. Click "Add SFTP User" to create one.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* TAB 2: GROUPS */}
            {activeTab === 'groups' && (
                <div style={S.tblWrap}>
                    <div style={S.tblHead}>
                        <div style={S.tblTitle}>
                            <span>📁</span> Classification Groups &amp; Template Settings ({groups.length}) on {currentServer?.name}
                        </div>
                        <button style={S.btnP} onClick={handleOpenAddGroup} disabled={!currentServer?.enabled}>
                            ➕ Add Group
                        </button>
                    </div>

                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>GROUP NAME</th>
                                <th style={S.th}>DIRECTORY TEMPLATE</th>
                                <th style={S.th}>DEFAULT PERMISSION</th>
                                <th style={S.th}>RATE LIMIT</th>
                                <th style={S.th}>DESCRIPTION</th>
                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groups.map(g => (
                                <tr key={g.name} style={S.tr}>
                                    <td style={{ ...S.td, fontWeight: 800, color: 'var(--text-primary)' }}>
                                        <span style={{ ...S.badge, background: 'rgba(168,85,247,0.15)', color: '#c084fc', border: '1px solid rgba(168,85,247,0.3)' }}>
                                            {g.name}
                                        </span>
                                    </td>
                                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>
                                        {g.home_dir_template || '-'}
                                    </td>
                                    <td style={S.td}>
                                        <span style={{
                                            ...S.badge,
                                            background: g.read_only ? 'rgba(245,158,11,0.15)' : 'rgba(56,189,248,0.15)',
                                            color: g.read_only ? '#fbbf24' : '#38bdf8',
                                            border: `1px solid ${g.read_only ? 'rgba(245,158,11,0.3)' : 'rgba(56,189,248,0.3)'}`
                                        }}>
                                            {g.read_only ? '🔒 Read-Only' : '✏️ Read-Write'}
                                        </span>
                                    </td>
                                    <td style={S.td}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <span style={{ ...S.badge, background: 'rgba(244,114,182,0.15)', color: '#f472b6', border: '1px solid rgba(244,114,182,0.3)', width: 'fit-content' }}>
                                                {g.rate_limit_kbps > 0 ? `${g.rate_limit_kbps} KB/s` : '⚡ Unlimited'}
                                            </span>
                                            {g.max_connections > 0 && (
                                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                    Max: {g.max_connections} sessions
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td style={{ ...S.td, fontSize: 12, color: 'var(--text-muted)' }}>
                                        {g.description || '-'}
                                    </td>
                                    <td style={{ ...S.td, textAlign: 'right' }}>
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                            <button style={{ ...S.btnO, padding: '5px 12px', fontSize: 12 }} onClick={() => handleOpenEditGroup(g)}>
                                                ✏️ Edit
                                            </button>
                                            <button style={S.btnDanger} onClick={() => handleDeleteGroup(g.name)}>
                                                🗑️ Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {groups.length === 0 && (
                                <tr>
                                    <td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No groups configured. Click "Add Group" to create one.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* TAB 3: ACTIVE SESSIONS */}
            {activeTab === 'sessions' && (
                <div style={S.tblWrap}>
                    <div style={S.tblHead}>
                        <div style={S.tblTitle}>
                            <span>⚡</span> Live Active Connections ({sessions.length}) on {currentServer?.name}
                        </div>
                    </div>

                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>SESSION ID</th>
                                <th style={S.th}>USERNAME</th>
                                <th style={S.th}>GROUP</th>
                                <th style={S.th}>CLIENT IP</th>
                                <th style={S.th}>RATE LIMIT</th>
                                <th style={S.th}>TRAFFIC (DOWN / UP)</th>
                                <th style={S.th}>AUTH TYPE</th>
                                <th style={S.th}>LOGIN TIME</th>
                                <th style={S.th}>CURRENT FILE / STATE</th>
                                <th style={{ ...S.th, textAlign: 'right' }}>ACTION</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sessions.map(s => (
                                <tr key={s.session_id} style={S.tr}>
                                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>
                                        {s.session_id.substring(0, 8)}...
                                    </td>
                                    <td style={{ ...S.td, fontWeight: 800, color: 'var(--text-primary)' }}>
                                        {s.username}
                                    </td>
                                    <td style={S.td}>
                                        <span style={{ ...S.badge, background: 'rgba(168,85,247,0.15)', color: '#c084fc' }}>
                                            {s.group || 'None'}
                                        </span>
                                    </td>
                                    <td style={{ ...S.td, fontFamily: 'monospace', color: '#38bdf8' }}>
                                        {s.client_ip}
                                    </td>
                                    <td style={S.td}>
                                        <span style={{ ...S.badge, background: 'rgba(244,114,182,0.15)', color: '#f472b6' }}>
                                            {s.rate_limit_kbps > 0 ? `${s.rate_limit_kbps} KB/s` : '⚡ Unlimited'}
                                        </span>
                                    </td>
                                    <td style={{ ...S.td, fontSize: 12 }}>
                                        <span style={{ color: '#38bdf8', fontWeight: 700 }} title="Downloaded by client">⬇ {formatBytes(s.bytes_read || 0)}</span>
                                        <span style={{ margin: '0 5px', color: 'var(--text-muted)' }}>/</span>
                                        <span style={{ color: '#34c759', fontWeight: 700 }} title="Uploaded by client">⬆ {formatBytes(s.bytes_written || 0)}</span>
                                    </td>
                                    <td style={S.td}>
                                        <span style={{ ...S.badge, background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                                            {s.auth_type}
                                        </span>
                                    </td>
                                    <td style={{ ...S.td, fontSize: 12, color: 'var(--text-muted)' }}>
                                        {new Date(s.login_time).toLocaleTimeString()}
                                    </td>
                                    <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
                                        <span style={{ fontFamily: 'monospace' }}>{s.current_file || 'Idle'}</span>
                                        {s.idle_timeout_seconds > 0 && (
                                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                                                Timeout: {s.idle_timeout_seconds}s
                                            </div>
                                        )}
                                    </td>
                                    <td style={{ ...S.td, textAlign: 'right' }}>
                                        <button style={S.btnDanger} onClick={() => handleKickSession(s.session_id, s.username)}>
                                            🛑 Kick
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {sessions.length === 0 && (
                                <tr>
                                    <td colSpan="10" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No active SFTP connections currently connected to {currentServer?.name}.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* TAB 4: AUDIT LOGS */}
            {activeTab === 'logs' && (
                <div style={S.tblWrap}>
                    <div style={S.tblHead}>
                        <div style={S.tblTitle}>
                            <span>📋</span> Audit & Transfer Event Stream ({filteredLogs.length}) on {currentServer?.name}
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <select
                                style={{ ...S.select, margin: 0, padding: '7px 12px', fontSize: 12, width: 'auto' }}
                                value={logFilterType}
                                onChange={e => setLogFilterType(e.target.value)}
                            >
                                <option value="ALL">All Events</option>
                                <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
                                <option value="LOGIN_FAILED">LOGIN_FAILED</option>
                                <option value="LOGIN_REJECTED">LOGIN_REJECTED</option>
                                <option value="FILE_OPEN_WRITE">FILE_WRITE</option>
                                <option value="FILE_OPEN_READ">FILE_READ</option>
                                <option value="FILE_DELETE">FILE_DELETE</option>
                                <option value="PERMISSION_DENIED">PERMISSION_DENIED</option>
                                <option value="IDLE_TIMEOUT">IDLE_TIMEOUT</option>
                                <option value="LOG_PURGE">LOG_PURGE</option>
                            </select>

                            <input
                                type="text"
                                placeholder="🔍 Filter logs..."
                                value={logSearch}
                                onChange={e => setLogSearch(e.target.value)}
                                style={{ ...S.input, maxWidth: 220, margin: 0, padding: '7px 14px' }}
                            />

                            <button style={{ ...S.btnDanger, padding: '8px 14px' }} onClick={handlePurgeLogs}>
                                🗑️ Purge Expired Logs
                            </button>
                        </div>
                    </div>

                    <div style={{ padding: '10px 24px', background: 'rgba(0,0,0,0.08)', borderBottom: '1px solid var(--border-color)', fontSize: 12, color: 'var(--text-secondary)' }}>
                        <span>📁 Storage: <strong>{status?.log_dir || 'Memory only'}</strong></span>
                        <span style={{ margin: '0 10px' }}>|</span>
                        <span>⏳ Retention: <strong>{status?.log_retention_days > 0 ? `${status.log_retention_days} Days` : 'Forever'}</strong></span>
                        <span style={{ margin: '0 10px' }}>|</span>
                        <span style={{ color: '#34c759' }}>🔄 Rotated Daily (sftp_audit_YYYYMMDD.log)</span>
                    </div>

                    <div style={{ maxHeight: 550, overflowY: 'auto' }}>
                        {filteredLogs.map(l => (
                            <div key={l.id} style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border-color)', fontSize: 12, fontFamily: 'monospace' }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: 11, width: 140, shrink: 0 }}>
                                    {new Date(l.timestamp).toLocaleTimeString()}
                                </span>
                                <span style={{
                                    ...S.badge,
                                    fontSize: 10,
                                    background: l.status === 'SUCCESS' ? 'rgba(52,199,89,0.15)' : 'rgba(255,59,48,0.15)',
                                    color: l.status === 'SUCCESS' ? '#34c759' : '#ff3b30'
                                }}>
                                    {l.type}
                                </span>
                                <span style={{ color: '#38bdf8', fontWeight: 800, width: 180, shrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {l.username} ({l.client_ip})
                                </span>
                                <span style={{ color: 'var(--text-primary)', flex: 1 }}>
                                    {l.details}
                                </span>
                            </div>
                        ))}
                        {filteredLogs.length === 0 && (
                            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                                No log entries match the search criteria on {currentServer?.name}.
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* TAB 5: SERVER SETTINGS & IP WHITELIST */}
            {activeTab === 'server' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {/* Lifecycle Controls */}
                    <div style={S.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>⚡ SFTP Listener Service Controls</h3>
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Control listener port runtime state on {currentServer?.name}</p>
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button style={S.btnP} onClick={() => handleServiceControl('start')} disabled={restarting}>
                                    ▶️ Start Listener
                                </button>
                                <button style={S.btnDanger} onClick={() => handleServiceControl('stop')} disabled={restarting}>
                                    ⏹️ Stop Listener
                                </button>
                                <button style={S.btnO} onClick={() => handleServiceControl('restart')} disabled={restarting}>
                                    {restarting ? '⏳ Restarting...' : '⚡ Restart Listener'}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Server Configuration Form */}
                    {serverConfig && (
                        <div style={S.card}>
                            <h3 style={{ margin: '0 0 16px 0', fontSize: 16, fontWeight: 900 }}>
                                ⚙️ Server Runtime Configuration ({currentServer?.name})
                            </h3>
                            <form onSubmit={handleSaveServerConfig} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>SFTP LISTENING PORT</label>
                                    <input
                                        type="number"
                                        style={S.input}
                                        value={serverConfig.sftp_port || 2222}
                                        onChange={e => setServerConfig({ ...serverConfig, sftp_port: parseInt(e.target.value, 10) })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>GLOBAL RATE LIMIT (KB/S, 0 = UNLIMITED)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        style={S.input}
                                        value={serverConfig.rate_limit_kbps || 0}
                                        onChange={e => setServerConfig({ ...serverConfig, rate_limit_kbps: parseInt(e.target.value, 10) })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>MAX SERVER CONNECTIONS (GLOBAL, 0 = UNLIMITED)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        style={S.input}
                                        value={serverConfig.max_connections || 0}
                                        onChange={e => setServerConfig({ ...serverConfig, max_connections: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>DEFAULT MAX CONNS PER USER (0 = UNLIMITED)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        style={S.input}
                                        value={serverConfig.max_connections_per_user || 0}
                                        onChange={e => setServerConfig({ ...serverConfig, max_connections_per_user: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>GLOBAL IDLE TIMEOUT (SECONDS, 0 = UNLIMITED)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        style={S.input}
                                        value={serverConfig.idle_timeout_seconds !== undefined ? serverConfig.idle_timeout_seconds : 900}
                                        onChange={e => setServerConfig({ ...serverConfig, idle_timeout_seconds: parseInt(e.target.value, 10) || 0 })}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>LOG RETENTION PERIOD (DAYS, 0 = INDEFINITE)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        style={S.input}
                                        value={serverConfig.log_retention_days !== undefined ? serverConfig.log_retention_days : 30}
                                        onChange={e => setServerConfig({ ...serverConfig, log_retention_days: parseInt(e.target.value, 10) })}
                                    />
                                </div>

                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>DEFAULT VIRTUAL ROOT DIRECTORY</label>
                                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                        <input
                                            type="text"
                                            style={{ ...S.input, marginTop: 0, fontFamily: 'monospace' }}
                                            value={serverConfig.default_root_dir || ''}
                                            onChange={e => setServerConfig({ ...serverConfig, default_root_dir: e.target.value })}
                                            required
                                        />
                                        <button type="button" style={S.btnO} onClick={() => openFolderBrowser('serverConfig.default_root_dir', serverConfig.default_root_dir)}>
                                            📁 Browse
                                        </button>
                                    </div>
                                </div>

                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>AUDIT LOG STORAGE DIRECTORY</label>
                                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                        <input
                                            type="text"
                                            style={{ ...S.input, marginTop: 0, fontFamily: 'monospace' }}
                                            value={serverConfig.log_dir || ''}
                                            onChange={e => setServerConfig({ ...serverConfig, log_dir: e.target.value })}
                                        />
                                        <button type="button" style={S.btnO} onClick={() => openFolderBrowser('serverConfig.log_dir', serverConfig.log_dir)}>
                                            📁 Browse
                                        </button>
                                    </div>
                                </div>

                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                        REMOTE MANAGEMENT IP WHITELIST (ALLOWED CLIENT IPS / CIDR SUBNETS)
                                    </label>
                                    <textarea
                                        rows="3"
                                        style={{ ...S.input, fontFamily: 'monospace' }}
                                        placeholder="127.0.0.1, ::1, 192.168.1.0/24, 10.0.0.100"
                                        value={(serverConfig.allowed_ips || []).join(', ')}
                                        onChange={e => setServerConfig({
                                            ...serverConfig,
                                            allowed_ips: e.target.value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
                                        })}
                                    />
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                                        Localhost is permanently whitelisted. Only remote IPs or CIDRs specified here can connect to the SFTP server Web Console and REST API. All other remote IPs are strictly rejected with 403 Forbidden.
                                    </span>
                                </div>

                                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                                    <button type="submit" style={S.btnP} disabled={savingServerConfig}>
                                        {savingServerConfig ? 'Saving...' : '💾 Save & Apply Server Configuration'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}
                </div>
            )}

            {/* ADD / EDIT USER MODAL */}
            {showUserModal && (
                <div style={S.overlay} onClick={() => setShowUserModal(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 16, marginBottom: 20 }}>
                            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>
                                {isEditing ? `✏️ Edit User on ${currentServer?.name}` : (isCloning ? `📋 Clone SFTP User (${userForm.username})` : `➕ Add User to ${currentServer?.name}`)}
                            </h3>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }} onClick={() => setShowUserModal(false)}>
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleSaveUser} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    USERNAME *
                                </label>
                                <input
                                    type="text"
                                    style={S.input}
                                    placeholder="Enter username"
                                    value={userForm.username}
                                    disabled={isEditing}
                                    onChange={e => setUserForm({ ...userForm, username: e.target.value })}
                                    required
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    CLASSIFICATION GROUP
                                </label>
                                <select
                                    style={S.select}
                                    value={userForm.group}
                                    onChange={e => handleUserGroupChange(e.target.value)}
                                >
                                    {groups.map(g => (
                                        <option key={g.name} value={g.name}>{g.name}</option>
                                    ))}
                                    {groups.length === 0 && (
                                        <option value="General">General (Default)</option>
                                    )}
                                </select>
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    AUTHENTICATION TYPE *
                                </label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
                                    <button
                                        type="button"
                                        style={{
                                            padding: '10px 14px',
                                            borderRadius: 12,
                                            border: userForm.auth_type === 'LOCAL' ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                            background: userForm.auth_type === 'LOCAL' ? 'rgba(139,92,246,0.15)' : 'transparent',
                                            color: userForm.auth_type === 'LOCAL' ? '#fff' : 'var(--text-muted)',
                                            fontWeight: 800,
                                            fontSize: 12,
                                            cursor: 'pointer'
                                        }}
                                        onClick={() => setUserForm({ ...userForm, auth_type: 'LOCAL' })}
                                    >
                                        🔑 Local Hashed Account
                                    </button>
                                    <button
                                        type="button"
                                        style={{
                                            padding: '10px 14px',
                                            borderRadius: 12,
                                            border: userForm.auth_type === 'AD' ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                            background: userForm.auth_type === 'AD' ? 'rgba(139,92,246,0.15)' : 'transparent',
                                            color: userForm.auth_type === 'AD' ? '#fff' : 'var(--text-muted)',
                                            fontWeight: 800,
                                            fontSize: 12,
                                            cursor: 'pointer'
                                        }}
                                        onClick={() => setUserForm({ ...userForm, auth_type: 'AD' })}
                                    >
                                        🏢 Windows Active Directory
                                    </button>
                                </div>
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    {userForm.auth_type === 'LOCAL' ? (isEditing ? 'PASSWORD (LEAVE BLANK TO KEEP UNCHANGED)' : 'PASSWORD *') : 'PASSWORD (FOR AD TEST VERIFICATION ONLY)'}
                                </label>
                                <input
                                    type="password"
                                    style={S.input}
                                    placeholder={isEditing ? 'Leave blank to preserve existing password' : 'Enter password'}
                                    value={userForm.password}
                                    required={!isEditing && userForm.auth_type === 'LOCAL'}
                                    onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                                />
                            </div>

                            {userForm.auth_type === 'AD' && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                            TARGET DOMAIN (OPTIONAL)
                                        </label>
                                        <button
                                            type="button"
                                            style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}
                                            onClick={handleTestAd}
                                            disabled={testingAd}
                                        >
                                            {testingAd ? '⏳ Testing...' : '🔍 Test AD Logon'}
                                        </button>
                                    </div>
                                    <input
                                        type="text"
                                        style={S.input}
                                        placeholder="e.g. CORP or corp.local"
                                        value={userForm.domain}
                                        onChange={e => setUserForm({ ...userForm, domain: e.target.value })}
                                    />
                                    {testAdResult && (
                                        <div style={{
                                            marginTop: 6,
                                            padding: 8,
                                            borderRadius: 8,
                                            background: testAdResult.success ? 'rgba(52,199,89,0.1)' : 'rgba(255,59,48,0.1)',
                                            color: testAdResult.success ? '#34c759' : '#ff3b30',
                                            fontSize: 11,
                                            fontWeight: 700
                                        }}>
                                            {testAdResult.success ? '✅ ' : '❌ '}{testAdResult.message}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    HOME DIRECTORY (PHYSICAL SANDBOX ROOT)
                                </label>
                                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                    <input
                                        type="text"
                                        style={{ ...S.input, marginTop: 0, fontFamily: 'monospace' }}
                                        placeholder="Leave blank to use group template"
                                        value={userForm.home_dir}
                                        onChange={e => setUserForm({ ...userForm, home_dir: e.target.value })}
                                    />
                                    <button type="button" style={S.btnO} onClick={() => openFolderBrowser('userForm.home_dir', userForm.home_dir)}>
                                        📁 Browse
                                    </button>
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                                    Leave blank to automatically apply group template or server default virtual root.
                                </span>
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    BANDWIDTH RATE LIMIT (KB/S, 0 = INHERIT GROUP / UNLIMITED)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    style={S.input}
                                    placeholder="0"
                                    value={userForm.rate_limit_kbps}
                                    onChange={e => setUserForm({ ...userForm, rate_limit_kbps: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    MAX CONCURRENT SESSIONS (0 = INHERIT GROUP / UNLIMITED)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    style={S.input}
                                    placeholder="0"
                                    value={userForm.max_connections || 0}
                                    onChange={e => setUserForm({ ...userForm, max_connections: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    IDLE TIMEOUT (SECONDS, 0 = INHERIT GROUP / UNLIMITED)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    style={S.input}
                                    placeholder="0"
                                    value={userForm.idle_timeout_seconds ?? 0}
                                    onChange={e => setUserForm({ ...userForm, idle_timeout_seconds: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            <div style={{ display: 'flex', gap: 24, marginTop: 6 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                                    <input
                                        type="checkbox"
                                        checked={userForm.read_only}
                                        onChange={e => setUserForm({ ...userForm, read_only: e.target.checked })}
                                        style={{ accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                    />
                                    <span>Read-Only Mode</span>
                                </label>

                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                                    <input
                                        type="checkbox"
                                        checked={userForm.enabled}
                                        onChange={e => setUserForm({ ...userForm, enabled: e.target.checked })}
                                        style={{ accentColor: '#34c759', transform: 'scale(1.2)' }}
                                    />
                                    <span>Account Enabled</span>
                                </label>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 14 }}>
                                <button type="button" style={S.btnO} onClick={() => setShowUserModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" style={S.btnP} disabled={savingUser}>
                                    {savingUser ? 'Saving...' : (isCloning ? '📋 Clone & Create User' : 'Save User Mapping')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* BULK EDIT MODAL */}
            {showBulkEditModal && (
                <div style={S.overlay} onClick={() => setShowBulkEditModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 580 }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 16, marginBottom: 16 }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>
                                    ✏️ Bulk Edit SFTP Users ({selectedUsers.length})
                                </h3>
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                                    Select and configure the attributes you want to batch-update across all {selectedUsers.length} selected accounts.
                                </p>
                            </div>
                            <button
                                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}
                                onClick={() => setShowBulkEditModal(false)}
                            >
                                ✕
                            </button>
                        </div>

                        {/* Target Users Chips */}
                        <div style={{
                            maxHeight: 70,
                            overflowY: 'auto',
                            background: 'var(--bg-primary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 12,
                            padding: '8px 12px',
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 6,
                            marginBottom: 16
                        }}>
                            {selectedUsers.map(u => (
                                <span
                                    key={u}
                                    style={{
                                        fontSize: 11,
                                        fontWeight: 800,
                                        padding: '3px 8px',
                                        borderRadius: 14,
                                        background: 'rgba(139,92,246,0.15)',
                                        color: '#c084fc',
                                        border: '1px solid rgba(139,92,246,0.3)'
                                    }}
                                >
                                    👤 {u}
                                </span>
                            ))}
                        </div>

                        <form onSubmit={handleSaveBulkEdit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            {/* 1. Classification Group */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 14px',
                                borderRadius: 12,
                                background: bulkEditForm.applyGroup ? 'rgba(139,92,246,0.08)' : 'transparent',
                                border: bulkEditForm.applyGroup ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={bulkEditForm.applyGroup}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, applyGroup: e.target.checked })}
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 800, color: bulkEditForm.applyGroup ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                        Update Classification Group
                                    </div>
                                    <select
                                        disabled={!bulkEditForm.applyGroup}
                                        value={bulkEditForm.group}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, group: e.target.value })}
                                        style={{ ...S.select, width: '100%', marginTop: 6, padding: '6px 12px', fontSize: 12, opacity: bulkEditForm.applyGroup ? 1 : 0.5 }}
                                    >
                                        {groups.map(g => (
                                            <option key={g.name} value={g.name}>{g.name}</option>
                                        ))}
                                        {groups.length === 0 && <option value="General">General</option>}
                                    </select>
                                </div>
                            </div>

                            {/* 2. Account Enabled Status */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 14px',
                                borderRadius: 12,
                                background: bulkEditForm.applyEnabled ? 'rgba(139,92,246,0.08)' : 'transparent',
                                border: bulkEditForm.applyEnabled ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={bulkEditForm.applyEnabled}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, applyEnabled: e.target.checked })}
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 800, color: bulkEditForm.applyEnabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                        Update Account Enabled Status
                                    </div>
                                    <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, cursor: bulkEditForm.applyEnabled ? 'pointer' : 'default', opacity: bulkEditForm.applyEnabled ? 1 : 0.5 }}>
                                            <input
                                                type="radio"
                                                name="bulkEnabled"
                                                disabled={!bulkEditForm.applyEnabled}
                                                checked={bulkEditForm.enabled === true}
                                                onChange={() => setBulkEditForm({ ...bulkEditForm, enabled: true })}
                                            />
                                            <span>🟢 Enable All Accounts</span>
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, cursor: bulkEditForm.applyEnabled ? 'pointer' : 'default', opacity: bulkEditForm.applyEnabled ? 1 : 0.5 }}>
                                            <input
                                                type="radio"
                                                name="bulkEnabled"
                                                disabled={!bulkEditForm.applyEnabled}
                                                checked={bulkEditForm.enabled === false}
                                                onChange={() => setBulkEditForm({ ...bulkEditForm, enabled: false })}
                                            />
                                            <span>⚪ Disable All Accounts</span>
                                        </label>
                                    </div>
                                </div>
                            </div>

                            {/* 3. Read-Only / Read-Write Mode */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 14px',
                                borderRadius: 12,
                                background: bulkEditForm.applyReadOnly ? 'rgba(139,92,246,0.08)' : 'transparent',
                                border: bulkEditForm.applyReadOnly ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={bulkEditForm.applyReadOnly}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, applyReadOnly: e.target.checked })}
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 800, color: bulkEditForm.applyReadOnly ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                        Update Permission Mode (Read-Only / Read-Write)
                                    </div>
                                    <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, cursor: bulkEditForm.applyReadOnly ? 'pointer' : 'default', opacity: bulkEditForm.applyReadOnly ? 1 : 0.5 }}>
                                            <input
                                                type="radio"
                                                name="bulkReadOnly"
                                                disabled={!bulkEditForm.applyReadOnly}
                                                checked={bulkEditForm.read_only === true}
                                                onChange={() => setBulkEditForm({ ...bulkEditForm, read_only: true })}
                                            />
                                            <span>🔒 Read-Only</span>
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, cursor: bulkEditForm.applyReadOnly ? 'pointer' : 'default', opacity: bulkEditForm.applyReadOnly ? 1 : 0.5 }}>
                                            <input
                                                type="radio"
                                                name="bulkReadOnly"
                                                disabled={!bulkEditForm.applyReadOnly}
                                                checked={bulkEditForm.read_only === false}
                                                onChange={() => setBulkEditForm({ ...bulkEditForm, read_only: false })}
                                            />
                                            <span>✏️ Read-Write</span>
                                        </label>
                                    </div>
                                </div>
                            </div>

                            {/* 4. Bandwidth Rate Limit */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 14px',
                                borderRadius: 12,
                                background: bulkEditForm.applyRateLimit ? 'rgba(139,92,246,0.08)' : 'transparent',
                                border: bulkEditForm.applyRateLimit ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={bulkEditForm.applyRateLimit}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, applyRateLimit: e.target.checked })}
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 800, color: bulkEditForm.applyRateLimit ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                        Update Bandwidth Rate Limit (KB/s, 0 = Inherit Group / Unlimited)
                                    </div>
                                    <input
                                        type="number"
                                        min="0"
                                        disabled={!bulkEditForm.applyRateLimit}
                                        value={bulkEditForm.rate_limit_kbps}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, rate_limit_kbps: parseInt(e.target.value, 10) || 0 })}
                                        style={{ ...S.input, marginTop: 6, padding: '6px 12px', fontSize: 12, opacity: bulkEditForm.applyRateLimit ? 1 : 0.5 }}
                                    />
                                </div>
                            </div>

                            {/* 5. Max Concurrent Sessions */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 14px',
                                borderRadius: 12,
                                background: bulkEditForm.applyMaxConnections ? 'rgba(139,92,246,0.08)' : 'transparent',
                                border: bulkEditForm.applyMaxConnections ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={bulkEditForm.applyMaxConnections}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, applyMaxConnections: e.target.checked })}
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 800, color: bulkEditForm.applyMaxConnections ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                        Update Max Concurrent Sessions (0 = Inherit Group / Unlimited)
                                    </div>
                                    <input
                                        type="number"
                                        min="0"
                                        disabled={!bulkEditForm.applyMaxConnections}
                                        value={bulkEditForm.max_connections}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, max_connections: parseInt(e.target.value, 10) || 0 })}
                                        style={{ ...S.input, marginTop: 6, padding: '6px 12px', fontSize: 12, opacity: bulkEditForm.applyMaxConnections ? 1 : 0.5 }}
                                    />
                                </div>
                            </div>

                            {/* 6. Idle Timeout */}
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '10px 14px',
                                borderRadius: 12,
                                background: bulkEditForm.applyIdleTimeout ? 'rgba(139,92,246,0.08)' : 'transparent',
                                border: bulkEditForm.applyIdleTimeout ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={bulkEditForm.applyIdleTimeout}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, applyIdleTimeout: e.target.checked })}
                                    style={{ cursor: 'pointer', accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 12, fontWeight: 800, color: bulkEditForm.applyIdleTimeout ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                        Update Idle Timeout (Seconds, 0 = Inherit Group / Unlimited)
                                    </div>
                                    <input
                                        type="number"
                                        min="0"
                                        disabled={!bulkEditForm.applyIdleTimeout}
                                        value={bulkEditForm.idle_timeout_seconds}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, idle_timeout_seconds: parseInt(e.target.value, 10) || 0 })}
                                        style={{ ...S.input, marginTop: 6, padding: '6px 12px', fontSize: 12, opacity: bulkEditForm.applyIdleTimeout ? 1 : 0.5 }}
                                    />
                                </div>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 14 }}>
                                <button type="button" style={S.btnO} onClick={() => setShowBulkEditModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" style={S.btnP} disabled={savingBulkEdit}>
                                    {savingBulkEdit ? 'Applying Changes...' : `Apply to ${selectedUsers.length} Users`}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ADD / EDIT GROUP MODAL */}
            {showGroupModal && (
                <div style={S.overlay} onClick={() => setShowGroupModal(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 16, marginBottom: 20 }}>
                            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>
                                {isEditingGroup ? `✏️ Edit Group on ${currentServer?.name}` : `➕ Add Group to ${currentServer?.name}`}
                            </h3>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }} onClick={() => setShowGroupModal(false)}>
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleSaveGroup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    GROUP NAME *
                                </label>
                                <input
                                    type="text"
                                    style={S.input}
                                    placeholder="e.g. Vendors, Developers, Accounting"
                                    value={groupForm.name}
                                    disabled={isEditingGroup}
                                    onChange={e => setGroupForm({ ...groupForm, name: e.target.value })}
                                    required
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    DIRECTORY TEMPLATE *
                                </label>
                                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                    <input
                                        type="text"
                                        style={{ ...S.input, marginTop: 0, fontFamily: 'monospace' }}
                                        placeholder="e.g. C:\SFTP_Data\Groups\{username}"
                                        value={groupForm.home_dir_template}
                                        onChange={e => setGroupForm({ ...groupForm, home_dir_template: e.target.value })}
                                        required
                                    />
                                    <button type="button" style={S.btnO} onClick={() => openFolderBrowser('groupForm.home_dir_template', groupForm.home_dir_template)}>
                                        📁 Browse
                                    </button>
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                                    Use <code>{'{username}'}</code> as the placeholder for isolated user subfolder.
                                </span>
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    DEFAULT RATE LIMIT (KB/S, 0 = UNLIMITED)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    style={S.input}
                                    placeholder="0"
                                    value={groupForm.rate_limit_kbps}
                                    onChange={e => setGroupForm({ ...groupForm, rate_limit_kbps: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    MAX CONCURRENT SESSIONS (0 = INHERIT GLOBAL / UNLIMITED)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    style={S.input}
                                    placeholder="0"
                                    value={groupForm.max_connections || 0}
                                    onChange={e => setGroupForm({ ...groupForm, max_connections: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    DEFAULT IDLE TIMEOUT (SECONDS, 0 = INHERIT GLOBAL / UNLIMITED)
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    style={S.input}
                                    placeholder="0"
                                    value={groupForm.idle_timeout_seconds ?? 0}
                                    onChange={e => setGroupForm({ ...groupForm, idle_timeout_seconds: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                    DESCRIPTION
                                </label>
                                <input
                                    type="text"
                                    style={S.input}
                                    placeholder="Brief note explaining this group's purpose"
                                    value={groupForm.description}
                                    onChange={e => setGroupForm({ ...groupForm, description: e.target.value })}
                                />
                            </div>

                            <div style={{ display: 'flex', gap: 24, marginTop: 6 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                                    <input
                                        type="checkbox"
                                        checked={groupForm.read_only}
                                        onChange={e => setGroupForm({ ...groupForm, read_only: e.target.checked })}
                                        style={{ accentColor: 'var(--accent-primary)', transform: 'scale(1.2)' }}
                                    />
                                    <span>Default Read-Only Mode</span>
                                </label>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 14 }}>
                                <button type="button" style={S.btnO} onClick={() => setShowGroupModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" style={S.btnP} disabled={savingGroup}>
                                    {savingGroup ? 'Saving...' : 'Save Group'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* FOLDER BROWSER MODAL */}
            {showBrowseModal && (
                <div style={S.overlay} onClick={() => setShowBrowseModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 580 }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 14, marginBottom: 16 }}>
                            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span>📁</span> Browse Remote Server Directory
                            </h3>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }} onClick={() => setShowBrowseModal(false)}>
                                ✕
                            </button>
                        </div>

                        {/* Current Path Bar */}
                        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                            <button
                                style={{ ...S.btnO, padding: '6px 14px', fontSize: 12 }}
                                disabled={browseData.parent_path === null || browseData.parent_path === undefined}
                                onClick={() => loadBrowsePath(browseData.parent_path || '')}
                            >
                                ⬆️ Up
                            </button>
                            <input
                                type="text"
                                readOnly
                                style={{ ...S.input, marginTop: 0, fontFamily: 'monospace', fontWeight: 800 }}
                                value={browseData.current_path || 'Windows Drives List'}
                            />
                        </div>

                        {/* List View */}
                        <div style={{ maxHeight: 280, minHeight: 180, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 12, padding: 8, marginBottom: 16, background: 'var(--bg-primary)' }}>
                            {loadingBrowse && (
                                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Loading directories...</div>
                            )}
                            {!loadingBrowse && (browseData.items || []).map((item, idx) => (
                                <div
                                    key={idx}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '8px 12px',
                                        borderRadius: 8,
                                        cursor: 'pointer',
                                        background: selectedBrowsePath === item.path ? 'rgba(139,92,246,0.15)' : 'transparent',
                                        color: selectedBrowsePath === item.path ? 'var(--accent-primary)' : 'var(--text-primary)',
                                        border: selectedBrowsePath === item.path ? '1px solid var(--accent-primary)' : '1px solid transparent',
                                        marginBottom: 2
                                    }}
                                    onClick={() => setSelectedBrowsePath(item.path)}
                                    onDoubleClick={() => loadBrowsePath(item.path)}
                                >
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span>{item.is_drive ? '💾' : '📁'}</span>
                                        <span style={{ fontWeight: 700, fontSize: 13 }}>{item.name}</span>
                                    </span>
                                    <button
                                        type="button"
                                        style={{ ...S.btnO, padding: '2px 8px', fontSize: 11 }}
                                        onClick={(e) => { e.stopPropagation(); loadBrowsePath(item.path); }}
                                    >
                                        Open ➔
                                    </button>
                                </div>
                            ))}
                            {!loadingBrowse && (browseData.items || []).length === 0 && (
                                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>(No subdirectories found)</div>
                            )}
                        </div>

                        {/* Selection Display & Actions */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 350 }}>
                                {selectedBrowsePath ? `Selected: ${selectedBrowsePath}` : '(No folder selected)'}
                            </span>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button type="button" style={S.btnO} onClick={() => setShowBrowseModal(false)}>
                                    Cancel
                                </button>
                                <button type="button" style={S.btnP} onClick={confirmFolderSelection}>
                                    ✅ Select Folder
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SFTPManager;
