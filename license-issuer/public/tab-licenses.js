// Licenses tab: filtered list and a detail view with the timeline and the actions Renew, Edit, Reissue, Replace, Revoke,
// Send to customer and Download. Also the shared dialogs LI.sendDialog (mail preview before sending) and LI.renew.
(function () {
    'use strict';
    var LI = window.LI;
    var C = window.LicenseContact;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var el = LI.el;
    var state = LI.state;
    var my = { detail: null, timer: null, loaded: false };

    // ------------------------------------------------------------------ shared: renew, send

    /** Opens the Issue tab prefilled as a renewal of `license`. */
    LI.renew = function (license) {
        LI.go('issue', { prefill: F.renewalDefaults(license, state.plans, state.session.today, state.session.defaultCurrency), license: license });
    };

    function input(id, value, attrs) {
        var i = el('input', { id: id, type: 'text', value: value === null || value === undefined ? '' : String(value) });
        Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
        return i;
    }
    function textarea(id, value, rows, max) {
        return el('textarea', { id: id, rows: rows || 3, maxLength: max || 500, value: value || '' });
    }
    function select(id, items, selected) { return LI.fillSelect(el('select', { id: id }), items, selected); }

    /**
     * Delivery mail with preview: recipient (default the customer's email), subject and text from the templates, the .lic
     * attachment. o.reason: also records a reissue with this reason. Resolves the send answer, or null.
     */
    LI.sendDialog = function (licenseId, o) {
        var opts = o || {};
        return LI.call('GET', 'api/licenses/' + encodeURIComponent(licenseId) + '/delivery').then(function (d) {
            var body = [];
            if (d.blocked) body.push(el('div', { className: 'banner err', text: d.blocked + ' It cannot be sent.' }));
            if (!d.mail.enabled) body.push(el('div', { className: 'banner warn', text: 'Mail is not configured: ' + d.mail.reason + '. See Settings > Email.' }));
            if (!d.attachment.ok) body.push(el('div', { className: 'banner err', text: 'Attachment: ' + d.attachment.error }));
            var to = input('d-to', d.to, { inputmode: 'email', maxlength: '200', spellcheck: 'false' });
            var hint = !d.to ? 'No email on file for this customer: type the recipient.' : !d.toValid ? 'The email on file is not a valid single address: correct it here.' : 'From the customer record; you can change it for this mail.';
            body.push(LI.field('To', to, { hint: hint }));
            if (opts.reason) body.push(el('p', { className: 'small-text', text: 'Recorded as a reissue: ' + opts.reason }));
            body.push(el('div', { className: 'mail-preview' }, [
                el('div', { className: 'muted small-text', text: 'Subject' }),
                el('div', { className: 'mail-subject', text: d.subject }),
                el('div', { className: 'muted small-text', text: 'Message' }),
                el('pre', { className: 'mail-body', text: d.text }),
                el('div', { className: 'muted small-text', text: 'Attachment: ' + d.attachment.name }),
            ]));
            body.push(el('p', { className: 'muted small-text', text: 'Subject and message come from the template in Settings > Email.' }));
            return LI.dialog({
                title: 'Send ' + d.licenseId + ' to the customer', body: body, okText: 'Send', okDisabled: !d.canSend, wide: true,
                onOk: function () {
                    var addr = to.value.trim();
                    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(addr)) return Promise.reject(Object.assign(new Error('Type one address like name@example.test.'), { field: 'to' }));
                    var b = { to: addr };
                    if (opts.reason) b.reason = opts.reason;
                    return LI.call('POST', 'api/licenses/' + encodeURIComponent(d.licenseId) + '/send', b);
                },
            });
        }).catch(function (err) {
            if (!LI.isSignedOut(err)) LI.banner('globalMsg', LI.errorText(err), 'err');
            return null;
        });
    };

    // ------------------------------------------------------------------ list

    function initFilters() {
        LI.fillSelect('licCustomer', [{ value: '', text: 'All' }].concat(state.customers.map(function (c) { return { value: c.id, text: c.name }; })), $('licCustomer').value);
        LI.fillSelect('licSales', LI.salesItems({ first: { value: '', text: 'All' }, none: true, all: true }), $('licSales').value);
        LI.fillSelect('licStatus', [{ value: '', text: 'All' }].concat(((state.meta && state.meta.statuses) || []).map(function (s) { return { value: s, text: s }; })), $('licStatus').value);
    }

    function filterQuery() {
        var period = $('licPeriod').value;
        var p = {
            q: $('licSearch').value.trim(), customerId: $('licCustomer').value, salesId: $('licSales').value, type: $('licType').value,
            status: $('licStatus').value, includeRevoked: $('licRevoked').checked ? '1' : '0', sort: 'newest',
        };
        if (period === 'custom') { p.period = 'custom'; p.from = $('licFrom').value; p.to = $('licTo').value; } else if (period !== 'all') { p.period = period; p.date = state.session.today; }
        return F.query(p);
    }

    function loadList() {
        Array.prototype.forEach.call(document.querySelectorAll('.licRange'), function (e) { e.hidden = $('licPeriod').value !== 'custom'; });
        return LI.call('GET', 'api/licenses?' + filterQuery()).then(function (d) { renderList(d.licenses); }).catch(LI.fail());
    }

    function renderList(list) {
        var body = $('licBody');
        body.textContent = '';
        list.forEach(function (l) {
            var tr = el('tr', { className: l.revokedAt ? 'revoked' : '' });
            LI.cell(tr, l.licenseId, 'mono nowrap');
            LI.cell(tr, l.licensedTo || l.customerName);
            LI.cell(tr, '').appendChild(LI.typeChip(l.type));
            LI.cell(tr, l.issuedAt, 'nowrap');
            LI.cell(tr, l.expiresAt || '—', 'nowrap');
            LI.cell(tr, l.daysLeft === null ? '—' : String(l.daysLeft), 'num');
            LI.cell(tr, l.salesName || '—');
            LI.cell(tr, F.money(l.amount, l.currency) || '—', 'num nowrap');
            LI.cell(tr, '').appendChild(LI.badge(l.status));
            LI.rowLink(tr, function () { openDetail(l.licenseId); });
            body.appendChild(tr);
        });
        LI.show('licEmpty', !list.length);
        $('licCount').textContent = list.length ? F.plural(list.length, 'license') : '';
    }

    function showList() {
        my.detail = null;
        LI.show('licDetailView', false);
        LI.show('licListView', true);
        return loadList();
    }

    // ------------------------------------------------------------------ detail

    function linkButton(text, onclick) { return el('button', { type: 'button', className: 'link', text: text, onclick: onclick }); }

    function openDetail(licenseId, message) {
        return LI.call('GET', 'api/licenses/' + encodeURIComponent(licenseId)).then(function (d) {
            my.detail = d;
            LI.show('licListView', false);
            LI.show('licDetailView', true);
            LI.banner('licDetailMsg', message || '', 'ok');
            renderDetail(d);
            window.scrollTo(0, 0);
        }).catch(LI.fail());
    }

    function renderDetail(d) {
        var l = d.license;
        $('ldTitle').textContent = l.licenseId + ' — ' + (l.licensedTo || l.customerName);
        var b = $('ldBadge');
        b.textContent = l.status;
        b.className = 'badge ' + F.badgeClass(l.status);

        var note = '';
        if (l.revokedAt) {
            note = 'Revoked on ' + F.stampText(l.revokedAt).slice(0, 10) + ' (' + F.reasonText(l.revokeReason).toLowerCase() + (l.revokeNote ? ': ' + l.revokeNote : '') + '). '
                + 'This is a record only: the customer\'s file stays valid until it expires' + (l.expiresAt ? ' on ' + l.expiresAt : '') + '.';
        }
        LI.banner('ldRevokedNote', note, 'warn');

        var dl = $('ldSummary');
        dl.textContent = '';
        function row(label, value, cls) {
            if (value === null || value === undefined || value === '') return;
            dl.appendChild(el('dt', { text: label }));
            var dd = el('dd', { className: cls || '' });
            if (typeof value === 'string') dd.textContent = value; else dd.appendChild(value);
            dl.appendChild(dd);
        }
        row('Customer', linkButton(l.customerName, function () { LI.go('customers', { customerId: l.customerId }); }));
        if (l.licensedTo && l.licensedTo !== l.customerName) row('Signed name', l.licensedTo);
        row('Type', F.typeLabel(l.type) + (l.type === 'paid' ? (l.isRenewal ? ' — renewal' : ' — new business') : ''));
        row('Plan', l.planName || '—');
        row('Issued', l.issuedAt);
        row('Expires', l.expiresAt ? l.expiresAt + ' (' + F.daysText(l.daysLeft) + ')' : '— (format 1)');
        row('Sales person', l.salesName || '(unassigned)');
        row('Amount', l.amount === null ? 'not recorded' : F.money(l.amount, l.currency));
        row('Order no.', l.orderNo || '—');
        row('Vendor contact', C.text(l.contactVendor || '', l.contactEmail || '') || 'none');
        if (l.replacesLicenseId) row('Replaces', linkButton(l.replacesLicenseId, function () { openDetail(l.replacesLicenseId); }));
        if (l.replacedByLicenseId) row('Replaced by', linkButton(l.replacedByLicenseId, function () { openDetail(l.replacedByLicenseId); }));
        row('File', (d.file.name || '—') + (d.file.ok ? '' : ' — ' + d.file.error), 'mono');
        row('SHA-256 (first 12)', l.sha12 || '—', 'mono');
        row('Signed at', l.signedAt ? F.stampText(l.signedAt) + (l.keyId ? ' with key ' + l.keyId : '') : '—');

        var revoked = !!l.revokedAt;
        var sendable = !revoked && l.status !== 'Expired' && l.status !== 'Format 1 (invalid)';
        LI.show('ldRenew', !revoked);
        LI.show('ldReissue', !revoked && d.file.ok);
        LI.show('ldReplace', !revoked);
        LI.show('ldRevoke', !revoked);
        LI.show('ldSend', sendable && d.file.ok);
        LI.show('ldDownload', d.file.ok);

        var ol = $('ldTimeline');
        ol.textContent = '';
        d.events.forEach(function (e) {
            ol.appendChild(el('li', { className: 'ev-' + e.type }, [
                el('span', { className: 'ev-time', text: F.stampText(e.at) }),
                el('span', { className: 'ev-text', text: F.eventText(e) }),
            ]));
        });
        if (!d.events.length) ol.appendChild(el('li', { className: 'muted', text: 'No events.' }));
    }

    function reload(message) { return openDetail(my.detail.license.licenseId, message); }

    // ------------------------------------------------------------------ actions

    $('ldRenew').addEventListener('click', function () { if (my.detail) LI.renew(my.detail.license); });

    $('ldDownload').addEventListener('click', function () {
        if (!my.detail) return;
        LI.banner('licDetailMsg', '');
        LI.downloadLicense(my.detail.license.licenseId, 'licDetailMsg').then(function (ok) { if (ok) reload('Downloaded.'); });
    });

    $('ldSend').addEventListener('click', function () {
        if (!my.detail) return;
        // reloaded either way: a failed attempt is on the timeline too
        LI.sendDialog(my.detail.license.licenseId).then(function (r) { reload(r ? 'Sent to ' + r.to + '.' : ''); });
    });

    $('ldEdit').addEventListener('click', function () {
        var l = my.detail && my.detail.license;
        if (!l) return;
        var sales = select('d-salesId', LI.salesItems({ first: { value: '', text: '(unassigned)' }, keep: l.salesId }), l.salesId || '');
        var amount = input('d-amount', l.amount, { inputmode: 'decimal', maxlength: '16' });
        var currency = select('d-currency', LI.currencyItems(), l.currency || state.session.defaultCurrency);
        var order = input('d-orderNo', l.orderNo, { maxlength: '100' });
        if (l.type === 'trial') amount.disabled = true;
        LI.dialog({
            title: 'Edit ' + l.licenseId,
            body: [
                el('p', { className: 'muted small-text', text: 'Only these business fields can change. To change the customer or the dates, use Replace.' }),
                el('div', { className: 'grid' }, [LI.field('Sales person', sales), LI.field('Order no.', order), LI.field('Amount', amount), LI.field('Currency', currency)]),
            ],
            okText: 'Save',
            onOk: function () {
                var a = F.parseAmount(amount.value);
                if (a.error) return Promise.reject(Object.assign(new Error(a.error), { field: 'amount' }));
                var b = { salesId: sales.value ? Number(sales.value) : null, currency: currency.value, orderNo: order.value.trim() };
                if (l.type !== 'trial') b.amount = a.value;
                return LI.call('PATCH', 'api/licenses/' + encodeURIComponent(l.licenseId), b);
            },
        }).then(function (r) { if (r) reload(r.changed ? 'Saved.' : 'Nothing changed.'); });
    });

    $('ldRevoke').addEventListener('click', function () {
        var l = my.detail && my.detail.license;
        if (!l) return;
        var reasons = ((state.meta && state.meta.revokeReasons) || ['terminated', 'issued_in_error', 'other']).map(function (r) { return { value: r, text: F.reasonText(r) }; });
        var reason = select('d-reason', reasons, 'terminated');
        var note = textarea('d-note', '', 3, 500);
        LI.dialog({
            title: 'Revoke ' + l.licenseId + '?',
            body: [
                el('div', { className: 'banner warn' }, [
                    el('strong', { text: 'Revoking is a record only. ' }),
                    'Licenses work offline and cannot be recalled: the customer\'s file ' + (my.detail.file.name || l.fileName || '') + ' stays valid until it expires'
                        + (l.expiresAt ? ' on ' + l.expiresAt : '') + '.',
                ]),
                el('p', { className: 'small-text', text: 'A revoked license is left out of the performance totals and the renewal board. To give the customer a corrected license, use Replace instead.' }),
                LI.field('Reason', reason),
                LI.field('Note (optional)', note),
            ],
            okText: 'Revoke', danger: true,
            onOk: function () {
                var b = { reason: reason.value };
                if (note.value.trim()) b.note = note.value.trim();
                return LI.call('POST', 'api/licenses/' + encodeURIComponent(l.licenseId) + '/revoke', b);
            },
        }).then(function (r) { if (r) reload('Revoked. The customer\'s file stays valid until it expires.'); });
    });

    $('ldReissue').addEventListener('click', function () {
        var d = my.detail;
        if (!d) return;
        var l = d.license;
        var reason = textarea('d-reason', '', 2, 500);
        var viaDownload = el('input', { type: 'radio', name: 'd-via', value: 'download', checked: true });
        var viaMail = el('input', { type: 'radio', name: 'd-via', value: 'mail' });
        var sendable = l.status !== 'Expired' && l.status !== 'Format 1 (invalid)';
        if (!sendable) viaMail.disabled = true;
        LI.dialog({
            title: 'Reissue ' + l.licenseId,
            body: [
                el('p', { className: 'small-text', text: 'Gives the customer the same file again (nothing is signed). The reason is recorded on the timeline. To change the dates or fix the customer name, use Replace.' }),
                LI.field('Reason', reason, { hint: 'e.g. "Customer lost the file", "New server"' }),
                el('div', { className: 'radio-row' }, [
                    el('label', { className: 'check' }, [viaDownload, ' Download the file again']),
                    el('label', { className: 'check' }, [viaMail, ' Send it by email (preview next)']),
                ]),
            ],
            okText: 'Continue',
            onOk: function () {
                var why = reason.value.trim();
                if (!why) return Promise.reject(Object.assign(new Error('Type the reason.'), { field: 'reason' }));
                if (viaMail.checked) return { via: 'mail', reason: why };
                return LI.call('POST', 'api/licenses/' + encodeURIComponent(l.licenseId) + '/reissue', { reason: why, via: 'download' })
                    .then(function () { return { via: 'download', reason: why }; });
            },
        }).then(function (r) {
            if (!r) return;
            if (r.via === 'mail') {
                LI.sendDialog(l.licenseId, { reason: r.reason }).then(function (s) { if (s) reload('Reissued: sent to ' + s.to + '.'); });
            } else {
                LI.downloadLicense(l.licenseId, 'licDetailMsg').then(function (ok) { reload(ok ? 'Reissue recorded; the file was downloaded.' : ''); });
            }
        });
    });

    $('ldReplace').addEventListener('click', function () {
        var l = my.detail && my.detail.license;
        if (!l) return;
        var id = input('d-licenseId', state.session.nextId, { maxlength: '11', spellcheck: 'false' });
        var issued = el('input', { id: 'd-issuedAt', type: 'date', value: l.issuedAt });
        var expires = el('input', { id: 'd-expiresAt', type: 'date', value: l.expiresAt || '' });
        var sales = select('d-salesId', LI.salesItems({ first: { value: '', text: 'Pick a sales person…' }, keep: l.salesId }), l.salesId || '');
        var amount = input('d-amount', l.amount, { inputmode: 'decimal', maxlength: '16' });
        var currency = select('d-currency', LI.currencyItems(), l.currency || state.session.defaultCurrency);
        var order = input('d-orderNo', l.orderNo, { maxlength: '100' });
        var note = textarea('d-note', '', 2, 500);
        if (l.type === 'trial') amount.disabled = true;
        LI.dialog({
            title: 'Replace ' + l.licenseId + '?',
            wide: true,
            body: [
                el('div', { className: 'banner warn', text: 'A new license is signed for ' + (l.licensedTo || l.customerName) + ' and ' + l.licenseId
                    + ' is marked revoked (replaced). The old file cannot be recalled: it stays valid until it expires' + (l.expiresAt ? ' on ' + l.expiresAt : '') + '.' }),
                el('div', { className: 'grid' }, [
                    LI.field('New license ID', id), LI.field('Sales person', sales),
                    LI.field('Issued', issued), LI.field('Expires', expires),
                    LI.field('Amount', amount), LI.field('Currency', currency),
                    LI.field('Order no.', order), LI.field('Note on ' + l.licenseId + ' (optional)', note),
                ]),
                el('p', { className: 'muted small-text', text: 'Customer, type, plan and vendor contact are kept. The new license counts as ' + (l.type === 'trial' ? 'a trial' : l.isRenewal ? 'a renewal' : 'new business') + ', like the old one.' }),
            ],
            okText: 'Replace and sign', danger: true,
            onOk: function () {
                var a = F.parseAmount(amount.value);
                if (a.error) return Promise.reject(Object.assign(new Error(a.error), { field: 'amount' }));
                if (!sales.value) return Promise.reject(Object.assign(new Error('Pick the sales person.'), { field: 'salesId' }));
                var b = {
                    licenseId: id.value.trim(), issuedAt: issued.value, expiresAt: expires.value, salesId: Number(sales.value),
                    currency: currency.value, orderNo: order.value.trim(),
                };
                if (l.type !== 'trial') b.amount = a.value;
                if (note.value.trim()) b.note = note.value.trim();
                return LI.call('POST', 'api/licenses/' + encodeURIComponent(l.licenseId) + '/replace', b).catch(function (err) {
                    if (err.data && err.data.nextId) { state.session.nextId = err.data.nextId; err.message += ' Next free ID: ' + err.data.nextId + '.'; }
                    throw err;
                });
            },
        }).then(function (r) {
            if (!r) return;
            state.session.nextId = r.nextId;
            LI.refreshSession().catch(LI.fail());
            openDetail(r.licenseId, 'Issued ' + r.licenseId + ' replacing ' + l.licenseId + '. Download or send the new file to the customer.'
                + (r.registryError ? ' ' + r.registryError : ''));
        });
    });

    $('licBackBtn').addEventListener('click', function () { showList(); });

    // ------------------------------------------------------------------ filters

    ['licCustomer', 'licSales', 'licType', 'licStatus', 'licPeriod', 'licFrom', 'licTo', 'licRevoked'].forEach(function (id) {
        $(id).addEventListener('change', loadList);
    });
    $('licSearch').addEventListener('input', function () {
        clearTimeout(my.timer);
        my.timer = setTimeout(loadList, 250);
    });

    LI.register('licenses', {
        show: function (arg) {
            return LI.loadCustomers().then(function () {
                initFilters();
                if (arg && arg.licenseId) return openDetail(arg.licenseId);
                if (arg && arg.customerId) $('licCustomer').value = String(arg.customerId);
                if (my.detail && !arg) return reload();
                return showList();
            });
        },
    });
})();
