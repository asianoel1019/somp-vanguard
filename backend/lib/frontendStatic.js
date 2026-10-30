/**
 * Serves the built frontend (frontend/dist) with deploy-safe caching:
 *  - index.html and non-hashed files: "no-cache" (always revalidated, so a new deploy is picked up
 *    immediately; unchanged files still answer 304 via ETag)
 *  - Vite's hashed files under /assets/: cached for a year as immutable (a new build gets new names)
 * Unknown /api/ paths return JSON 404; every other path falls back to index.html (SPA).
 */
const path = require('path');
const express = require('express');

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function mountFrontend(app, distDir) {
    // Absolute path required: sendFile rejects relative paths and asset matching compares absolute paths
    const distPath = path.resolve(distDir);
    const assetsDir = path.join(distPath, 'assets') + path.sep;

    app.use(express.static(distPath, {
        cacheControl: false,
        setHeaders(res, filePath) {
            res.setHeader('Cache-Control', filePath.startsWith(assetsDir) ? IMMUTABLE : NO_CACHE);
        },
    }));

    // Fallback: all other requests serve index.html (SPA client-side routes)
    app.use((req, res) => {
        // Skip API routes that should have been caught above
        if (req.path.startsWith('/api/')) {
            return res.status(404).json({ error: 'Not Found' });
        }
        res.setHeader('Cache-Control', NO_CACHE);
        // root option: only 'index.html' is checked for dot-segments, not the install path (e.g. ....claude...)
        res.sendFile('index.html', { root: distPath, cacheControl: false });
    });
}

module.exports = { mountFrontend };
