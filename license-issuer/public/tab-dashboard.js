// Dashboard tab: this month / this quarter (issued, new, renewal, trial, amounts per currency), the renewal board
// (30 / 60 / 90 days, Renew opens the Issue tab prefilled) and trials (active, expiring soon, conversion rate).
(function () {
    'use strict';
    var LI = window.LI;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var el = LI.el;
    var state = LI.state;

    function stat(label, value, cls) {
        return el('div', { className: 'stat' + (cls ? ' ' + cls : '') }, [
            el('div', { className: 'stat-value', text: value }),
            el('div', { className: 'stat-label', text: label }),
        ]);
    }

    function period(boxId, rangeId, p) {
        $(rangeId).textContent = p.from + ' – ' + p.to;
        var box = $(boxId);
        box.textContent = '';
        box.appendChild(stat('Issued', String(p.issued)));
        box.appendChild(stat('New', String(p.new)));
        box.appendChild(stat('Renewal', String(p.renewal)));
        box.appendChild(stat('Trial', String(p.trial)));
        box.appendChild(stat('Amount', F.amountsText(p.amounts, state.meta && state.meta.currencies), 'stat-wide'));
    }

    function licenseRow(l, cols) {
        var tr = el('tr');
        LI.cell(tr, l.licenseId, 'mono nowrap');
        LI.cell(tr, l.licensedTo || l.customerName);
        if (cols.type) LI.cell(tr, '').appendChild(LI.typeChip(l.type));
        LI.cell(tr, l.expiresAt, 'nowrap');
        LI.cell(tr, String(l.daysLeft), 'num');
        LI.cell(tr, l.salesName || '—');
        if (cols.status) LI.cell(tr, '').appendChild(LI.badge(l.status));
        var act = LI.cell(tr, '', 'nowrap right');
        act.appendChild(LI.smallButton(l.type === 'trial' ? 'Convert' : 'Renew', function () { LI.renew(l); }));
        LI.rowLink(tr, function () { LI.go('licenses', { licenseId: l.licenseId }); });
        return tr;
    }

    function render(d) {
        period('dbMonth', 'dbMonthRange', d.month);
        period('dbQuarter', 'dbQuarterRange', d.quarter);
        renderRenewals(d.renewals);
        var t = d.trials;
        var c = t.conversion;
        var box = $('dbTrialStats');
        box.textContent = '';
        box.appendChild(stat('Active trials', String(t.active)));
        box.appendChild(stat('Expiring within ' + ((state.meta && state.meta.soonDays && state.meta.soonDays.trial) || 7) + ' days', String(t.expiringSoon), t.expiringSoon ? 'stat-warn' : ''));
        box.appendChild(stat('Conversion rate', F.percent(c.rate)));
        box.appendChild(stat('Converted', c.converted + ' of ' + F.plural(c.withTrial, 'customer') + ' with a trial', 'stat-wide'));
        var body = $('dbTrials');
        body.textContent = '';
        t.list.forEach(function (l) { body.appendChild(licenseRow(l, { status: true })); });
        LI.show('dbTrialsEmpty', !t.list.length);
    }

    function renderRenewals(r) {
        var body = $('dbRenewals');
        body.textContent = '';
        r.rows.forEach(function (l) { body.appendChild(licenseRow(l, { type: true })); });
        LI.show('dbRenewalsEmpty', !r.rows.length);
    }

    function load() {
        return LI.call('GET', 'api/dashboard?days=' + encodeURIComponent($('dbDays').value)).then(render);
    }

    $('dbDays').addEventListener('change', function () {
        LI.call('GET', 'api/renewals?days=' + encodeURIComponent($('dbDays').value)).then(renderRenewals).catch(LI.fail());
    });

    LI.register('dashboard', { show: load });
})();
