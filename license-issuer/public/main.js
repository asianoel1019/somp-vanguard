// Page start: sign-in / sign-out, session data (CSRF token, defaults, mail state), shared lists and the tab bar.
(function () {
    'use strict';
    var LI = window.LI;
    var F = window.LicenseFormat;
    var $ = LI.$;
    var state = LI.state;

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
        LI.closeDialog(null);
        LI.show('appView', false);
        LI.show('loginView', true);
        var text = lockText(info || {}) || message || '';
        LI.banner('loginMsg', text, 'err');
        $('loginBtn').disabled = !!(info && info.locked);
        if (info && info.locked && info.retryAfter) {
            clearTimeout(state.lockTimer);
            state.lockTimer = setTimeout(function () { $('loginBtn').disabled = false; LI.banner('loginMsg', ''); }, info.retryAfter * 1000 + 500);
        }
        $('password').value = '';
        $('password').focus();
    }
    state.onSignedOut = toLogin;

    $('loginForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = $('password').value;
        if (!pw) return LI.banner('loginMsg', 'Enter the password.', 'err');
        $('loginBtn').disabled = true;
        LI.api('POST', 'api/login', { password: pw }).then(function (r) {
            $('password').value = '';
            if (r.ok) { state.csrf = r.data.csrfToken; LI.banner('loginMsg', ''); return start(); }
            $('loginBtn').disabled = false;
            if (r.data.locked) return toLogin(r.data);
            var msg = r.data.error || 'Sign-in failed.';
            if (typeof r.data.remaining === 'number') msg += ' ' + F.plural(r.data.remaining, 'attempt') + ' left before sign-in is locked for 15 minutes.';
            LI.banner('loginMsg', msg, 'err');
        }).catch(function (err) { $('loginBtn').disabled = false; if (!LI.isSignedOut(err)) LI.banner('loginMsg', 'Cannot reach the server.', 'err'); });
    });

    $('logoutBtn').addEventListener('click', function () {
        LI.api('POST', 'api/logout').catch(function () { /* signed out either way */ }).then(function () {
            toLogin({}, '');
            LI.banner('loginMsg', 'Signed out.', 'ok');
        });
    });

    // ---- session ----
    /** Reloads /api/session (next ID, today, mail state, registry state); resolves the session. */
    LI.refreshSession = function () {
        return LI.call('GET', 'api/session').then(function (s) {
            state.csrf = s.csrfToken;
            state.session = s;
            $('keyBadge').textContent = 'key ' + s.keyId;
            var reg = s.registry || {};
            LI.banner('registryWarn', reg.ok === false && reg.error
                ? 'The generated registry copy (' + reg.file + ') could not be written: ' + reg.error + '. The database is up to date; the copy is written again after the next change.'
                : '', 'warn');
            return s;
        });
    };

    function start() {
        return LI.refreshSession().then(function () {
            return Promise.all([LI.call('GET', 'api/meta'), LI.loadSales(), LI.loadPlans()]);
        }).then(function (r) {
            state.meta = r[0];
            LI.show('loginView', false);
            LI.show('appView', true);
            Object.keys(state.tabs).forEach(function (t) { if (state.tabs[t].init) state.tabs[t].init(); });
            var tab = (location.hash || '').replace('#', '');
            LI.go(state.tabs[tab] ? tab : 'dashboard');
        }).catch(function (err) { if (!LI.isSignedOut(err)) toLogin({}, LI.errorText(err)); });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
        b.addEventListener('click', function () { LI.go(b.getAttribute('data-tab')); });
    });
    window.addEventListener('hashchange', function () {
        var tab = (location.hash || '').replace('#', '');
        if (state.csrf && state.tabs[tab] && tab !== state.tab) LI.go(tab);
    });

    start();
})();
