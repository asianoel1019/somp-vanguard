import { useState, useEffect, useRef } from 'react';
import api from '../api';

/* ── Lightweight Markdown → HTML ────────────────────── */
function md(raw) {
  if (!raw) return '';
  let h = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/^### (.*$)/gim, '<h3 class="rb-h3">$1</h3>');
  h = h.replace(/^## (.*$)/gim,  '<h2 class="rb-h2">$1</h2>');
  h = h.replace(/^# (.*$)/gim,   '<h1 class="rb-h1">$1</h1>');
  h = h.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.*?)\*/g, '<em>$1</em>');
  h = h.replace(/`(.*?)`/g, '<code class="rb-code">$1</code>');
  // Lists
  h = h.replace(/^\s*\d+\.\s+(.*$)/gim, '<li class="rb-li">$1</li>');
  h = h.replace(/^\s*-\s+(.*$)/gim, '<li class="rb-li">$1</li>');
  // Wrap consecutive <li> in <ul>
  h = h.replace(/((?:<li class="rb-li">.*<\/li>\n?)+)/g, '<ul class="rb-ul">$1</ul>');
  // Paragraphs – skip lines that already start with HTML tags
  h = h.split('\n\n').map(p => {
    const t = p.trim();
    if (!t || /^<[hulo]/.test(t)) return p;
    return `<p class="rb-p">${p.replace(/\n/g, '<br/>')}</p>`;
  }).join('\n');
  return h;
}

// Clears the cross-page pending-open marker set by agentClient.requestOpen
function clearPendingOpen(type) {
  if (window.__sompPendingOpen?.type === type) window.__sompPendingOpen = null;
}

/* ── Constants ──────────────────────────────────────── */
const COMPONENTS = [
  'DNS Hub','AD Control','Server Check','Remote Command','Server Provision',
  'Nutanix','Server Inventory','Task Scheduler','FortiProxy Manager','Squid Proxy',
  'IPAM','SSL Certificate','NetSearch','Mail Relay','ELK Manager','Prometheus Target',
  'Redis Control','Kubernetes','Workflow Editor','Data Centers','Server Rack',
  'Topology Map','Spare Parts','Hardware Issues','Contracts & Warranties','Other'
];
const TAGS = ['例行維護','緊急應變','新人教學','安全審計'];

/* ── Main Component ─────────────────────────────────── */
export default function Runbook() {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const role = user.role || 'Viewer';
  const canEdit = role === 'SuperAdmin' || role === 'Operator';

  const [runbooks, setRunbooks]     = useState([]);
  const [selected, setSelected]     = useState(null);
  // Agent cross-page open: id waiting to be selected once the list is loaded (ref avoids set-state-in-effect)
  const pendingOpenRef = useRef(window.__sompPendingOpen?.type === 'runbook' ? window.__sompPendingOpen.id : null);
  const loadRef = useRef(null);
  const [search, setSearch]         = useState('');
  const [filterComp, setFilterComp] = useState('');
  const [filterTag, setFilterTag]   = useState('');
  const [editing, setEditing]       = useState(false);
  const [formMode, setFormMode]     = useState('create');
  const [alert, setAlert]           = useState(null);

  // Form fields
  const [fTitle, setFTitle]       = useState('');
  const [fComp, setFComp]         = useState('DNS Hub');
  const [fTags, setFTags]         = useState('');
  const [fContent, setFContent]   = useState('');
  const [fWfId, setFWfId]         = useState('');
  const [fCmdIds, setFCmdIds]     = useState([]);

  // Auxiliary
  const [workflows, setWorkflows] = useState([]);
  const [commands, setCommands]   = useState([]);

  useEffect(() => { load(); loadAux(); }, []);

  /* ── Data Fetching ───────────────────────────────── */
  async function load(q = search, c = filterComp, t = filterTag) {
    try {
      const p = [];
      if (q) p.push(`query=${encodeURIComponent(q)}`);
      if (c) p.push(`component=${encodeURIComponent(c)}`);
      if (t) p.push(`tag=${encodeURIComponent(t)}`);
      const res = await api.get(`/runbook${p.length ? '?' + p.join('&') : ''}`);
      setRunbooks(res.data);
      let next = null;
      if (res.data.length) {
        next = selected ? res.data.find(r => r.id === selected.id) || null : null;
      }
      if (pendingOpenRef.current) {
        const rb = res.data.find(r => r.id === pendingOpenRef.current);
        if (rb) next = rb;
        pendingOpenRef.current = null;
        clearPendingOpen('runbook');
      }
      setSelected(next);
    } catch { notify('Failed to load runbooks'); }
  }
  async function loadAux() {
    try { const r = await api.get('/workflow'); setWorkflows(r.data || []); } catch {}
    try { const r = await api.get('/cmd-library'); setCommands(r.data.commands || []); } catch {}
  }

  function notify(msg) { setAlert(msg); }

  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    const onOpen = (e) => {
      pendingOpenRef.current = e.detail?.id || null;
      if (loadRef.current) loadRef.current();
    };
    window.addEventListener('somp:open-runbook', onOpen);
    return () => window.removeEventListener('somp:open-runbook', onOpen);
  }, []);

  /* ── Handlers ────────────────────────────────────── */
  function onSearch(v) { setSearch(v); load(v, filterComp, filterTag); }
  function onComp(v)   { setFilterComp(v); load(search, v, filterTag); }
  function onTag(t)    { const v = filterTag === t ? '' : t; setFilterTag(v); load(search, filterComp, v); }

  function openForm(mode, rb) {
    setFormMode(mode);
    if (mode === 'edit' && rb) {
      setFTitle(rb.title); setFComp(rb.component);
      setFTags(rb.tags?.join(', ') || ''); setFContent(rb.content);
      setFWfId(rb.workflowId || ''); setFCmdIds(rb.commandIds || []);
    } else {
      setFTitle(''); setFComp('DNS Hub'); setFTags(''); setFContent('');
      setFWfId(''); setFCmdIds([]);
    }
    setEditing(true);
  }

  async function submitForm() {
    if (!fTitle.trim() || !fContent.trim()) return notify('Title and Content are required');
    const body = {
      title: fTitle, component: fComp,
      tags: fTags.split(',').map(t => t.trim()).filter(Boolean),
      content: fContent, workflowId: fWfId || null, commandIds: fCmdIds
    };
    try {
      if (formMode === 'create') {
        const r = await api.post('/runbook', body);
        setSelected(r.data); notify('SOP created');
      } else {
        const r = await api.put(`/runbook/${selected.id}`, body);
        setSelected(r.data); notify('SOP updated');
      }
      setEditing(false); load();
    } catch (e) { notify(e.response?.data?.error || e.message); }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/runbook/${id}`);
      notify('SOP deleted'); setSelected(null); load();
    } catch { notify('Delete failed'); }
  }

  async function runWorkflow(id) {
    try {
      const r = await api.post(`/workflow/${id}/execute`, {});
      notify(`Workflow executed — ${r.data.status}`);
    } catch (e) { notify(e.response?.data?.error || e.message); }
  }

  function copyCmd(txt) { navigator.clipboard.writeText(txt); notify('Copied to clipboard'); }
  function toggleCmd(id) { setFCmdIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }
  function wfName(id) { const w = workflows.find(x => x.id === id); return w ? w.name : id; }

  /* ── Styles ──────────────────────────────────────── */
  const S = {
    wrap: { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    header: { padding: '24px 32px 20px', flexShrink: 0 },
    title: { fontSize: 22, fontWeight: 900, margin: 0, letterSpacing: '-0.02em' },
    sub: { fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' },
    body: { flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 },

    // Dynamic Left Panel
    left: (isSelected) => ({ 
      width: isSelected ? 340 : '100%', 
      maxWidth: isSelected ? 'none' : 800,
      margin: isSelected ? '0' : '0 auto',
      flexShrink: 0, 
      display: 'flex', 
      flexDirection: 'column', 
      borderRight: isSelected ? '1px solid var(--border-color)' : 'none', 
      background: 'rgba(0,0,0,0.08)',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      borderRadius: isSelected ? 0 : 16,
      overflow: 'hidden'
    }),
    
    // Search box
    searchBox: { padding: '20px 24px 16px', display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0, borderBottom: '1px solid var(--border-color)' },
    input: { width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '9px 12px', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
    select: { width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '9px 12px', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
    tagRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
    tag: (active) => ({ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border-color)', background: active ? 'var(--accent-primary)' : 'transparent', color: active ? '#fff' : 'var(--text-muted)', transition: 'all .2s' }),
    
    // List
    list: { flex: 1, overflowY: 'auto', padding: '12px 16px' },
    item: (active) => ({ padding: '14px 16px', borderRadius: 10, cursor: 'pointer', marginBottom: 6, background: active ? 'rgba(255,255,255,0.06)' : 'var(--bg-primary)', border: '1px solid var(--border-color)', borderLeft: active ? '4px solid var(--accent-primary)' : '4px solid transparent', transition: 'all .15s' }),
    itemTitleWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
    itemTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.4 },
    itemMeta: { display: 'flex', gap: 12, alignItems: 'center' },
    itemComp: { fontSize: 10, fontWeight: 700, color: 'var(--accent-primary)', background: 'rgba(59,130,246,0.1)', padding: '2px 6px', borderRadius: 6 },
    itemTag: { fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', padding: '2px 6px', borderRadius: 6 },
    itemDate: { fontSize: 10, color: 'var(--text-muted)' },

    // Right detail (expands)
    right: (isSelected) => ({ 
      flex: isSelected ? 1 : 0, 
      opacity: isSelected ? 1 : 0,
      width: isSelected ? 'auto' : 0,
      display: 'flex', 
      flexDirection: 'column', 
      overflow: 'hidden',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
    }),
    detailHead: { padding: '28px 36px 20px', flexShrink: 0, borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' },
    detailBody: { flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 },
    content: { flex: 1, overflowY: 'auto', padding: '28px 36px 36px', lineHeight: 1.7 },
    sidebar: { width: 280, flexShrink: 0, borderLeft: '1px solid var(--border-color)', overflowY: 'auto', padding: '24px 20px' },
    sideSection: { marginBottom: 28 },
    sideLabel: { fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12 },


    // Buttons
    btnPrimary: { background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
    btnOutline: { background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
    btnDanger: { background: 'transparent', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
    btnSmall: { background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: 0 },
  };

  /* ── Render ──────────────────────────────────────── */
  return (
    <div style={S.wrap}>
      <style>{`
        .rb-h1{font-size:1.5rem;font-weight:800;color:var(--text-primary);border-bottom:1px solid var(--border-color);padding-bottom:10px;margin:0 0 20px}
        .rb-h2{font-size:1.15rem;font-weight:700;color:var(--text-primary);margin:28px 0 12px}
        .rb-h3{font-size:1rem;font-weight:600;color:var(--text-primary);margin:20px 0 8px}
        .rb-p{font-size:.9rem;line-height:1.7;color:var(--text-secondary);margin:0 0 16px}
        .rb-ul{padding-left:20px;margin:0 0 16px;list-style:disc}
        .rb-li{font-size:.9rem;line-height:1.6;color:var(--text-secondary);margin-bottom:4px}
        .rb-code{font-family:monospace;background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-size:.82rem;color:#f0abfc}
        .rb-item:hover{background:rgba(255,255,255,0.03)}
        .rb-cmd-block{margin:0;padding:8px 10px;background:#0a0a0a;border-radius:6px;overflow-x:auto;font-size:11px;font-family:'Cascadia Code',monospace;line-height:1.5}
      `}</style>

      {/* ── Header bar ──────────────────── */}
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={S.title}>📖 維運 SOP 手冊</h2>
            <p style={S.sub}>標準作業程序與知識庫</p>
          </div>
          {canEdit && <button style={S.btnPrimary} onClick={() => openForm('create')}>+ New SOP</button>}
        </div>
      </div>

      <div style={{ ...S.body, padding: selected ? 0 : '24px 32px' }}>
        
        {/* ── Dynamic Left Panel ───────────────────── */}
        <div style={S.left(!!selected)}>
          <div style={S.searchBox}>
            <input
              style={S.input}
              placeholder="🔍  搜尋 SOP…"
              value={search}
              onChange={e => onSearch(e.target.value)}
            />
            <select style={S.select} value={filterComp} onChange={e => onComp(e.target.value)}>
              <option value="">所有組件</option>
              {COMPONENTS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <div style={S.tagRow}>
              {TAGS.map(t => (
                <span key={t} style={S.tag(filterTag === t)} onClick={() => onTag(t)}>{t}</span>
              ))}
            </div>
          </div>

          <div style={S.list}>
            {runbooks.map(rb => {
              const isSelected = selected?.id === rb.id;
              return (
                <div
                  key={rb.id}
                  className="rb-item"
                  style={S.item(isSelected)}
                  onClick={() => setSelected(isSelected ? null : rb)}
                >
                  <div style={S.itemTitleWrap}>
                    <div style={S.itemTitle}>{rb.title}</div>
                    <div style={S.itemMeta}>
                      <span style={S.itemComp}>{rb.component}</span>
                      <span style={S.itemDate}>{new Date(rb.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {runbooks.length === 0 && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
                沒有符合的 SOP
              </div>
            )}
          </div>
        </div>

        {/* ── Dynamic Right Panel ──────────────────── */}
        <div style={S.right(!!selected)}>
          {selected && (
            <>
              {/* Detail Header */}
              <div style={S.detailHead}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-primary)', background: 'rgba(59,130,246,0.1)', padding: '3px 10px', borderRadius: 6 }}>
                        {selected.component}
                      </span>
                      {selected.tags?.map(t => (
                        <span key={t} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', padding: '3px 10px', borderRadius: 6 }}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900 }}>{selected.title}</h2>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                      最後更新者 <strong style={{ color: 'var(--text-secondary)' }}>{selected.updatedBy}</strong> · {new Date(selected.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <button 
                    onClick={() => setSelected(null)} 
                    style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >✕</button>
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                    <button style={S.btnOutline} onClick={() => openForm('edit', selected)}>✏️ Edit</button>
                    {role === 'SuperAdmin' && (
                      <button style={S.btnDanger} onClick={() => handleDelete(selected.id)}>🗑️ Delete</button>
                    )}
                  </div>
                )}
              </div>

              {/* Detail Body */}
              <div style={S.detailBody}>
                {/* Markdown content */}
                <div style={S.content} dangerouslySetInnerHTML={{ __html: md(selected.content) }} />

                {/* Integration sidebar — only if linked data */}
                {(selected.workflowId || selected.commandIds?.length > 0) && (
                  <div style={S.sidebar}>
                    {/* Workflow */}
                    {selected.workflowId && (
                      <div style={S.sideSection}>
                        <div style={S.sideLabel}>🔗 關聯工作流程</div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
                          {wfName(selected.workflowId)}
                        </div>
                        {canEdit && (
                          <button style={{ ...S.btnPrimary, width: '100%', padding: '8px 0' }} onClick={() => runWorkflow(selected.workflowId)}>
                            ▶ Execute
                          </button>
                        )}
                      </div>
                    )}

                    {/* Commands */}
                    {selected.commandIds?.length > 0 && (
                      <div style={S.sideSection}>
                        <div style={S.sideLabel}>⚡ 指令庫</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                          {selected.commandIds.map(cid => {
                            const c = commands.find(x => x.id === cid);
                            if (!c) return null;
                            return (
                              <div key={cid}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{c.name}</div>
                                {c.winCommand && (
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>POWERSHELL</span>
                                      <button style={S.btnSmall} onClick={() => copyCmd(c.winCommand)}>Copy</button>
                                    </div>
                                    <pre className="rb-cmd-block" style={{ color: '#85ff51' }}>{c.winCommand}</pre>
                                  </div>
                                )}
                                {c.nixCommand && (
                                  <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>BASH / SSH</span>
                                      <button style={S.btnSmall} onClick={() => copyCmd(c.nixCommand)}>Copy</button>
                                    </div>
                                    <pre className="rb-cmd-block" style={{ color: '#ffb354' }}>{c.nixCommand}</pre>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Edit / Create Modal ─────────────────── */}
      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 20, width: '90%', maxWidth: 880, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}>

            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
                {formMode === 'create' ? '📝 新增 SOP 文件' : '📝 編輯 SOP 文件'}
              </h3>
              <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>

            {/* Modal Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', gap: 24 }}>

              {/* Left: Core Fields */}
              <div style={{ flex: 1.3, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Field label="標題">
                  <input style={S.input} value={fTitle} onChange={e => setFTitle(e.target.value)} placeholder="e.g. Daily Server Health Check" />
                </Field>

                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="組件" style={{ flex: 1 }}>
                    <select style={S.select} value={fComp} onChange={e => setFComp(e.target.value)}>
                      {COMPONENTS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="標籤 (以逗號分隔)" style={{ flex: 1 }}>
                    <input style={S.input} value={fTags} onChange={e => setFTags(e.target.value)} placeholder="例行維護, 緊急應變" />
                  </Field>
                </div>

                <Field label="內容 (Markdown)" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    value={fContent}
                    onChange={e => setFContent(e.target.value)}
                    placeholder="# SOP Title&#10;## Steps&#10;1. First step..."
                    style={{ ...S.input, flex: 1, minHeight: 220, resize: 'vertical', fontFamily: "'Cascadia Code', monospace", lineHeight: 1.6 }}
                  />
                </Field>
              </div>

              {/* Right: Linking */}
              <div style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Field label="關聯工作流程">
                  <select style={S.select} value={fWfId} onChange={e => setFWfId(e.target.value)}>
                    <option value="">無</option>
                    {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </Field>

                <Field label="關聯指令" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ flex: 1, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)', padding: 10, overflowY: 'auto', maxHeight: 260 }}>
                    {commands.map(c => (
                      <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={fCmdIds.includes(c.id)} onChange={() => toggleCmd(c.id)} />
                        <span style={{ opacity: 0.5, fontSize: 10 }}>[{c.category}]</span> {c.name}
                      </label>
                    ))}
                    {commands.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>無可用指令</span>}
                  </div>
                </Field>
              </div>
            </div>

            {/* Modal Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 28px', borderTop: '1px solid var(--border-color)', flexShrink: 0 }}>
              <button style={S.btnOutline} onClick={() => setEditing(false)}>Cancel</button>
              <button style={S.btnPrimary} onClick={submitForm}>Save SOP</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Notification Modal ──────────────── */}
      {alert && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '28px 32px', borderRadius: 16, maxWidth: 380, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,0.4)', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>
              {alert.toLowerCase().includes('fail') || alert.toLowerCase().includes('required') ? '⚠️' : '✅'}
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px', wordBreak: 'break-word' }}>{alert}</p>
            <button style={{ ...S.btnPrimary, width: '100%' }} onClick={() => setAlert(null)}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tiny helper ───────────────────────────── */
function Field({ label, children, style }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
