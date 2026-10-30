require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const cfgMod = require('../../lib/provisioningConfig');

// ---------------------------------------------------------------------------------------------
// Reference copies of the parsing that routes/nutanix.js used BEFORE it was switched to the shared module
// (kept verbatim as the characterization baseline).
// ---------------------------------------------------------------------------------------------
function legacyNutanixWindows(config, env) {
    const nasPath = config.SYSNAS_SOFTWARE_PATH || env.SYSNAS_SOFTWARE_PATH || '';
    const masterListStr = config.REMOTE_INSTALL_SOFTWARE_MASTER || env.REMOTE_INSTALL_SOFTWARE_MASTER || '';
    const masterList = masterListStr.split(/\\n|\n/)
        .map(l => l.trim())
        .filter(l => l.includes('|'))
        .map(l => {
            const [name, path, args] = l.split('|');
            return { name: name.trim(), path: path.trim(), args: (args || '').trim() };
        });
    const buStr = config.REMOTE_INSTALL_BUS || env.REMOTE_INSTALL_BUS || '';
    const busList = buStr.split(',').map(s => s.trim()).filter(s => s);
    const buSoftwareMapping = {};
    busList.forEach(bu => {
        const buSafe = bu.replace(/-/g, '_');
        const key = `REMOTE_INSTALL_SOFTWARE_${buSafe}`;
        const mappingVal = config[key] || env[key] || '';
        buSoftwareMapping[bu] = mappingVal.split(',').map(s => s.trim()).filter(s => s);
    });
    return { nasPath, masterList, buSoftwareMapping };
}

function legacyNutanixLinux(config, env, vmBU) {
    const linuxListStr = config.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER || env.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER || '';
    const linuxMasterList = linuxListStr.split(/\\n|\n/)
        .map(l => l.trim())
        .filter(l => l.includes('|'))
        .map(l => {
            const [name, command] = l.split('|');
            return { name: name.trim(), command: command.trim() };
        });
    const buSafe = vmBU.replace(/-/g, '_');
    let selectedNames = (config[`REMOTE_INSTALL_LINUX_SOFTWARE_${buSafe}`] || env[`REMOTE_INSTALL_LINUX_SOFTWARE_${buSafe}`] || '').split(',').map(s => s.trim()).filter(s => s);
    if (selectedNames.length === 0 && buSafe !== 'Basic') {
        selectedNames = (config['REMOTE_INSTALL_LINUX_SOFTWARE_Basic'] || env['REMOTE_INSTALL_LINUX_SOFTWARE_Basic'] || '').split(',').map(s => s.trim()).filter(s => s);
    }
    return { selectedNames, selectedSoftware: linuxMasterList.filter(sw => selectedNames.includes(sw.name)) };
}

const FIXTURES = [
    {
        name: 'real newlines, CRLF, spaces and BU mapping with hyphen',
        config: {
            SYSNAS_SOFTWARE_PATH: '\\\\srv\\share',
            REMOTE_INSTALL_BUS: ' BU-A , BU-B ,, Basic',
            REMOTE_INSTALL_SOFTWARE_MASTER: ' 7zip | \\\\srv\\share\\7z.exe | /S \r\nTool|tools\\setup.bat|-q\r\nNoArgs|a\\b.exe|\nnot a line\nOnlyName|path',
            REMOTE_INSTALL_SOFTWARE_BU_A: '7zip, Tool',
            REMOTE_INSTALL_SOFTWARE_Basic: '7zip',
            REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a\r\npkgB|yum install -y b\nbad line',
            REMOTE_INSTALL_LINUX_SOFTWARE_BU_A: 'pkgA',
            REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA,pkgB'
        },
        env: {}
    },
    {
        name: 'values only in the process environment, legacy literal backslash-n separator',
        config: {},
        env: {
            SYSNAS_SOFTWARE_PATH: 'D:\\soft',
            REMOTE_INSTALL_BUS: 'X',
            REMOTE_INSTALL_SOFTWARE_MASTER: 'A|a.exe|-q\\nB|b.exe|/S',
            REMOTE_INSTALL_SOFTWARE_X: 'A,B',
            REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'L1|echo 1\\nL2|echo 2',
            REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'L1,L2'
        }
    },
    { name: 'nothing configured', config: {}, env: {} },
    { name: 'settings file wins over environment', config: { REMOTE_INSTALL_BUS: 'A', REMOTE_INSTALL_SOFTWARE_MASTER: 'S|s.exe|' }, env: { REMOTE_INSTALL_BUS: 'B', REMOTE_INSTALL_SOFTWARE_MASTER: 'T|t.exe|' } }
];

for (const fx of FIXTURES) {
    test(`characterization (Windows / Nutanix): shared module equals the old inline parsing - ${fx.name}`, () => {
        const old = legacyNutanixWindows(fx.config, fx.env);
        const cfg = cfgMod.loadInstallConfig(fx.config, fx.env);
        const shared = cfgMod.nutanixRemoteInstallConfig(fx.config, fx.env);
        assert.deepEqual(shared, old);
        // The provisioning caller sees the same list, plus the optional detect field only when present
        assert.deepEqual(cfg.masterList.map(({ name, path, args }) => ({ name, path, args })), old.masterList);
        assert.deepEqual(cfg.mapping, old.buSoftwareMapping);
    });

    test(`characterization (Linux / Nutanix): same selection for every BU - ${fx.name}`, () => {
        const cfg = cfgMod.loadInstallConfig(fx.config, fx.env);
        for (const bu of ['Basic', 'BU-A', 'BU-B', 'X', 'Unknown']) {
            const old = legacyNutanixLinux(fx.config, fx.env, bu);
            assert.deepEqual(cfgMod.selectedNamesFor(cfg, bu, 'linux'), old.selectedNames, `names for ${bu}`);
            assert.deepEqual(cfgMod.resolveSoftware(cfg, bu, 'linux').map(({ name, command }) => ({ name, command })), old.selectedSoftware, `software for ${bu}`);
        }
    });
}

test('intended difference: a Linux command containing a pipe is kept whole (the old Nutanix parsing cut it at the second pipe)', () => {
    const config = { REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'P|curl -s http://x/a.sh | sh -s -- -q' };
    const old = legacyNutanixLinux({ ...config, REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'P' }, {}, 'Basic');
    assert.equal(old.selectedSoftware[0].command, 'curl -s http://x/a.sh');
    const cfg = cfgMod.loadInstallConfig(config, {});
    assert.equal(cfg.linuxMasterList[0].command, 'curl -s http://x/a.sh | sh -s -- -q');
});

test('intended difference: with real newlines a literal backslash-n inside a path is not a separator', () => {
    const cfg = cfgMod.loadInstallConfig({ REMOTE_INSTALL_SOFTWARE_MASTER: 'A|D:\\new\\a.exe|-q\nB|\\\\srv\\share\\notepad++\\npp.exe|' }, {});
    assert.deepEqual(cfg.masterList.map(s => s.path), ['D:\\new\\a.exe', '\\\\srv\\share\\notepad++\\npp.exe']);
});

test('legacy literal backslash-n separator keeps working and never cuts a UNC path', () => {
    assert.deepEqual(cfgMod.splitLines('A|\\\\nas01\\soft\\a.exe|\\nB|b'), ['A|\\\\nas01\\soft\\a.exe|', 'B|b']);
});

test('provisioning.js re-exports the shared parsing (one implementation)', () => {
    const prov = require('../../lib/provisioning');
    assert.equal(prov.loadInstallConfig, cfgMod.loadInstallConfig);
    assert.equal(prov.resolveSoftware, cfgMod.resolveSoftware);
    assert.equal(prov.splitLines, cfgMod.splitLines);
    assert.equal(prov.parseMasterList, cfgMod.parseMasterList);
});

test('routes/nutanix.js no longer carries its own copy of the parsing', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'routes', 'nutanix.js'), 'utf8');
    assert.ok(!/split\(\/\\\\n\|\\n\/\)/.test(src), 'no inline master list split');
    assert.match(src, /provisioningConfig/);
});

// ---------------------------------------------------------------------------------------------
// detect rules
// ---------------------------------------------------------------------------------------------
test('detect syntax: a trailing |@detect:<rule> is optional and does not disturb the old format', () => {
    const cfg = cfgMod.loadInstallConfig({
        REMOTE_INSTALL_SOFTWARE_MASTER: [
            'Chrome|chrome\\setup.msi|/qn|@detect:reg:Google Chrome>=120.0',
            'NoArgs|tools\\a.exe||@detect:file:C:\\Program Files\\A\\a.exe',
            'ThreeField|tools\\b.exe|@detect:reg:B*',
            'Plain|tools\\c.exe|-q'
        ].join('\n'),
        REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: [
            'agent|yum install -y agent|@detect:rpm:agent',
            'curl|curl -s http://x | sh|@detect:cmd:test -x /opt/x/bin/x && /opt/x/bin/x --v | grep 1',
            'old|yum install -y old'
        ].join('\n')
    }, {});
    const [chrome, noArgs, three, plain] = cfg.masterList;
    assert.deepEqual({ name: chrome.name, path: chrome.path, args: chrome.args }, { name: 'Chrome', path: 'chrome\\setup.msi', args: '/qn' });
    assert.deepEqual(chrome.detect, { type: 'reg', value: 'Google Chrome', minVersion: '120.0' });
    assert.deepEqual(noArgs.detect, { type: 'file', value: 'C:\\Program Files\\A\\a.exe', minVersion: '' });
    assert.equal(noArgs.args, '');
    assert.deepEqual(three.detect, { type: 'reg', value: 'B*', minVersion: '' });
    assert.equal(three.args, '');
    assert.equal(plain.detect, undefined);
    assert.equal(plain.detectError, undefined);
    const [agent, curl, old] = cfg.linuxMasterList;
    assert.equal(agent.command, 'yum install -y agent');
    assert.deepEqual(agent.detect, { type: 'rpm', value: 'agent', minVersion: '' });
    assert.equal(curl.command, 'curl -s http://x | sh');
    assert.deepEqual(curl.detect, { type: 'cmd', value: 'test -x /opt/x/bin/x && /opt/x/bin/x --v | grep 1', minVersion: '' });
    assert.equal(old.detect, undefined);
});

test('detect validation: unknown type, empty value, bad version, wrong OS, hostile package names and control characters are errors', () => {
    const d = cfgMod.parseDetect;
    assert.deepEqual(d('reg:Foo*', 'windows'), { detect: { type: 'reg', value: 'Foo*', minVersion: '' } });
    assert.match(d('rpm:x', 'windows').error, /not valid for Windows/);
    assert.match(d('reg:x', 'linux').error, /not valid for Linux/);
    assert.match(d('magic:x', 'windows').error, /Unknown detect type/);
    assert.match(d('reg:', 'windows').error, /empty/i);
    assert.match(d('reg:Foo>=abc', 'windows').error, /version/i);
    assert.match(d('file:C:\\a.exe>=1.0', 'windows').error, /minimum version/i);
    assert.match(d('rpm:a b', 'linux').error, /package name/i);
    assert.match(d('dpkg:$(id)', 'linux').error, /package name/i);
    assert.match(d('rpm:agent>=1.0', 'linux').error, /minimum version/i);
    assert.match(d('cmd:true\u0001', 'linux').error, /control/i);
    assert.match(d('', 'linux').error, /empty/i);
    assert.deepEqual(d('dpkg:openssh-server', 'linux').detect, { type: 'dpkg', value: 'openssh-server', minVersion: '' });
});

test('an invalid detect rule is reported as detectError on the entry and never throws', () => {
    const cfg = cfgMod.loadInstallConfig({ REMOTE_INSTALL_SOFTWARE_MASTER: 'A|a.exe||@detect:bogus:x\nB|b.exe|' }, {});
    assert.match(cfg.masterList[0].detectError, /Unknown detect type/);
    assert.equal(cfg.masterList[0].detect, undefined);
    assert.equal(cfg.masterList[1].detectError, undefined);
    assert.deepEqual(cfgMod.detectErrors(cfg.masterList), [{ name: 'A', error: cfg.masterList[0].detectError }]);
});

test('validateMasterListText (used by the settings save) reports every invalid detect rule', () => {
    assert.deepEqual(cfgMod.validateMasterListText('A|a.exe||@detect:reg:A\nB|b.exe|', 'windows'), []);
    const errs = cfgMod.validateMasterListText('A|a.exe||@detect:nope:A\nB|b.exe||@detect:rpm:x', 'windows');
    assert.equal(errs.length, 2);
    assert.match(errs[0], /^A: /);
    assert.equal(cfgMod.validateMasterListText('x|y|@detect:rpm:ok', 'linux').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Field-aware splitting of the encoding the Settings screen stores (backslash, backslash, n for a newline)
// ---------------------------------------------------------------------------------------------
const ENC = (t) => t.replace(/\r?\n/g, '\\\\n');

test('field-aware split: stored three-character separators split Windows lists, a UNC path start stays whole', () => {
    const raw = 'A|\\\\nas01\\soft\\a.exe|/S\nB|b\\b.exe|\nC|c\\c.exe|-q||@detect:reg:C*\nD|\\\\n-srv\\x\\d.msi|/qn';
    const cfg = cfgMod.loadInstallConfig({ REMOTE_INSTALL_SOFTWARE_MASTER: ENC(raw) }, {});
    assert.deepEqual(cfg.masterList.map(x => [x.name, x.path, x.args]), [
        ['A', '\\\\nas01\\soft\\a.exe', '/S'], ['B', 'b\\b.exe', ''], ['C', 'c\\c.exe', '-q'], ['D', '\\\\n-srv\\x\\d.msi', '/qn']]);
    assert.equal(cfg.masterList[2].detect.value, 'C*');
});

test('field-aware split: a Linux cmd: detect rule never swallows the following lines', () => {
    const raw = 'L1|echo one|@detect:cmd:test -f /x\nL2|yum install -y foo\nL3|echo three|@detect:rpm:three';
    const cfg = cfgMod.loadInstallConfig({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: ENC(raw) }, {});
    assert.deepEqual(cfg.linuxMasterList.map(x => [x.name, x.command]), [['L1', 'echo one'], ['L2', 'yum install -y foo'], ['L3', 'echo three']]);
    assert.equal(cfg.linuxMasterList[0].detect.value, 'test -f /x');
    assert.equal(cfg.linuxMasterList[2].detect.value, 'three');
});

test('field-aware split: the same inputs through the Nutanix call sites equal the old Nutanix result minus its stray trailing backslash', () => {
    const win = 'A|\\\\nas01\\soft\\a.exe|/S\nB|b.exe|\nC|c.exe|-q';
    const lin = 'L1|echo one|@detect:cmd:test -f /x\nL2|yum install -y foo';
    const config = { REMOTE_INSTALL_BUS: 'X', REMOTE_INSTALL_SOFTWARE_MASTER: ENC(win), REMOTE_INSTALL_SOFTWARE_X: 'A,B,C', REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: ENC(lin), REMOTE_INSTALL_LINUX_SOFTWARE_X: 'L1,L2' };
    const shared = cfgMod.nutanixRemoteInstallConfig(config, {});
    const old = legacyNutanixWindows(config, {});
    // the old split cut the UNC path of A (names only compare after dropping its bogus entries)
    assert.deepEqual(shared.masterList.map(x => x.name), ['A', 'B', 'C']);
    assert.deepEqual(shared.masterList.map(x => x.args), ['/S', '', '-q']);
    assert.deepEqual(old.masterList.filter(x => ['B', 'C'].includes(x.name)).map(x => ({ ...x, args: x.args.replace(/\\$/, '') })), shared.masterList.filter(x => ['B', 'C'].includes(x.name)));
    assert.deepEqual(shared.buSoftwareMapping, old.buSoftwareMapping);
    const cfg = cfgMod.loadInstallConfig(config, {});
    const oldL = legacyNutanixLinux(config, {}, 'X');
    assert.deepEqual(cfgMod.selectedNamesFor(cfg, 'X', 'linux'), oldL.selectedNames);
    assert.equal(cfgMod.resolveSoftware(cfg, 'X', 'linux').length, 2);
    assert.equal(cfgMod.resolveSoftware(cfg, 'X', 'linux')[1].command, 'yum install -y foo');
});

test('save-time rule: a Linux command containing a backslash-n is rejected, Windows-style text is not', () => {
    assert.equal(cfgMod.validateMasterListText('L|printf "a\\nb"', 'linux').length, 1);
    assert.equal(cfgMod.validateMasterListText('L|echo ok|@detect:cmd:grep x\\ny', 'linux').length, 1);
    assert.equal(cfgMod.validateMasterListText('L|echo ok\nM|echo two', 'linux').length, 0);
});

// Settings-saved values (two-backslash separators): a single backslash-n inside a relative path is not a separator
const BS = String.fromCharCode(92);
const SEP = BS + BS + 'n';
const splitLinesFn = cfgMod.splitLines;
test('stored form keeps single-backslash n inside paths', () => {
    const v = ['A|soft' + BS + 'notepad' + BS + 'setup.exe|/S', 'B|' + BS + BS + 'nas01' + BS + 'x.msi|', 'C|c.exe|'].join(SEP);
    assert.deepEqual(splitLinesFn(v, 'windows'), ['A|soft' + BS + 'notepad' + BS + 'setup.exe|/S', 'B|' + BS + BS + 'nas01' + BS + 'x.msi|', 'C|c.exe|']);
});
test('legacy single form still splits when no stored separator', () => {
    const v = ['A|a.exe|', 'B|b.exe|'].join(BS + 'n');
    assert.deepEqual(splitLinesFn(v, 'windows'), ['A|a.exe|', 'B|b.exe|']);
});

test('mis-split 2: a "\\new\\" path part with empty args followed by a stored separator splits at the stored separator only', () => {
    const v = 'A|soft\\new\\a.exe|\\\\nB|D:\\b.exe|';
    assert.deepEqual(cfgMod.splitLines(v), ['A|soft\\new\\a.exe|', 'B|D:\\b.exe|']);
    assert.deepEqual(cfgMod.loadInstallConfig({ REMOTE_INSTALL_SOFTWARE_MASTER: v }, {}).masterList.map(x => [x.name, x.path]), [['A', 'soft\\new\\a.exe'], ['B', 'D:\\b.exe']]);
});

test('mis-split 1: a single UNC entry with a "\\notepad" path part is kept whole', () => {
    const v = 'N|\\\\nas\\soft\\notepad\\setup.exe|/S';
    assert.deepEqual(cfgMod.splitLines(v), [v]);
});

test('N1b: real newlines are split further at the stored separator (mixed text), the legacy form is not used there', () => {
    const v = 'A|a.exe|-q\\\\nB|b.exe|\nC|soft\\new\\c.exe|';
    assert.deepEqual(cfgMod.splitLines(v), ['A|a.exe|-q', 'B|b.exe|', 'C|soft\\new\\c.exe|']);
});

test('save-time rules: Linux entries are checked after removing stored separators; Windows allows a two-backslash-n only at the Path start', () => {
    assert.equal(cfgMod.validateMasterListText('L1|yum install a\\\\nL2|yum install b', 'linux').length, 0);
    assert.equal(cfgMod.validateMasterListText('L1|yum install a\\\\nL2|printf "a\\nb"', 'linux').length, 1);
    assert.equal(cfgMod.validateMasterListText('A|\\\\nas\\x\\a.exe|/S\nB|b.exe|/src=\\\\nas\\x', 'windows').length, 1);
    assert.equal(cfgMod.validateMasterListText('A|\\\\nas\\x\\a.exe|/S\nB|\\\\n-srv\\b.exe|', 'windows').length, 0);
    assert.match(cfgMod.validateMasterListText('A|a.exe|\nB|b.exe|@detect:file:\\\\nas\\x', 'windows').join(' '), /B: a UNC path/);
});

test('decodeMasterList: stored form and legacy form become one entry per real line', () => {
    assert.equal(cfgMod.decodeMasterList('A|\\\\nas01\\a.exe|/S\\\\nB|b.exe|', 'windows'), 'A|\\\\nas01\\a.exe|/S\nB|b.exe|');
    assert.equal(cfgMod.decodeMasterList('L1|echo 1\\\\nL2|echo 2', 'linux'), 'L1|echo 1\nL2|echo 2');
    assert.equal(cfgMod.decodeMasterList('', 'linux'), '');
});
