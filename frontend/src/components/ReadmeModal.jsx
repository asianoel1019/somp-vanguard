import React, { useState, useEffect } from 'react';
import api from '../api';

const ReadmeModal = ({ onClose, type = 'readme' }) => {
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);

    const isGuide = type === 'userguide';
    const isTrouble = type === 'troubleshoot';
    const docName = isTrouble ? 'Troubleshooting Guide' : (isGuide ? 'User Guide' : 'README.md');

    useEffect(() => {
        api.get(`/auth/${type}`)
            .then(res => {
                setContent(res.data.content || `${docName} content is empty.`);
            })
            .catch(err => {
                setContent(`Failed to load ${docName}: ` + (err.response?.data?.error || err.message));
            })
            .finally(() => setLoading(false));
    }, [type, docName]);

    const renderMarkdown = (text) => {
        if (!text) return null;
        let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');
        html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
        html = html.replace(/`(.*?)`/g, '<code>$1</code>');
        html = html.replace(/^- (.*$)/gm, '<li>$1</li>');
        const parts = html.split(/(<\/h1>|<\/h2>|<\/h3>|<\/pre>|<\/blockquote>|<\/li>)/);
        const processed = parts.map(p => {
            if (p.startsWith('<li>') || p.startsWith('<h1>') || p.startsWith('<h2>') || p.startsWith('<h3>') || p.startsWith('<pre>') || p.startsWith('<blockquote>')) return p;
            if (p.match(/^<\//)) return p;
            return p.replace(/\n/g, '<br/>');
        }).join('');
        return <div className="readme-content" dangerouslySetInnerHTML={{ __html: processed }} />;
    };

    return (
        <div className="modal-overlay">
            <div className="glass-panel modal-content" style={{ paddingTop: '1.5rem' }}>
                <div style={{ flex: '1 1 0%', display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0 }} className="custom-scrollbar">
                    <div style={{ padding: '0 2rem 2rem 2rem' }}>
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-24">
                                <div className="dot-loading mb-6"></div>
                                <span className="text-secondary animate-pulse tracking-widest uppercase text-xs font-bold">Parsing {docName}</span>
                            </div>
                        ) : (
                            renderMarkdown(content)
                        )}
                    </div>
                </div>

                <div className="p-6 border-t border-white/10 flex justify-end shrink-0">
                    <button className="btn btn-primary px-8" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
};

export default ReadmeModal;
