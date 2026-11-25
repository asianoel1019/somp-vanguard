// SOMP License Issuer page: sign-in, issue form with review step, registry with renew / download.
(function () {
    'use strict';
    var D = window.LicenseDates;
    var $ = function (id) { return document.getElementById(id); };
    var state = { csrf: '', today: '', nextId: '', rows: [], ids: {}, pending: null, lockTimer: null };

    function show(el, on) { (typeof el === 'string' ? $(el) : el).hidden = !on; }
    function banner(id, text, kind) {
        var el = $(id);
        el.textContent = text || '';
        if (kind) el.className = 'banner ' + kind;
        el.hidden = !text;
    }
    function plural(n, word) { return n + ' ' + word + (Math.abs(n) === 1 ? '' : 's'); }

    function api(method, url, body) {
        var headers = { 'Accept': 'application/json' };
        if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = state.csrf; }
        return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' })
            .then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (data) {
                    if (r.status === 401 && url !== 'api/login') {
                        toLogin(data, state.csrf ? 'Your session ended. Sign in again.' : ''); // first visit: no message
                        throw new Error('signed out');
                    }
                    return { status: r.status, ok: r.ok, data: data };
                });
            });
    }

    // ---- sign-in ----
    function lockText(info) {
        if (info.locked && info.lockedUntil) {
            var t = new Date(info.lockedUntil);
            return 'Too many wrong passwords. Sign-in is locked until ' + t.toLocaleTimeString() + '.';
        }
        return '';
    }
    function toLogin(info, message) {
        state.csrf = '';
        show('appView', false);
        show('loginView', true);
        var text = lockText(info || {}) || message || '';
        banner('loginMsg', text, 'banner err');
        $('loginBtn').disabled = !!(info && info.locked);
        if (info && info.locked && info.retryAfter) {
            clearTimeout(state.lockTimer);
            state.lockTimer = setTimeout(function () { $('loginBtn').disabled = false; banner('loginMsg', ''); }, info.retryAfter * 1000 + 500);
        }
        $('password').value = '';
        $('password').focus();
    }

    $('loginForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = $('password').value;
        if (!pw) return banner('loginMsg', 'Enter the password.', 'banner err');
        $('loginBtn').disabled = true;
        api('POST', 'api/login', { password: pw }).then(function (r) {
            $('password').value = '';
            if (r.ok) { state.csrf = r.data.csrfToken; banner('loginMsg', ''); return start(); }
            $('loginBtn').disabled = false;
            if (r.data.locked) return toLogin(r.data);
            var msg = r.data.error || 'Sign-in failed.';
            if (typeof r.data.remaining === 'number') msg += ' ' + plural(r.data.remaining, 'attempt') + ' left before sign-in is locked for 15 minutes.';
            banner('loginMsg', msg, 'banner err');
        }).catch(function (err) { $('loginBtn').disabled = false; if (err.message !== 'signed out') banner('loginMsg', 'Cannot reach the server.', 'banner err'); });
    });

    $('logoutBtn').addEventListener('click', function () {
        api('POST', 'api/logout').catch(function () { /* signed out either way */ }).then(function () { toLogin({}, 'Signed out.'); banner('loginMsg', 'Signed out.', 'banner ok'); });
    });

    // ---- start ----
    function start() {
        return api('GET', 'api/session').then(function (r) {
            if (!r.ok) throw new Error(r.data.error || 'error');
            state.csrf = r.data.csrfToken;
            state.today = r.data.today;
            state.nextId = r.data.nextId;
            $('keyBadge').textContent = 'key ' + r.data.keyId;
            show('loginView', false);
            show('appView', true);
            resetForm();
            return loadRegistry();
        }).catch(function (err) { if (err.message !== 'signed out') toLogin({}, ''); });
    }

    // ---- tabs ----
    function tab(name) {
        var issue = name === 'issue';
        $('tabIssue').classList.toggle('active', issue);
        $('tabRegistry').classList.toggle('active', !issue);
        $('tabIssue').setAttribute('aria-selected', String(issue));
        $('tabRegistry').setAttribute('aria-selected', String(!issue));
        show('issuePanel', issue);
        show('registryPanel', !issue);
        if (!issue) loadRegistry();
    }
    $('tabIssue').addEventListener('click', function () { tab('issue'); });
    $('tabRegistry').addEventListener('click', function () { tab('registry'); });

    // ---- issue form ----
    var FIELDS = ['customer', 'licenseId', 'issuedAt', 'expiresAt'];
    function clearErrors() {
        FIELDS.forEach(function (f) { banner('err-' + f, ''); $(f).classList.remove('invalid'); });
        banner('issueMsg', '');
    }
    function fieldError(field, text) {
        if (field && $('err-' + field)) { banner('err-' + field, text); $(field).classList.add('invalid'); $(field).focus(); } else banner('issueMsg', text, 'banner err');
    }
    function values() {
        return { customer: $('customer').value.trim(), licenseId: $('licenseId').value.trim(), issuedAt: $('issuedAt').value, expiresAt: $('expiresAt').value };
    }
    function resetForm() {
        $('customer').value = '';
        $('licenseId').value = state.nextId;
        $('issuedAt').value = state.today;
        $('expiresAt').value = D.termEnd(state.today, 1);
        clearErrors();
        show('confirmBox', false);
        $('issueForm').classList.remove('locked');
        updateInfo();
    }
    function updateInfo() {
        var exp = $('expiresAt').value;
        $('daysInfo').textContent = D.isRealDate(exp) && state.today ? plural(D.daysBetween(state.today, exp), 'day') + ' from today' : '';
        var id = $('licenseId').value.trim().toUpperCase();
        var dup = id && state.ids[id];
        $('dupWarn').textContent = dup ? 'This ID is already in the registry. Next free ID: ' + state.nextId : '';
        show('dupWarn', !!dup);
    }
    ['licenseId', 'expiresAt', 'issuedAt'].forEach(function (id) { $(id).addEventListener('input', updateInfo); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-years]'), function (b) {
        b.addEventListener('click', function () {
            var start = D.isRealDate($('issuedAt').value) ? $('issuedAt').value : state.today;
            $('expiresAt').value = D.termEnd(start, Number(b.getAttribute('data-years')));
            updateInfo();
        });
    });

    function check(v) {
        if (!v.customer) return ['customer', 'Customer is required.'];
        if (v.customer.length > 200) return ['customer', 'Customer is longer than 200 characters.'];
        if (!/^L-\d{4}-\d{4}$/.test(v.licenseId)) return ['licenseId', 'License ID must look like L-YYYY-NNNN.'];
        if (state.ids[v.licenseId.toUpperCase()]) return ['licenseId', 'This ID is already in the registry. Next free ID: ' + state.nextId];
        if (!D.isRealDate(v.issuedAt)) return ['issuedAt', 'Issued must be a real date.'];
        if (!D.isRealDate(v.expiresAt)) return ['expiresAt', 'Expires must be a real date.'];
        if (v.expiresAt < state.today) return ['expiresAt', 'Expires is in the past.'];
        if (v.expiresAt < v.issuedAt) return ['expiresAt', 'Expires is before Issued.'];
        return null;
    }

    $('issueForm').addEventListener('submit', function (e) {
        e.preventDefault();
        clearErrors();
        var v = values();
        var bad = check(v);
        if (bad) return fieldError(bad[0], bad[1]);
        state.pending = v;
        $('cCustomer').textContent = v.customer;
        $('cId').textContent = v.licenseId;
        $('cIssued').textContent = v.issuedAt;
        $('cExpires').textContent = v.expiresAt;
        $('cDays').textContent = plural(D.daysBetween(v.issuedAt, v.expiresAt) + 1, 'day') + ' (' + plural(D.daysBetween(state.today, v.expiresAt), 'day') + ' from today)';
        show('resultBox', false);
        show('confirmBox', true);
        $('issueForm').classList.add('locked');
        $('signBtn').focus();
    });
    $('cancelBtn').addEventListener('click', function () {
        show('confirmBox', false);
        $('issueForm').classList.remove('locked');
        state.pending = null;
    });
    $('signBtn').addEventListener('click', function () {
        if (!state.pending) return;
        $('signBtn').disabled = true;
        api('POST', 'api/issue', state.pending).then(function (r) {
            $('signBtn').disabled = false;
            show('confirmBox', false);
            $('issueForm').classList.remove('locked');
            if (!r.ok) {
                if (r.data.nextId) state.nextId = r.data.nextId;
                return fieldError(r.data.field, r.data.error || 'The license was not issued.');
            }
            var d = r.data;
            $('resultTitle').textContent = d.registryError ? 'License issued (registry not updated)' : 'License issued';
            $('rCustomer').textContent = d.customer;
            $('rId').textContent = d.licenseId;
            $('rExpires').textContent = d.expiresAt + ' (' + plural(d.days, 'day') + ' from today)';
            $('rFile').textContent = d.file;
            $('rSha').textContent = d.sha256;
            banner('rRegistryErr', d.registryError || '', 'banner warn');
            $('rRow').textContent = d.row || '';
            show('rRow', !!d.row);
            var link = $('rDownload');
            link.setAttribute('data-id', d.licenseId);
            show(link, !d.registryError); // downloads come from registry rows only
            show('resultBox', true);
            state.nextId = d.nextId;
            state.pending = null;
            resetForm();
            loadRegistry();
        }).catch(function (err) {
            $('signBtn').disabled = false;
            if (err.message !== 'signed out') banner('issueMsg', 'Cannot reach the server.', 'banner err');
        });
    });
    $('rDownload').addEventListener('click', function (e) { e.preventDefault(); download(this.getAttribute('data-id')); });

    // ---- download ----
    function download(id) {
        banner('globalMsg', '');
        fetch('api/download/' + encodeURIComponent(id), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) {
                return r.json().catch(function () { return {}; }).then(function (d) {
                    if (r.status === 401) return toLogin(d, 'Your session ended. Sign in again.');
                    banner('globalMsg', 'Download refused: ' + (d.error || r.status), 'banner err');
                });
            }
            var cd = r.headers.get('Content-Disposition') || '';
            var star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
            var m = /filename="?([^";]+)"?/i.exec(cd);
            var name = star ? decodeURIComponent(star[1]) : m ? m[1] : id + '.lic';
            return r.blob().then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            });
        }).catch(function () { banner('globalMsg', 'Cannot reach the server.', 'banner err'); });
    }

    // ---- registry ----
    function loadRegistry() {
        return api('GET', 'api/registry').then(function (r) {
            if (!r.ok) { banner('globalMsg', r.data.error || 'Cannot load the registry.', 'banner err'); return; }
            state.today = r.data.today;
            state.rows = r.data.rows;
            state.ids = {};
            r.data.rows.forEach(function (row) { state.ids[row.licenseId.toUpperCase()] = true; });
            // the prefilled ID follows the registry; an ID typed by hand stays
            if ($('licenseId').value === state.nextId || !$('licenseId').value) $('licenseId').value = r.data.nextId;
            state.nextId = r.data.nextId;
            $('registryPath').textContent = r.data.registryFile + (r.data.exists ? '' : ' (not created yet)');
            renderRegistry();
            renderUnreadable(r.data.unreadable || []);
            updateInfo();
        }).catch(function (err) { if (err.message !== 'signed out') banner('globalMsg', 'Cannot reach the server.', 'banner err'); });
    }

    var BADGE = { 'Active': 'ok', 'Expires soon': 'warn', 'Expired': 'bad', 'Format 1 (invalid)': 'bad' };
    function cell(tr, text, cls) {
        var td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
        return td;
    }
    function renderRegistry() {
        var q = $('search').value.trim().toLowerCase();
        var body = $('registryBody');
        body.textContent = '';
        var rows = state.rows.filter(function (r) { return !q || r.customer.toLowerCase().indexOf(q) >= 0 || r.licenseId.toLowerCase().indexOf(q) >= 0; });
        rows.forEach(function (r) {
            var tr = document.createElement('tr');
            cell(tr, r.licenseId, 'mono nowrap');
            cell(tr, r.customer);
            cell(tr, r.issuedAt, 'nowrap');
            cell(tr, r.expiresAt, D.isRealDate(r.expiresAt) ? 'nowrap' : 'small-text');
            cell(tr, r.daysLeft === null ? '—' : String(r.daysLeft), 'num');
            var st = cell(tr, '');
            var badge = document.createElement('span');
            badge.className = 'badge ' + (BADGE[r.status] || '');
            badge.textContent = r.status;
            st.appendChild(badge);
            var act = cell(tr, '', 'nowrap');
            var renew = document.createElement('button');
            renew.type = 'button';
            renew.className = 'ghost small';
            renew.textContent = 'Renew';
            renew.addEventListener('click', function () { prefillRenew(r); });
            var dl = document.createElement('button');
            dl.type = 'button';
            dl.className = 'ghost small';
            dl.textContent = 'Download';
            dl.title = r.fileName;
            dl.addEventListener('click', function () { download(r.licenseId); });
            act.appendChild(renew);
            act.appendChild(dl);
            body.appendChild(tr);
        });
        show('registryEmpty', !rows.length);
    }
    function renderUnreadable(list) {
        var ul = $('unreadableList');
        ul.textContent = '';
        list.forEach(function (u) {
            var li = document.createElement('li');
            li.textContent = 'Line ' + u.line + ': ' + u.text;
            ul.appendChild(li);
        });
        show('unreadableBox', list.length > 0);
    }
    $('search').addEventListener('input', renderRegistry);

    function prefillRenew(r) {
        tab('issue');
        resetForm();
        show('resultBox', false);
        var d = D.renewDates(r.expiresAt, state.today);
        $('customer').value = r.customer;
        $('licenseId').value = state.nextId;
        $('issuedAt').value = d.issuedAt;
        $('expiresAt').value = d.expiresAt;
        updateInfo();
        $('customer').focus();
    }

    start();
})();
