// Settings tab: sales people (add / edit / deactivate), plans (add / edit / deactivate), email (status, test mail,
// delivery template, weekly digest day and time, default currency, digest preview) and database backups.
(function () {
    'use strict';
    var LI = window.LI;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var el = LI.el;
    var state = LI.state;
    var DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    function input(id, value, attrs) {
        var i = el('input', { id: id, type: 'text', value: value === null || value === undefined ? '' : String(value) });
        Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
        return i;
    }
    function reject(field, text) { return Promise.reject(Object.assign(new Error(text), { field: field })); }

    // ------------------------------------------------------------------ sales people

    function renderSales() {
        var body = $('salesBody');
        body.textContent = '';
        state.sales.forEach(function (s) {
            var tr = el('tr', { className: s.active ? '' : 'revoked' });
            LI.cell(tr, s.name);
            LI.cell(tr, s.email || '—');
            LI.cell(tr, String(s.licenseCount || 0), 'num');
            LI.cell(tr, s.active ? 'Active' : 'Inactive');
            var act = LI.cell(tr, '', 'nowrap right');
            act.appendChild(LI.smallButton('Edit', function () { editSales(s); }));
            act.appendChild(LI.smallButton(s.active ? 'Deactivate' : 'Activate', function () { setSalesActive(s, !s.active); }));
            body.appendChild(tr);
        });
        if (!state.sales.length) {
            var tr = el('tr');
            LI.cell(tr, 'No sales people yet. Add one below: issuing needs a sales person.', 'muted').colSpan = 5;
            body.appendChild(tr);
        }
    }

    function reloadSales() { return LI.loadSales().then(renderSales); }

    function editSales(s) {
        var name = input('d-name', s.name, { maxlength: '100' });
        var email = input('d-email', s.email, { maxlength: '200', inputmode: 'email', spellcheck: 'false' });
        LI.dialog({
            title: 'Edit sales person',
            body: [LI.field('Name', name), LI.field('Email (optional)', email, { hint: 'The weekly digest goes to this address.' })],
            okText: 'Save',
            onOk: function () {
                if (!name.value.trim()) return reject('name', 'Name is required.');
                return LI.call('PATCH', 'api/sales/' + s.id, { name: name.value.trim(), email: email.value.trim() });
            },
        }).then(function (r) { if (r) reloadSales().catch(LI.fail('salesMsg')); });
    }

    function setSalesActive(s, active) {
        LI.banner('salesMsg', '');
        LI.call('PATCH', 'api/sales/' + s.id, { active: active }).then(reloadSales).catch(LI.fail('salesMsg'));
    }

    $('salesAddForm').addEventListener('submit', function (e) {
        e.preventDefault();
        LI.banner('salesMsg', '');
        var name = $('salesAddName').value.trim();
        var email = $('salesAddEmail').value.trim();
        if (!name) { LI.banner('salesMsg', 'Type the name of the sales person.', 'err'); $('salesAddName').focus(); return; }
        var b = { name: name };
        if (email) b.email = email;
        LI.call('POST', 'api/sales', b).then(function () {
            $('salesAddName').value = '';
            $('salesAddEmail').value = '';
            return reloadSales();
        }).catch(LI.fail('salesMsg'));
    });

    // ------------------------------------------------------------------ plans

    function termText(p) { return p.termValue + ' ' + (p.termUnit === 'days' ? (p.termValue === 1 ? 'day' : 'days') : (p.termValue === 1 ? 'month' : 'months')); }

    function renderPlans() {
        var body = $('plansBody');
        body.textContent = '';
        state.plans.forEach(function (p) {
            var tr = el('tr', { className: p.active ? '' : 'revoked' });
            LI.cell(tr, p.name);
            LI.cell(tr, '').appendChild(LI.typeChip(p.type));
            LI.cell(tr, termText(p));
            LI.cell(tr, p.price === null ? 'typed when issuing' : F.money(p.price, p.currency), 'num nowrap');
            LI.cell(tr, p.active ? 'Active' : 'Inactive');
            var act = LI.cell(tr, '', 'nowrap right');
            act.appendChild(LI.smallButton('Edit', function () { planDialog(p); }));
            act.appendChild(LI.smallButton(p.active ? 'Deactivate' : 'Activate', function () {
                LI.banner('plansMsg', '');
                LI.call('PATCH', 'api/plans/' + p.id, { active: !p.active }).then(reloadPlans).catch(LI.fail('plansMsg'));
            }));
            body.appendChild(tr);
        });
    }

    function reloadPlans() { return LI.loadPlans().then(renderPlans); }

    function planDialog(p) {
        var plan = p || { name: '', type: 'paid', termValue: 12, termUnit: 'months', price: null, currency: state.session.defaultCurrency };
        var name = input('d-name', plan.name, { maxlength: '100' });
        var type = LI.fillSelect(el('select', { id: 'd-type' }), [{ value: 'paid', text: 'Paid' }, { value: 'trial', text: 'Trial' }], plan.type);
        var term = input('d-termValue', plan.termValue, { inputmode: 'numeric', maxlength: '4' });
        var unit = LI.fillSelect(el('select', { id: 'd-termUnit' }), [{ value: 'months', text: 'months' }, { value: 'days', text: 'days' }], plan.termUnit);
        var price = input('d-price', plan.price, { inputmode: 'decimal', maxlength: '16', placeholder: 'empty = typed when issuing' });
        var currency = LI.fillSelect(el('select', { id: 'd-currency' }), LI.currencyItems(), plan.currency);
        function syncType() {
            var trial = type.value === 'trial';
            if (trial) price.value = '0';
            price.disabled = trial;
        }
        type.addEventListener('change', syncType);
        syncType();
        LI.dialog({
            title: p ? 'Edit plan' : 'Add plan',
            body: [
                el('div', { className: 'grid' }, [
                    LI.field('Name', name, { wide: true }),
                    LI.field('Type', type), el('div'),
                    LI.field('Term', term), LI.field('Unit', unit),
                    LI.field('Price (optional)', price), LI.field('Currency', currency),
                ]),
                el('p', { className: 'muted small-text', text: 'Changing a plan does not change licenses already issued with it.' }),
            ],
            okText: p ? 'Save' : 'Add plan',
            onOk: function () {
                if (!name.value.trim()) return reject('name', 'Name is required.');
                if (!/^\d{1,4}$/.test(term.value.trim()) || Number(term.value) < 1) return reject('termValue', 'Term must be a whole number of at least 1.');
                var a = F.parseAmount(price.value);
                if (a.error) return reject('price', a.error.replace('Amount', 'Price'));
                var b = { name: name.value.trim(), type: type.value, termValue: Number(term.value), termUnit: unit.value, price: a.value, currency: currency.value };
                if (p) {
                    Object.keys(b).forEach(function (k) { if (b[k] === p[k]) delete b[k]; });
                    if (!Object.keys(b).length) return true;
                    return LI.call('PATCH', 'api/plans/' + p.id, b);
                }
                return LI.call('POST', 'api/plans', b);
            },
        }).then(function (r) { if (r) reloadPlans().catch(LI.fail('plansMsg')); });
    }

    $('planAddBtn').addEventListener('click', function () { planDialog(null); });

    // ------------------------------------------------------------------ email

    function renderMail(s) {
        LI.banner('mailStatus', s.enabled ? 'Mail is configured.' : 'Mail is off: ' + s.reason + '. Delivery mails, the test mail and the weekly digest need SMTP_HOST and MAIL_FROM in .env (restart after changing it).', s.enabled ? 'ok' : 'warn');
        var dl = $('mailInfo');
        dl.textContent = '';
        var rows = [
            ['SMTP server', s.host ? s.host + ':' + s.port + (s.secure ? ' (TLS)' : ' (STARTTLS when offered)') : '—'],
            ['Sign-in', s.auth ? 'with SMTP_USER / SMTP_PASS' : 'none'],
            ['From', s.from || '—'],
            ['Digest summary to (MAIL_ADMIN)', s.admin || '— (no summary mail)'],
        ];
        rows.forEach(function (r) { dl.appendChild(el('dt', { text: r[0] })); dl.appendChild(el('dd', { text: r[1] })); });
        $('testMailTo').placeholder = s.admin ? 'Recipient (default ' + s.admin + ')' : 'Recipient';
        var g = s.digest || {};
        var parts = [];
        parts.push(g.scheduled ? 'The digest timer runs (checks every 10 minutes).' : s.enabled ? 'The digest timer is not running.' : 'The digest is off while mail is off.');
        parts.push('This week: ' + (g.currentWeek || '?') + (g.lastDigestWeek === g.currentWeek ? ', already sent.' : g.due ? ', due now.' : ', not due yet.'));
        if (g.lastRun) parts.push('Last run ' + F.stampText(g.lastRun.at) + ': ' + g.lastRun.status + (g.lastRun.error ? ' (' + g.lastRun.error + ')' : '') + '.');
        $('digestInfo').textContent = parts.join(' ');
    }

    function renderSettings(d) {
        var s = d.settings;
        $('mailSubject').value = s.mailSubject;
        $('mailBody').value = s.mailBody;
        $('digestWeekday').value = String(s.digestWeekday);
        $('digestTime').value = s.digestTime;
        LI.fillSelect('defaultCurrency', LI.currencyItems(), s.defaultCurrency);
        var vars = $('mailVars');
        vars.textContent = '';
        Object.keys(d.templateVariables || {}).forEach(function (k, i) {
            if (i) vars.appendChild(document.createTextNode(' '));
            vars.appendChild(el('code', { text: '{' + k + '}', title: d.templateVariables[k] }));
        });
        if (d.warnings && d.warnings.length) LI.banner('mailSettingsMsg', d.warnings.join(' '), 'warn');
    }

    function loadMail() {
        return Promise.all([LI.call('GET', 'api/mail/status'), LI.call('GET', 'api/settings')]).then(function (r) {
            renderMail(r[0]);
            renderSettings(r[1]);
        });
    }

    $('testMailForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var to = $('testMailTo').value.trim();
        LI.banner('testMailMsg', 'Sending…', 'info');
        LI.call('POST', 'api/mail/test', to ? { to: to } : {}).then(function (r) {
            LI.banner('testMailMsg', 'Test mail sent to ' + r.to + '.', 'ok');
        }).catch(function (err) { if (!LI.isSignedOut(err)) LI.banner('testMailMsg', LI.errorText(err), 'err'); });
    });

    $('mailSettingsForm').addEventListener('submit', function (e) {
        e.preventDefault();
        LI.clearErrors('mailSettingsForm');
        LI.banner('mailSettingsMsg', '');
        var b = {
            mailSubject: $('mailSubject').value, mailBody: $('mailBody').value, digestWeekday: Number($('digestWeekday').value),
            digestTime: $('digestTime').value, defaultCurrency: $('defaultCurrency').value,
        };
        LI.call('PATCH', 'api/settings', b).then(function (d) {
            state.session.defaultCurrency = d.settings.defaultCurrency;
            LI.banner('mailSettingsMsg', d.warnings && d.warnings.length ? 'Saved. ' + d.warnings.join(' ') : 'Saved.', d.warnings && d.warnings.length ? 'warn' : 'ok');
            return LI.call('GET', 'api/mail/status').then(renderMail);
        }).catch(function (err) {
            if (LI.isSignedOut(err)) return;
            if (!(err.field && LI.fieldError(err.field, err.message))) LI.banner('mailSettingsMsg', LI.errorText(err), 'err');
        });
    });

    $('digestPreviewBtn').addEventListener('click', function () {
        LI.call('GET', 'api/mail/digest').then(function (d) {
            var body = [el('p', { className: 'small-text', text: 'Week ' + d.week + ': ' + F.plural(d.total, 'license') + ' expiring ' + d.today + ' – ' + d.until
                + '. Scheduled for ' + DAYS[Number($('digestWeekday').value)] + ' ' + $('digestTime').value + '. Nothing is sent from this preview.' })];
            if (!d.mail.enabled) body.push(el('div', { className: 'banner warn', text: 'Mail is off: ' + d.mail.reason + '.' }));
            d.mails.forEach(function (m) {
                body.push(el('div', { className: 'mail-preview' }, [
                    el('div', { className: 'muted small-text', text: (m.kind === 'admin' ? 'Summary to ' : 'To ') + m.to + (m.alreadySent ? ' (already sent this week)' : '') }),
                    el('div', { className: 'mail-subject', text: m.subject }),
                    el('pre', { className: 'mail-body', text: m.text }),
                ]));
            });
            if (!d.mails.length) body.push(el('p', { className: 'muted', text: 'No mails would be sent (no MAIL_ADMIN and no sales person with expiring licenses and an email).' }));
            (d.skipped || []).forEach(function (s) {
                body.push(el('p', { className: 'small-text warn-text', text: 'Skipped ' + (s.salesName || '?') + (s.email ? ' <' + s.email + '>' : '') + ': ' + s.reason }));
            });
            return LI.dialog({ title: 'Weekly digest preview', body: body, hideOk: true, wide: true });
        }).catch(LI.fail());
    });

    // ------------------------------------------------------------------ backups

    function loadBackups() {
        return LI.call('GET', 'api/backups').then(function (d) {
            $('backupDir').textContent = d.dir;
            var body = $('backupBody');
            body.textContent = '';
            d.backups.forEach(function (b) {
                var tr = el('tr');
                LI.cell(tr, b.name, 'mono');
                LI.cell(tr, F.sizeText(b.size), 'num nowrap');
                LI.cell(tr, F.stampText(b.createdAt), 'nowrap');
                var act = LI.cell(tr, '', 'right');
                act.appendChild(LI.smallButton('Download', function () {
                    LI.download('api/backups/' + encodeURIComponent(b.name), b.name).then(function (err) {
                        if (err && err !== LI.SIGNED_OUT) LI.banner('backupMsg', err, 'err');
                    });
                }));
                body.appendChild(tr);
            });
            LI.show('backupEmpty', !d.backups.length);
        });
    }

    $('backupBtn').addEventListener('click', function () {
        $('backupBtn').disabled = true;
        LI.call('POST', 'api/backups').then(function (d) {
            $('backupBtn').disabled = false;
            LI.banner('backupMsg', 'Backup created: ' + d.backup.name + ' (' + F.sizeText(d.backup.size) + ').', 'ok');
            return loadBackups();
        }).catch(function (err) {
            $('backupBtn').disabled = false;
            if (!LI.isSignedOut(err)) LI.banner('backupMsg', LI.errorText(err), 'err');
        });
    });

    LI.register('settings', {
        show: function () {
            LI.banner('salesMsg', '');
            LI.banner('plansMsg', '');
            LI.banner('testMailMsg', '');
            LI.banner('mailSettingsMsg', '');
            LI.banner('backupMsg', '');
            return Promise.all([reloadSales(), reloadPlans(), loadMail(), loadBackups()]);
        },
    });
})();
