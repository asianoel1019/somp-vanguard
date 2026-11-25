// Data layer of the license issuer, used by the web app (license-issuer/src) and the CLI (scripts/license_issue.js):
//   const S = require('<repo>/license-issuer/src/store');
//   const store = S.openStore(dbFile, { registryFile });  store.importRegistryIfNeeded();  ...  store.close();
// The database (license-issuer.db, next to the private key by default) is the source of truth; issued-licenses.md is
// regenerated from it after every change. Needs Node.js 22.13 or later (node:sqlite), loaded only when a store is opened.
const path = require('path');
const { openStore, Store, SCHEMA_VERSION } = require('./store');
const { issueLicense, replaceLicense } = require('./issue');
const rules = require('./rules');
const registry = require('./registry');
const reports = require('./reports');
const { MIN_NODE } = require('./sqlite');

const DB_NAME = 'license-issuer.db';

/** The default database file: license-issuer.db next to the private key. */
const defaultDbFile = (keyFile) => path.join(path.dirname(path.resolve(keyFile)), DB_NAME);

module.exports = {
    openStore, Store, SCHEMA_VERSION, MIN_NODE, DB_NAME, defaultDbFile,
    issueLicense, replaceLicense,
    rules, StoreError: rules.StoreError, computeStatus: rules.computeStatus, periodRange: rules.periodRange, isoWeek: rules.isoWeek,
    digestDue: rules.digestDue, slugify: rules.slugify,
    REGISTRY_MARKER: registry.MARKER, isGeneratedRegistry: registry.isGenerated, renderRegistry: registry.renderRegistry,
    reportRange: reports.range,
};
