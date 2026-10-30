import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';

export default function SpareParts() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [spareParts, setSpareParts] = useState({ categories: [], items: [] });
    const [initialLoaded, setInitialLoaded] = useState(false);
    
    // UI state
    const [spareSearch, setSpareSearch] = useState('');
    const [spareFilterCat, setSpareFilterCat] = useState('ALL');
    
    // Modal states
    const [showAddSpareModal, setShowAddSpareModal] = useState(false);
    const [currentSpareItem, setCurrentSpareItem] = useState({ category: '', name: '', model: '', spec: '', quantity: 0, minStock: 5, unitPrice: 0, location: '', history: [] });
    
    const [showStockModal, setShowStockModal] = useState(false);
    const [stockItem, setStockItem] = useState(null);
    const [stockQty, setStockQty] = useState(1);
    const [stockNote, setStockNote] = useState('');
    const [stockType, setStockType] = useState('IN'); // 'IN' or 'OUT'
    
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [historyItem, setHistoryItem] = useState(null);

    const [busy, setBusy] = useState(false);

    const loadSpareParts = () => api.get('/rack/spare-parts').then(res => {
        if (res.data) setSpareParts({ categories: res.data.categories || [], items: res.data.items || [] });
    });

    // Fetch on mount
    useEffect(() => {
        api.get('/rack/spare-parts').then(res => {
            if (res.data) setSpareParts({ categories: res.data.categories || [], items: res.data.items || [] });
            setInitialLoaded(true);
        }).catch(err => {
            console.error('Failed to fetch spare parts:', err);
            setInitialLoaded(true);
        });
    }, []);

    // Every change goes to the server first; the list is then reloaded from it (quantities are server-computed)
    const runChange = async (request, successMsg) => {
        if (role === 'Viewer' || busy) return false;
        setBusy(true);
        try {
            await request();
            if (successMsg) showToast(successMsg, 'success');
            return true;
        } catch (err) {
            console.error('Spare parts change failed:', err);
            showToast(err.response?.data?.error || err.message || 'Failed to save spare parts.', 'error');
            return false;
        } finally {
            setBusy(false);
            loadSpareParts().catch(err => {
                console.error('Failed to reload spare parts:', err);
                showToast('Failed to reload spare parts.', 'error');
            });
        }
    };

    const saveCategories = (categories) => runChange(() => api.put('/rack/spare-parts/categories', { categories }));

    const isExistingItem = (item) => !!item.id && spareParts.items.some(i => i.id === item.id);

    const handleSaveItem = async () => {
        if (!currentSpareItem.name || !currentSpareItem.category) return showToast('Fill all required fields', 'error');
        const { name, category, model, spec, location, minStock, unitPrice } = currentSpareItem;
        const fields = { name, category, model, spec, location, minStock, unitPrice };
        const ok = isExistingItem(currentSpareItem)
            ? await runChange(() => api.patch(`/rack/spare-parts/${encodeURIComponent(currentSpareItem.id)}`, fields), 'Item saved')
            : await runChange(() => api.post('/rack/spare-parts/items', { ...fields, quantity: parseInt(currentSpareItem.quantity, 10) || 0 }), 'Item added');
        if (ok) setShowAddSpareModal(false);
    };

    const handleStockConfirm = async () => {
        if (stockType === 'OUT' && stockQty > stockItem.quantity) return showToast('Not enough stock!', 'error');
        const ok = await runChange(() => api.post(`/rack/spare-parts/${encodeURIComponent(stockItem.id)}/stock`, {
            type: stockType,
            qty: stockQty,
            note: stockNote
        }));
        if (ok) setShowStockModal(false);
    };

    // History dates: new entries are ISO strings, old ones were saved pre-formatted with toLocaleString()
    const formatHistoryDate = (value) => {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
            const d = new Date(value);
            if (!Number.isNaN(d.getTime())) return d.toLocaleString();
        }
        return value || '-';
    };

    if (!initialLoaded) return <div style={{ padding: 40, textAlign: 'center' }}>Loading Spare Parts...</div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h1 className="page-title" style={{ margin: 0 }}>Spare Parts Inventory</h1>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <input 
                        type="text" 
                        placeholder="Search parts..." 
                        value={spareSearch} 
                        onChange={e => setSpareSearch(e.target.value)} 
                        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-glass)', width: 250 }}
                    />
                    {role !== 'Viewer' && (
                        <button className="btn btn-primary" onClick={async () => {
                            setCurrentSpareItem({ category: spareParts.categories[0] || '', name: '', model: '', spec: '', quantity: 0, minStock: 5, unitPrice: 0, location: '', history: [] });
                            setShowAddSpareModal(true);
                        }}>
                            + New Item
                        </button>
                    )}
                </div>
            </div>

            {/* Dashboard */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 24 }}>
                <div style={{ background: 'var(--bg-glass)', borderRadius: 12, padding: 16, border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ fontSize: 32 }}>💰</div>
                    <div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>TOTAL INVENTORY VALUE</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>
                            TWD ${spareParts.items.reduce((sum, item) => sum + (item.quantity * (Number(item.unitPrice) || 0)), 0).toLocaleString()}
                        </div>
                    </div>
                </div>
                <div style={{ background: 'var(--bg-glass)', borderRadius: 12, padding: 16, border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ fontSize: 32 }}>📦</div>
                    <div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>TOTAL ITEMS IN STOCK</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>
                            {spareParts.items.reduce((sum, item) => sum + item.quantity, 0).toLocaleString()}
                        </div>
                    </div>
                </div>
                <div style={{ background: 'var(--bg-glass)', borderRadius: 12, padding: 16, border: '1px solid var(--danger)', display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ fontSize: 32 }}>🚨</div>
                    <div>
                        <div style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>LOW STOCK ALERTS</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--danger)' }}>
                            {spareParts.items.filter(item => item.quantity < (item.minStock || 0)).length}
                        </div>
                    </div>
                </div>
            </div>

            <div style={{ display: 'flex', flex: 1, gap: 24, overflow: 'hidden' }}>
                {/* Category Sidebar */}
                <div style={{ width: 220, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column' }}>
                    <h3 style={{ fontSize: 13, marginBottom: 16, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Categories</h3>
                    <div style={{ flex: 1, overflow: 'auto' }}>
                        <div
                            style={{
                                padding: '8px 12px',
                                background: spareFilterCat === 'ALL' ? 'var(--accent-primary)' : 'transparent',
                                color: spareFilterCat === 'ALL' ? '#fff' : 'var(--text-primary)',
                                borderRadius: 6,
                                marginBottom: 4,
                                fontSize: 13,
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            }}
                            onClick={() => setSpareFilterCat('ALL')}
                        >
                            All Categories
                        </div>
                        {spareParts.categories.map((cat, idx) => (
                            <div
                                key={idx}
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '8px 12px',
                                    background: spareFilterCat === cat ? 'var(--accent-primary)' : 'transparent',
                                    color: spareFilterCat === cat ? '#fff' : 'var(--text-primary)',
                                    borderRadius: 6,
                                    marginBottom: 4,
                                    fontSize: 13,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s'
                                }}
                                onClick={() => setSpareFilterCat(cat)}
                            >
                                <span>{cat}</span>
                                {role !== 'Viewer' && (
                                    <button 
                                        style={{ background: 'none', border: 'none', color: spareFilterCat === cat ? '#fff' : 'var(--danger)', cursor: 'pointer', opacity: 0.7 }} 
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            if (await showConfirm(`Delete category "${cat}"?`)) {
                                                saveCategories(spareParts.categories.filter(c => c !== cat));
                                                if (spareFilterCat === cat) setSpareFilterCat('ALL');
                                            }
                                        }}
                                    >×</button>
                                )}
                            </div>
                        ))}
                    </div>
                    {role !== 'Viewer' && (
                        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                            <input
                                type="text"
                                placeholder="New Category (Enter)..."
                                style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 12 }}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && e.target.value.trim()) {
                                        const val = e.target.value.trim();
                                        if (!spareParts.categories.includes(val)) {
                                            saveCategories([...spareParts.categories, val]);
                                        }
                                        e.target.value = '';
                                    }
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* Items Table */}
                <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10 }}>
                            <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Category & Status</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Item Name / Model</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Location</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Stock / Value</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {spareParts.items
                                .filter(i => {
                                    const matchesSearch = !spareSearch || i.name.toLowerCase().includes(spareSearch.toLowerCase()) || i.category.toLowerCase().includes(spareSearch.toLowerCase()) || (i.model || '').toLowerCase().includes(spareSearch.toLowerCase());
                                    const matchesCat = spareFilterCat === 'ALL' || i.category === spareFilterCat;
                                    return matchesSearch && matchesCat;
                                })
                                .sort((a, b) => {
                                    const aLow = a.quantity < (a.minStock || 0) ? 1 : 0;
                                    const bLow = b.quantity < (b.minStock || 0) ? 1 : 0;
                                    return bLow - aLow; // Low stock floats to top
                                })
                                .map(item => {
                                    const isLow = item.quantity < (item.minStock || 0);
                                    return (
                                    <tr key={item.id} style={{ borderBottom: '1px solid var(--border-color)', background: isLow ? 'rgba(239, 68, 68, 0.05)' : 'transparent' }}>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                                                <span style={{ padding: '4px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: 4, fontSize: 11 }}>{item.category}</span>
                                                {isLow && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger)', fontWeight: 600 }}>⚠️ Low Stock</span>}
                                            </div>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{item.name}</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{item.model || '-'} | {item.spec || '-'}</div>
                                        </td>
                                        <td style={{ padding: '12px 16px', color: 'var(--text-secondary)', fontSize: 12 }}>
                                            📍 {item.location || 'Unassigned'}
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ fontSize: 16, fontWeight: 700, color: item.quantity > 0 ? (isLow ? 'var(--warning)' : 'var(--success)') : 'var(--danger)' }}>{item.quantity} <span style={{fontSize: 10, fontWeight: 400, color:'var(--text-muted)'}}>/ Min: {item.minStock || 0}</span></div>
                                            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Value: ${(item.quantity * (Number(item.unitPrice) || 0)).toLocaleString()}</div>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div className="flex gap-2">
                                                {role !== 'Viewer' && (
                                                    <>
                                                        <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--success)', borderColor: 'var(--success)' }} onClick={async () => { setStockType('IN'); setStockItem(item); setStockQty(1); setStockNote(''); setShowStockModal(true); }}>
                                                            📥 In
                                                        </button>
                                                        <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={async () => { setStockType('OUT'); setStockItem(item); setStockQty(1); setStockNote(''); setShowStockModal(true); }}>
                                                            📤 Out
                                                        </button>
                                                    </>
                                                )}
                                                <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: 12 }} onClick={async () => { setHistoryItem(item); setShowHistoryModal(true); }}>
                                                    📜
                                                </button>
                                                {role !== 'Viewer' && (
                                                    <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: 12 }} onClick={async () => { setCurrentSpareItem(item); setShowAddSpareModal(true); }}>
                                                        ✏️
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                    );
                                })}
                            {spareParts.items.length === 0 && (
                                <tr>
                                    <td colSpan="5" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No spare parts found.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Modals Below */}
            {/* Add/Edit Modal */}
            {showAddSpareModal && (
                <div className="modal-overlay" style={{ zIndex: 3100, position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="modal-content glass-panel" style={{ width: 450, padding: 32, borderRadius: 16 }}>
                        <h2 style={{ color: 'var(--accent-primary)', marginBottom: 24, fontSize: 18 }}>{isExistingItem(currentSpareItem) ? 'Edit Item' : 'New Spare Item'}</h2>
                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Category</label>
                            <select className="form-control" value={currentSpareItem.category} onChange={e => setCurrentSpareItem({ ...currentSpareItem, category: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}>
                                {spareParts.categories.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Item Name</label>
                            <input type="text" className="form-control" value={currentSpareItem.name} onChange={e => setCurrentSpareItem({ ...currentSpareItem, name: e.target.value })} placeholder="e.g. DDR4 RAM" style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Model</label>
                            <input type="text" className="form-control" value={currentSpareItem.model} onChange={e => setCurrentSpareItem({ ...currentSpareItem, model: e.target.value })} placeholder="e.g. KVR26N19S8/16" style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                            <div className="form-group">
                                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Location / Bin Number</label>
                                <input type="text" className="form-control" value={currentSpareItem.location || ''} onChange={e => setCurrentSpareItem({ ...currentSpareItem, location: e.target.value })} placeholder="e.g. Rack A Shelf 2" style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                            </div>
                            <div className="form-group">
                                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Unit Price (TWD)</label>
                                <input type="number" min="0" className="form-control" value={currentSpareItem.unitPrice || ''} onChange={e => setCurrentSpareItem({ ...currentSpareItem, unitPrice: e.target.value })} placeholder="e.g. 1500" style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                            </div>
                        </div>

                        {!isExistingItem(currentSpareItem) && (
                            <div className="form-group" style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Initial Quantity (初始庫存)</label>
                                <input type="number" min="0" className="form-control" value={currentSpareItem.quantity ?? 0} onChange={e => setCurrentSpareItem({ ...currentSpareItem, quantity: Math.max(0, parseInt(e.target.value) || 0) })} style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                            </div>
                        )}
                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Minimum Stock Alert Level</label>
                            <input type="number" min="0" className="form-control" value={currentSpareItem.minStock !== undefined ? currentSpareItem.minStock : ''} onChange={e => setCurrentSpareItem({ ...currentSpareItem, minStock: parseInt(e.target.value) || 0 })} placeholder="e.g. 5" style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 24 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Specification</label>
                            <textarea
                                className="form-control"
                                value={currentSpareItem.spec}
                                onChange={e => setCurrentSpareItem({ ...currentSpareItem, spec: e.target.value })}
                                placeholder="e.g. 2666MHz, CL19, 1.2V"
                                style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', height: 80, resize: 'none' }}
                            />
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button className="btn btn-outline" onClick={() => setShowAddSpareModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleSaveItem} disabled={busy}>Save Item</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Stock In/Out Modal */}
            {showStockModal && stockItem && (
                <div className="modal-overlay" style={{ zIndex: 3200, position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="modal-content glass-panel" style={{ width: 400, padding: 32, borderRadius: 16, borderTop: `4px solid ${stockType === 'IN' ? 'var(--success)' : 'var(--danger)'}` }}>
                        <h2 style={{ color: stockType === 'IN' ? 'var(--success)' : 'var(--danger)', marginBottom: 16, fontSize: 18 }}>
                            {stockType === 'IN' ? '📥 Stock In' : '📤 Stock Out'}
                        </h2>
                        <p style={{ marginBottom: 24, fontSize: 13, color: 'var(--text-secondary)' }}>Item: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{stockItem.name}</span></p>

                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Quantity</label>
                            <input type="number" min="1" className="form-control" value={stockQty} onChange={e => setStockQty(Math.max(1, parseInt(e.target.value) || 1))} style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                        </div>
                        <div className="form-group" style={{ marginBottom: 24 }}>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-muted)' }}>Note / Reference</label>
                            <input type="text" className="form-control" value={stockNote} onChange={e => setStockNote(e.target.value)} placeholder="e.g. PO#12345 or Issue ID" style={{ width: '100%', padding: 10, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }} />
                        </div>

                        <div className="flex justify-end gap-3">
                            <button className="btn btn-outline" onClick={() => setShowStockModal(false)}>Cancel</button>
                            <button className="btn btn-primary" style={{ background: stockType === 'IN' ? 'var(--success)' : 'var(--danger)', borderColor: 'transparent' }} onClick={handleStockConfirm} disabled={busy}>Confirm</button>
                        </div>
                    </div>
                </div>
            )}

            {/* History Modal */}
            {showHistoryModal && historyItem && (
                <div className="modal-overlay" style={{ zIndex: 3300, position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="modal-content glass-panel" style={{ width: 600, height: '70vh', padding: 32, borderRadius: 16, display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                            <div>
                                <h2 style={{ color: 'var(--accent-primary)', margin: 0, fontSize: 18 }}>📜 Stock History</h2>
                                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                                    {historyItem.name} {historyItem.model && `| ${historyItem.model}`}
                                </div>
                            </div>
                            <button className="btn btn-outline" style={{ padding: '4px 8px' }} onClick={() => setShowHistoryModal(false)}>Close</button>
                        </div>

                        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border-color)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-glass)', zIndex: 10 }}>
                                    <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                        <th style={{ padding: '12px 16px' }}>Date</th>
                                        <th style={{ padding: '12px 16px' }}>Type</th>
                                        <th style={{ padding: '12px 16px' }}>Qty</th>
                                        <th style={{ padding: '12px 16px' }}>User</th>
                                        <th style={{ padding: '12px 16px' }}>Note</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...(historyItem.history || [])].reverse().map((h, i) => (
                                        <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{formatHistoryDate(h.date)}</td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <span style={{ color: h.type === 'IN' ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{h.type}</span>
                                            </td>
                                            <td style={{ padding: '12px 16px' }}>{h.qty}</td>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{h.user || '-'}</td>
                                            <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{h.note || '-'}</td>
                                        </tr>
                                    ))}
                                    {(historyItem.history || []).length === 0 && (
                                        <tr>
                                            <td colSpan="5" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No history recorded.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
