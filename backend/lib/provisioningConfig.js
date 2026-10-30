// Shared Server Provision configuration parsing (BU list, software master lists, BU -> software mapping, detect rules).
// Used by routes/install.js (via lib/provisioning.js) AND routes/nutanix.js so both callers behave identically.
// Pure functions only (no I/O): the caller passes the settings object (readEnv()) and the environment.

function pick(config, env, key) {
    return (config && config[key]) || (env && env[key]) || '';
}

// Entry separators, in order of preference:
//   1. real newlines (each line is still scanned for the stored two-backslash separator, but not for the legacy one);
//   2. the sequence the Settings screen stores for a newline: backslash, backslash, n (three characters);
//   3. the legacy single backslash + n (hand-edited values only, not preceded by a backslash).
// Forms 2 and 3 are ambiguous with a UNC path (\\nas01\soft starts with backslash, backslash, n), so the scan is
// FIELD-AWARE (kind = 'windows': Name|Path|Args[|@detect:...], kind = 'linux': Name|Command[|@detect:...]):
// a backslash-backslash-n that starts the Path field of a Windows entry (right after the first `|`) is a UNC path;
// anywhere else (Args, detect rule, Linux command, after the last field) it is a separator.
// Once a stored (two-backslash) separator is present, a single backslash-n is part of a path (soft\notepad\setup.exe).
// Known limitation: a single-entry or hand-edited legacy value with a "\n" path part in an Args field stays ambiguous;
// GET /api/settings returns master lists with real newlines, so a value saved again through Settings is unambiguous.
function splitLines(str, kind = 'windows') {
    const s = String(str || '');
    let parts;
    if (/[\r\n]/.test(s)) {
        parts = s.split(/\r?\n/).flatMap(l => splitLinesScan(l, kind, false).parts);
    } else {
        const storedForm = splitLinesScan(s, kind, true).sawStoredSeparator;
        parts = splitLinesScan(s, kind, !storedForm).parts;
    }
    return parts.map(l => l.trim()).filter(l => l.includes('|'));
}

/** One left-to-right pass of splitLines; also reports whether a two-backslash (Settings) separator was seen. */
function splitLinesScan(s, kind, allowLegacy) {
    const parts = [];
    let sawStoredSeparator = false;
    let field = 0;
    let fieldStart = 0;
    let start = 0;
    let i = 0;
    // A legacy single backslash-n only counts as a separator once a whole entry's Path field is behind us
    // (Windows: in Args or later; Linux: in the Command): a backslash-n inside a Path (soft\new\a.exe) is a path part.
    const minLegacyField = kind === 'linux' ? 1 : 2;
    while (i < s.length) {
        const c = s[i];
        if (c === '|') { field++; fieldStart = i + 1; i++; continue; }
        if (c === '\\' && s[i + 1] === '\\' && s[i + 2] === 'n') {
            const uncPathStart = kind !== 'linux' && field === 1 && s.slice(fieldStart, i).trim() === '';
            if (uncPathStart) { i += 2; continue; }
            sawStoredSeparator = true;
            parts.push(s.slice(start, i));
            i += 3; start = i; field = 0; fieldStart = i;
            continue;
        }
        if (allowLegacy && field >= minLegacyField && c === '\\' && s[i + 1] === 'n' && (i === 0 || s[i - 1] !== '\\')) {
            parts.push(s.slice(start, i));
            i += 2; start = i; field = 0; fieldStart = i;
            continue;
        }
        i++;
    }
    parts.push(s.slice(start));
    return { parts, sawStoredSeparator };
}

/** A master list value as real newlines, one entry per line (used by GET /api/settings so the textarea is unambiguous). */
function decodeMasterList(str, kind = 'windows') {
    return splitLines(str, kind).join('\n');
}

function csv(str) {
    return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Detect rules ("skip when already installed")
//
// Syntax: an optional trailing segment `|@detect:<type>:<value>` at the END of a master list line. Lines without it are
// parsed exactly as before. The first `|@detect:` on a line starts the rule; everything after it belongs to the rule.
//   Windows: Name|NAS_Path|Args|@detect:reg:<DisplayName pattern>[>=<min DisplayVersion>]
//            Name|NAS_Path|Args|@detect:file:<absolute path on the guest>
//   Linux:   Name|Command|@detect:rpm:<package>      (rpm -q)
//            Name|Command|@detect:dpkg:<package>     (dpkg-query status)
//            Name|Command|@detect:cmd:<command>      (exit code 0 = installed)
// `reg` looks at the Uninstall keys under HKLM (64-bit and WOW6432Node) and matches DisplayName with PowerShell -like
// (case-insensitive, * and ? wildcards; write *Chrome* for a substring). Without a minimum, any match counts.
// ---------------------------------------------------------------------------------------------
const DETECT_RE = /^(.*?)\s*\|\s*@detect:(.*)$/s;
const MAX_DETECT_VALUE = 500;
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,127}$/;
const WINDOWS_DETECT_TYPES = ['reg', 'file'];
const LINUX_DETECT_TYPES = ['rpm', 'dpkg', 'cmd'];

/** Parses one rule text ("reg:Foo*>=1.2"). Returns { detect } or { error }. */
function parseDetect(text, os) {
    const raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw) return { error: 'Detect rule is empty' };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(raw)) return { error: 'Detect rule contains control characters' };
    const idx = raw.indexOf(':');
    const type = (idx < 0 ? raw : raw.slice(0, idx)).trim().toLowerCase();
    let value = idx < 0 ? '' : raw.slice(idx + 1).trim();
    const known = os === 'linux' ? LINUX_DETECT_TYPES : WINDOWS_DETECT_TYPES;
    if (!known.includes(type)) {
        const other = os === 'linux' ? WINDOWS_DETECT_TYPES : LINUX_DETECT_TYPES;
        if (other.includes(type)) return { error: `Detect type "${type}" is not valid for ${os === 'linux' ? 'Linux' : 'Windows'} packages (use ${known.join(', ')})` };
        return { error: `Unknown detect type "${type.slice(0, 20)}" (use ${known.join(', ')})` };
    }
    let minVersion = '';
    if (type === 'reg') {
        const m = /^(.*?)\s*>=\s*(.*)$/s.exec(value);
        if (m) {
            value = m[1].trim();
            minVersion = m[2].trim();
            if (!VERSION_RE.test(minVersion)) return { error: `Invalid minimum version "${minVersion.slice(0, 30)}" (use dotted numbers such as 1.2.3)` };
        }
    } else if (type !== 'cmd' && value.includes('>=')) {
        return { error: `A minimum version (>=) is only supported for reg rules` };
    }
    if (!value) return { error: `Detect rule "${type}" has an empty value` };
    if (value.length > MAX_DETECT_VALUE) return { error: `Detect value is longer than ${MAX_DETECT_VALUE} characters` };
    if ((type === 'rpm' || type === 'dpkg') && !PKG_NAME_RE.test(value)) return { error: `Invalid package name "${value.slice(0, 40)}" for ${type}` };
    if (type === 'file' && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\')) return { error: 'file rules need an absolute path (for example C:\\Program Files\\App\\app.exe)' };
    return { detect: { type, value, minVersion } };
}

/** Splits an optional trailing detect rule from a line: { body, detectText } (detectText undefined when absent). */
function splitDetect(line) {
    const m = DETECT_RE.exec(line);
    if (!m) return { body: line, detectText: undefined };
    return { body: m[1], detectText: m[2] };
}

function withDetect(entry, detectText, os) {
    if (detectText === undefined) return entry;
    const r = parseDetect(detectText, os);
    return r.error ? { ...entry, detectError: r.error } : { ...entry, detect: r.detect };
}

function parseMasterList(str) {
    return splitLines(str).map(l => {
        const { body, detectText } = splitDetect(l);
        const [name, path, args] = body.split('|');
        return withDetect({ name: name.trim(), path: (path || '').trim(), args: (args || '').trim() }, detectText, 'windows');
    });
}

function parseLinuxMasterList(str) {
    return splitLines(str, 'linux').map(l => {
        const { body, detectText } = splitDetect(l);
        const idx = body.indexOf('|');
        const entry = idx < 0
            ? { name: body.trim(), command: '' }
            : { name: body.slice(0, idx).trim(), command: body.slice(idx + 1).trim() };
        return withDetect(entry, detectText, 'linux');
    });
}

/** Entries of a parsed master list whose detect rule is invalid: [{ name, error }]. */
function detectErrors(list) {
    return (list || []).filter(s => s.detectError).map(s => ({ name: s.name, error: s.detectError }));
}

/** Validates the raw text of a master list setting (used when saving settings): array of "<name>: <error>". */
function validateMasterListText(text, os) {
    const list = os === 'linux' ? parseLinuxMasterList(text) : parseMasterList(text);
    const errors = detectErrors(list).map(e => `${e.name}: ${e.error}`);
    const raw = String(text || '');
    const hasReal = /[\r\n]/.test(raw);
    const label = (l) => l.split('|')[0].trim().slice(0, 40);
    if (os === 'linux') {
        // After removing the stored separators, a backslash-n left inside an entry would be read as a separator once saved
        const lines = raw.split(/\r?\n/).flatMap(l => l.split('\\\\n'));
        for (const l of lines) {
            if (l.includes('|') && /\\n/.test(l)) errors.push(`${label(l)}: the command or rule contains a backslash-n sequence, which is the line separator in saved settings (use printf with an octal escape or a script file instead)`);
        }
    } else if (hasReal) {
        // Windows: a two-backslash-n is only allowed at the start of the Path field (UNC path); anywhere else it would split the entry
        for (const l of raw.split(/\r?\n/)) {
            if (!l.includes('|')) continue;
            let field = 0;
            let fieldStart = 0;
            for (let i = 0; i < l.length; i++) {
                if (l[i] === '|') { field++; fieldStart = i + 1; continue; }
                if (l[i] === '\\' && l[i + 1] === '\\' && l[i + 2] === 'n') {
                    if (field === 1 && l.slice(fieldStart, i).trim() === '') { i += 1; continue; }
                    errors.push(`${label(l)}: a UNC path (backslash-backslash-n...) is only allowed at the start of the Path field; it would split the entry here`);
                    break;
                }
            }
        }
    }
    return errors;
}

/** Reads the provisioning configuration (settings file first, then process env). */
function loadInstallConfig(config, env = process.env) {
    const masterList = parseMasterList(pick(config, env, 'REMOTE_INSTALL_SOFTWARE_MASTER'));
    const linuxMasterList = parseLinuxMasterList(pick(config, env, 'REMOTE_INSTALL_LINUX_SOFTWARE_MASTER'));
    const bus = csv(pick(config, env, 'REMOTE_INSTALL_BUS'));
    const mapping = {};
    const linuxMapping = {};
    bus.forEach(bu => {
        const safe = bu.replace(/-/g, '_');
        mapping[bu] = csv(pick(config, env, `REMOTE_INSTALL_SOFTWARE_${safe}`));
        linuxMapping[bu] = csv(pick(config, env, `REMOTE_INSTALL_LINUX_SOFTWARE_${safe}`));
    });
    return { masterList, linuxMasterList, bus, mapping, linuxMapping, raw: { config, env } };
}

/** Names selected for a template (BU); an empty template falls back to Basic (as before). */
function selectedNamesFor(cfg, buType, os) {
    const prefix = os === 'linux' ? 'REMOTE_INSTALL_LINUX_SOFTWARE_' : 'REMOTE_INSTALL_SOFTWARE_';
    const { config, env } = cfg.raw;
    const read = (bu) => csv(pick(config, env, `${prefix}${bu.replace(/-/g, '_')}`));
    let names = read(buType);
    if (names.length === 0 && buType !== 'Basic') names = read('Basic');
    return names;
}

function resolveSoftware(cfg, buType, os) {
    const names = selectedNamesFor(cfg, buType, os);
    const master = os === 'linux' ? cfg.linuxMasterList : cfg.masterList;
    return master.filter(sw => names.includes(sw.name));
}

/** The NAS software share (SYSNAS_SOFTWARE_PATH), settings file first, then environment. */
function nasPathFor(config, env = process.env) {
    return pick(config, env, 'SYSNAS_SOFTWARE_PATH');
}

/**
 * The Windows part of the Nutanix clone parameter file: { nasPath, masterList: [{ name, path, args }], buSoftwareMapping }.
 * Only the fields the Nutanix scripts know (no detect rules) so that script input stays unchanged.
 */
function nutanixRemoteInstallConfig(config, env = process.env) {
    const cfg = loadInstallConfig(config, env);
    return {
        nasPath: nasPathFor(config, env),
        masterList: cfg.masterList.map(({ name, path, args }) => ({ name, path, args })),
        buSoftwareMapping: cfg.mapping
    };
}

module.exports = {
    pick, splitLines, csv, parseDetect, parseMasterList, parseLinuxMasterList, detectErrors, validateMasterListText, decodeMasterList,
    loadInstallConfig, selectedNamesFor, resolveSoftware, nasPathFor, nutanixRemoteInstallConfig,
    WINDOWS_DETECT_TYPES, LINUX_DETECT_TYPES
};
