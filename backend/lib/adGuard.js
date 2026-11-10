// Which user accounts AD Control may change (enable, disable, unlock, reset password, grant).
// - Never: protected accounts (adminCount = 1: members, or former members, of Domain Admins and the other
//   AdminSDHolder-protected groups), krbtgt, and the AD service account Vanguard runs as.
// - Only inside the managed OUs: AD_MANAGE_OUS (DNs separated by ";"). When it is not set, the OUs configured for
//   AD Control (every AD_OU_* value, AD_OU_SEARCH included) are the managed OUs; with none of those either, the
//   whole domain is (still without the protected accounts).
// The check runs on the domain controller right before the change, against the account's current DN and adminCount.
const { psLit, serviceAccount } = require('./adService');
const { isBrowsableDn, dnParts } = require('./adModel');

const PROTECTED_PREFIX = 'PROTECTED_ACCOUNT:';
const SCOPE_PREFIX = 'OUTSIDE_MANAGED_OUS:';

class GuardConfigError extends Error {
    constructor(message) { super(message); this.status = 503; this.userSafe = true; }
}

/** Split at ';' that are not escaped ("\;" stays inside a DN). */
function splitDns(value) {
    const out = [];
    let cur = '';
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
        if (s[i] === ';') { out.push(cur); cur = ''; continue; }
        cur += s[i];
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
}

/**
 * The managed OUs: { dns: [...], source: 'AD_MANAGE_OUS' | 'AD_OU_*' | 'domain' }.
 * Throws a readable error when AD_MANAGE_OUS holds something that is not an OU / container DN.
 */
function managedOus(env = process.env) {
    if (String(env.AD_MANAGE_OUS || '').trim()) {
        const dns = splitDns(env.AD_MANAGE_OUS);
        const bad = dns.filter(d => !isBrowsableDn(d));
        if (bad.length) throw new GuardConfigError(`AD_MANAGE_OUS has an entry that is not an OU distinguished name: ${bad[0].slice(0, 120)}`);
        return { dns, source: 'AD_MANAGE_OUS' };
    }
    const dns = Object.keys(env).filter(k => k.startsWith('AD_OU_')).sort()
        .map(k => String(env[k] || '').trim()).filter(d => d && isBrowsableDn(d));
    return dns.length ? { dns: [...new Set(dns)], source: 'AD_OU_*' } : { dns: [], source: 'domain' };
}

/**
 * PowerShell defining Get-ManagedUser: reads the account fresh and throws when AD Control may not change it.
 * Use the returned object as -Identity, so the change hits exactly the account that was checked.
 */
function guardScript() {
    const { dns } = managedOus();
    const svc = serviceAccount().username;
    return `
$guardScopes = @(${dns.map(psLit).join(', ')})
$guardService = ${psLit(svc)}
function Get-ManagedUser([string]$sam) {
    $u = Get-ADUser -Identity $sam -Properties adminCount -Credential $global:AD_CRED @dcArgs
    if ($u.adminCount -eq 1 -or $u.SamAccountName -eq 'krbtgt' -or $u.SamAccountName -eq $guardService) {
        throw "${PROTECTED_PREFIX} $($u.SamAccountName) is a protected account (administrators, krbtgt or the service account) and cannot be changed here"
    }
    if ($guardScopes.Count -gt 0) {
        $parts = @($u.DistinguishedName -split '(?<!\\\\),' | ForEach-Object { $_.Trim().ToLowerInvariant() })
        $inside = $false
        foreach ($scope in $guardScopes) {
            $s = @($scope -split '(?<!\\\\),' | ForEach-Object { $_.Trim().ToLowerInvariant() })
            if ($s.Count -le $parts.Count) {
                $tail = $parts[($parts.Count - $s.Count)..($parts.Count - 1)]
                if ((Compare-Object -ReferenceObject $s -DifferenceObject $tail -SyncWindow 0) -eq $null) { $inside = $true; break }
            }
        }
        if (-not $inside) { throw "${SCOPE_PREFIX} $($u.SamAccountName) is outside the OUs AD Control manages" }
    }
    return $u
}
`;
}

/** A guard refusal as { status: 403, error } (null for any other failure). */
function guardRefusal(text) {
    const s = String(text || '');
    for (const prefix of [PROTECTED_PREFIX, SCOPE_PREFIX]) {
        const i = s.indexOf(prefix);
        if (i >= 0) return { status: 403, error: s.slice(i + prefix.length).split(/\r?\n/)[0].trim() };
    }
    return null;
}

module.exports = { managedOus, splitDns, guardScript, guardRefusal, PROTECTED_PREFIX, SCOPE_PREFIX };
