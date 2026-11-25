// Customers tab: list (search, license count, next expiry) and a detail view (edit the record, license history,
// "Issue a license", delete when the customer has no licenses).
(function () {
    'use strict';
    var LI = window.LI;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var el = LI.el;
    var state = LI.state;
    var FIELDS = ['name', 'email', 'contactPerson', 'phone', 'taxId', 'address', 'defaultSalesId', 'notes'];
    var my = { customer: null, isNew: false, timer: null };

    // ------------------------------------------------------------------ list

    function loadList() {
        return LI.call('GET', 'api/customers?' + F.query({ q: $('custSearch').value.trim() })).then(function (d) {
            var body = $('custBody');
            body.textContent = '';
            d.customers.forEach(function (c) {
                var tr = el('tr');
                LI.cell(tr, c.name);
                LI.cell(tr, [c.contactPerson, c.phone].filter(Boolean).join(', ') || '—');
                LI.cell(tr, c.email || '—');
                LI.cell(tr, c.defaultSalesName || '—');
                LI.cell(tr, String(c.licenseCount), 'num');
                LI.cell(tr, c.nextExpiry || '—', 'nowrap');
                LI.rowLink(tr, function () { openDetail(c.id).catch(LI.fail()); });
                body.appendChild(tr);
            });
            LI.show('custEmpty', !d.customers.length);
        });
    }

    function showList() {
        my.customer = null;
        my.isNew = false;
        LI.show('custDetailView', false);
        LI.show('custListView', true);
        return loadList();
    }

    // ------------------------------------------------------------------ detail

    function fillForm(c) {
        LI.fillSelect('cu-defaultSalesId', LI.salesItems({ first: { value: '', text: '(none)' }, keep: c && c.defaultSalesId }), c && c.defaultSalesId ? c.defaultSalesId : '');
        FIELDS.forEach(function (f) {
            if (f === 'defaultSalesId') return;
            $('cu-' + f).value = c && c[f] !== null && c[f] !== undefined ? String(c[f]) : '';
        });
        LI.clearErrors('custForm');
        LI.banner('custFormMsg', '');
    }

    function openNew() {
        my.customer = null;
        my.isNew = true;
        fillForm(null);
        $('custTitle').textContent = 'New customer';
        LI.show('cu-nameHint', false);
        LI.show('custDeleteBtn', false);
        LI.show('custDeleteHint', false);
        LI.show('custIssueBtn', false);
        LI.show('custLicensesCard', false);
        LI.banner('custMsg', '');
        LI.show('custListView', false);
        LI.show('custDetailView', true);
        $('cu-name').focus();
    }

    function openDetail(id, message) {
        return LI.call('GET', 'api/customers/' + id).then(function (d) {
            var c = d.customer;
            my.customer = c;
            my.isNew = false;
            fillForm(c);
            $('custTitle').textContent = c.name;
            LI.show('cu-nameHint', true);
            LI.show('custDeleteBtn', true);
            $('custDeleteBtn').disabled = c.licenseCount > 0;
            LI.show('custDeleteHint', c.licenseCount > 0);
            LI.show('custIssueBtn', true);
            LI.show('custLicensesCard', true);
            LI.banner('custMsg', message || '', 'ok');
            var body = $('custLicBody');
            body.textContent = '';
            (c.licenses || []).forEach(function (l) {
                var tr = el('tr', { className: l.revokedAt ? 'revoked' : '' });
                LI.cell(tr, l.licenseId, 'mono nowrap');
                LI.cell(tr, '').appendChild(LI.typeChip(l.type));
                LI.cell(tr, l.issuedAt, 'nowrap');
                LI.cell(tr, l.expiresAt || '—', 'nowrap');
                LI.cell(tr, l.salesName || '—');
                LI.cell(tr, F.money(l.amount, l.currency) || '—', 'num nowrap');
                LI.cell(tr, '').appendChild(LI.badge(l.status));
                LI.rowLink(tr, function () { LI.go('licenses', { licenseId: l.licenseId }); });
                body.appendChild(tr);
            });
            LI.show('custLicEmpty', !(c.licenses || []).length);
            LI.show('custListView', false);
            LI.show('custDetailView', true);
        });
    }

    $('custForm').addEventListener('submit', function (e) {
        e.preventDefault();
        LI.clearErrors('custForm');
        LI.banner('custFormMsg', '');
        var b = {};
        FIELDS.forEach(function (f) {
            var v = $('cu-' + f).value;
            if (f === 'defaultSalesId') { b[f] = v ? Number(v) : null; return; }
            b[f] = v.trim();
        });
        if (!b.name) { LI.fieldError('cu-name', 'Name is required.'); return; }
        if (my.isNew) {
            FIELDS.forEach(function (f) { if (b[f] === '' || b[f] === null) delete b[f]; });
        } else {
            // only what changed
            var c = my.customer;
            FIELDS.forEach(function (f) {
                var old = c[f] === null || c[f] === undefined ? (f === 'defaultSalesId' ? null : '') : c[f];
                if (b[f] === old) delete b[f];
            });
            if (!Object.keys(b).length) { LI.banner('custMsg', 'Nothing changed.', 'info'); return; }
        }
        $('custSaveBtn').disabled = true;
        var req = my.isNew ? LI.call('POST', 'api/customers', b) : LI.call('PATCH', 'api/customers/' + my.customer.id, b);
        req.then(function (d) {
            $('custSaveBtn').disabled = false;
            return openDetail(d.customer.id, my.isNew ? 'Customer created.' : 'Saved.');
        }).catch(function (err) {
            $('custSaveBtn').disabled = false;
            if (LI.isSignedOut(err)) return;
            if (!(err.field && LI.fieldError('cu-' + err.field, err.message))) LI.banner('custFormMsg', LI.errorText(err), 'err');
        });
    });

    $('custDeleteBtn').addEventListener('click', function () {
        var c = my.customer;
        if (!c || c.licenseCount > 0) return;
        LI.confirm('Delete ' + c.name + '?', ['The customer record is deleted permanently. This cannot be undone.'], 'Delete customer', true).then(function (ok) {
            if (!ok) return;
            LI.call('DELETE', 'api/customers/' + c.id).then(function () {
                return showList().then(function () { LI.banner('globalMsg', 'Deleted ' + c.name + '.', 'ok'); });
            }).catch(LI.fail('custFormMsg'));
        });
    });

    $('custIssueBtn').addEventListener('click', function () {
        var c = my.customer;
        if (c) LI.go('issue', { prefill: { customerId: c.id, salesId: c.defaultSalesId || null } });
    });
    $('custNewBtn').addEventListener('click', openNew);
    $('custBackBtn').addEventListener('click', function () { showList().catch(LI.fail()); });
    $('custSearch').addEventListener('input', function () {
        clearTimeout(my.timer);
        my.timer = setTimeout(function () { loadList().catch(LI.fail()); }, 250);
    });

    LI.register('customers', {
        show: function (arg) {
            if (arg && arg.customerId) return openDetail(arg.customerId);
            if (my.customer && !arg) return openDetail(my.customer.id);
            return showList();
        },
    });
})();
