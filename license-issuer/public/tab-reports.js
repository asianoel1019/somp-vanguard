// Reports tab: period (month / quarter / year containing a date, a date range, or all time) on the issue date, sales,
// type and new / renewal filters; summary per sales person (amounts per currency), detail rows; CSV export of both.
(function () {
    'use strict';
    var LI = window.LI;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var el = LI.el;
    var state = LI.state;
    var my = { ready: false };

    function params() {
        var period = $('repPeriod').value;
        var p = { period: period, salesId: $('repSales').value, type: $('repType').value, kind: $('repKind').value };
        if (period === 'custom') { p.from = $('repFrom').value; p.to = $('repTo').value; } else if (period !== 'all') p.date = $('repDate').value || state.session.today;
        return p;
    }

    function syncInputs() {
        var period = $('repPeriod').value;
        LI.show('repDateBox', period !== 'custom' && period !== 'all');
        Array.prototype.forEach.call(document.querySelectorAll('.repRange'), function (e) { e.hidden = period !== 'custom'; });
    }

    function load() {
        syncInputs();
        var q = F.query(Object.assign(params(), { includeRevoked: $('repRevoked').checked ? '1' : '' }));
        return LI.call('GET', 'api/reports?' + q).then(render).catch(LI.fail());
    }

    function render(d) {
        $('repRange').textContent = 'Issued ' + (d.from && d.to ? d.from + ' – ' + d.to : d.from ? 'from ' + d.from : d.to ? 'up to ' + d.to : 'at any time') + '.';
        var order = state.meta && state.meta.currencies;
        var rows = d.summary.rows;
        var cur = F.currenciesOf(rows.concat([d.summary.totals]), order);
        var head = $('repSummaryHead');
        head.textContent = '';
        var htr = el('tr');
        ['Sales', 'Licenses', 'New', 'Renewal', 'Trial'].forEach(function (h, i) { htr.appendChild(el('th', { text: h, className: i ? 'num' : '' })); });
        cur.forEach(function (c) { htr.appendChild(el('th', { text: 'Amount ' + c, className: 'num' })); });
        head.appendChild(htr);
        function line(tr, r) {
            LI.cell(tr, String(r.count), 'num');
            LI.cell(tr, String(r.new), 'num');
            LI.cell(tr, String(r.renewal), 'num');
            LI.cell(tr, String(r.trial), 'num');
            cur.forEach(function (c) { LI.cell(tr, r.amounts && r.amounts[c] !== undefined ? F.number(r.amounts[c]) : '—', 'num nowrap'); });
        }
        var body = $('repSummaryBody');
        body.textContent = '';
        rows.forEach(function (r) {
            var tr = el('tr');
            LI.cell(tr, r.salesName || '(unassigned)');
            line(tr, r);
            body.appendChild(tr);
        });
        var foot = $('repSummaryFoot');
        foot.textContent = '';
        if (rows.length) {
            var ftr = el('tr', { className: 'total' });
            LI.cell(ftr, 'Total');
            line(ftr, d.summary.totals);
            foot.appendChild(ftr);
        }
        LI.show('repSummaryEmpty', !rows.length);

        var dbody = $('repDetailBody');
        dbody.textContent = '';
        d.detail.rows.forEach(function (l) {
            var tr = el('tr', { className: l.revokedAt ? 'revoked' : '' });
            LI.cell(tr, l.licenseId, 'mono nowrap');
            LI.cell(tr, l.licensedTo || l.customerName);
            LI.cell(tr, F.kindLabel(l));
            LI.cell(tr, l.issuedAt, 'nowrap');
            LI.cell(tr, l.expiresAt || '—', 'nowrap');
            LI.cell(tr, l.salesName || '—');
            LI.cell(tr, F.money(l.amount, l.currency) || '—', 'num nowrap');
            LI.cell(tr, l.orderNo || '—');
            LI.cell(tr, '').appendChild(LI.badge(l.status));
            LI.rowLink(tr, function () { LI.go('licenses', { licenseId: l.licenseId }); });
            dbody.appendChild(tr);
        });
        LI.show('repDetailEmpty', !d.detail.rows.length);
    }

    function exportCsv(kind) {
        var p = params();
        if (kind === 'detail' && $('repRevoked').checked) p.includeRevoked = '1';
        LI.banner('globalMsg', '');
        LI.download('api/reports/' + kind + '.csv?' + F.query(p), 'license-report-' + kind + '.csv').then(function (err) {
            if (err && err !== LI.SIGNED_OUT) LI.banner('globalMsg', err, 'err');
        });
    }

    ['repPeriod', 'repDate', 'repFrom', 'repTo', 'repSales', 'repType', 'repKind', 'repRevoked'].forEach(function (id) { $(id).addEventListener('change', load); });
    $('repSummaryCsv').addEventListener('click', function () { exportCsv('summary'); });
    $('repDetailCsv').addEventListener('click', function () { exportCsv('detail'); });

    LI.register('reports', {
        show: function () {
            LI.fillSelect('repSales', LI.salesItems({ first: { value: '', text: 'All' }, none: true, all: true }), $('repSales').value);
            if (!my.ready) {
                my.ready = true;
                $('repDate').value = state.session.today;
            }
            return load();
        },
    });
})();
