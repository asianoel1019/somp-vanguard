// Password change page: reads the policy and contact, checks the form, posts it, shows the answer.
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var minLength = 0;

    function show(kind, text) {
        var r = $('result');
        r.className = 'banner ' + kind;
        r.textContent = text;
        r.hidden = false;
    }

    function item(text) {
        var li = document.createElement('li');
        li.textContent = text;
        $('policy').appendChild(li);
    }

    fetch('api/info', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (info) {
        if (info.httpWarning) $('httpWarning').hidden = false;
        if (info.adminContact) {
            $('contactZh').textContent = '（' + info.adminContact + '）';
            $('contactEn').textContent = ' (' + info.adminContact + ')';
        }
        var p = info.policy;
        if (p) {
            minLength = p.minLength || 0;
            if (p.minLength) item('至少 ' + p.minLength + ' 個字元 / At least ' + p.minLength + ' characters');
            if (p.complexity) item('需包含大寫、小寫、數字、符號其中三類，且不可含帳號名稱 / Three of: upper case, lower case, digits, symbols; not containing your account name');
            if (p.history) item('不可與最近 ' + p.history + ' 次用過的密碼相同 / Not one of your last ' + p.history + ' passwords');
            if (p.minAgeDays >= 1) item('距離上次變更需滿 ' + Math.round(p.minAgeDays) + ' 天 / At least ' + Math.round(p.minAgeDays) + ' day(s) since the last change');
            $('policy').hidden = false;
        }
    }).catch(function () { /* the form works without the policy text */ });

    $('showPasswords').addEventListener('change', function (e) {
        ['currentPassword', 'newPassword', 'confirmPassword'].forEach(function (id) { $(id).type = e.target.checked ? 'text' : 'password'; });
    });

    $('form').addEventListener('submit', function (e) {
        e.preventDefault();
        var body = {
            account: $('account').value.trim(),
            currentPassword: $('currentPassword').value,
            newPassword: $('newPassword').value,
            confirmPassword: $('confirmPassword').value
        };
        if (!body.account || !body.currentPassword || !body.newPassword) return show('err', '請填寫所有欄位。 / Fill in every field.');
        if (body.newPassword !== body.confirmPassword) return show('err', '兩次輸入的新密碼不一致。 / The new passwords do not match.');
        if (body.newPassword === body.currentPassword) return show('err', '新密碼不能與目前密碼相同。 / The new password must differ from the current one.');
        if (minLength && body.newPassword.length < minLength) return show('err', '新密碼至少需要 ' + minLength + ' 個字元。 / The new password needs at least ' + minLength + ' characters.');

        $('submit').disabled = true;
        show('', '處理中… / Working…');
        fetch('api/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                show(res.ok ? 'ok' : 'err', res.message || (res.ok ? 'OK' : 'Error'));
                ['currentPassword', 'newPassword', 'confirmPassword'].forEach(function (id) { $(id).value = ''; });
            })
            .catch(function () { show('err', '無法連線，請稍後再試。 / The page could not be reached. Try again later.'); })
            .then(function () { $('submit').disabled = false; });
    });
}());
