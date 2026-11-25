// Issue tab: customer picker (search) or a new customer, plan / type / sales / amount / order no., license ID and dates,
// vendor contact; a review box listing everything; the result with Download .lic and Send to customer.
// Renew (Dashboard / Licenses) and "Issue a license" (Customers) open this tab prefilled: LI.go('issue', { prefill }).
(function () {
    'use strict';
    var LI = window.LI;
    var D = window.LicenseDates;
    var C = window.LicenseContact;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var el = LI.el;
    var state = LI.state;

    var NEW_FIELDS = ['name', 'email', 'contactPerson', 'phone', 'taxId', 'address'];
    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var MAX_LISTED = 300;
    var my = {
        ready: false, mode: 'pick', customerId: null, customer: null, renewalOf: null, renewalLicense: null, pending: null, last: null,
        expiryTouched: false,
    };

    function today() { return state.session.today; }

    // ------------------------------------------------------------------ selects

    function fillSelects() {
        var plans = state.plans.filter(function (p) { return p.active; });
        var current = $('plan').value;
        LI.fillSelect('plan', [{ value: '', text: 'No plan (dates typed by hand)' }].concat(plans.map(function (p) {
            return { value: p.id, text: p.name + (p.type === 'trial' ? ' (trial)' : '') };
        })), current);
        LI.fillSelect('sales', LI.salesItems({ first: { value: '', text: state.sales.some(function (s) { return s.active; }) ? 'Pick a sales person…' : 'No sales people yet (add them in Settings)' } }), $('sales').value);
        LI.fillSelect('currency', LI.currencyItems(), $('currency').value || state.session.defaultCurrency);
    }

    function defaultPlan() {
        var paid = state.plans.filter(function (p) { return p.active && p.type === 'paid'; });
        return paid.filter(function (p) { return p.termUnit === 'months' && p.termValue === 12; })[0] || paid[0] || null;
    }

    // ------------------------------------------------------------------ customers

    function renderCustomerList() {
        var list = F.filterCustomers(state.customers, $('customerSearch').value);
        var items = list.slice(0, MAX_LISTED).map(function (c) {
            var extra = [c.email, c.taxId].filter(Boolean).join(', ');
            return { value: c.id, text: c.name + (extra ? '  —  ' + extra : '') };
        });
        if (!items.length) items.push({ value: '', text: state.customers.length ? 'No customer matches. Use "New customer".' : 'No customers yet. Use "New customer".', disabled: true });
        LI.fillSelect('customerSelect', items, my.customerId);
        if (my.customerId && $('customerSelect').value !== String(my.customerId)) $('customerSelect').selectedIndex = -1;
    }

    function pickCustomer(id) {
        my.customerId = id;
        my.customer = null;
        $('customerInfo').textContent = '';
        LI.clearErrors('customerPickBox');
        if (!id) return Promise.resolve();
        return LI.call('GET', 'api/customers/' + id).then(function (d) {
            if (my.customerId !== id) return;
            var c = d.customer;
            my.customer = c;
            var bits = [];
            if (c.email) bits.push(c.email); else bits.push('no email on file');
            if (c.contactPerson) bits.push(c.contactPerson);
            bits.push(F.plural(c.licenseCount, 'license'));
            if (c.defaultSalesName) bits.push('default sales: ' + c.defaultSalesName);
            $('customerInfo').textContent = c.name + ' — ' + bits.join(' · ');
            var s = c.defaultSalesId && LI.salesById(c.defaultSalesId);
            if (!$('sales').value && s && s.active) $('sales').value = String(s.id);
            updateHints();
        }).catch(LI.fail('issueMsg'));
    }

    function setMode(mode) {
        my.mode = mode;
        LI.show('customerPickBox', mode === 'pick');
        LI.show('newCustomerBox', mode === 'new');
        if (mode === 'new') {
            if (!$('nc-name').value && $('customerSearch').value.trim()) $('nc-name').value = $('customerSearch').value.trim();
            $('nc-name').focus();
        }
        updateHints();
    }

    // ------------------------------------------------------------------ plan / type / amount / dates

    function selectedPlan() { return $('plan').value ? LI.planById(Number($('plan').value)) : null; }

    function applyPlan() {
        var plan = selectedPlan();
        $('type').disabled = !!plan;
        if (plan) {
            $('type').value = plan.type;
            if (!my.renewalOf || !my.expiryTouched) setExpiryFromPlan();
            if (plan.price !== null && plan.price !== undefined) {
                $('amount').value = String(plan.price);
                $('currency').value = plan.currency;
            }
        }
        applyType();
    }

    function setExpiryFromPlan() {
        var plan = selectedPlan();
        if (!plan) return;
        var start = my.renewalOf ? F.renewalStart(my.renewalLicense && !my.renewalLicense.revokedAt ? my.renewalLicense.expiresAt : null, today()) : $('issuedAt').value;
        if (!D.isRealDate(start)) return;
        $('expiresAt').value = F.planExpiry(start, plan);
        my.expiryTouched = false;
    }

    function applyType() {
        var trial = $('type').value === 'trial';
        if (trial) $('amount').value = '0';
        else if ($('amount').disabled && $('amount').value === '0') $('amount').value = ''; // back from a trial
        $('amount').disabled = trial;
        updateHints();
    }

    function updateHints() {
        var plan = selectedPlan();
        var trial = $('type').value === 'trial';
        var hint = plan ? 'Follows the plan.' : '';
        if (trial) hint = (hint ? hint + ' ' : '') + 'Trial: free, at most ' + ((state.meta && state.meta.trialMaxDays) || 60) + ' days, one per customer.';
        if (!trial && my.mode === 'pick' && my.customer) {
            hint = (hint ? hint + ' ' : '') + (isRenewal() ? 'Counts as a renewal.' : 'Counts as new business.');
        } else if (!trial && my.mode === 'new') {
            hint = (hint ? hint + ' ' : '') + 'Counts as new business.';
        }
        if (trial && my.mode === 'pick' && my.customer) {
            var used = (my.customer.licenses || []).filter(function (l) { return l.type === 'trial' && l.revokeReason !== 'replaced'; })[0];
            if (used) hint += ' This customer already had a trial (' + used.licenseId + ').';
        }
        $('typeHint').textContent = hint;
        var exp = $('expiresAt').value;
        var iss = $('issuedAt').value;
        var info = [];
        if (D.isRealDate(exp) && D.isRealDate(iss) && exp >= iss) info.push('valid for ' + F.plural(D.daysBetween(iss, exp) + 1, 'day'));
        if (D.isRealDate(exp)) info.push(F.daysText(D.daysBetween(today(), exp)).replace(' left', ' from today'));
        $('daysInfo').textContent = info.join(', ');
    }

    /** The server's rule for a paid license: Renew of a paid license, or the customer already has a non-revoked paid one. */
    function isRenewal() {
        if (my.renewalLicense && my.renewalLicense.type === 'paid') return true;
        return my.mode === 'pick' && !!my.customer && (my.customer.licenses || []).some(function (l) { return l.type === 'paid' && !l.revokedAt; });
    }

    // ------------------------------------------------------------------ reset / prefill

    function reset(keepContact) {
        my.pending = null;
        my.renewalOf = null;
        my.renewalLicense = null;
        my.expiryTouched = false;
        $('issueTitle').textContent = 'Issue a license';
        LI.banner('renewNote', '');
        $('customerSearch').value = '';
        my.customerId = null;
        my.customer = null;
        $('customerInfo').textContent = '';
        NEW_FIELDS.forEach(function (f) { $('nc-' + f).value = ''; });
        fillSelects();
        var plan = defaultPlan();
        $('plan').value = plan ? String(plan.id) : '';
        $('type').value = 'paid';
        $('sales').value = '';
        $('amount').value = '';
        $('currency').value = state.session.defaultCurrency;
        $('orderNo').value = '';
        $('licenseId').value = state.session.nextId;
        $('issuedAt').value = today();
        $('expiresAt').value = D.termEnd(today(), 1);
        if (!keepContact) {
            var cd = state.session.contactDefaults || {};
            $('contactVendor').value = cd.vendor || '';
            $('contactEmail').value = cd.email || '';
        }
        applyPlan();
        renderCustomerList();
        setMode('pick');
        clearErrors();
        unlock();
    }

    /** p: { customerId, renewalOf, planId, salesId, issuedAt, expiresAt, amount, currency, orderNo }; license: the renewed one. */
    function prefill(p, license) {
        reset(false);
        LI.show('resultBox', false);
        if (p.planId !== undefined) $('plan').value = p.planId ? String(p.planId) : '';
        applyPlan();
        if (p.renewalOf) {
            my.renewalOf = p.renewalOf;
            my.renewalLicense = license || null;
            $('issueTitle').textContent = 'Renew ' + p.renewalOf;
            var l = license || {};
            LI.banner('renewNote', 'Renewal of ' + p.renewalOf + ' (' + (l.licensedTo || l.customerName || '') + ', ' + F.typeLabel(l.type).toLowerCase() + ', expires ' + (l.expiresAt || '—') + '). '
                + 'The new license starts where the old one ends; change the dates if needed.', 'info');
        }
        if (p.salesId) {
            var s = LI.salesById(p.salesId);
            if (s && s.active) $('sales').value = String(s.id);
        }
        if (p.issuedAt) $('issuedAt').value = p.issuedAt;
        if (p.expiresAt) { $('expiresAt').value = p.expiresAt; my.expiryTouched = true; }
        if (p.amount !== undefined) $('amount').value = p.amount === null ? '' : String(p.amount);
        if (p.currency) $('currency').value = p.currency;
        applyType();
        var found = state.customers.filter(function (c) { return c.id === p.customerId; })[0];
        if (found) $('customerSearch').value = found.name;
        renderCustomerList();
        $('customerSelect').value = String(p.customerId);
        return pickCustomer(p.customerId).then(function () {
            if (p.salesId) { var s = LI.salesById(p.salesId); if (s && s.active) $('sales').value = String(s.id); }
            updateHints();
            ($('sales').value ? $('reviewBtn') : $('sales')).focus();
        });
    }

    // ------------------------------------------------------------------ check / review / sign

    function clearErrors() {
        LI.clearErrors('issueForm');
        LI.banner('issueMsg', '');
        checkContact();
    }

    function checkContact() {
        var bad = C.check($('contactVendor').value, $('contactEmail').value);
        [['contactVendor', bad.vendor], ['contactEmail', bad.email]].forEach(function (p) {
            var box = $('err-' + p[0]);
            box.textContent = p[1];
            box.hidden = !p[1];
            $(p[0]).classList.toggle('invalid', !!p[1]);
        });
        $('reviewBtn').disabled = !!(bad.vendor || bad.email);
        return bad.vendor ? ['contactVendor', bad.vendor] : bad.email ? ['contactEmail', bad.email] : null;
    }

    function values() {
        var amount = F.parseAmount($('amount').value);
        var v = {
            mode: my.mode, customerId: my.customerId, plan: selectedPlan(), type: $('type').value, salesId: $('sales').value ? Number($('sales').value) : null,
            amountText: $('amount').value.trim(), amount: amount.value, amountError: amount.error, currency: $('currency').value, orderNo: $('orderNo').value.trim(),
            licenseId: $('licenseId').value.trim(), issuedAt: $('issuedAt').value, expiresAt: $('expiresAt').value,
            contactVendor: $('contactVendor').value.trim(), contactEmail: $('contactEmail').value.trim(), newCustomer: null,
        };
        if (my.mode === 'new') {
            v.newCustomer = {};
            NEW_FIELDS.forEach(function (f) { var x = $('nc-' + f).value.trim(); if (x) v.newCustomer[f] = x; });
        }
        return v;
    }

    function check(v) {
        if (v.mode === 'pick' && !v.customerId) return ['customerSelect', 'Pick a customer (or use "New customer").'];
        if (v.mode === 'new') {
            if (!v.newCustomer.name) return ['nc-name', 'Customer name is required.'];
            if (v.newCustomer.email && !EMAIL_PATTERN.test(v.newCustomer.email)) return ['nc-email', 'Email must look like name@example.test.'];
        }
        if (!v.salesId) return ['sales', 'Pick the sales person of this license.'];
        if (v.amountError) return ['amount', v.amountError];
        if (v.type === 'trial' && v.amount) return ['amount', 'A trial license is free: its amount must be 0.'];
        var contact = checkContact();
        if (contact) return contact;
        if (!/^L-\d{4}-\d{4}$/.test(v.licenseId)) return ['licenseId', 'License ID must look like L-YYYY-NNNN.'];
        if (!D.isRealDate(v.issuedAt)) return ['issuedAt', 'Issued must be a real date.'];
        if (!D.isRealDate(v.expiresAt)) return ['expiresAt', 'Expires must be a real date.'];
        if (v.expiresAt < today()) return ['expiresAt', 'Expires is in the past.'];
        if (v.expiresAt < v.issuedAt) return ['expiresAt', 'Expires is before Issued.'];
        var max = (state.meta && state.meta.trialMaxDays) || 60;
        if (v.type === 'trial' && D.daysBetween(v.issuedAt, v.expiresAt) + 1 > max) return ['expiresAt', 'A trial license can be valid for at most ' + max + ' days.'];
        return null;
    }

    /** Server field -> input id on this form. */
    function inputFor(field) {
        if (my.mode === 'new' && NEW_FIELDS.indexOf(field) >= 0) return 'nc-' + field;
        var map = { customerId: 'customerSelect', customer: my.mode === 'new' ? 'nc-name' : 'customerSelect', newCustomer: 'nc-name', planId: 'plan', salesId: 'sales' };
        return map[field] || field;
    }

    function showError(field, text) {
        if (!(field && LI.fieldError(inputFor(field), text))) LI.banner('issueMsg', text, 'err');
    }

    function lock() { $('issueForm').classList.add('locked'); }
    function unlock() { $('issueForm').classList.remove('locked'); LI.show('confirmBox', false); }

    function summaryRows(list, rows) {
        var dl = $(list);
        dl.textContent = '';
        rows.forEach(function (r) {
            if (!r) return;
            dl.appendChild(el('dt', { text: r[0] }));
            dl.appendChild(el('dd', { text: r[1], className: r[2] || '' }));
        });
    }

    function customerName(v) {
        if (v.mode === 'new') return v.newCustomer.name + ' (new customer)';
        var c = my.customer || state.customers.filter(function (x) { return x.id === v.customerId; })[0];
        return c ? c.name : '#' + v.customerId;
    }

    $('issueForm').addEventListener('submit', function (e) {
        e.preventDefault();
        clearErrors();
        var v = values();
        var bad = check(v);
        if (bad) { if (!LI.fieldError(bad[0], bad[1])) LI.banner('issueMsg', bad[1], 'err'); return; }
        my.pending = v;
        var sales = LI.salesById(v.salesId);
        var kind = v.type === 'trial' ? 'Trial' : !isRenewal() ? 'New business' + (my.renewalOf ? ' (converts ' + my.renewalOf + ')' : '')
            : my.renewalOf ? 'Renewal of ' + my.renewalOf : 'Renewal (the customer already has a paid license)';
        summaryRows('confirmList', [
            ['Customer', customerName(v)],
            v.mode === 'new' && v.newCustomer.email ? ['Customer email', v.newCustomer.email] : null,
            ['Type', F.typeLabel(v.type)],
            ['Counts as', kind],
            ['Plan', v.plan ? v.plan.name : 'none'],
            ['Sales person', sales ? sales.name : ''],
            ['Amount', v.type === 'trial' ? 'free (0)' : v.amount === null ? 'not recorded' : F.money(v.amount, v.currency)],
            ['Order no.', v.orderNo || 'none'],
            ['License ID', v.licenseId, 'mono'],
            ['Issued', v.issuedAt],
            ['Expires', v.expiresAt],
            ['Valid for', F.plural(D.daysBetween(v.issuedAt, v.expiresAt) + 1, 'day') + ' (' + F.daysText(D.daysBetween(today(), v.expiresAt)).replace(' left', ' from today') + ')'],
            ['Vendor contact', C.text(v.contactVendor, v.contactEmail) || 'none'],
        ]);
        LI.banner('confirmMsg', '');
        LI.show('resultBox', false);
        LI.show('confirmBox', true);
        lock();
        $('signBtn').focus();
    });

    $('cancelBtn').addEventListener('click', function () { unlock(); my.pending = null; });

    $('signBtn').addEventListener('click', function () {
        var v = my.pending;
        if (!v) return;
        var body = {
            salesId: v.salesId, type: v.type, currency: v.currency, licenseId: v.licenseId, issuedAt: v.issuedAt, expiresAt: v.expiresAt,
            contactVendor: v.contactVendor, contactEmail: v.contactEmail, amount: v.type === 'trial' ? 0 : v.amount,
        };
        if (v.mode === 'new') body.newCustomer = v.newCustomer; else body.customerId = v.customerId;
        if (v.plan) body.planId = v.plan.id;
        if (v.orderNo) body.orderNo = v.orderNo;
        if (my.renewalOf) body.renewalOf = my.renewalOf;
        $('signBtn').disabled = true;
        LI.api('POST', 'api/licenses', body).then(function (r) {
            $('signBtn').disabled = false;
            if (!r.ok) {
                unlock();
                if (r.data.nextId) state.session.nextId = r.data.nextId;
                var msg = r.data.error || 'The license was not issued.';
                if (r.data.code === 'duplicate-id' && r.data.nextId) msg += ' Next free ID: ' + r.data.nextId + '.';
                return showError(r.data.field, msg);
            }
            var d = r.data;
            var l = d.license;
            my.last = l;
            state.session.nextId = d.nextId;
            $('resultTitle').textContent = d.registryError ? 'License issued (registry copy not updated)' : 'License issued';
            summaryRows('resultList', [
                ['Customer', l.licensedTo],
                ['License ID', l.licenseId, 'mono'],
                ['Type', F.typeLabel(l.type) + (l.type === 'paid' ? (l.isRenewal ? ' (renewal)' : ' (new)') : '')],
                ['Expires', l.expiresAt + ' (' + F.daysText(l.daysLeft) + ')'],
                ['Sales person', l.salesName || ''],
                ['Amount', l.amount === null ? 'not recorded' : F.money(l.amount, l.currency)],
                ['Vendor contact', C.text(l.contactVendor || '', l.contactEmail || '') || 'none'],
                ['Saved to', d.file, 'mono'],
                ['SHA-256', d.sha256, 'mono'],
            ]);
            LI.banner('resultWarn', d.registryError || '', 'warn');
            LI.banner('resultMsg', '');
            LI.show('resultBox', true);
            reset(true); // the next license for the same vendor contact
            LI.loadCustomers().then(renderCustomerList).catch(LI.fail('issueMsg'));
            LI.refreshSession().catch(LI.fail('issueMsg'));
            $('resultDownloadBtn').focus();
        }).catch(function (err) {
            $('signBtn').disabled = false;
            unlock();
            if (!LI.isSignedOut(err)) LI.banner('issueMsg', LI.errorText(err), 'err');
        });
    });

    // ------------------------------------------------------------------ result actions

    $('resultDownloadBtn').addEventListener('click', function () {
        if (!my.last) return;
        LI.banner('resultMsg', '');
        LI.downloadLicense(my.last.licenseId, 'resultMsg');
    });
    $('resultSendBtn').addEventListener('click', function () {
        if (!my.last) return;
        LI.sendDialog(my.last.licenseId).then(function (sent) {
            if (sent) LI.banner('resultMsg', 'Sent to ' + sent.to + '.', 'ok');
        });
    });
    $('resultViewBtn').addEventListener('click', function () { if (my.last) LI.go('licenses', { licenseId: my.last.licenseId }); });

    // ------------------------------------------------------------------ inputs

    $('customerSearch').addEventListener('input', renderCustomerList);
    $('customerSearch').addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); $('customerSelect').focus(); if ($('customerSelect').selectedIndex < 0) $('customerSelect').selectedIndex = 0; pickFromList(); }
        if (e.key === 'Enter') { e.preventDefault(); var list = F.filterCustomers(state.customers, $('customerSearch').value); if (list.length === 1) { $('customerSelect').value = String(list[0].id); pickFromList(); } }
    });
    function pickFromList() {
        var id = Number($('customerSelect').value);
        if (id && id !== my.customerId) pickCustomer(id);
    }
    $('customerSelect').addEventListener('change', pickFromList);
    $('newCustomerBtn').addEventListener('click', function () { setMode('new'); });
    $('pickCustomerBtn').addEventListener('click', function () { setMode('pick'); $('customerSearch').focus(); });
    $('plan').addEventListener('change', function () { my.expiryTouched = false; applyPlan(); });
    $('type').addEventListener('change', applyType);
    $('issuedAt').addEventListener('change', function () { if (selectedPlan() && !my.renewalOf) setExpiryFromPlan(); updateHints(); });
    $('expiresAt').addEventListener('input', function () { my.expiryTouched = true; updateHints(); });
    ['contactVendor', 'contactEmail'].forEach(function (id) { $(id).addEventListener('input', checkContact); });
    $('issueClearBtn').addEventListener('click', function () { reset(false); LI.show('resultBox', false); });

    LI.register('issue', {
        init: function () { my.ready = false; },
        show: function (arg) {
            return LI.loadCustomers().then(function () {
                if (arg && arg.prefill) { my.ready = true; return prefill(arg.prefill, arg.license); }
                if (!my.ready) { my.ready = true; reset(false); LI.show('resultBox', false); return; }
                // coming back: refresh the lists, keep what was typed
                var keepPlan = $('plan').value;
                fillSelects();
                $('plan').value = keepPlan;
                renderCustomerList();
                updateHints();
            });
        },
    });
})();
