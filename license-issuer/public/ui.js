// Shared page helpers (window.LI): DOM shortcuts, the JSON API client (CSRF header, signed-out handling), downloads,
// the modal dialog, select / table builders, shared lists (sales people, plans, customers) and tab switching.
(function () {
    'use strict';
    var F = window.LicenseFormat;
    var LI = window.LI = {};
    var $ = LI.$ = function (id) { return document.getElementById(id); };

    LI.state = {
        csrf: '', session: null, meta: null, sales: [], plans: [], customers: [], tab: '', tabs: {}, lockTimer: null, onSignedOut: null,
    };
    var state = LI.state;

    LI.show = function (el, on) { (typeof el === 'string' ? $(el) : el).hidden = !on; };

    /** Shows `text` in a banner element (kind: err | warn | ok | info); empty text hides it. */
    LI.banner = function (el, text, kind) {
        var e = typeof el === 'string' ? $(el) : el;
        e.textContent = text || '';
        if (kind) e.className = 'banner ' + kind;
        e.hidden = !text;
    };

    /**
     * el('button', { className: 'ghost small', text: 'Renew', type: 'button', onclick: fn, attrs: { 'data-x': 1 } }, [children])
     * Text is always set with textContent (never HTML).
     */
    LI.el = function (tag, props, children) {
        var e = document.createElement(tag);
        var p = props || {};
        Object.keys(p).forEach(function (k) {
            var v = p[k];
            if (v === undefined || v === null) return;
            if (k === 'text') e.textContent = String(v);
            else if (k === 'attrs') Object.keys(v).forEach(function (a) { e.setAttribute(a, String(v[a])); });
            else if (k.indexOf('on') === 0 && typeof v === 'function') e.addEventListener(k.slice(2), v);
            else e[k] = v;
        });
        (children || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
        return e;
    };
    var el = LI.el;

    LI.clear = function (e) { (typeof e === 'string' ? $(e) : e).textContent = ''; };

    // ------------------------------------------------------------------ API

    /** Error thrown after a 401: the login view is already shown, callers just stop. */
    LI.SIGNED_OUT = 'signed out';
    LI.isSignedOut = function (err) { return err && err.message === LI.SIGNED_OUT; };

    /** fetch JSON: resolves { status, ok, data }; a 401 (outside login) shows the sign-in view and rejects. */
    LI.api = function (method, url, body) {
        var headers = { 'Accept': 'application/json' };
        if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = state.csrf; }
        return fetch(url, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' })
            .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (data) {
                    if (r.status === 401 && url !== 'api/login') {
                        if (state.onSignedOut) state.onSignedOut(data, state.csrf ? 'Your session ended. Sign in again.' : '');
                        throw new Error(LI.SIGNED_OUT);
                    }
                    return { status: r.status, ok: r.ok, data: data };
                });
            });
    };

    /** Like api, but rejects with Error(message) (err.field, err.data) when the answer is not ok. */
    LI.call = function (method, url, body) {
        return LI.api(method, url, body).then(function (r) {
            if (r.ok) return r.data;
            var e = new Error(r.data.error || ('Request failed (' + r.status + ').'));
            e.field = r.data.field || null;
            e.code = r.data.code || null;
            e.status = r.status;
            e.data = r.data;
            throw e;
        });
    };

    /** The text to show for a failed call (network errors included). */
    LI.errorText = function (err) {
        if (!err) return 'Something went wrong.';
        if (err instanceof TypeError) return 'Cannot reach the server.';
        return err.message || 'Something went wrong.';
    };

    /** Standard catch: ignores sign-outs, shows other errors in the banner `target` (default the page banner). */
    LI.fail = function (target) {
        return function (err) {
            if (LI.isSignedOut(err)) return;
            LI.banner(target || 'globalMsg', LI.errorText(err), 'err');
        };
    };

    /** Downloads a file answer (license, CSV, backup) through a blob; resolves null or an error text. */
    LI.download = function (url, fallbackName) {
        return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) {
                return r.json().catch(function () { return {}; }).then(function (d) {
                    if (r.status === 401) { if (state.onSignedOut) state.onSignedOut(d, 'Your session ended. Sign in again.'); return LI.SIGNED_OUT; }
                    return 'Download refused: ' + (d.error || r.status);
                });
            }
            var name = F.dispositionName(r.headers.get('Content-Disposition'), fallbackName || 'download');
            return r.blob().then(function (blob) {
                var href = URL.createObjectURL(blob);
                var a = el('a', { href: href, download: name });
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
                return null;
            });
        }).catch(function () { return 'Cannot reach the server.'; });
    };

    /** Downloads a license file (records a 'downloaded' event); errors go to the banner `target`. */
    LI.downloadLicense = function (licenseId, target) {
        return LI.download('api/download/' + encodeURIComponent(licenseId), licenseId + '.lic').then(function (err) {
            if (err && err !== LI.SIGNED_OUT) LI.banner(target || 'globalMsg', err, 'err');
            return !err;
        });
    };

    // ------------------------------------------------------------------ shared lists

    LI.loadSales = function () { return LI.call('GET', 'api/sales').then(function (d) { state.sales = d.sales; return d.sales; }); };
    LI.loadPlans = function () { return LI.call('GET', 'api/plans').then(function (d) { state.plans = d.plans; return d.plans; }); };
    LI.loadCustomers = function () { return LI.call('GET', 'api/customers').then(function (d) { state.customers = d.customers; return d.customers; }); };
    LI.salesById = function (id) { return state.sales.filter(function (s) { return s.id === id; })[0] || null; };
    LI.planById = function (id) { return state.plans.filter(function (p) { return p.id === id; })[0] || null; };

    /** Replaces the options of a select: items [{ value, text, disabled? }]; keeps `selected` when it is offered. */
    LI.fillSelect = function (select, items, selected) {
        var s = typeof select === 'string' ? $(select) : select;
        s.textContent = '';
        items.forEach(function (i) {
            var o = el('option', { value: String(i.value), text: i.text });
            if (i.disabled) o.disabled = true;
            s.appendChild(o);
        });
        if (selected !== undefined && selected !== null) s.value = String(selected);
        return s;
    };

    /**
     * Sales options. o.first: { value, text } first item (e.g. "Pick…", "All", "None"); o.keep: an id shown even when
     * deactivated (the current one of a license); o.none: add { value: 'none', text: 'Unassigned' } (filters).
     */
    LI.salesItems = function (o) {
        var opts = o || {};
        var items = opts.first ? [opts.first] : [];
        if (opts.none) items.push({ value: 'none', text: '(unassigned)' });
        state.sales.forEach(function (s) {
            if (s.active || s.id === opts.keep || opts.all) items.push({ value: s.id, text: s.name + (s.active ? '' : ' (inactive)') });
        });
        return items;
    };

    LI.currencyItems = function () {
        return ((state.meta && state.meta.currencies) || ['TWD']).map(function (c) { return { value: c, text: c }; });
    };

    // ------------------------------------------------------------------ tables

    LI.cell = function (tr, text, cls) {
        var td = el('td', { text: text === null || text === undefined ? '' : text });
        if (cls) td.className = cls;
        tr.appendChild(td);
        return td;
    };
    LI.badge = function (status) { return el('span', { className: 'badge ' + F.badgeClass(status), text: status }); };
    LI.typeChip = function (type) { return el('span', { className: 'pill ' + (type === 'trial' ? 'pill-trial' : ''), text: F.typeLabel(type) }); };
    LI.smallButton = function (text, onclick, cls) {
        return el('button', { type: 'button', className: cls || 'ghost small', text: text, onclick: function (e) { e.stopPropagation(); onclick(e); } });
    };
    /** Makes a table row open something on click and on Enter. */
    LI.rowLink = function (tr, open) {
        tr.tabIndex = 0;
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); open(); } });
    };

    // ------------------------------------------------------------------ field errors

    /** Clears every [data-err] / .err-text inside `root`, and .invalid marks. */
    LI.clearErrors = function (root) {
        var r = typeof root === 'string' ? $(root) : root;
        Array.prototype.forEach.call(r.querySelectorAll('.err-text'), function (e) { e.textContent = ''; e.hidden = true; });
        Array.prototype.forEach.call(r.querySelectorAll('.invalid'), function (e) { e.classList.remove('invalid'); });
    };
    /** Shows `text` under the input `inputId` (error element err-<inputId>); false when there is no such element. */
    LI.fieldError = function (inputId, text) {
        var box = $('err-' + inputId);
        var input = $(inputId);
        if (!box || !input) return false;
        box.textContent = text;
        box.hidden = false;
        input.classList.add('invalid');
        input.focus();
        return true;
    };

    // ------------------------------------------------------------------ dialog

    /**
     * A labelled form row for dialogs: field(label, input, { hint, id }) -> element. The error element is
     * err-<input.id>, so LI.fieldError works inside the dialog too.
     */
    LI.field = function (label, input, o) {
        var opts = o || {};
        var box = el('div', { className: 'field' + (opts.wide ? ' wide' : '') });
        box.appendChild(el('label', { text: label, htmlFor: input.id }));
        box.appendChild(input);
        if (opts.hint) box.appendChild(el('div', { className: 'hint muted', text: opts.hint }));
        box.appendChild(el('div', { className: 'hint err-text', id: 'err-' + input.id, hidden: true }));
        return box;
    };

    var current = null; // { onOk, resolve }
    var dlg = $('dialog');

    function closeDialog(value) {
        if (!current) return;
        var c = current;
        current = null;
        if (dlg.open) dlg.close();
        c.resolve(value);
    }

    /**
     * Modal dialog. o: { title, body: Node | string | [Node], okText, danger: bool, cancelText, hideOk, wide,
     * onOk: () => Promise|value }. onOk resolving to false keeps the dialog open; a rejected promise shows its message
     * (under the input d-<field> when the error names a field shown in the dialog; fieldPrefix changes "d-"). Resolves onOk's value, or null when cancelled.
     */
    LI.dialog = function (o) {
        if (current) closeDialog(null);
        return new Promise(function (resolve) {
            current = { onOk: o.onOk, resolve: resolve, prefix: o.fieldPrefix || 'd-' };
            $('dialogTitle').textContent = o.title || '';
            var body = $('dialogBody');
            body.textContent = '';
            [].concat(o.body || []).forEach(function (b) { body.appendChild(typeof b === 'string' ? el('p', { text: b }) : b); });
            LI.banner('dialogMsg', '');
            var ok = $('dialogOk');
            ok.textContent = o.okText || 'OK';
            ok.className = o.danger ? 'danger' : 'primary';
            ok.hidden = !!o.hideOk;
            ok.disabled = !!o.okDisabled;
            $('dialogCancel').textContent = o.cancelText || (o.hideOk ? 'Close' : 'Cancel');
            dlg.classList.toggle('wide', !!o.wide);
            if (!dlg.open) dlg.showModal();
            var first = body.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
            (first || (o.hideOk ? $('dialogCancel') : ok)).focus();
        });
    };
    LI.dialogOk = function () { return $('dialogOk'); };
    LI.dialogError = function (text) { LI.banner('dialogMsg', text, 'err'); };

    $('dialogForm').addEventListener('submit', function (e) {
        e.preventDefault();
        if (!current) return;
        var c = current;
        var ok = $('dialogOk');
        LI.banner('dialogMsg', '');
        LI.clearErrors($('dialogBody'));
        if (!c.onOk) return closeDialog(true);
        ok.disabled = true;
        Promise.resolve().then(c.onOk).then(function (value) {
            ok.disabled = false;
            if (value === false) return;
            if (current === c) closeDialog(value === undefined ? true : value);
        }, function (err) {
            ok.disabled = false;
            if (LI.isSignedOut(err)) return closeDialog(null);
            var input = err && err.field ? $(c.prefix + err.field) : null;
            if (!(input && $('dialogBody').contains(input) && LI.fieldError(c.prefix + err.field, err.message))) LI.dialogError(LI.errorText(err));
        });
    });
    $('dialogCancel').addEventListener('click', function () { closeDialog(null); });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeDialog(null); });
    LI.closeDialog = closeDialog;

    /** Confirmation: resolves true / null. */
    LI.confirm = function (title, lines, okText, danger) {
        return LI.dialog({ title: title, body: [].concat(lines).map(function (l) { return typeof l === 'string' ? el('p', { text: l }) : l; }), okText: okText, danger: danger });
    };

    // ------------------------------------------------------------------ tabs

    /** register('licenses', { show(arg) }) — show runs every time the tab is opened (arg from LI.go). */
    LI.register = function (name, tab) { state.tabs[name] = tab; };

    /** Opens a tab: go('licenses', { licenseId }) etc. */
    LI.go = function (name, arg) {
        if (!state.tabs[name]) name = 'dashboard';
        state.tab = name;
        Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
            var on = b.getAttribute('data-tab') === name;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', String(on));
        });
        Object.keys(state.tabs).forEach(function (t) { LI.show('panel-' + t, t === name); });
        LI.banner('globalMsg', '');
        if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
        var r = state.tabs[name].show(arg);
        if (r && r.catch) r.catch(LI.fail());
        window.scrollTo(0, 0);
    };
})();
