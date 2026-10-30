import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';

// Verbatim Parsers from backend/lib/netsearchParser.js adapted/mirrored for React client-side
let _idCounter = 0;
const genId = () => 'id_' + (++_idCounter) + '_' + Math.random().toString(36).slice(2, 8);

const isCIDR = s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(String(s));
const isExactIP = s => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(s)) && !isCIDR(s);
const isIPWithMask = s => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}_\d{1,2}$/.test(String(s));
const normalizeIP = s => String(s).replace(/_(\d{1,2})$/, '/$1');
const isIPish = s => /^\d[\d.]*$/.test(String(s)) && !isExactIP(s) && !isCIDR(s);

const parseValue = (str) => {
  const m = str.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  return m.map(s => s.replace(/['"]/g, '')).filter(s => s !== '[' && s !== ']');
};

// FortiGate Parser
const parseFortiGateConfig = (text) => {
  const lines = String(text).split('\n');
  const acc = { type: 'FortiGate', hostname: 'Unknown-FortiGate', tags: {}, addresses: {}, groups: {}, services: {}, serviceGroups: {}, urlCategories: {}, secRules: {}, natRules: {}, routes: {}, schedules: {}, vipMap: {}, vipgrpMap: {}, unparsed: [] };
  const parseFGTValue = (str) => (str.match(/"[^"]+"|'[^']+'|\S+/g) || []).map(s => s.replace(/['"]/g, ''));
  let cs = null, ce = null, co = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('config ')) { cs = line.substring(7).trim(); if (cs === 'system global') co = {}; continue; }
    if (line === 'end') { if (cs === 'system global' && co && co.hostname) acc.hostname = String(Array.isArray(co.hostname) ? co.hostname[0] : co.hostname); cs = null; continue; }
    if (line.startsWith('edit ')) { ce = line.substring(5).replace(/['"]/g, '').trim(); co = { name: ce }; continue; }
    if (line === 'next') {
      if (co && cs) {
        if (cs === 'firewall policy') {
          let rn = co.nameField || co.name;
          let rule = { name: String(rn), from: new Set(), to: new Set(), source: new Set(), destination: new Set(), application: new Set(), service: new Set(), category: new Set(), tag: new Set(), action: 'deny', disabled: false };
          if (co.srcintf) [].concat(co.srcintf).forEach(v => rule.from.add(v));
          if (co.dstintf) [].concat(co.dstintf).forEach(v => rule.to.add(v));
          if (co.srcaddr) [].concat(co.srcaddr).forEach(v => rule.source.add(v));
          if (co.dstaddr) [].concat(co.dstaddr).forEach(v => rule.destination.add(v));
          if (co.service) [].concat(co.service).forEach(v => rule.service.add(v));
          if (co.action) { const av = Array.isArray(co.action) ? co.action[0] : co.action; rule.action = (av === 'accept') ? 'allow' : 'deny'; }
          if (co.status) { const sv = Array.isArray(co.status) ? co.status[0] : co.status; rule.disabled = (sv === 'disable'); }
          if (co.comments) rule.name = String(co.comments);
          if (co.schedule) rule.schedule = co.schedule;
          acc.secRules[ce] = rule;
        } else if (cs === 'firewall address') {
          if (co.subnet) { const parts = parseFGTValue(co.subnet.join ? co.subnet.join(' ') : co.subnet); if (parts.length >= 2) { const ip = parts[0], mask = parts[1]; const bits = mask.split('.').reduce((a, o) => a + parseInt(o, 10).toString(2).split('').filter(b => b === '1').length, 0); acc.addresses[ce] = { type: 'ip-netmask', value: `${ip}/${bits}` }; } }
          if (co.fqdn) acc.addresses[ce] = { type: 'fqdn', value: String(Array.isArray(co.fqdn) ? co.fqdn[0] : co.fqdn) };
          if (co['start-ip'] && co['end-ip']) acc.addresses[ce] = { type: 'ip-range', value: `${co['start-ip']}-${co['end-ip']}` };
        } else if (cs === 'firewall addrgrp') {
          if (!acc.groups[ce]) acc.groups[ce] = new Set();
          if (co.member) [].concat(co.member).forEach(v => acc.groups[ce].add(v));
        } else if (cs === 'firewall service custom') {
          if (co['tcp-portrange']) acc.services[ce] = { protocol: 'tcp', port: String(co['tcp-portrange']) };
          else if (co['udp-portrange']) acc.services[ce] = { protocol: 'udp', port: String(co['udp-portrange']) };
        } else if (cs === 'firewall service group') {
          if (!acc.serviceGroups[ce]) acc.serviceGroups[ce] = new Set();
          if (co.member) [].concat(co.member).forEach(v => acc.serviceGroups[ce].add(v));
        } else if (cs === 'firewall central-snat-map' || cs === 'firewall central-dnat') {
          let rule = { name: String(co.name || ce), disabled: false, from: new Set(), to: new Set(), source: new Set(), destination: new Set(), service: new Set(), tag: new Set(), sourceTranslation: [], destinationTranslation: [] };
          if (co.srcintf) [].concat(co.srcintf).forEach(v => rule.from.add(v));
          if (co.dstintf) [].concat(co.dstintf).forEach(v => rule.to.add(v));
          if (co['orig-addr']) [].concat(co['orig-addr']).forEach(v => rule.source.add(v));
          if (co['dst-addr']) [].concat(co['dst-addr']).forEach(v => rule.destination.add(v));
          if (co['nat-ippool']) [].concat(co['nat-ippool']).forEach(v => rule.sourceTranslation.push(v));
          if (co['dst-addr-nated']) [].concat(co['dst-addr-nated']).forEach(v => rule.destinationTranslation.push(v));
          if (co.extip) [].concat(co.extip).forEach(v => rule.destinationTranslation.push(v));
          if (co.mappedip) [].concat(co.mappedip).forEach(v => rule.destinationTranslation.push(v));
          if (co.status) { const sv = Array.isArray(co.status) ? co.status[0] : co.status; rule.disabled = (sv === 'disable'); }
          acc.natRules[ce] = rule;
        } else if (cs === 'firewall vip') {
          const extip = co.extip ? (Array.isArray(co.extip) ? co.extip[0] : co.extip) : '';
          const mappedip = co.mappedip ? (Array.isArray(co.mappedip) ? co.mappedip[0] : co.mappedip) : '';
          const extintf = co.extintf ? String(Array.isArray(co.extintf) ? co.extintf[0] : co.extintf) : '';
          if (extip) acc.vipMap[ce] = { extip, mappedip, extintf };
          if (extip && mappedip) acc.addresses[ce] = { type: 'ip-netmask', value: extip, mappedip };
        } else if (cs === 'firewall vipgrp') {
          acc.vipgrpMap[ce] = { members: co.member ? [].concat(co.member) : [] };
        } else if (cs === 'router static') {
          acc.routes[ce] = { name: String(ce), destination: co.dst ? String(Array.isArray(co.dst) ? co.dst[0] : co.dst) : '', nexthop: co.gateway ? String(Array.isArray(co.gateway) ? co.gateway[0] : co.gateway) : '', interface: co.device ? String(Array.isArray(co.device) ? co.device[0] : co.device) : '' };
        } else if (cs === 'firewall schedule onetime') {
          if (co.start && co.end) { const sa = Array.isArray(co.start) ? co.start : [co.start]; const ea = Array.isArray(co.end) ? co.end : [co.end]; if (sa.length >= 2 && ea.length >= 2) acc.schedules[ce] = { name: ce, start: `${String(sa[1]).replace(/\//g, '-')}T${sa[0]}`, end: `${String(ea[1]).replace(/\//g, '-')}T${ea[0]}` }; }
        }
      }
      if (cs === 'system global' && co && co.hostname) acc.hostname = String(Array.isArray(co.hostname) ? co.hostname[0] : co.hostname);
      co = null; ce = null; continue;
    }
    if (co) {
      const m = line.match(/^set\s+(\S+)\s+(.*)/);
      if (m) { const k = m[1], vals = parseFGTValue(m[2]); co[k] = vals.length === 1 ? vals[0] : vals; }
    }
  }
  const toArr = s => s instanceof Set ? Array.from(s) : (Array.isArray(s) ? s : []);
  const groups = {}; Object.entries(acc.groups).forEach(([k, v]) => groups[k] = Array.from(v));
  const serviceGroups = {}; Object.entries(acc.serviceGroups).forEach(([k, v]) => serviceGroups[k] = Array.from(v));
  const resolveVip = (name, vipMap, vipgrpMap) => {
    if (vipgrpMap[name]) return vipgrpMap[name].members.flatMap(m => vipMap[m] ? [{ name: m, extip: vipMap[m].extip, mappedip: vipMap[m].mappedip }] : []);
    if (vipMap[name]) return [{ name, extip: vipMap[name].extip, mappedip: vipMap[name].mappedip }];
    return null;
  };
  const secRules = Object.values(acc.secRules).map(r => {
    const base = { name: String(r.name), disabled: r.disabled, action: r.action, from: toArr(r.from), to: toArr(r.to), source: toArr(r.source), destination: toArr(r.destination), application: toArr(r.application), service: toArr(r.service), category: toArr(r.category), tag: toArr(r.tag), schedule: r.schedule || null };
    const dstVips = toArr(r.destination).flatMap(a => { const v = resolveVip(a, acc.vipMap, acc.vipgrpMap); return v || []; });
    if (dstVips.length) base.dstVips = dstVips;
    return base;
  });
  secRules.forEach(r => { if (r.schedule && typeof r.schedule === 'string' && acc.schedules[r.schedule]) r.schedule = acc.schedules[r.schedule]; });
  const natRules = Object.values(acc.natRules).map(r => ({ name: String(r.name), disabled: !!r.disabled, from: toArr(r.from), to: toArr(r.to), source: toArr(r.source), destination: toArr(r.destination), service: toArr(r.service), tag: toArr(r.tag), sourceTranslation: Array.from(r.sourceTranslation || []), destinationTranslation: Array.from(r.destinationTranslation || []) }));
  const routesArr = Object.values(acc.routes).map(r => ({ name: String(r.name || ''), destination: r.destination ? String(r.destination) : '', nexthop: r.nexthop ? String(r.nexthop) : '', interface: r.interface ? String(r.interface) : '' }));
  return { ...acc, groups, serviceGroups, secRules, natRules, routes: routesArr };
};

// Palo Alto Parser
const parsePAConfig = (text) => {
  const lines = String(text).split('\n');
  const acc = { type: 'PA', hostname: 'Unknown-PA', tags: {}, addresses: {}, groups: {}, services: {}, serviceGroups: {}, urlCategories: {}, secRules: {}, natRules: {}, routes: {}, schedules: {}, unparsed: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith('set ')) { acc.unparsed.push(line); continue; }
    if (line.includes('deviceconfig system hostname ')) { const m = line.match(/deviceconfig system hostname\s+("[^"]+"|'[^']+'|\S+)/); if (m) acc.hostname = String(m[1]).replace(/['"]/g, ''); continue; }
    const tagM = line.match(/tag\s+("[^"]+"|'[^']+'|\S+)\s+color\s+(color\d+)/);
    if (tagM) { acc.tags[String(tagM[1]).replace(/['"]/g, '')] = String(tagM[2]); continue; }
    const addrM = line.match(/address\s+("[^"]+"|'[^']+'|\S+)\s+(ip-netmask|fqdn|ip-range)\s+(.+)$/);
    if (addrM) { acc.addresses[String(addrM[1]).replace(/['"]/g, '')] = { type: String(addrM[2]), value: String(addrM[3]).replace(/['"]/g, '').trim() }; continue; }
    const agP = line.split(/address-group\s+/);
    if (agP.length > 1) { const nm = agP[1].match(/^("[^"]+"|'[^']+'|\S+)\s+(.*)/); if (nm) { const name = String(nm[1]).replace(/['"]/g, ''); if (!acc.groups[name]) acc.groups[name] = new Set(); const tm = nm[2].match(/^(static|members)\s+(.*)/); if (tm) parseValue(tm[2]).forEach(v => acc.groups[name].add(v)); } continue; }
    const srvM = line.match(/service\s+("[^"]+"|'[^']+'|\S+)\s+protocol\s+(tcp|udp)\s+(?:source-port\s+\S+\s+)?port\s+(.+)$/i);
    if (srvM) { acc.services[String(srvM[1]).replace(/['"]/g, '')] = { protocol: String(srvM[2]).toLowerCase(), port: String(srvM[3]).replace(/['"]/g, '').trim() }; continue; }
    const sgP = line.split(/service-group\s+/);
    if (sgP.length > 1) { const nm = sgP[1].match(/^("[^"]+"|'[^']+'|\S+)\s+(.*)/); if (nm) { const name = String(nm[1]).replace(/['"]/g, ''); if (!acc.serviceGroups[name]) acc.serviceGroups[name] = new Set(); const tm = nm[2].match(/^(static|members)\s+(.*)/); if (tm) parseValue(tm[2]).forEach(v => acc.serviceGroups[name].add(v)); } continue; }
    const urlP = line.split(/custom-url-category\s+/);
    if (urlP.length > 1) { const nm = urlP[1].match(/^("[^"]+"|'[^']+'|\S+)\s+(.*)/); if (nm) { const name = String(nm[1]).replace(/['"]/g, ''); if (!acc.urlCategories[name]) acc.urlCategories[name] = new Set(); const tm = nm[2].match(/^(list|members)\s+(.*)/); if (tm) parseValue(tm[2]).forEach(v => acc.urlCategories[name].add(v)); } continue; }
    const secM = line.match(/rulebase security rules\s+("[^"]+"|'[^']+'|\S+)\s+(.*)/);
    if (secM) {
      const rn = String(secM[1]).replace(/['"]/g, ''); if (!acc.secRules[rn]) acc.secRules[rn] = { name: rn, from: new Set(), to: new Set(), source: new Set(), destination: new Set(), application: new Set(), service: new Set(), category: new Set(), tag: new Set(), action: 'allow', disabled: false }; const rest = secM[2];
      const fm = rest.match(/^from\s+(.*)/); if (fm) parseValue(fm[1]).forEach(v => acc.secRules[rn].from.add(v));
      const tm = rest.match(/^to\s+(.*)/); if (tm) parseValue(tm[1]).forEach(v => acc.secRules[rn].to.add(v));
      const sm = rest.match(/^source\s+(.*)/); if (sm) parseValue(sm[1]).forEach(v => acc.secRules[rn].source.add(v));
      const dm = rest.match(/^destination\s+(.*)/); if (dm) parseValue(dm[1]).forEach(v => acc.secRules[rn].destination.add(v));
      const am = rest.match(/^application\s+(.*)/); if (am) parseValue(am[1]).forEach(v => acc.secRules[rn].application.add(v));
      const svm = rest.match(/^service\s+(.*)/); if (svm) parseValue(svm[1]).forEach(v => acc.secRules[rn].service.add(v));
      const cm = rest.match(/^category\s+(.*)/); if (cm) parseValue(cm[1]).forEach(v => acc.secRules[rn].category.add(v));
      const tgm = rest.match(/^tag\s+(.*)/); if (tgm) parseValue(tgm[1]).forEach(v => acc.secRules[rn].tag.add(v));
      const acm = rest.match(/^action\s+(\S+)/); if (acm) acc.secRules[rn].action = String(acm[1]);
      if (rest.match(/^disabled\s+yes/)) acc.secRules[rn].disabled = true;
      const schm = rest.match(/^schedule\s+("[^"]+"|'[^']+'|\S+)/); if (schm) acc.secRules[rn].schedule = String(schm[1]).replace(/['"]/g, '');
      continue;
    }
    const natM = line.match(/rulebase nat rules\s+("[^"]+"|'[^']+'|\S+)\s+(.*)/);
    if (natM) {
      const rn = String(natM[1]).replace(/['"]/g, ''); if (!acc.natRules[rn]) acc.natRules[rn] = { name: rn, from: new Set(), to: new Set(), source: new Set(), destination: new Set(), service: new Set(), tag: new Set(), 'source-translation': new Set(), 'destination-translation': new Set(), disabled: false }; const rest = natM[2];
      const fm = rest.match(/^from\s+(.*)/); if (fm) parseValue(fm[1]).forEach(v => acc.natRules[rn].from.add(v));
      const tm = rest.match(/^to\s+(.*)/); if (tm) parseValue(tm[1]).forEach(v => acc.natRules[rn].to.add(v));
      const sm = rest.match(/^source\s+(.*)/); if (sm) parseValue(sm[1]).forEach(v => acc.natRules[rn].source.add(v));
      const dm = rest.match(/^destination\s+(.*)/); if (dm) parseValue(dm[1]).forEach(v => acc.natRules[rn].destination.add(v));
      const svm = rest.match(/^service\s+(.*)/); if (svm) parseValue(svm[1]).forEach(v => acc.natRules[rn].service.add(v));
      const tgm = rest.match(/^tag\s+(.*)/); if (tgm) parseValue(tgm[1]).forEach(v => acc.natRules[rn].tag.add(v));
      if (rest.includes('source-translation')) acc.natRules[rn]['source-translation'].add(rest.split(/\s+/).pop());
      if (rest.includes('destination-translation')) acc.natRules[rn]['destination-translation'].add(rest.split(/\s+/).pop());
      if (rest.match(/^disabled\s+yes/)) acc.natRules[rn].disabled = true;
      continue;
    }
    const schedM = line.match(/set schedule\s+("[^"]+"|'[^']+'|\S+)\s+schedule-type\s+non-recurring\s+(\d{4}\/\d{2}\/\d{2})@(\d{2}:\d{2})-(\d{4}\/\d{2}\/\d{2})@(\d{2}:\d{2})/);
    if (schedM) { const sn = String(schedM[1]).replace(/['"]/g, ''); acc.schedules[sn] = { name: sn, start: `${schedM[2].replace(/\//g, '-')}T${schedM[3]}`, end: `${schedM[4].replace(/\//g, '-')}T${schedM[5]}` }; continue; }
    const rtM = line.match(/virtual-router\s+\S+\s+routing-table\s+ip\s+static-route\s+("[^"]+"|'[^']+'|\S+)\s+(.*)/);
    if (rtM) {
      const rn = String(rtM[1]).replace(/['"]/g, ''); if (!acc.routes[rn]) acc.routes[rn] = { name: rn }; const rest = rtM[2];
      const dm = rest.match(/^destination\s+(\S+)/); if (dm) acc.routes[rn].destination = String(dm[1]);
      const nm = rest.match(/^nexthop\s+ip-address\s+(\S+)/); if (nm) acc.routes[rn].nexthop = String(nm[1]);
      const im = rest.match(/^interface\s+(\S+)/); if (im) acc.routes[rn].interface = String(im[1]);
      continue;
    }
  }
  const toArr = s => s instanceof Set ? Array.from(s) : (Array.isArray(s) ? s : []);
  const groups = {}; Object.entries(acc.groups).forEach(([k, v]) => groups[k] = Array.from(v));
  const serviceGroups = {}; Object.entries(acc.serviceGroups).forEach(([k, v]) => serviceGroups[k] = Array.from(v));
  const urlCategories = {}; Object.entries(acc.urlCategories).forEach(([k, v]) => urlCategories[k] = Array.from(v));
  const secRules = Object.values(acc.secRules).map(r => ({ name: String(r.name), disabled: !!r.disabled, action: r.action || 'allow', from: toArr(r.from), to: toArr(r.to), source: toArr(r.source), destination: toArr(r.destination), application: toArr(r.application), service: toArr(r.service), category: toArr(r.category), tag: Array.from(r.tag || []), schedule: r.schedule || null }));
  secRules.forEach(r => { if (r.schedule && typeof r.schedule === 'string' && acc.schedules[r.schedule]) r.schedule = acc.schedules[r.schedule]; });
  const natRules = Object.values(acc.natRules).map(r => ({ name: String(r.name), disabled: !!r.disabled, from: toArr(r.from), to: toArr(r.to), source: toArr(r.source), destination: toArr(r.destination), service: toArr(r.service), tag: Array.from(r.tag || []), sourceTranslation: Array.from(r['source-translation'] || []), destinationTranslation: Array.from(r['destination-translation'] || []) }));
  const routesArr = Object.values(acc.routes).map(r => ({ name: String(r.name || ''), destination: r.destination ? String(r.destination) : '', nexthop: r.nexthop ? String(r.nexthop) : '', interface: r.interface ? String(r.interface) : '' }));
  return { ...acc, groups, serviceGroups, urlCategories, secRules, natRules, routes: routesArr };
};

// Juniper SRX Parser
const parseSRXConfig = (text) => {
  const lines = String(text).split('\n');
  const acc = {
    type: 'SRX', hostname: 'Unknown-SRX',
    tags: {}, addresses: {}, groups: {}, services: {}, serviceGroups: {},
    urlCategories: {}, secRules: {}, natRules: {}, routes: {}, unparsed: [],
    _snatRuleSets: {}, _dnatRuleSets: {}, _sourcePools: {}, _destPools: {},
    _deactivatedSecRules: new Set(),
    _deactivatedSnatRules: new Set(),
    _deactivatedDnatRules: new Set(),
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\{[^}]*\}$/.test(line)) continue;
    if (line.startsWith('deactivate ')) {
      { const dm = line.match(/^deactivate security policies from-zone (\S+) to-zone (\S+) policy (\S+)$/);
        if (dm) { acc._deactivatedSecRules.add(`${dm[1]}::${dm[2]}::${dm[3]}`); continue; } }
      { const dm = line.match(/^deactivate security nat source rule-set (\S+) rule (\S+)$/);
        if (dm) { acc._deactivatedSnatRules.add(`${dm[1]}:${dm[2]}`); continue; } }
      { const dm = line.match(/^deactivate security nat destination rule-set (\S+) rule (\S+)$/);
        if (dm) { acc._deactivatedDnatRules.add(`${dm[1]}:${dm[2]}`); continue; } }
      acc.unparsed.push(line); continue;
    }
    if (!line.startsWith('set ')) { acc.unparsed.push(line); continue; }

    { const m2 = line.match(/^set groups node0 system host-name (\S+)$/);
      if (m2) { acc.hostname = m2[1].replace(/['"]/g, ''); acc._hostnameFromGroups = 2; continue; } }
    { const m2 = line.match(/^set groups \S+ system host-name (\S+)$/);
      if (m2 && (acc._hostnameFromGroups || 0) < 2) { acc.hostname = m2[1].replace(/['"]/g, ''); acc._hostnameFromGroups = 1; continue; } }
    if (!acc._hostnameFromGroups && line.startsWith('set system host-name ')) {
      acc.hostname = line.slice('set system host-name '.length).trim().replace(/['"]/g, '');
      continue;
    }

    let m;
    m = line.match(/^set (?:groups \S+ )?security zones security-zone \S+ address-book address (\S+) (\S+)$/);
    if (m) {
      const [, name, val] = m;
      if (!acc.addresses[name]) {
        const type = (isCIDR(val) || isExactIP(val)) ? 'ip-netmask' : 'fqdn';
        acc.addresses[name] = { type, value: val };
      }
      continue;
    }

    m = line.match(/^set (?:groups \S+ )?security zones security-zone \S+ address-book address-set (\S+) address (\S+)$/);
    if (m) {
      const [, name, member] = m;
      if (!acc.groups[name]) acc.groups[name] = new Set();
      acc.groups[name].add(member);
      continue;
    }

    m = line.match(/^set applications application (\S+) protocol (tcp|udp|icmp)$/i);
    if (m) {
      const [, name, proto] = m;
      if (!acc.services[name]) acc.services[name] = { protocol: proto.toLowerCase(), port: '' };
      else acc.services[name].protocol = proto.toLowerCase();
      continue;
    }
    m = line.match(/^set applications application (\S+) destination-port (\S+)$/);
    if (m) {
      const [, name, port] = m;
      if (!acc.services[name]) acc.services[name] = { protocol: 'tcp', port };
      else acc.services[name].port = port;
      continue;
    }
    m = line.match(/^set applications application-set (\S+) application (\S+)$/);
    if (m) {
      const [, name, app] = m;
      if (!acc.serviceGroups[name]) acc.serviceGroups[name] = new Set();
      acc.serviceGroups[name].add(app);
      continue;
    }

    m = line.match(/^set security policies from-zone (\S+) to-zone (\S+) policy (\S+) (.+)$/);
    if (m) {
      const [, fromZ, toZ, polName, rest] = m;
      const ruleKey = `${fromZ}::${toZ}::${polName}`;
      if (!acc.secRules[ruleKey]) {
        acc.secRules[ruleKey] = {
          name: polName, from: new Set([fromZ]), to: new Set([toZ]),
          source: new Set(), destination: new Set(),
          application: new Set(), service: new Set(),
          category: new Set(), tag: new Set(),
          action: 'allow', disabled: false,
        };
      }
      const r = acc.secRules[ruleKey];
      const srcM = rest.match(/^match source-address (\S+)$/); if (srcM) { r.source.add(srcM[1]); continue; }
      const dstM = rest.match(/^match destination-address (\S+)$/); if (dstM) { r.destination.add(dstM[1]); continue; }
      const appM = rest.match(/^match application (\S+)$/); if (appM) { r.application.add(appM[1]); r.service.add(appM[1]); continue; }
      if (rest === 'then permit') { r.action = 'allow'; continue; }
      if (rest === 'then deny' || rest === 'then reject') { r.action = 'deny'; continue; }
      if (rest.match(/^then inactive$/)) { r.disabled = true; continue; }
      continue;
    }

    m = line.match(/^set security nat source rule-set (\S+) from (?:zone|routing-instance) (\S+)$/);
    if (m) {
      const [, rs, from] = m;
      if (!acc._snatRuleSets[rs]) acc._snatRuleSets[rs] = { from: '', to: '', rules: {} };
      acc._snatRuleSets[rs].from = from; continue;
    }
    m = line.match(/^set security nat source rule-set (\S+) to (?:zone|routing-instance) (\S+)$/);
    if (m) {
      const [, rs, to] = m;
      if (!acc._snatRuleSets[rs]) acc._snatRuleSets[rs] = { from: '', to: '', rules: {} };
      acc._snatRuleSets[rs].to = to; continue;
    }
    m = line.match(/^set security nat source rule-set (\S+) rule (\S+) match source-address (\S+)$/);
    if (m) {
      const [, rs, rn, addr] = m;
      if (!acc._snatRuleSets[rs]) acc._snatRuleSets[rs] = { from: '', to: '', rules: {} };
      if (!acc._snatRuleSets[rs].rules[rn]) acc._snatRuleSets[rs].rules[rn] = { source: [], snat: [] };
      acc._snatRuleSets[rs].rules[rn].source.push(addr); continue;
    }
    m = line.match(/^set security nat source rule-set (\S+) rule (\S+) then source-nat (?:pool (\S+)|interface)$/);
    if (m) {
      const [, rs, rn, pool] = m;
      if (!acc._snatRuleSets[rs]) acc._snatRuleSets[rs] = { from: '', to: '', rules: {} };
      if (!acc._snatRuleSets[rs].rules[rn]) acc._snatRuleSets[rs].rules[rn] = { source: [], snat: [] };
      acc._snatRuleSets[rs].rules[rn].snat.push(pool || 'interface'); continue;
    }
    m = line.match(/^set security nat source pool (\S+) address (\S+)$/);
    if (m) {
      const [, pool, addr] = m;
      if (!acc._sourcePools[pool]) acc._sourcePools[pool] = [];
      acc._sourcePools[pool].push(addr); continue;
    }

    m = line.match(/^set security nat destination rule-set (\S+) from (?:zone|routing-instance) (\S+)$/);
    if (m) {
      const [, rs, from] = m;
      if (!acc._dnatRuleSets[rs]) acc._dnatRuleSets[rs] = { from: '', rules: {} };
      acc._dnatRuleSets[rs].from = from; continue;
    }
    m = line.match(/^set security nat destination rule-set (\S+) rule (\S+) match destination-address (\S+)$/);
    if (m) {
      const [, rs, rn, addr] = m;
      if (!acc._dnatRuleSets[rs]) acc._dnatRuleSets[rs] = { from: '', rules: {} };
      if (!acc._dnatRuleSets[rs].rules[rn]) acc._dnatRuleSets[rs].rules[rn] = { destination: [], dnat: [] };
      acc._dnatRuleSets[rs].rules[rn].destination.push(addr); continue;
    }
    m = line.match(/^set security nat destination rule-set (\S+) rule (\S+) then destination-nat pool (\S+)$/);
    if (m) {
      const [, rs, rn, pool] = m;
      if (!acc._dnatRuleSets[rs]) acc._dnatRuleSets[rs] = { from: '', rules: {} };
      if (!acc._dnatRuleSets[rs].rules[rn]) acc._dnatRuleSets[rs].rules[rn] = { destination: [], dnat: [] };
      acc._dnatRuleSets[rs].rules[rn].dnat.push(pool); continue;
    }
    m = line.match(/^set security nat destination pool (\S+) address (\S+)$/);
    if (m) {
      const [, pool, addr] = m;
      if (!acc._destPools[pool]) acc._destPools[pool] = [];
      acc._destPools[pool].push(addr); continue;
    }

    m = line.match(/^set routing-options static route (\S+) next-hop (\S+)$/);
    if (m) {
      const [, dest, nh] = m;
      acc.routes[dest] = { name: dest, destination: dest, nexthop: nh, interface: '' }; continue;
    }
    m = line.match(/^set routing-instances (\S+) routing-options static route (\S+) next-hop (\S+)$/);
    if (m) {
      const [, ri, dest, nh] = m;
      const key = `${ri}:${dest}`;
      acc.routes[key] = { name: `[${ri}] ${dest}`, destination: dest, nexthop: nh, interface: ri }; continue;
    }
  }

  Object.entries(acc._snatRuleSets).forEach(([rsName, rs]) => {
    Object.entries(rs.rules).forEach(([ruleName, rule]) => {
      const snatTargets = rule.snat.flatMap(s =>
        s === 'interface' ? ['interface (outgoing)'] : (acc._sourcePools[s] || [s])
      );
      acc.natRules[`snat:${rsName}:${ruleName}`] = {
        name: `${rsName} / ${ruleName}`,
        disabled: acc._deactivatedSnatRules.has(`${rsName}:${ruleName}`),
        from: rs.from ? [rs.from] : [], to: rs.to ? [rs.to] : [],
        source: rule.source, destination: [], service: [], tag: [],
        sourceTranslation: snatTargets, destinationTranslation: [],
      };
    });
  });

  Object.entries(acc._dnatRuleSets).forEach(([rsName, rs]) => {
    Object.entries(rs.rules).forEach(([ruleName, rule]) => {
      const dnatTargets = rule.dnat.flatMap(p => acc._destPools[p] || [p]);
      acc.natRules[`dnat:${rsName}:${ruleName}`] = {
        name: `${rsName} / ${ruleName}`,
        disabled: acc._deactivatedDnatRules.has(`${rsName}:${ruleName}`),
        from: rs.from ? [rs.from] : [], to: [],
        source: [], destination: rule.destination, service: [], tag: [],
        sourceTranslation: [], destinationTranslation: dnatTargets,
      };
    });
  });

  const toArr = s => s instanceof Set ? Array.from(s) : (Array.isArray(s) ? s : []);
  const groups = {}; Object.entries(acc.groups).forEach(([k, v]) => groups[k] = Array.from(v));
  const serviceGroups = {}; Object.entries(acc.serviceGroups).forEach(([k, v]) => serviceGroups[k] = Array.from(v));
  const secRules = Object.entries(acc.secRules).map(([key, r]) => ({
    name: String(r.name), disabled: !!r.disabled || acc._deactivatedSecRules.has(key), action: r.action || 'allow',
    from: toArr(r.from), to: toArr(r.to),
    source: toArr(r.source), destination: toArr(r.destination),
    application: toArr(r.application), service: toArr(r.service),
    category: [], tag: [],
  }));
  const natRules = Object.values(acc.natRules).map(r => ({
    name: String(r.name), disabled: !!r.disabled,
    from: r.from || [], to: r.to || [],
    source: r.source || [], destination: r.destination || [],
    service: [], tag: [],
    sourceTranslation: r.sourceTranslation || [],
    destinationTranslation: r.destinationTranslation || [],
  }));
  const routesArr = Object.values(acc.routes).map(r => ({
    name: String(r.name || ''), destination: String(r.destination || ''),
    nexthop: String(r.nexthop || ''), interface: String(r.interface || ''),
  }));
  return { ...acc, groups, serviceGroups, urlCategories: {}, secRules, natRules, routes: routesArr };
};

// F5 Parser
const parseF5Config = (text) => {
  const acc = { type: 'F5', hostname: 'Unknown-F5', virtuals: [], pools: [], addresses: {}, groups: {}, services: {}, serviceGroups: {}, secRules: [], natRules: [], routes: [], unparsed: [] };
  const st = String(text);
  const hnM = st.match(/sys global-settings\s*\{[^}]*hostname\s+([^\s;}]+)/);
  if (hnM) acc.hostname = String(hnM[1]);
  let pos = 0;
  while (pos < st.length) {
    const m = st.substring(pos).match(/^(ltm virtual|ltm pool)\s+([^\s{]+)?\s*\{/m);
    if (!m) break;
    const si = pos + m.index, type = m[1], name = m[2] || '';
    const bs = st.indexOf('{', si);
    let ob = 0, ei = bs;
    for (let i = bs; i < st.length; i++) { if (st[i] === '{') ob++; else if (st[i] === '}') { ob--; if (ob === 0) { ei = i; break; } } }
    const content = st.substring(bs + 1, ei), pn = String(name.split('/').pop());
    if (type === 'ltm virtual') {
      const destM = content.match(/destination\s+([^\s;}]+)/);
      const poolM = content.match(/pool\s+([^\s;}]+)/);
      const isDis = content.split('\n').some(l => l.trim() === 'disabled');
      let ip = '', port = '*';
      if (destM) { let d = destM[1].split('/').pop(); let sep = Math.max(d.lastIndexOf(':'), d.lastIndexOf('.')); if (sep > 0 && sep > d.indexOf('%')) { port = d.substring(sep + 1); ip = d.substring(0, sep); } else ip = d; ip = ip.split('%')[0]; if (port === 'any') port = '*'; }
      acc.virtuals.push({ name: pn, ip: String(ip), port: String(port), pool: poolM ? poolM[1].split('/').pop() : '', status: isDis ? 'disabled' : 'enabled' });
    } else if (type === 'ltm pool') {
      let members = [];
      const memM = content.match(/members\s*\{/);
      if (memM) {
        let ms = memM.index + memM[0].length, mo = 1, me = ms;
        while (me < content.length && mo > 0) { if (content[me] === '{') mo++; if (content[me] === '}') mo--; me++; }
        let memStr = content.substring(ms, me - 1);
        let re = /([^\s{]+)\s*\{([^}]*)\}/g, mm;
        while ((mm = re.exec(memStr)) !== null) {
          let mn = String(mm[1].split('/').pop()), mc = String(mm[2]), mi = mn, mp = '*';
          let sep = Math.max(mn.lastIndexOf(':'), mn.lastIndexOf('.'));
          if (sep > 0) { mp = mn.substring(sep + 1); mi = mn.substring(0, sep); }
          let am = mc.match(/address\s+([^\s;}]+)/); if (am) mi = String(am[1]);
          mi = mi.split('%')[0];
          let isDis = mc.includes('user-disabled') || mc.includes('user-down') || mc.match(/\bdisabled\b/) !== null;
          members.push({ ip: String(mi), port: String(mp), name: String(mn), status: isDis ? 'disabled' : 'enabled' });
        }
      }
      acc.pools.push({ name: pn, members });
    }
    pos = ei + 1;
  }
  return acc;
};

// FQDN Parser
function isValidGeoInfo(v) {
  if (!v || v === 'null') return false;
  if (v.length > 50) return false;
  if (/[=;@]/.test(v)) return false;
  if (/^\d+\.\d+\.\d+/.test(v)) return false;
  if (/^\d+\s/.test(v)) return false;
  if ((v.match(/\./g) || []).length >= 2) return false;
  return true;
}

const parseFqdnFile = (text) => {
  const lines = String(text).split('\n');
  const records = [];
  let headers = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const sep = line.includes('\t') ? '\t' : (line.includes(',') ? ',' : null);
    if (!sep) continue;
    const cols = line.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (!headers) {
      const lower = cols.map(c => c.toLowerCase());
      if (lower.some(c => c.includes('fqdn') || c.includes('domain') || c.includes('ip'))) {
        const fi = (fn) => lower.findIndex((c, i) => c !== '' && fn(c));
        headers = { fqdn: fi(c => c.includes('fqdn')), domain: fi(c => c.includes('domain')), ip: fi(c => c.includes('ip') && !c.includes('type')), owner: fi(c => c.includes('owner') || c.includes('bu')), type: fi(c => c.includes('type') || c.includes('record')), geo: fi(c => c.includes('geo') || c.includes('country')) };
        continue;
      }
      headers = { fqdn: 0, domain: -1, ip: cols.length > 1 ? 1 : -1, owner: -1, type: -1, geo: -1 };
    }
    const g = (idx) => idx >= 0 && idx < cols.length ? cols[idx] : '';
    const fqdn = g(headers.fqdn), domain = g(headers.domain), ip = g(headers.ip);
    if (!fqdn && !domain && (!ip || ip.toLowerCase() === 'null')) continue;
    const rawGeo = g(headers.geo);
    records.push({ id: genId(), owner: g(headers.owner), domain: domain, fqdn: fqdn, type: g(headers.type), ip: ip, geoInfo: isValidGeoInfo(rawGeo) ? rawGeo : '' });
  }
  return records;
};

const parseConfig = (text) => {
  const s = String(text);
  if (s.includes('sys global-settings') || s.includes('ltm virtual ') || s.includes('ltm pool ')) return parseF5Config(s);
  if (s.includes('config firewall policy') || s.includes('config system global')) return parseFortiGateConfig(s);
  if (s.includes('set security policies from-zone') || s.includes('set security nat source rule-set') || s.includes('set security zones security-zone')) return parseSRXConfig(s);
  return parsePAConfig(s);
};

// Network/IP Helper Utilities
const ipToNum = (ip) => {
  const p = String(ip).split('.');
  if (p.length !== 4) return NaN;
  for (const o of p) { const n = parseInt(o, 10); if (isNaN(n) || n < 0 || n > 255) return NaN; }
  return p.reduce((a, o) => ((a << 8) + parseInt(o, 10)) >>> 0, 0);
};

const ipInCIDR = (ip, cidr) => {
  try {
    const [net, bs] = String(cidr).split('/');
    const b = parseInt(bs, 10);
    if (isNaN(b) || b < 0 || b > 32) return false;
    const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
    const ipN = ipToNum(ip), netN = ipToNum(net);
    if (isNaN(ipN) || isNaN(netN)) return false;
    return (ipN & mask) === (netN & mask);
  } catch { return false; }
};

const cidrOverlaps = (c1, c2) => {
  try {
    const [n1, b1s] = String(c1).split('/'), [n2, b2s] = String(c2).split('/');
    const b1 = parseInt(b1s, 10), b2 = parseInt(b2s, 10);
    if (isNaN(b1) || isNaN(b2)) return false;
    const mb = Math.min(b1, b2), mask = mb === 0 ? 0 : (0xFFFFFFFF << (32 - mb)) >>> 0;
    const a = ipToNum(n1), b = ipToNum(n2);
    if (isNaN(a) || isNaN(b)) return false;
    return (a & mask) === (b & mask);
  } catch { return false; }
};

const smartSort = (a, b, key, dir) => {
  let vA = a[key] ?? '', vB = b[key] ?? '';
  if (key === 'ip') {
    const nA = ipToNum(String(vA).split('/')[0]), nB = ipToNum(String(vB).split('/')[0]);
    if (!isNaN(nA) && !isNaN(nB)) return dir === 'asc' ? nA - nB : nB - nA;
  }
  if (key === 'port') {
    const nA = parseInt(vA, 10), nB = parseInt(vB, 10);
    if (!isNaN(nA) && !isNaN(nB)) return dir === 'asc' ? nA - nB : nB - nA;
  }
  return dir === 'asc' ? String(vA).localeCompare(String(vB), undefined, { numeric: true, sensitivity: 'base' }) : String(vB).localeCompare(String(vA), undefined, { numeric: true, sensitivity: 'base' });
};

// AST Boolean Search Parser
const parseSearch = (query) => {
  if (!query || !String(query).trim()) return null;
  const sq = String(query).replace(/\(/g, ' ( ').replace(/\)/g, ' ) ');
  const raw = sq.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  let tokens = raw.map(t => String(t).trim()).filter(Boolean);
  const proc = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toUpperCase();
    proc.push(tokens[i]);
    if (i < tokens.length - 1) {
      const nx = tokens[i + 1].toUpperCase();
      const isCurVal = t !== 'AND' && t !== 'OR' && t !== 'NOT' && t !== '(';
      const isNxVal = nx !== 'AND' && nx !== 'OR' && nx !== ')';
      if ((isCurVal || t === ')') && (isNxVal || nx === 'NOT' || nx === '(')) proc.push('AND');
    }
  }
  tokens = proc;
  let pos = 0;
  function parseExpr() { let n = parseTerm(); while (pos < tokens.length && tokens[pos].toUpperCase() === 'OR') { pos++; n = { type: 'OR', left: n, right: parseTerm() }; } return n; }
  function parseTerm() { let n = parseFactor(); while (pos < tokens.length && tokens[pos].toUpperCase() === 'AND') { pos++; n = { type: 'AND', left: n, right: parseFactor() }; } return n; }
  function parseFactor() {
    if (pos >= tokens.length) return { type: 'LITERAL', value: '', isExact: false };
    const tk = tokens[pos];
    if (tk.toUpperCase() === 'NOT') { pos++; return { type: 'NOT', operand: parseFactor() }; }
    if (tk === '(') { pos++; let n = parseExpr(); if (pos < tokens.length && tokens[pos] === ')') pos++; return n; }
    pos++; let v = tk, ex = false;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) { v = v.slice(1, -1); ex = true; }
    return { type: 'LITERAL', value: v, isExact: ex };
  }
  try { const ast = parseExpr(); if (pos < tokens.length) return { type: 'LITERAL', value: String(query).trim(), isExact: false }; return ast; } catch { return { type: 'LITERAL', value: String(query).trim(), isExact: false }; }
};

const evaluateAST = (ast, matchFn) => {
  if (!ast) return true;
  if (ast.type === 'LITERAL') return matchFn(ast.value, ast.isExact);
  if (ast.type === 'NOT') return !evaluateAST(ast.operand, matchFn);
  if (ast.type === 'AND') return evaluateAST(ast.left, matchFn) && evaluateAST(ast.right, matchFn);
  if (ast.type === 'OR') return evaluateAST(ast.left, matchFn) || evaluateAST(ast.right, matchFn);
  return false;
};

const extractTerms = (ast) => {
  const terms = new Set();
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'LITERAL' && n.value) terms.add(String(n.value).trim());
    if (n.type === 'NOT') walk(n.operand);
    if (n.type === 'AND' || n.type === 'OR') { walk(n.left); walk(n.right); }
  };
  walk(ast);
  return Array.from(terms);
};

const extractPositiveTerms = (ast) => {
  const terms = new Set();
  const walk = (n, negated) => {
    if (!n) return;
    if (n.type === 'LITERAL' && n.value) { if (!negated) terms.add(String(n.value).trim()); return; }
    if (n.type === 'NOT') { walk(n.operand, true); return; }
    if (n.type === 'AND' || n.type === 'OR') { walk(n.left, negated); walk(n.right, negated); }
  };
  walk(ast, false);
  return Array.from(terms);
};

// Object/Service group resolution
const resolveObject = (name, addresses, groups, depth = 0) => {
  if (depth > 10) return [{ name: String(name), value: '…', type: 'max-depth' }];
  if (name === 'any' || name === 'all') return [{ name, value: '*', type: 'wildcard' }];
  const res = [];
  if (groups && groups[name]) {
    res.push({ name: String(name), type: 'group', value: '' });
    groups[name].forEach(m => res.push(...resolveObject(m, addresses, groups, depth + 1)));
  } else if (addresses && addresses[name]) {
    res.push({ name: String(name), ...addresses[name] });
  } else {
    res.push({ name: String(name), value: String(name), type: 'unknown' });
  }
  return res;
};

const resolveService = (name, services, serviceGroups, depth = 0) => {
  if (depth > 10) return [{ name: String(name), value: '…', type: 'max-depth' }];
  if (name === 'any' || name === 'all' || name === 'application-default') return [{ name, value: '*', type: 'wildcard' }];
  const res = [];
  if (serviceGroups && serviceGroups[name]) {
    res.push({ name: String(name), type: 'group', value: '' });
    serviceGroups[name].forEach(m => res.push(...resolveService(m, services, serviceGroups, depth + 1)));
  } else if (services && services[name]) {
    const s = services[name];
    res.push({ name: String(name), ...s, value: `${s.protocol}/${s.port}` });
  } else {
    res.push({ name: String(name), value: String(name), type: 'unknown' });
  }
  return res;
};

const matchObject = (name, value, search, isExact, ignoreCIDR = false) => {
  if (!search) return true;
  const isSM = isIPWithMask(search);
  const normalizedSearch = isSM ? normalizeIP(search) : search;
  const s = String(normalizedSearch).toLowerCase();
  const isSC = isCIDR(normalizedSearch), isSI = isExactIP(normalizedSearch);
  if (isExact) { if (name && String(name).toLowerCase() === s) return true; if (value && String(value).toLowerCase() === s) return true; }
  else { const isIPLike = isSI || isSC || isSM || /^\d[\d._/]*$/.test(String(search).toLowerCase()); if (!isIPLike && name && String(name).toLowerCase().includes(s)) return true; const isVI = value && (isExactIP(value) || isCIDR(value)); if (value && (!isVI || (!isSI && !isSC)) && String(value).toLowerCase().includes(s)) return true; }
  if (value) { const v = String(value); if (!ignoreCIDR) { if (isSC) { if (isCIDR(v)) return cidrOverlaps(search, v); if (isExactIP(v)) return ipInCIDR(v, search); } if (isSI) { if (isCIDR(v)) return ipInCIDR(search, v); if (isExactIP(v)) return search === v; } } else if (isSI) { if (v.split('/')[0] === s) return true; } else if (isSC) { if (v.split('/')[0] === s.split('/')[0]) return true; } }
  return false;
};

const _matchNameOnly = (name, s, groups, isExact, depth = 0) => {
  if (depth > 10) return false;
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (isExact ? n === s : n.includes(s)) return true;
  if (!groups || !groups[name]) return false;
  return groups[name].some(m => _matchNameOnly(m, s, groups, isExact, depth + 1));
};

const objectListMatchesSearch = (nameList, search, addresses, groups, searchMode, ignoreCIDR = false) => {
  if (!search) return true;
  if (!nameList || !Array.isArray(nameList)) return false;
  const isExact = searchMode === 'exact';
  const isIPSearch = isCIDR(search) || isExactIP(search) || isIPWithMask(search);
  if (!isIPSearch) return nameList.some(top => _matchNameOnly(top, String(search).toLowerCase(), groups, isExact));
  return nameList.some(top => resolveObject(top, addresses, groups).some(r => matchObject(r.name, r.value, search, isExact, ignoreCIDR)));
};

const serviceListMatchesSearch = (nameList, search, services, serviceGroups, searchMode) => {
  if (!search) return true;
  if (!nameList || !Array.isArray(nameList)) return false;
  const s = String(search).toLowerCase(), isExact = searchMode === 'exact';
  return nameList.some(top => resolveService(top, services, serviceGroups).some(r => {
    if (isExact) { return (r.name && String(r.name).toLowerCase() === s) || (r.value && String(r.value).toLowerCase() === s) || (r.port && String(r.port).toLowerCase() === s); }
    return (r.name && String(r.name).toLowerCase().includes(s)) || (r.value && String(r.value).toLowerCase().includes(s)) || (r.port && String(r.port).toLowerCase().includes(s));
  }));
};

const objectListMatchesFqdnIp = (nameList, fqdnIp, addresses, groups, ignoreCIDR = false) => {
  if (!fqdnIp || !nameList || !Array.isArray(nameList)) return false;
  return nameList.some(top => resolveObject(top, addresses, groups).some(r => {
    const vRaw = r.value;
    const v = vRaw && isIPWithMask(vRaw) ? normalizeIP(vRaw) : vRaw;
    if (v) { if (!ignoreCIDR) { if (isCIDR(v)) return ipInCIDR(fqdnIp, v); if (isExactIP(v)) return fqdnIp === v; } else { if (String(v).split('/')[0] === String(fqdnIp)) return true; } if (String(v).toLowerCase() === String(fqdnIp).toLowerCase()) return true; }
    if (r.name && String(r.name).toLowerCase() === String(fqdnIp).toLowerCase()) return true;
    return false;
  }));
};

// Main NetSearch Component
const NetSearch = () => {
  const sessionUser = JSON.parse(localStorage.getItem('user') || '{}');
  const userRole = sessionUser.role || 'Viewer';
  const isOperatorOrAdmin = userRole === 'SuperAdmin' || userRole === 'Operator';

  const [lang, setLang] = useState('en');
  const [activeTab, setActiveTab] = useState('sec');
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState('keyword');
  const [ignoreCIDR, setIgnoreCIDR] = useState(false);
  const [highlightEnabled, setHighlightEnabled] = useState(true);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [serverLastLoaded, setServerLastLoaded] = useState(null);
  const [toast, setToast] = useState(null);

  // Parse state: local/imported & loaded configs
  const [parsedConfigs, setParsedConfigs] = useState([]);
  const [fqdnRecords, setFqdnRecords] = useState([]);
  const [hasFqdnSource, setHasFqdnSource] = useState(true);
  const [rawConfigs, setRawConfigs] = useState([]);
  const [disabledHosts, setDisabledHosts] = useState(new Set());
  const [searchHistory, setSearchHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('ns_search_history') || '[]');
    } catch {
      return [];
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const searchInputRef = useRef(null);

  // Filters state
  const [fromZoneFilter, setFromZoneFilter] = useState('');
  const [toZoneFilter, setToZoneFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [filterSource, setFilterSource] = useState(false);
  const [filterDest, setFilterDest] = useState(false);
  const [secHideDisabled, setSecHideDisabled] = useState(false);
  const [secShowDisabledOnly, setSecShowDisabledOnly] = useState(false);
  const [showDisabledMembersOnly, setShowDisabledMembersOnly] = useState(false);

  // Group chevron state (which device cards are collapsed)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const [expandedPills, setExpandedPills] = useState(new Set());
  const [expandedUrlCats, setExpandedUrlCats] = useState(new Set());

  // Bulk search modal
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [bulkMode, setBulkMode] = useState('OR');

  // Import modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [stagedConfigs, setStagedConfigs] = useState([]);
  const [stagedFqdn, setStagedFqdn] = useState([]);

  // Copy/Export tab columns picker
  const [copyFields, setCopyFields] = useState([
    { key: 'hostname', label: 'Device', selected: true },
    { key: 'rule_name', label: 'Rule Name', selected: true },
    { key: 'action', label: 'Action', selected: true },
    { key: 'from', label: 'From Zone', selected: true },
    { key: 'to', label: 'To Zone', selected: true },
    { key: 'source', label: 'Source Address', selected: true },
    { key: 'destination', label: 'Destination Address', selected: true },
    { key: 'service', label: 'Service', selected: true },
    { key: 'application', label: 'Application', selected: true },
    { key: 'url_category', label: 'URL Category', selected: true },
    { key: 'nat_name', label: 'NAT Rule Name', selected: false },
    { key: 'nat_from', label: 'NAT From', selected: false },
    { key: 'nat_to', label: 'NAT To', selected: false },
    { key: 'nat_orig_src', label: 'NAT Source', selected: false },
    { key: 'nat_orig_dst', label: 'NAT Destination', selected: false },
    { key: 'nat_snat', label: 'SNAT Translate', selected: false },
    { key: 'nat_dnat', label: 'DNAT Translate', selected: false },
    { key: 'f5_vs', label: 'F5 VS Name', selected: false },
    { key: 'f5_dest', label: 'F5 VS IP', selected: false },
    { key: 'f5_port', label: 'F5 VS Port', selected: false },
    { key: 'f5_status', label: 'F5 VS Status', selected: false },
    { key: 'f5_pool', label: 'F5 VS Pool', selected: false },
    { key: 'f5_members', label: 'F5 Pool Members', selected: false },
  ]);

  // Load backend data
  const loadFromServer = async () => {
    setLoading(true);
    try {
      const res = await api.get('/netsearch/data');
      if (res.data) {
        setParsedConfigs(res.data.parsedConfigs || []);
        setFqdnRecords(res.data.fqdnRecords || []);
        setServerLastLoaded(res.data.lastLoaded);
        setHasFqdnSource(res.data.hasFqdnSource !== false);
      }
    } catch (err) {
      console.error('Failed to load NetSearch configs from server:', err);
      showToast('error', 'Failed to fetch parsed configurations from server');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFromServer();
  }, []);

  const triggerReload = async () => {
    if (!isOperatorOrAdmin) {
      showToast('error', 'Only Operator or SuperAdmin roles can trigger backups reload');
      return;
    }
    setSyncing(true);
    showToast('info', 'Triggering backup sweep & config parser parsing...');
    try {
      const res = await api.post('/netsearch/reload');
      if (res.data && res.data.ok) {
        showToast('success', 'Backup configuration reloaded successfully!');
        await loadFromServer();
      } else {
        showToast('error', res.data?.error || 'Failed to reload configurations');
      }
    } catch (err) {
      console.error(err);
      showToast('error', 'Server error triggering backup config refresh');
    } finally {
      setSyncing(false);
    }
  };

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  };

  const handleSearchKeyPress = (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      setSearch(val);
      if (val) {
        addToSearchHistory(val);
      }
      setHistoryOpen(false);
    }
  };

  const addToSearchHistory = (q) => {
    const type = isCIDR(q) ? 'cidr' : isExactIP(q) ? 'ip' : isIPWithMask(q) ? 'cidr' : isIPish(q) ? 'ip' : 'keyword';
    const time = new Date().toLocaleTimeString(lang === 'zh' ? 'zh-TW' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const entry = { query: q, type: searchMode === 'exact' ? 'exact' : type, time };
    setSearchHistory(prev => {
      const filtered = prev.filter(h => h.query !== q);
      const next = [entry, ...filtered].slice(0, 50);
      localStorage.setItem('ns_search_history', JSON.stringify(next));
      return next;
    });
  };

  const clearHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem('ns_search_history');
    setHistoryOpen(false);
  };

  const toggleDevice = (host) => {
    setDisabledHosts(prev => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  };

  const toggleAllDevices = () => {
    setDisabledHosts(prev => {
      if (prev.size === 0) {
        const next = new Set(parsedConfigs.map(c => c.parsed.hostname));
        return next;
      } else {
        return new Set();
      }
    });
  };

  // Parsing & filtering engine
  const searchAST = parseSearch(search);

  // Compute matched keys to speed up IP matching
  const termMatchedKeysMap = {};
  const termFqdnIpsMap = {};
  const allFqdnIps = new Set();
  const allRuleIps = new Set();
  const allRuleIpsForFqdn = new Set();

  const positiveTerms = searchAST ? extractPositiveTerms(searchAST) : [];

  // Populate maps
  if (searchAST) {
    const terms = extractTerms(searchAST);
    terms.forEach(term => {
      termMatchedKeysMap[term] = new Set();
      const s = term.toLowerCase();
      fqdnRecords.forEach(r => {
        if (r.ip && isExactIP(r.ip) && (r.fqdn?.toLowerCase() === s || r.owner?.toLowerCase()?.includes(s) || r.domain?.toLowerCase()?.includes(s))) {
          if (!termFqdnIpsMap[term]) termFqdnIpsMap[term] = [];
          termFqdnIpsMap[term].push(r.ip);
          allFqdnIps.add(r.ip);
        }
      });
    });

    // Populate rule IPs (symmetric chaining)
    parsedConfigs.forEach(cfg => {
      const p = cfg.parsed;
      const device = p.hostname;
      if (disabledHosts.has(device)) return;

      // Scan rules matches
      const checkRuleMatches = (rules, isSec) => {
        rules.forEach(r => {
          let matches = false;
          if (isSec) {
            matches = evaluateAST(searchAST, (term, forceExact) => {
              const chk = v => forceExact || searchMode === 'exact' ? String(v).toLowerCase() === term.toLowerCase() : String(v).toLowerCase().includes(term.toLowerCase());
              return chk(r.name) || (r.from || []).some(chk) || (r.to || []).some(chk);
            });
          } else {
            matches = evaluateAST(searchAST, (term, forceExact) => {
              const chk = v => forceExact || searchMode === 'exact' ? String(v).toLowerCase() === term.toLowerCase() : String(v).toLowerCase().includes(term.toLowerCase());
              return chk(r.name) || (r.from || []).some(chk) || (r.to || []).some(chk);
            });
          }
          if (matches) {
            const addAddrList = (list) => {
              (list || []).forEach(obj => {
                resolveObject(obj, p.addresses, p.groups).forEach(resolved => {
                  if (resolved.value) {
                    allRuleIps.add(resolved.value);
                    allRuleIpsForFqdn.add(resolved.value);
                  }
                });
              });
            };
            addAddrList(r.source);
            addAddrList(r.destination);
            if (!isSec) {
              addAddrList(r.sourceTranslation);
              addAddrList(r.destinationTranslation);
            }
          }
        });
      };
      if (p.secRules) checkRuleMatches(p.secRules, true);
      if (p.natRules) checkRuleMatches(p.natRules, false);
    });
  }

  // Filtered dataset generator
  const getFilteredData = () => {
    const result = {
      secRules: [],
      natRules: [],
      routes: [],
      addresses: [],
      groups: [],
      f5Virtuals: [],
      f5Pools: [],
      fqdnList: [],
    };

    parsedConfigs.forEach(cfg => {
      const parsed = cfg.parsed;
      const hn = parsed.hostname;
      if (disabledHosts.has(hn)) return;

      // 1. Security Rules
      (parsed.secRules || []).forEach(r => {
        if (secHideDisabled && r.disabled) return;
        if (secShowDisabledOnly && !r.disabled) return;
        if (fromZoneFilter && !(r.from || []).includes(fromZoneFilter)) return;
        if (toZoneFilter && !(r.to || []).includes(toZoneFilter)) return;
        if (tagFilter && !(r.tag || []).includes(tagFilter)) return;

        let match = true;
        let chainedFromFqdn = false;
        if (searchAST) {
          match = evaluateAST(searchAST, (term, forceExact) => {
            const s = String(term).toLowerCase(), isEx = forceExact || searchMode === 'exact';
            const chk = v => isEx ? String(v).toLowerCase() === s : String(v).toLowerCase().includes(s);
            if (chk(r.name)) return true;
            if ((r.from || []).some(chk)) return true;
            if ((r.to || []).some(chk)) return true;

            const am = isEx ? 'exact' : (isCIDR(term) || isExactIP(term) || isIPWithMask(term)) ? 'cidr' : 'keyword';
            const ms = !filterDest ? objectListMatchesSearch(r.source, term, parsed.addresses, parsed.groups, am, ignoreCIDR) : false;
            const md = !filterSource ? objectListMatchesSearch(r.destination, term, parsed.addresses, parsed.groups, am, ignoreCIDR) : false;
            let direct = ms || md || serviceListMatchesSearch(r.service, term, parsed.services, parsed.serviceGroups, am);
            if (direct) return true;

            const fqdnIps = termFqdnIpsMap[term];
            if (fqdnIps && fqdnIps.length > 0) {
              for (const fip of fqdnIps) {
                const fms = !filterDest ? objectListMatchesFqdnIp(r.source, fip, parsed.addresses, parsed.groups, ignoreCIDR) : false;
                const fmd = !filterSource ? objectListMatchesFqdnIp(r.destination, fip, parsed.addresses, parsed.groups, ignoreCIDR) : false;
                if (fms || fmd) { chainedFromFqdn = true; return true; }
              }
            }
            return false;
          });
        }
        if (match) {
          result.secRules.push({ ...r, _hostname: hn, _parsed: parsed, _chainedFromFqdn: chainedFromFqdn });
        }
      });

      // 2. NAT Rules
      (parsed.natRules || []).forEach(r => {
        if (secHideDisabled && r.disabled) return;
        if (secShowDisabledOnly && !r.disabled) return;
        if (fromZoneFilter && !(r.from || []).includes(fromZoneFilter)) return;
        if (toZoneFilter && !(r.to || []).includes(toZoneFilter)) return;
        if (tagFilter && !(r.tag || []).includes(tagFilter)) return;

        let match = true;
        let chainedFromFqdn = false;
        if (searchAST) {
          match = evaluateAST(searchAST, (term, forceExact) => {
            const s = String(term).toLowerCase(), isEx = forceExact || searchMode === 'exact';
            const chk = v => isEx ? String(v).toLowerCase() === s : String(v).toLowerCase().includes(s);
            if (chk(r.name)) return true;
            if ((r.from || []).some(chk)) return true;
            if ((r.to || []).some(chk)) return true;

            const am = isEx ? 'exact' : (isCIDR(term) || isExactIP(term) || isIPWithMask(term)) ? 'cidr' : 'keyword';
            const ms = !filterDest ? (objectListMatchesSearch(r.source, term, parsed.addresses, parsed.groups, am, ignoreCIDR) || objectListMatchesSearch(r.sourceTranslation || [], term, parsed.addresses, parsed.groups, am, ignoreCIDR)) : false;
            const md = !filterSource ? (objectListMatchesSearch(r.destination, term, parsed.addresses, parsed.groups, am, ignoreCIDR) || objectListMatchesSearch(r.destinationTranslation || [], term, parsed.addresses, parsed.groups, am, ignoreCIDR)) : false;
            let direct = ms || md || serviceListMatchesSearch(r.service, term, parsed.services, parsed.serviceGroups, am);
            if (direct) return true;

            const fqdnIps = termFqdnIpsMap[term];
            if (fqdnIps && fqdnIps.length > 0) {
              for (const fip of fqdnIps) {
                const fms = !filterDest ? (objectListMatchesFqdnIp(r.source, fip, parsed.addresses, parsed.groups, ignoreCIDR) || objectListMatchesFqdnIp(r.sourceTranslation || [], fip, parsed.addresses, parsed.groups, ignoreCIDR)) : false;
                const fmd = !filterSource ? (objectListMatchesFqdnIp(r.destination, fip, parsed.addresses, parsed.groups, ignoreCIDR) || objectListMatchesFqdnIp(r.destinationTranslation || [], fip, parsed.addresses, parsed.groups, ignoreCIDR)) : false;
                if (fms || fmd) { chainedFromFqdn = true; return true; }
              }
            }
            return false;
          });
        }
        if (match) {
          result.natRules.push({ ...r, _hostname: hn, _parsed: parsed, _chainedFromFqdn: chainedFromFqdn });
        }
      });

      // 3. Routes
      (parsed.routes || []).forEach(r => {
        let match = true;
        let chainedMatch = false;
        if (search) {
          const aSearch = isIPWithMask(search) ? normalizeIP(search) : search;
          const s = aSearch.toLowerCase();
          match = String(r.destination).toLowerCase().includes(s) || String(r.nexthop).toLowerCase().includes(s) || String(r.interface).toLowerCase().includes(s) || String(r.name).toLowerCase().includes(s);
          if (!ignoreCIDR && !match && isCIDR(aSearch) && isCIDR(r.destination)) match = cidrOverlaps(aSearch, r.destination);
          if (!ignoreCIDR && !match && isExactIP(aSearch) && isCIDR(r.destination)) match = ipInCIDR(aSearch, r.destination);

          if (!match && searchAST) {
            match = evaluateAST(searchAST, (term, forceExact) => {
              const isEx = forceExact || searchMode === 'exact';
              const chk = v => isEx ? String(v).toLowerCase() === String(term).toLowerCase() : String(v).toLowerCase().includes(String(term).toLowerCase());
              return chk(r.destination) || chk(r.nexthop) || chk(r.interface) || chk(r.name);
            });
          }
          if (!ignoreCIDR && !match && allFqdnIps.size > 0 && isCIDR(r.destination)) {
            for (const fip of allFqdnIps) { if (ipInCIDR(fip, r.destination)) { match = true; chainedMatch = true; break; } }
          }
          if (!match && allFqdnIps.size > 0 && isExactIP(r.nexthop)) {
            for (const fip of allFqdnIps) { if (fip === r.nexthop) { match = true; chainedMatch = true; break; } }
          }
          if (!ignoreCIDR && !match && allRuleIps.size > 0 && isCIDR(r.destination)) {
            for (const rip of allRuleIps) {
              if (isExactIP(rip) && ipInCIDR(rip, r.destination)) { match = true; chainedMatch = true; break; }
              if (isCIDR(rip) && cidrOverlaps(rip, r.destination)) { match = true; chainedMatch = true; break; }
            }
          }
        }
        if (match) result.routes.push({ ...r, _hostname: hn, _chained: chainedMatch });
      });

      // 4. Addresses & Groups
      Object.entries(parsed.addresses || {}).forEach(([name, addr]) => {
        let match = true;
        let chainedMatch = false;
        if (search) {
          match = matchObject(name, addr.value, search, searchMode === 'exact', ignoreCIDR);
          if (!match && searchAST) {
            match = evaluateAST(searchAST, (term, forceExact) => {
              return matchObject(name, addr.value, term, forceExact || searchMode === 'exact', ignoreCIDR);
            });
          }
          if (!match && allFqdnIps.size > 0) {
            for (const fip of allFqdnIps) {
              if (matchObject(name, addr.value, fip, true, ignoreCIDR)) { match = true; chainedMatch = true; break; }
            }
          }
          if (!match && allRuleIps.size > 0) {
            for (const rip of allRuleIps) {
              if (matchObject(name, addr.value, rip, true, ignoreCIDR)) { match = true; chainedMatch = true; break; }
            }
          }
        }
        if (match) result.addresses.push({ name, type: addr.type, value: addr.value, _hostname: hn, _chained: chainedMatch });
      });

      Object.entries(parsed.groups || {}).forEach(([name, members]) => {
        let match = true;
        let chainedMatch = false;
        const listM = Array.isArray(members) ? members : Array.from(members);
        if (search) {
          const sl = search.toLowerCase();
          match = String(name).toLowerCase().includes(sl) || listM.some(m => String(m).toLowerCase().includes(sl));
          if (!match && searchAST) {
            match = evaluateAST(searchAST, (term) => {
              const st = String(term).toLowerCase();
              return String(name).toLowerCase().includes(st) || listM.some(m => String(m).toLowerCase().includes(st));
            });
          }
          if (!match && (allFqdnIps.size > 0 || allRuleIps.size > 0)) {
            const allChainIps = new Set([...allFqdnIps, ...allRuleIps]);
            for (const mem of listM) {
              const resolved = resolveObject(mem, parsed.addresses, parsed.groups);
              for (const r of resolved) {
                if (!r.value) continue;
                for (const cip of allChainIps) {
                  if (matchObject(r.name, r.value, cip, true, ignoreCIDR)) { match = true; chainedMatch = true; break; }
                }
                if (match) break;
              }
              if (match) break;
            }
          }
        }
        if (match) result.groups.push({ name, members: listM, _hostname: hn, _parsed: parsed, _chained: chainedMatch });
      });

      // 5. F5 Virtual Servers & Pools
      (parsed.virtuals || []).forEach(vs => {
        let match = true;
        let chainedFromRule = false;
        if (searchAST) {
          match = evaluateAST(searchAST, (term, forceExact) => {
            const s = String(term).toLowerCase(), isEx = forceExact || searchMode === 'exact';
            if (isEx) return String(vs.name).toLowerCase() === s || String(vs.ip) === s || String(vs.port) === s || (vs.pool && String(vs.pool).toLowerCase() === s);
            return String(vs.name).toLowerCase().includes(s) || String(vs.ip).toLowerCase().includes(s) || String(vs.port) === s || (vs.pool && String(vs.pool).toLowerCase().includes(s));
          });
          if (!match && allRuleIps.size > 0) {
            for (const rip of allRuleIps) {
              if (isExactIP(rip) && vs.ip === rip) { match = true; chainedFromRule = true; break; }
              if (!ignoreCIDR && isCIDR(rip) && ipInCIDR(vs.ip, rip)) { match = true; chainedFromRule = true; break; }
            }
          }
          if (!match && allFqdnIps.size > 0) {
            for (const fip of allFqdnIps) {
              if (vs.ip === fip) { match = true; chainedFromRule = true; break; }
            }
          }
        }
        if (showDisabledMembersOnly && vs.status !== 'disabled') {
          // If status filter enabled, skip if not disabled
          return;
        }
        if (match) result.f5Virtuals.push({ ...vs, _hostname: hn, _parsed: parsed, _chainedFromRule: chainedFromRule });
      });

      (parsed.pools || []).forEach(pool => {
        let match = true;
        let chainedMatch = false;
        if (searchAST) {
          match = evaluateAST(searchAST, (term, forceExact) => {
            const s = String(term).toLowerCase(), isEx = forceExact || searchMode === 'exact';
            if (String(pool.name).toLowerCase().includes(s)) return true;
            return (pool.members || []).some(m => String(m.ip).toLowerCase().includes(s) || String(m.port) === s || String(m.name).toLowerCase().includes(s));
          });
          if (!match && (allFqdnIps.size > 0 || allRuleIps.size > 0)) {
            const allChainIps = new Set([...allFqdnIps, ...allRuleIps]);
            for (const m of (pool.members || [])) {
              for (const cip of allChainIps) {
                if (m.ip === cip) { match = true; chainedMatch = true; break; }
                if (!ignoreCIDR && isCIDR(cip) && ipInCIDR(m.ip, cip)) { match = true; chainedMatch = true; break; }
              }
              if (match) break;
            }
          }
        }
        if (match) result.f5Pools.push({ ...pool, _hostname: hn, _parsed: parsed, _chained: chainedMatch });
      });
    });

    // 6. FQDN Records
    const fqdnRuleIpRanges = [];
    for (const rawTerm of positiveTerms) {
      const term = isIPWithMask(rawTerm) ? normalizeIP(rawTerm) : rawTerm;
      if (isExactIP(term)) { fqdnRuleIpRanges.push({ num: ipToNum(term) >>> 0, mask: 0xFFFFFFFF }); }
      else if (isCIDR(term)) { const [base, bits] = term.split('/'); const mask = bits === '32' ? 0xFFFFFFFF : (~(0xFFFFFFFF >>> +bits)) >>> 0; fqdnRuleIpRanges.push({ num: (ipToNum(base) & mask) >>> 0, mask }); }
    }
    if (fqdnRuleIpRanges.length === 0) {
      for (const rawRip of allRuleIpsForFqdn) {
        const rip = isIPWithMask(rawRip) ? normalizeIP(rawRip) : rawRip;
        if (isExactIP(rip)) { fqdnRuleIpRanges.push({ num: ipToNum(rip) >>> 0, mask: 0xFFFFFFFF }); }
        else if (isCIDR(rip)) { const [base, bits] = rip.split('/'); const mask = bits === '32' ? 0xFFFFFFFF : (~(0xFFFFFFFF >>> +bits)) >>> 0; fqdnRuleIpRanges.push({ num: (ipToNum(base) & mask) >>> 0, mask }); }
      }
    }

    fqdnRecords.forEach(r => {
      let match = false;
      let chainedFromRule = false;
      if (searchAST) {
        match = evaluateAST(searchAST, (term, forceExact) => {
          const s = term.toLowerCase(), isEx = forceExact || searchMode === 'exact';
          if (isEx) return String(r.fqdn).toLowerCase() === s || String(r.ip).toLowerCase() === s || String(r.owner).toLowerCase() === s;
          return String(r.fqdn).toLowerCase() === s
            || String(r.ip).toLowerCase() === s
            || String(r.domain).toLowerCase().includes(s)
            || String(r.owner).toLowerCase().includes(s);
        });
      } else if (search) {
        const s = search.toLowerCase();
        match = String(r.fqdn).toLowerCase() === s
          || String(r.ip).toLowerCase() === s
          || String(r.domain).toLowerCase().includes(s)
          || String(r.owner).toLowerCase().includes(s);
      } else {
        match = true;
      }

      if (!match && fqdnRuleIpRanges.length > 0 && r.ip && r.ip.toLowerCase() !== 'null' && isExactIP(r.ip)) {
        const rn = ipToNum(r.ip) >>> 0;
        for (const range of fqdnRuleIpRanges) {
          if (((rn & range.mask) >>> 0) === range.num) { match = true; chainedFromRule = true; break; }
        }
      }
      if (match) result.fqdnList.push({ ...r, _chainedFromRule: chainedFromRule });
    });

    return result;
  };

  const filteredData = getFilteredData();

  // Excel-style TSV Export logic
  const copyTSV = () => {
    const data = filteredData.secRules.map(sec => {
      const row = {
        hostname: sec._hostname,
        rule_name: sec.name,
        action: sec.action,
        from: (sec.from || []).join(', '),
        to: (sec.to || []).join(', '),
        source: (sec.source || []).join(', '),
        destination: (sec.destination || []).join(', '),
        service: (sec.service || []).join(', '),
        application: (sec.application || []).join(', '),
        url_category: (sec.category || []).join(', '),
      };
      // Find matching NAT rule
      const nat = filteredData.natRules.find(n => n._hostname === sec._hostname && n.name === sec.name);
      if (nat) {
        row.nat_name = nat.name;
        row.nat_from = (nat.from || []).join(', ');
        row.nat_to = (nat.to || []).join(', ');
        row.nat_orig_src = (nat.source || []).join(', ');
        row.nat_orig_dst = (nat.destination || []).join(', ');
        row.nat_snat = (nat.sourceTranslation || []).join(', ');
        row.nat_dnat = (nat.destinationTranslation || []).join(', ');
      }
      return row;
    });

    const activeFields = copyFields.filter(f => f.selected);
    const header = activeFields.map(f => f.label).join('\t');
    const body = data.map(row =>
      activeFields.map(f => {
        const val = String(row[f.key] || '');
        return val.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
      }).join('\t')
    ).join('\n');

    const tsv = header + '\n' + body;
    navigator.clipboard.writeText(tsv)
      .then(() => showToast('success', lang === 'zh' ? '✓ 已複製到剪貼簿！' : '✓ Copied to clipboard!'))
      .catch(() => showToast('error', 'Failed to copy to clipboard'));
  };

  // Toggle chevrons
  const toggleGroup = (gid) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const togglePill = (pid) => {
    setExpandedPills(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  const expandAllPills = () => {
    const next = new Set(expandedPills);
    next.add('__ALL__');
    setExpandedPills(next);
  };

  const collapseAllPills = () => {
    setExpandedPills(new Set());
  };

  // Drag and drop sorting of copy columns
  const [draggedIndex, setDraggedIndex] = useState(null);
  const handleDragStart = (index) => {
    setDraggedIndex(index);
  };
  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    const items = [...copyFields];
    const item = items.splice(draggedIndex, 1)[0];
    items.splice(index, 0, item);
    setDraggedIndex(index);
    setCopyFields(items);
  };

  // Client-side file uploading / import (similar to local cache testing)
  const handleLocalConfigImport = async (files) => {
    const list = Array.from(files);
    for (const f of list) {
      const text = await readFileAsync(f);
      try {
        const parsed = parseConfig(text);
        setParsedConfigs(prev => {
          // Check if device already exists to overwrite/update
          const next = prev.filter(c => c.parsed.hostname !== parsed.hostname);
          return [...next, { id: genId(), filename: f.name, parsed }];
        });
        setRawConfigs(prev => {
          const next = prev.filter(c => c.filename !== f.name);
          return [...next, { filename: f.name, text }];
        });
      } catch (err) {
        console.error(err);
        showToast('error', `Failed to parse config file: ${f.name}`);
      }
    }
  };

  const handleLocalFqdnImport = async (files) => {
    const list = Array.from(files);
    for (const f of list) {
      const text = await readFileAsync(f);
      try {
        const parsed = parseFqdnFile(text);
        setFqdnRecords(prev => [...prev, ...parsed]);
      } catch (err) {
        console.error(err);
        showToast('error', `Failed to parse FQDN file: ${f.name}`);
      }
    }
  };

  const readFileAsync = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  // Render pills in rules
  const renderPillItem = (item, type, parsed, ruleKey) => {
    const pid = `${item}_${parsed?.hostname || ''}_${ruleKey}`;
    const isExpanded = expandedPills.has('__ALL__') || expandedPills.has(pid);
    const star = highlightEnabled && searchAST && extractTerms(searchAST).some(t => item.toLowerCase().includes(t.toLowerCase())) ? '✦' : '';

    const handlePillClick = (e) => {
      e.stopPropagation();
      togglePill(pid);
    };

    const handleQuickSearch = (e) => {
      e.stopPropagation();
      setSearch(item);
      addToSearchHistory(item);
    };

    if (isExpanded) {
      let resolved = [];
      if (type === 'service') {
        resolved = resolveService(item, parsed?.services, parsed?.serviceGroups);
      } else {
        resolved = resolveObject(item, parsed?.addresses, parsed?.groups);
      }
      return (
        <div key={pid} className="pill-expand-container" onClick={handlePillClick} style={{ border: '1px solid var(--border-color)', margin: '4px', background: 'rgba(255,255,255,0.02)', padding: '6px' }}>
          <div className="pill-expand-header" style={{ fontWeight: 600, color: 'var(--accent-primary)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
            <span>▼ {item} ({resolved.length})</span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }} onClick={handleQuickSearch}>🔍</span>
          </div>
          <div className="pill-expand-body" style={{ paddingLeft: '10px', borderLeft: '2px solid var(--accent-primary)', marginTop: '4px' }}>
            {resolved.map(r => (
              <div key={r.name} style={{ display: 'flex', gap: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
                <span style={{ color: 'var(--text-primary)' }}>{r.name}</span>
                {r.value && <span style={{ color: 'var(--text-secondary)' }}>[{r.value}]</span>}
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <span key={pid} className="pill" onClick={handlePillClick} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', margin: '2px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '12px' }}>
        {item} {star && <span style={{ color: 'var(--support-warning)', fontSize: '10px' }}>{star}</span>}
      </span>
    );
  };

  const t = (key) => {
    return (i18n[lang] || i18n.en)[key] || key;
  };

  // Tab configurations
  const TABS = [
    { id: 'fqdn', label: { en: 'FQDN', zh: 'FQDN' } },
    { id: 'sec', label: { en: 'Sec Rules', zh: '安全規則' } },
    { id: 'nat', label: { en: 'NAT Rules', zh: 'NAT 規則' } },
    { id: 'route', label: { en: 'Routes', zh: '路由表' } },
    { id: 'objects', label: { en: 'Objects', zh: '安全物件' } },
    { id: 'f5_vs', label: { en: 'F5 Virtuals', zh: 'F5 虛擬服務' } },
    { id: 'f5_pools', label: { en: 'F5 Pools', zh: 'F5 伺服器群' } },
    { id: 'copy', label: { en: 'Export', zh: '匯出複製' } },
    { id: 'raw', label: { en: 'Raw Config', zh: '原始設定' } },
    { id: 'debug', label: { en: 'Debug', zh: '解析調試' } },
  ];

  const i18n = {
    en: {
      fromZoneAll: 'FROM ZONE (All)', toZoneAll: 'TO ZONE (All)', tagAll: 'TAG (All)',
      hideDisabled: 'Hide Disabled', disabledOnly: 'Disabled Only', f5Disabled: 'F5 Disabled',
      btnExpand: 'Expand All', btnCollapse: 'Collapse All', btnClear: '✕ Clear Filters',
      recentSearches: 'Recent Searches', clearHistory: 'Clear History',
      copiedClipboard: '✓ Copied to clipboard!',
    },
    zh: {
      fromZoneAll: '來源區域 (全部)', toZoneAll: '目的區域 (全部)', tagAll: '標籤 (全部)',
      hideDisabled: '隱藏停用規則', disabledOnly: '只顯示停用', f5Disabled: '只顯示 F5 停用',
      btnExpand: '全部展開', btnCollapse: '全部收合', btnClear: '✕ 清除篩選',
      recentSearches: '最近搜尋記錄', clearHistory: '清除歷史記錄',
      copiedClipboard: '✓ 已成功複製到剪貼簿！',
    }
  };

  return (
    <div style={{ padding: '20px 24px', fontFamily: "'IBM Plex Sans', sans-serif", color: 'var(--text-primary)' }}>
      {/* Toast Alert */}
      {toast && (
        <div style={{
          position: 'fixed', top: '24px', right: '24px', zIndex: 1000,
          background: toast.type === 'error' ? 'rgba(218,30,40,0.95)' : toast.type === 'success' ? 'rgba(36,161,72,0.95)' : 'rgba(15,98,254,0.95)',
          color: '#fff', padding: '12px 24px', borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          fontFamily: 'monospace', fontSize: '13px', border: '1px solid rgba(255,255,255,0.2)'
        }}>
          {toast.message}
        </div>
      )}

      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '24px' }}>🔍</span>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>NetSearch — Configuration Visualizer</h2>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {serverLastLoaded ? `Backend Sync: ${new Date(serverLastLoaded).toLocaleString()}` : 'Backend Data: Not Synced'}
            </div>
          </div>
        </div>

        {/* Search Input Controls */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1, maxWidth: '600px', margin: '0 20px', position: 'relative' }}>
          <button 
            onClick={() => setSearchMode(prev => prev === 'keyword' ? 'exact' : 'keyword')}
            style={{ padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: '6px', background: searchMode === 'exact' ? 'var(--accent-primary)' : 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '12px', cursor: 'pointer' }}
          >
            {searchMode === 'exact' ? 'Exact' : 'Keyword'}
          </button>
          
          <input 
            ref={searchInputRef}
            type="text" 
            placeholder="Search IP, CIDR, Port, or Rule..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyPress}
            onFocus={() => setHistoryOpen(true)}
            style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ position: 'absolute', right: '110px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}>✕</button>
          )}

          {/* Search History Dropdown */}
          {historyOpen && searchHistory.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: '85px', right: 0, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '8px', zIndex: 100, boxShadow: '0 8px 20px rgba(0,0,0,0.5)', maxHeight: '300px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--text-muted)' }}>
                <span>{t('recentSearches')}</span>
                <span onClick={clearHistory} style={{ cursor: 'pointer', color: 'var(--support-error)' }}>{t('clearHistory')}</span>
              </div>
              {searchHistory.map((h, i) => (
                <div 
                  key={i} 
                  onClick={() => { setSearch(h.query); setHistoryOpen(false); }}
                  style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', fontSize: '12px', borderBottom: '1px dashed rgba(255,255,255,0.05)' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <span>
                    <span style={{ background: 'var(--accent-primary)', color: '#fff', padding: '1px 4px', borderRadius: '3px', fontSize: '10px', marginRight: '6px' }}>{h.type.toUpperCase()}</span>
                    {h.query}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{h.time}</span>
                </div>
              ))}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input type="checkbox" checked={ignoreCIDR} onChange={(e) => setIgnoreCIDR(e.target.checked)} />
            Ignore CIDR
          </label>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setShowBulkModal(true)} style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '12px', cursor: 'pointer' }}>
            📋 Bulk
          </button>
          <button onClick={() => setShowImportModal(true)} style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '12px', cursor: 'pointer' }}>
            📥 Import
          </button>
          <button 
            onClick={triggerReload} 
            disabled={syncing || !isOperatorOrAdmin} 
            style={{ padding: '8px 14px', borderRadius: '6px', border: 'none', background: 'var(--accent-primary)', color: '#fff', fontSize: '12px', cursor: syncing ? 'not-allowed' : 'pointer', fontWeight: 600 }}
          >
            {syncing ? '🔄 Syncing...' : '🔄 Reload'}
          </button>
          <button onClick={() => setLang(prev => prev === 'en' ? 'zh' : 'en')} style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '12px', cursor: 'pointer' }}>
            {lang === 'en' ? 'EN' : '中文'}
          </button>
        </div>
      </div>

      {/* Device Filter Strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 16px', marginBottom: '16px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>Device Sources:</span>
        <button 
          onClick={toggleAllDevices}
          style={{ padding: '4px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', background: disabledHosts.size === 0 ? 'var(--accent-primary)' : 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '11px', cursor: 'pointer' }}
        >
          All ({parsedConfigs.length})
        </button>
        {parsedConfigs.map(cfg => {
          const hn = cfg.parsed.hostname;
          const isDisabled = disabledHosts.has(hn);
          const type = cfg.parsed.type;
          const color = type === 'PA' ? '#6929c4' : type === 'FortiGate' ? '#da1e28' : type === 'SRX' ? '#007d79' : '#0043ce';
          return (
            <button
              key={hn}
              onClick={() => toggleDevice(hn)}
              style={{
                padding: '4px 10px', borderRadius: '4px', border: `1px solid ${isDisabled ? 'var(--border-color)' : color}`,
                background: isDisabled ? 'transparent' : `${color}20`,
                color: isDisabled ? 'var(--text-muted)' : '#fff',
                fontSize: '11px', cursor: 'pointer'
              }}
            >
              {hn.split('.')[0]}
            </button>
          );
        })}
      </div>

      {/* Filter Options Bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px 16px', marginBottom: '16px' }}>
        <input 
          type="text" 
          placeholder="From Zone..." 
          value={fromZoneFilter}
          onChange={(e) => setFromZoneFilter(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '12px', width: '120px' }}
        />
        <input 
          type="text" 
          placeholder="To Zone..." 
          value={toZoneFilter}
          onChange={(e) => setToZoneFilter(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '12px', width: '120px' }}
        />
        <input 
          type="text" 
          placeholder="Tag Filter..." 
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '12px', width: '120px' }}
        />

        <div style={{ display: 'flex', gap: '10px', fontSize: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={filterSource} onChange={(e) => setFilterSource(e.target.checked)} />
            Src Match
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={filterDest} onChange={(e) => setFilterDest(e.target.checked)} />
            Dst Match
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={secHideDisabled} onChange={(e) => setSecHideDisabled(e.target.checked)} />
            Hide Disabled
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={showDisabledMembersOnly} onChange={(e) => setShowDisabledMembersOnly(e.target.checked)} />
            F5 Disabled Only
          </label>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <button onClick={expandAllPills} style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '11px', cursor: 'pointer' }}>
            {t('btnExpand')}
          </button>
          <button onClick={collapseAllPills} style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '11px', cursor: 'pointer' }}>
            {t('btnCollapse')}
          </button>
          <button onClick={() => { setSearch(''); setFromZoneFilter(''); setToZoneFilter(''); setTagFilter(''); setFilterSource(false); setFilterDest(false); setSecHideDisabled(false); setShowDisabledMembersOnly(false); }} style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--support-error)', background: 'rgba(218,30,40,0.1)', color: 'var(--support-error)', fontSize: '11px', cursor: 'pointer' }}>
            {t('btnClear')}
          </button>
        </div>
      </div>

      {/* Tabs list */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: '16px', gap: '4px' }}>
        {TABS.map(tab => {
          let count = 0;
          if (tab.id === 'sec') count = filteredData.secRules.length;
          else if (tab.id === 'nat') count = filteredData.natRules.length;
          else if (tab.id === 'route') count = filteredData.routes.length;
          else if (tab.id === 'objects') count = filteredData.addresses.length + filteredData.groups.length;
          else if (tab.id === 'f5_vs') count = filteredData.f5Virtuals.length;
          else if (tab.id === 'f5_pools') count = filteredData.f5Pools.length;
          else if (tab.id === 'fqdn') count = filteredData.fqdnList.length;

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '10px 16px', border: 'none', borderBottom: activeTab === tab.id ? '2px solid var(--accent-primary)' : 'none',
                background: 'transparent', color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: activeTab === tab.id ? 700 : 500, fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
              }}
            >
              {tab.label[lang]}
              {count > 0 && (
                <span style={{ fontSize: '10px', background: 'rgba(255,255,255,0.1)', padding: '1px 6px', borderRadius: '10px', color: 'var(--text-secondary)' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content Rendering */}
      <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '20px', minHeight: '400px' }}>
        {loading && <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>⏳ Loading configurations database...</div>}

        {!loading && activeTab === 'sec' && (
          <div>
            {filteredData.secRules.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>No Security Rules match the query filters.</div>
            ) : (
              filteredData.secRules.map((sec, idx) => {
                const color = sec._parsed?.type === 'PA' ? '#6929c4' : sec._parsed?.type === 'FortiGate' ? '#da1e28' : sec._parsed?.type === 'SRX' ? '#007d79' : '#0043ce';
                return (
                  <div key={idx} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px', marginBottom: '10px', background: sec.disabled ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.02)', opacity: sec.disabled ? 0.6 : 1, borderLeft: `4px solid ${color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ fontWeight: 700, fontSize: '14px' }}>
                        {sec.name}
                        {sec._chainedFromFqdn && <span style={{ marginLeft: '8px', background: '#24a148', color: '#fff', fontSize: '9px', padding: '2px 6px', borderRadius: '4px' }}>FQDN CHAINED</span>}
                      </span>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: '4px' }}>{sec._hostname}</span>
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: sec.action === 'allow' ? 'rgba(36,161,72,0.1)' : 'rgba(218,30,40,0.1)', color: sec.action === 'allow' ? 'var(--support-success)' : 'var(--support-error)', fontWeight: 600 }}>{sec.action.toUpperCase()}</span>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px', marginTop: '10px' }}>
                      <div>
                        <strong style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>FROM / TO</strong>
                        <div style={{ fontSize: '12px' }}>{(sec.from || []).join(', ')} → {(sec.to || []).join(', ')}</div>
                      </div>
                      <div>
                        <strong style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>SOURCES</strong>
                        <div>{(sec.source || []).map(s => renderPillItem(s, 'object', sec._parsed, `sec_src_${idx}`))}</div>
                      </div>
                      <div>
                        <strong style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>DESTINATIONS</strong>
                        <div>{(sec.destination || []).map(d => renderPillItem(d, 'object', sec._parsed, `sec_dst_${idx}`))}</div>
                      </div>
                      <div>
                        <strong style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>SERVICES</strong>
                        <div>{(sec.service || []).map(s => renderPillItem(s, 'service', sec._parsed, `sec_svc_${idx}`))}</div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {!loading && activeTab === 'nat' && (
          <div>
            {filteredData.natRules.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>No NAT Rules found matching the filters.</div>
            ) : (
              filteredData.natRules.map((nat, idx) => (
                <div key={idx} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px', marginBottom: '10px', background: nat.disabled ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.02)', opacity: nat.disabled ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '13px' }}>{nat.name}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{nat._hostname}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px' }}>
                    <div>
                      <strong style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>ORIGINAL</strong>
                      <span style={{ fontSize: '12px' }}>{(nat.source || []).join(', ')} → {(nat.destination || []).join(', ')}</span>
                    </div>
                    <div>
                      <strong style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>TRANSLATED</strong>
                      <span style={{ fontSize: '12px' }}>
                        {nat.sourceTranslation && nat.sourceTranslation.length > 0 ? `SNAT: ${nat.sourceTranslation.join(', ')}` : ''}
                        {nat.destinationTranslation && nat.destinationTranslation.length > 0 ? `DNAT: ${nat.destinationTranslation.join(', ')}` : ''}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {!loading && activeTab === 'route' && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '8px 12px' }}>Device</th>
                <th style={{ padding: '8px 12px' }}>Destination</th>
                <th style={{ padding: '8px 12px' }}>Next Hop</th>
                <th style={{ padding: '8px 12px' }}>Interface</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.routes.map((rt, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '8px 12px' }}>{rt._hostname}</td>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{rt.destination}</td>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{rt.nexthop}</td>
                  <td style={{ padding: '8px 12px' }}>{rt.interface}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && activeTab === 'objects' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            <div>
              <h3 style={{ fontSize: '14px', marginBottom: '10px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>Addresses</h3>
              {filteredData.addresses.map((addr, idx) => (
                <div key={idx} style={{ padding: '6px 10px', borderBottom: '1px dashed rgba(255,255,255,0.05)', fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{addr.name}</span>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{addr.value}</span>
                </div>
              ))}
            </div>
            <div>
              <h3 style={{ fontSize: '14px', marginBottom: '10px', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>Address Groups</h3>
              {filteredData.groups.map((grp, idx) => (
                <div key={idx} style={{ padding: '8px', border: '1px solid var(--border-color)', borderRadius: '6px', marginBottom: '6px', fontSize: '12px' }}>
                  <div style={{ fontWeight: 700, color: 'var(--accent-primary)' }}>{grp.name} ({grp.members.length})</div>
                  <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {grp.members.map(m => (
                      <span key={m} style={{ background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>{m}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && activeTab === 'f5_vs' && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '8px 12px' }}>Device</th>
                <th style={{ padding: '8px 12px' }}>VS Name</th>
                <th style={{ padding: '8px 12px' }}>IP Target</th>
                <th style={{ padding: '8px 12px' }}>Port</th>
                <th style={{ padding: '8px 12px' }}>Pool</th>
                <th style={{ padding: '8px 12px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.f5Virtuals.map((vs, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '8px 12px' }}>{vs._hostname}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 600 }}>{vs.name}</td>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{vs.ip}</td>
                  <td style={{ padding: '8px 12px' }}>{vs.port}</td>
                  <td style={{ padding: '8px 12px' }}>{vs.pool || 'None'}</td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: '4px', fontSize: '10px',
                      background: vs.status === 'enabled' ? 'rgba(36,161,72,0.1)' : 'rgba(218,30,40,0.1)',
                      color: vs.status === 'enabled' ? 'var(--support-success)' : 'var(--support-error)'
                    }}>
                      {vs.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && activeTab === 'f5_pools' && (
          <div>
            {filteredData.f5Pools.map((pool, idx) => (
              <div key={idx} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px', marginBottom: '10px', background: 'rgba(255,255,255,0.01)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '6px', marginBottom: '8px' }}>
                  <span style={{ fontWeight: 700, color: 'var(--accent-primary)' }}>{pool.name}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{pool._hostname}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                  {(pool.members || []).map((m, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', fontSize: '11px' }}>
                      <span style={{ fontFamily: 'monospace' }}>{m.ip}:{m.port}</span>
                      <span style={{ color: m.status === 'enabled' ? 'var(--support-success)' : 'var(--support-error)' }}>{m.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && activeTab === 'fqdn' && (
          !hasFqdnSource ? (
            <div style={{ padding: '24px', textAlign: 'center', background: 'rgba(218, 30, 40, 0.1)', border: '1px dashed var(--support-error)', borderRadius: '8px', color: 'var(--support-error)', fontWeight: 600, fontSize: '14px' }}>
              ⚠️ no fqdn source
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '8px 12px' }}>FQDN</th>
                  <th style={{ padding: '8px 12px' }}>IP Address</th>
                  <th style={{ padding: '8px 12px' }}>Domain</th>
                  <th style={{ padding: '8px 12px' }}>Type</th>
                  <th style={{ padding: '8px 12px' }}>Owner</th>
                  <th style={{ padding: '8px 12px' }}>Geo Location</th>
                </tr>
              </thead>
              <tbody>
                {filteredData.fqdnList.slice(0, 500).map((fqdn, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{fqdn.fqdn}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{fqdn.ip}</td>
                    <td style={{ padding: '8px 12px' }}>{fqdn.domain}</td>
                    <td style={{ padding: '8px 12px' }}>{fqdn.type}</td>
                    <td style={{ padding: '8px 12px' }}>{fqdn.owner}</td>
                    <td style={{ padding: '8px 12px' }}>{fqdn.geoInfo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {!loading && activeTab === 'copy' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 600 }}>Configure Export Columns (Drag to Reorder)</h3>
              <button onClick={copyTSV} style={{ padding: '8px 16px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}>
                📋 Copy TSV to Clipboard
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '20px' }}>
              {copyFields.map((f, i) => (
                <div
                  key={f.key}
                  draggable
                  onDragStart={() => handleDragStart(i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  style={{
                    padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border-color)',
                    background: f.selected ? 'rgba(15,98,254,0.1)' : 'rgba(255,255,255,0.03)',
                    color: f.selected ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: 'grab', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={f.selected}
                    onChange={(e) => {
                      const next = [...copyFields];
                      next[i].selected = e.target.checked;
                      setCopyFields(next);
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{f.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && activeTab === 'raw' && (
          <div>
            {rawConfigs.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>No raw configuration files uploaded. Go to Import to upload configuration text.</div>
            ) : (
              rawConfigs.map((cfg, idx) => (
                <div key={idx} style={{ marginBottom: '20px' }}>
                  <h4 style={{ fontSize: '13px', color: 'var(--accent-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px' }}>{cfg.filename}</h4>
                  <pre style={{ background: 'var(--bg-primary)', padding: '12px', borderRadius: '6px', overflowX: 'auto', fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {cfg.text.slice(0, 10000)}
                    {cfg.text.length > 10000 ? '\n... (truncated for display performance)' : ''}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}

        {!loading && activeTab === 'debug' && (
          <div>
            <h3 style={{ fontSize: '14px', marginBottom: '12px' }}>Parser Diagnostic Metrics</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
              {parsedConfigs.map((cfg, idx) => (
                <div key={idx} style={{ padding: '14px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'rgba(255,255,255,0.01)' }}>
                  <div style={{ fontWeight: 700, marginBottom: '6px' }}>{cfg.parsed.hostname}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                    <span>Type: {cfg.parsed.type}</span>
                    <span>Filename: {cfg.filename}</span>
                    <span>Sec Rules: {Object.keys(cfg.parsed.secRules || {}).length}</span>
                    <span>NAT Rules: {Object.keys(cfg.parsed.natRules || {}).length}</span>
                    <span>Addresses: {Object.keys(cfg.parsed.addresses || {}).length}</span>
                    <span>Groups: {Object.keys(cfg.parsed.groups || {}).length}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bulk Search Modal */}
      {showBulkModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '12px', width: '90%', maxWidth: '500px', padding: '20px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: '16px' }}>Bulk Search Engine</h3>
            <textarea
              placeholder="Enter one search term per line (IP, CIDR, Port, or Keyword)..."
              value={bulkInput}
              onChange={(e) => setBulkInput(e.target.value)}
              rows={8}
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace', outline: 'none', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: '12px', marginTop: '12px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Logic Operator:</span>
              {['OR', 'AND'].map(mode => (
                <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
                  <input type="radio" name="bulk_logic" checked={bulkMode === mode} onChange={() => setBulkMode(mode)} />
                  {mode}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <button 
                onClick={() => {
                  const terms = bulkInput.split('\n').map(t => t.trim()).filter(Boolean);
                  if (terms.length > 0) {
                    const queryStr = terms.map(t => t.includes(' ') ? `"${t}"` : t).join(` ${bulkMode} `);
                    setSearch(queryStr);
                    addToSearchHistory(queryStr);
                  }
                  setShowBulkModal(false);
                }}
                style={{ flex: 1, padding: '8px 16px', background: 'var(--accent-primary)', border: 'none', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
              >
                Run Bulk Search
              </button>
              <button onClick={() => setShowBulkModal(false)} style={{ flex: 1, padding: '8px 16px', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: '12px', width: '90%', maxWidth: '600px', padding: '24px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '18px' }}>Import Custom Configs & Data (Ad-hoc)</h3>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                Config Files (Palo Alto / FortiGate / Juniper SRX / F5)
              </label>
              <input
                type="file"
                multiple
                onChange={(e) => handleLocalConfigImport(e.target.files)}
                style={{ display: 'block', fontSize: '12px' }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                FQDN Lookup List (CSV / TSV)
              </label>
              <input
                type="file"
                multiple
                onChange={(e) => handleLocalFqdnImport(e.target.files)}
                style={{ display: 'block', fontSize: '12px' }}
              />
            </div>

            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => {
                  setParsedConfigs([]);
                  setFqdnRecords([]);
                  setRawConfigs([]);
                  loadFromServer();
                  showToast('info', 'Reset and re-fetched from server');
                }} 
                style={{ padding: '8px 16px', background: 'rgba(218,30,40,0.1)', color: 'var(--support-error)', border: '1px solid var(--support-error)', borderRadius: '6px', cursor: 'pointer' }}
              >
                Reset to Server Defaults
              </button>
              <button onClick={() => setShowImportModal(false)} style={{ padding: '8px 16px', background: 'var(--accent-primary)', border: 'none', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NetSearch;
