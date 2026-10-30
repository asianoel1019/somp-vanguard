'use strict';
// Parsing functions extracted verbatim from NetSearch-prototype.html

// ID generator (mirrors browser-side genId)
let _idCounter = 0;
const genId = () => 'id_' + (++_idCounter) + '_' + Math.random().toString(36).slice(2, 8);

// Helper predicates used by SRX parser
const isCIDR = s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(String(s));
const isExactIP = s => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(s)) && !isCIDR(s);

const parseValue = (str) => {
  const m = str.match(/"[^"]+"|'[^']+'|\S+/g)||[];
  return m.map(s=>s.replace(/['"]/g,'')).filter(s=>s!=='['&&s!==']');
};

// FortiGate Parser
const parseFortiGateConfig = (text) => {
  const lines=String(text).split('\n');
  const acc={type:'FortiGate',hostname:'Unknown-FortiGate',tags:{},addresses:{},groups:{},services:{},serviceGroups:{},urlCategories:{},secRules:{},natRules:{},routes:{},schedules:{},vipMap:{},vipgrpMap:{},unparsed:[]};
  const parseFGTValue=(str)=>(str.match(/"[^"]+"|'[^']+'|\S+/g)||[]).map(s=>s.replace(/['"]/g,''));
  let cs=null,ce=null,co=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim();
    if(!line||line.startsWith('#'))continue;
    if(line.startsWith('config ')){cs=line.substring(7).trim();if(cs==='system global')co={};continue;}
    if(line==='end'){if(cs==='system global'&&co&&co.hostname)acc.hostname=String(Array.isArray(co.hostname)?co.hostname[0]:co.hostname);cs=null;continue;}
    if(line.startsWith('edit ')){ce=line.substring(5).replace(/['"]/g,'').trim();co={name:ce};continue;}
    if(line==='next'){
      if(co&&cs){
        if(cs==='firewall policy'){
          let rn=co.nameField||co.name;
          let rule={name:String(rn),from:new Set(),to:new Set(),source:new Set(),destination:new Set(),application:new Set(),service:new Set(),category:new Set(),tag:new Set(),action:'deny',disabled:false};
          if(co.srcintf)[].concat(co.srcintf).forEach(v=>rule.from.add(v));
          if(co.dstintf)[].concat(co.dstintf).forEach(v=>rule.to.add(v));
          if(co.srcaddr)[].concat(co.srcaddr).forEach(v=>rule.source.add(v));
          if(co.dstaddr)[].concat(co.dstaddr).forEach(v=>rule.destination.add(v));
          if(co.service)[].concat(co.service).forEach(v=>rule.service.add(v));
          if(co.action){const av=Array.isArray(co.action)?co.action[0]:co.action;rule.action=(av==='accept')?'allow':'deny';}
          if(co.status){const sv=Array.isArray(co.status)?co.status[0]:co.status;rule.disabled=(sv==='disable');}
          if(co.comments)rule.name=String(co.comments);
          if(co.schedule)rule.schedule=co.schedule;
          acc.secRules[ce]=rule;
        } else if(cs==='firewall address'){
          if(co.subnet){const parts=parseFGTValue(co.subnet.join?co.subnet.join(' '):co.subnet);if(parts.length>=2){const ip=parts[0],mask=parts[1];const bits=mask.split('.').reduce((a,o)=>a+parseInt(o,10).toString(2).split('').filter(b=>b==='1').length,0);acc.addresses[ce]={type:'ip-netmask',value:`${ip}/${bits}`};}}
          if(co.fqdn)acc.addresses[ce]={type:'fqdn',value:String(Array.isArray(co.fqdn)?co.fqdn[0]:co.fqdn)};
          if(co['start-ip']&&co['end-ip'])acc.addresses[ce]={type:'ip-range',value:`${co['start-ip']}-${co['end-ip']}`};
        } else if(cs==='firewall addrgrp'){
          if(!acc.groups[ce])acc.groups[ce]=new Set();
          if(co.member)[].concat(co.member).forEach(v=>acc.groups[ce].add(v));
        } else if(cs==='firewall service custom'){
          if(co['tcp-portrange'])acc.services[ce]={protocol:'tcp',port:String(co['tcp-portrange'])};
          else if(co['udp-portrange'])acc.services[ce]={protocol:'udp',port:String(co['udp-portrange'])};
        } else if(cs==='firewall service group'){
          if(!acc.serviceGroups[ce])acc.serviceGroups[ce]=new Set();
          if(co.member)[].concat(co.member).forEach(v=>acc.serviceGroups[ce].add(v));
        } else if(cs==='firewall central-snat-map'||cs==='firewall central-dnat'){
          let rule={name:String(co.name||ce),disabled:false,from:new Set(),to:new Set(),source:new Set(),destination:new Set(),service:new Set(),tag:new Set(),sourceTranslation:[],destinationTranslation:[]};
          if(co.srcintf)[].concat(co.srcintf).forEach(v=>rule.from.add(v));
          if(co.dstintf)[].concat(co.dstintf).forEach(v=>rule.to.add(v));
          if(co['orig-addr'])[].concat(co['orig-addr']).forEach(v=>rule.source.add(v));
          if(co['dst-addr'])[].concat(co['dst-addr']).forEach(v=>rule.destination.add(v));
          // SNAT: nat-ippool
          if(co['nat-ippool'])[].concat(co['nat-ippool']).forEach(v=>rule.sourceTranslation.push(v));
          // DNAT: extip / mappedip / dst-addr-nated
          if(co['dst-addr-nated'])[].concat(co['dst-addr-nated']).forEach(v=>rule.destinationTranslation.push(v));
          if(co.extip)[].concat(co.extip).forEach(v=>rule.destinationTranslation.push(v));
          if(co.mappedip)[].concat(co.mappedip).forEach(v=>rule.destinationTranslation.push(v));
          if(co.status){const sv=Array.isArray(co.status)?co.status[0]:co.status;rule.disabled=(sv==='disable');}
          acc.natRules[ce]=rule;
        } else if(cs==='firewall vip'){
          const extip=co.extip?(Array.isArray(co.extip)?co.extip[0]:co.extip):'';
          const mappedip=co.mappedip?(Array.isArray(co.mappedip)?co.mappedip[0]:co.mappedip):'';
          const extintf=co.extintf?String(Array.isArray(co.extintf)?co.extintf[0]:co.extintf):'';
          if(extip)acc.vipMap[ce]={extip,mappedip,extintf};
          if(extip&&mappedip)acc.addresses[ce]={type:'ip-netmask',value:extip,mappedip};
        } else if(cs==='firewall vipgrp'){
          acc.vipgrpMap[ce]={members:co.member?[].concat(co.member):[]};
        } else if(cs==='router static'){
          acc.routes[ce]={name:String(ce),destination:co.dst?String(Array.isArray(co.dst)?co.dst[0]:co.dst):'',nexthop:co.gateway?String(Array.isArray(co.gateway)?co.gateway[0]:co.gateway):'',interface:co.device?String(Array.isArray(co.device)?co.device[0]:co.device):''};
        } else if(cs==='firewall schedule onetime'){
          if(co.start&&co.end){const sa=Array.isArray(co.start)?co.start:[co.start];const ea=Array.isArray(co.end)?co.end:[co.end];if(sa.length>=2&&ea.length>=2)acc.schedules[ce]={name:ce,start:`${String(sa[1]).replace(/\//g,'-')}T${sa[0]}`,end:`${String(ea[1]).replace(/\//g,'-')}T${ea[0]}`};}
        }
      }
      if(cs==='system global'&&co&&co.hostname)acc.hostname=String(Array.isArray(co.hostname)?co.hostname[0]:co.hostname);
      co=null;ce=null;continue;
    }
    if(co){
      const m=line.match(/^set\s+(\S+)\s+(.*)/);
      if(m){const k=m[1],vals=parseFGTValue(m[2]);co[k]=vals.length===1?vals[0]:vals;}
    }
  }
  const toArr=s=>s instanceof Set?Array.from(s):(Array.isArray(s)?s:[]);
  const groups={};Object.entries(acc.groups).forEach(([k,v])=>groups[k]=Array.from(v));
  const serviceGroups={};Object.entries(acc.serviceGroups).forEach(([k,v])=>serviceGroups[k]=Array.from(v));
  const resolveVip=(name,vipMap,vipgrpMap)=>{
    if(vipgrpMap[name])return vipgrpMap[name].members.flatMap(m=>vipMap[m]?[{name:m,extip:vipMap[m].extip,mappedip:vipMap[m].mappedip}]:[]);
    if(vipMap[name])return [{name,extip:vipMap[name].extip,mappedip:vipMap[name].mappedip}];
    return null;
  };
  const secRules=Object.values(acc.secRules).map(r=>{
    const base={name:String(r.name),disabled:r.disabled,action:r.action,from:toArr(r.from),to:toArr(r.to),source:toArr(r.source),destination:toArr(r.destination),application:toArr(r.application),service:toArr(r.service),category:toArr(r.category),tag:toArr(r.tag),schedule:r.schedule||null};
    const dstVips=toArr(r.destination).flatMap(a=>{const v=resolveVip(a,acc.vipMap,acc.vipgrpMap);return v||[];});
    if(dstVips.length)base.dstVips=dstVips;
    return base;
  });
  secRules.forEach(r=>{if(r.schedule&&typeof r.schedule==='string'&&acc.schedules[r.schedule])r.schedule=acc.schedules[r.schedule];});
  const natRules=Object.values(acc.natRules).map(r=>({name:String(r.name),disabled:!!r.disabled,from:toArr(r.from),to:toArr(r.to),source:toArr(r.source),destination:toArr(r.destination),service:toArr(r.service),tag:toArr(r.tag),sourceTranslation:Array.from(r.sourceTranslation||[]),destinationTranslation:Array.from(r.destinationTranslation||[])}));
  const routesArr=Object.values(acc.routes).map(r=>({name:String(r.name||''),destination:r.destination?String(r.destination):'',nexthop:r.nexthop?String(r.nexthop):'',interface:r.interface?String(r.interface):''}));
  return {...acc,groups,serviceGroups,secRules,natRules,routes:routesArr};
};

// Palo Alto Parser
const parsePAConfig = (text) => {
  const lines=String(text).split('\n');
  const acc={type:'PA',hostname:'Unknown-PA',tags:{},addresses:{},groups:{},services:{},serviceGroups:{},urlCategories:{},secRules:{},natRules:{},routes:{},schedules:{},unparsed:[]};
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim();
    if(!line||line.startsWith('#'))continue;
    if(!line.startsWith('set ')){acc.unparsed.push(line);continue;}
    if(line.includes('deviceconfig system hostname ')){const m=line.match(/deviceconfig system hostname\s+("[^"]+"|'[^']+'|\S+)/);if(m)acc.hostname=String(m[1]).replace(/['"]/g,'');continue;}
    const tagM=line.match(/tag\s+("[^"]+"|'[^']+'|\S+)\s+color\s+(color\d+)/);
    if(tagM){acc.tags[String(tagM[1]).replace(/['"]/g,'')]=String(tagM[2]);continue;}
    const addrM=line.match(/address\s+("[^"]+"|'[^']+'|\S+)\s+(ip-netmask|fqdn|ip-range)\s+(.+)$/);
    if(addrM){acc.addresses[String(addrM[1]).replace(/['"]/g,'')]={type:String(addrM[2]),value:String(addrM[3]).replace(/['"]/g,'').trim()};continue;}
    const agP=line.split(/address-group\s+/);
    if(agP.length>1){const nm=agP[1].match(/^("[^"]+"|'[^']+'|\S+)\s+(.*)/);if(nm){const name=String(nm[1]).replace(/['"]/g,'');if(!acc.groups[name])acc.groups[name]=new Set();const tm=nm[2].match(/^(static|members)\s+(.*)/);if(tm)parseValue(tm[2]).forEach(v=>acc.groups[name].add(v));}continue;}
    const srvM=line.match(/service\s+("[^"]+"|'[^']+'|\S+)\s+protocol\s+(tcp|udp)\s+(?:source-port\s+\S+\s+)?port\s+(.+)$/i);
    if(srvM){acc.services[String(srvM[1]).replace(/['"]/g,'')]={protocol:String(srvM[2]).toLowerCase(),port:String(srvM[3]).replace(/['"]/g,'').trim()};continue;}
    const sgP=line.split(/service-group\s+/);
    if(sgP.length>1){const nm=sgP[1].match(/^("[^"]+"|'[^']+'|\S+)\s+(.*)/);if(nm){const name=String(nm[1]).replace(/['"]/g,'');if(!acc.serviceGroups[name])acc.serviceGroups[name]=new Set();const tm=nm[2].match(/^(static|members)\s+(.*)/);if(tm)parseValue(tm[2]).forEach(v=>acc.serviceGroups[name].add(v));}continue;}
    const urlP=line.split(/custom-url-category\s+/);
    if(urlP.length>1){const nm=urlP[1].match(/^("[^"]+"|'[^']+'|\S+)\s+(.*)/);if(nm){const name=String(nm[1]).replace(/['"]/g,'');if(!acc.urlCategories[name])acc.urlCategories[name]=new Set();const tm=nm[2].match(/^(list|members)\s+(.*)/);if(tm)parseValue(tm[2]).forEach(v=>acc.urlCategories[name].add(v));}continue;}
    const secM=line.match(/rulebase security rules\s+("[^"]+"|'[^']+'|\S+)\s+(.*)/);
    if(secM){const rn=String(secM[1]).replace(/['"]/g,'');if(!acc.secRules[rn])acc.secRules[rn]={name:rn,from:new Set(),to:new Set(),source:new Set(),destination:new Set(),application:new Set(),service:new Set(),category:new Set(),tag:new Set(),action:'allow',disabled:false};const rest=secM[2];
      const fm=rest.match(/^from\s+(.*)/);if(fm)parseValue(fm[1]).forEach(v=>acc.secRules[rn].from.add(v));
      const tm=rest.match(/^to\s+(.*)/);if(tm)parseValue(tm[1]).forEach(v=>acc.secRules[rn].to.add(v));
      const sm=rest.match(/^source\s+(.*)/);if(sm)parseValue(sm[1]).forEach(v=>acc.secRules[rn].source.add(v));
      const dm=rest.match(/^destination\s+(.*)/);if(dm)parseValue(dm[1]).forEach(v=>acc.secRules[rn].destination.add(v));
      const am=rest.match(/^application\s+(.*)/);if(am)parseValue(am[1]).forEach(v=>acc.secRules[rn].application.add(v));
      const svm=rest.match(/^service\s+(.*)/);if(svm)parseValue(svm[1]).forEach(v=>acc.secRules[rn].service.add(v));
      const cm=rest.match(/^category\s+(.*)/);if(cm)parseValue(cm[1]).forEach(v=>acc.secRules[rn].category.add(v));
      const tgm=rest.match(/^tag\s+(.*)/);if(tgm)parseValue(tgm[1]).forEach(v=>acc.secRules[rn].tag.add(v));
      const acm=rest.match(/^action\s+(\S+)/);if(acm)acc.secRules[rn].action=String(acm[1]);
      if(rest.match(/^disabled\s+yes/))acc.secRules[rn].disabled=true;
      const schm=rest.match(/^schedule\s+("[^"]+"|'[^']+'|\S+)/);if(schm)acc.secRules[rn].schedule=String(schm[1]).replace(/['"]/g,'');
      continue;
    }
    const natM=line.match(/rulebase nat rules\s+("[^"]+"|'[^']+'|\S+)\s+(.*)/);
    if(natM){const rn=String(natM[1]).replace(/['"]/g,'');if(!acc.natRules[rn])acc.natRules[rn]={name:rn,from:new Set(),to:new Set(),source:new Set(),destination:new Set(),service:new Set(),tag:new Set(),'source-translation':new Set(),'destination-translation':new Set(),disabled:false};const rest=natM[2];
      const fm=rest.match(/^from\s+(.*)/);if(fm)parseValue(fm[1]).forEach(v=>acc.natRules[rn].from.add(v));
      const tm=rest.match(/^to\s+(.*)/);if(tm)parseValue(tm[1]).forEach(v=>acc.natRules[rn].to.add(v));
      const sm=rest.match(/^source\s+(.*)/);if(sm)parseValue(sm[1]).forEach(v=>acc.natRules[rn].source.add(v));
      const dm=rest.match(/^destination\s+(.*)/);if(dm)parseValue(dm[1]).forEach(v=>acc.natRules[rn].destination.add(v));
      const svm=rest.match(/^service\s+(.*)/);if(svm)parseValue(svm[1]).forEach(v=>acc.natRules[rn].service.add(v));
      const tgm=rest.match(/^tag\s+(.*)/);if(tgm)parseValue(tgm[1]).forEach(v=>acc.natRules[rn].tag.add(v));
      if(rest.includes('source-translation'))acc.natRules[rn]['source-translation'].add(rest.split(/\s+/).pop());
      if(rest.includes('destination-translation'))acc.natRules[rn]['destination-translation'].add(rest.split(/\s+/).pop());
      if(rest.match(/^disabled\s+yes/))acc.natRules[rn].disabled=true;
      continue;
    }
    const schedM=line.match(/set schedule\s+("[^"]+"|'[^']+'|\S+)\s+schedule-type\s+non-recurring\s+(\d{4}\/\d{2}\/\d{2})@(\d{2}:\d{2})-(\d{4}\/\d{2}\/\d{2})@(\d{2}:\d{2})/);
    if(schedM){const sn=String(schedM[1]).replace(/['"]/g,'');acc.schedules[sn]={name:sn,start:`${schedM[2].replace(/\//g,'-')}T${schedM[3]}`,end:`${schedM[4].replace(/\//g,'-')}T${schedM[5]}`};continue;}
    const rtM=line.match(/virtual-router\s+\S+\s+routing-table\s+ip\s+static-route\s+("[^"]+"|'[^']+'|\S+)\s+(.*)/);
    if(rtM){const rn=String(rtM[1]).replace(/['"]/g,'');if(!acc.routes[rn])acc.routes[rn]={name:rn};const rest=rtM[2];
      const dm=rest.match(/^destination\s+(\S+)/);if(dm)acc.routes[rn].destination=String(dm[1]);
      const nm=rest.match(/^nexthop\s+ip-address\s+(\S+)/);if(nm)acc.routes[rn].nexthop=String(nm[1]);
      const im=rest.match(/^interface\s+(\S+)/);if(im)acc.routes[rn].interface=String(im[1]);
      continue;
    }
  }
  const toArr=s=>s instanceof Set?Array.from(s):(Array.isArray(s)?s:[]);
  const groups={};Object.entries(acc.groups).forEach(([k,v])=>groups[k]=Array.from(v));
  const serviceGroups={};Object.entries(acc.serviceGroups).forEach(([k,v])=>serviceGroups[k]=Array.from(v));
  const urlCategories={};Object.entries(acc.urlCategories).forEach(([k,v])=>urlCategories[k]=Array.from(v));
  const secRules=Object.values(acc.secRules).map(r=>({name:String(r.name),disabled:!!r.disabled,action:r.action||'allow',from:toArr(r.from),to:toArr(r.to),source:toArr(r.source),destination:toArr(r.destination),application:toArr(r.application),service:toArr(r.service),category:toArr(r.category),tag:Array.from(r.tag||[]),schedule:r.schedule||null}));
  secRules.forEach(r=>{if(r.schedule&&typeof r.schedule==='string'&&acc.schedules[r.schedule])r.schedule=acc.schedules[r.schedule];});
  const natRules=Object.values(acc.natRules).map(r=>({name:String(r.name),disabled:!!r.disabled,from:toArr(r.from),to:toArr(r.to),source:toArr(r.source),destination:toArr(r.destination),service:toArr(r.service),tag:Array.from(r.tag||[]),sourceTranslation:Array.from(r['source-translation']||[]),destinationTranslation:Array.from(r['destination-translation']||[])}));
  const routesArr=Object.values(acc.routes).map(r=>({name:String(r.name||''),destination:r.destination?String(r.destination):'',nexthop:r.nexthop?String(r.nexthop):'',interface:r.interface?String(r.interface):''}));
  return {...acc,groups,serviceGroups,urlCategories,secRules,natRules,routes:routesArr};
};

// Juniper SRX (JunOS set-format) Parser
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
      if (m2 && (acc._hostnameFromGroups||0) < 2) { acc.hostname = m2[1].replace(/['"]/g, ''); acc._hostnameFromGroups = 1; continue; } }
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
      const srcM = rest.match(/^match source-address (\S+)$/);       if (srcM) { r.source.add(srcM[1]); continue; }
      const dstM = rest.match(/^match destination-address (\S+)$/);  if (dstM) { r.destination.add(dstM[1]); continue; }
      const appM = rest.match(/^match application (\S+)$/);          if (appM) { r.application.add(appM[1]); r.service.add(appM[1]); continue; }
      if (rest === 'then permit')                    { r.action = 'allow'; continue; }
      if (rest === 'then deny' || rest === 'then reject') { r.action = 'deny'; continue; }
      if (rest.match(/^then inactive$/))             { r.disabled = true; continue; }
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
  const acc={type:'F5',hostname:'Unknown-F5',virtuals:[],pools:[],addresses:{},groups:{},services:{},serviceGroups:{},secRules:[],natRules:[],routes:[],unparsed:[]};
  const st=String(text);
  const hnM=st.match(/sys global-settings\s*\{[^}]*hostname\s+([^\s;}]+)/);
  if(hnM)acc.hostname=String(hnM[1]);
  let pos=0;
  while(pos<st.length){
    const m=st.substring(pos).match(/^(ltm virtual|ltm pool)\s+([^\s{]+)?\s*\{/m);
    if(!m)break;
    const si=pos+m.index, type=m[1], name=m[2]||'';
    const bs=st.indexOf('{',si);
    let ob=0,ei=bs;
    for(let i=bs;i<st.length;i++){if(st[i]==='{')ob++;else if(st[i]==='}'){ob--;if(ob===0){ei=i;break;}}}
    const content=st.substring(bs+1,ei), pn=String(name.split('/').pop());
    if(type==='ltm virtual'){
      const destM=content.match(/destination\s+([^\s;}]+)/);
      const poolM=content.match(/pool\s+([^\s;}]+)/);
      const isDis=content.split('\n').some(l=>l.trim()==='disabled');
      let ip='',port='*';
      if(destM){let d=destM[1].split('/').pop();let sep=Math.max(d.lastIndexOf(':'),d.lastIndexOf('.'));if(sep>0&&sep>d.indexOf('%')){port=d.substring(sep+1);ip=d.substring(0,sep);}else ip=d;ip=ip.split('%')[0];if(port==='any')port='*';}
      acc.virtuals.push({name:pn,ip:String(ip),port:String(port),pool:poolM?poolM[1].split('/').pop():'',status:isDis?'disabled':'enabled'});
    } else if(type==='ltm pool'){
      let members=[];
      const memM=content.match(/members\s*\{/);
      if(memM){
        let ms=memM.index+memM[0].length,mo=1,me=ms;
        while(me<content.length&&mo>0){if(content[me]==='{')mo++;if(content[me]==='}')mo--;me++;}
        let memStr=content.substring(ms,me-1);
        let re=/([^\s{]+)\s*\{([^}]*)\}/g,mm;
        while((mm=re.exec(memStr))!==null){
          let mn=String(mm[1].split('/').pop()),mc=String(mm[2]),mi=mn,mp='*';
          let sep=Math.max(mn.lastIndexOf(':'),mn.lastIndexOf('.'));
          if(sep>0){mp=mn.substring(sep+1);mi=mn.substring(0,sep);}
          let am=mc.match(/address\s+([^\s;}]+)/);if(am)mi=String(am[1]);
          mi=mi.split('%')[0];
          let isDis=mc.includes('user-disabled')||mc.includes('user-down')||mc.match(/\bdisabled\b/)!==null;
          members.push({ip:String(mi),port:String(mp),name:String(mn),status:isDis?'disabled':'enabled'});
        }
      }
      acc.pools.push({name:pn,members});
    }
    pos=ei+1;
  }
  return acc;
};

// FQDN Parser
function isValidGeoInfo(v) {
  if(!v||v==='null') return false;
  if(v.length>50) return false;
  if(/[=;@]/.test(v)) return false;
  if(/^\d+\.\d+\.\d+/.test(v)) return false;
  if(/^\d+\s/.test(v)) return false;
  if((v.match(/\./g)||[]).length>=2) return false;
  return true;
}

const parseFqdnFile = (text) => {
  const lines=String(text).split('\n');
  const records=[];
  let headers=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim();
    if(!line)continue;
    const sep=line.includes('\t')?'\t':(line.includes(',')?',':null);
    if(!sep)continue;
    const cols=line.split(sep).map(c=>c.trim().replace(/^["']|["']$/g,''));
    if(!headers){
      const lower=cols.map(c=>c.toLowerCase());
      if(lower.some(c=>c.includes('fqdn')||c.includes('domain')||c.includes('ip'))){
        const fi=(fn)=>lower.findIndex((c,i)=>c!==''&&fn(c));
        headers={fqdn:fi(c=>c.includes('fqdn')),domain:fi(c=>c.includes('domain')),ip:fi(c=>c.includes('ip')&&!c.includes('type')),owner:fi(c=>c.includes('owner')||c.includes('bu')),type:fi(c=>c.includes('type')||c.includes('record')),geo:fi(c=>c.includes('geo')||c.includes('country'))};
        continue;
      }
      headers={fqdn:0,domain:-1,ip:cols.length>1?1:-1,owner:-1,type:-1,geo:-1};
    }
    const g=(idx)=>idx>=0&&idx<cols.length?cols[idx]:'';
    const fqdn=g(headers.fqdn), domain=g(headers.domain), ip=g(headers.ip);
    if(!fqdn&&!domain&&(!ip||ip.toLowerCase()==='null'))continue;
    const rawGeo=g(headers.geo);
    records.push({id:genId(),owner:g(headers.owner),domain:domain,fqdn:fqdn,type:g(headers.type),ip:ip,geoInfo:isValidGeoInfo(rawGeo)?rawGeo:''});
  }
  return records;
};

// Auto-detect parser
const parseConfig = (text) => {
  const s=String(text);
  if(s.includes('sys global-settings')||s.includes('ltm virtual ')||s.includes('ltm pool '))return parseF5Config(s);
  if(s.includes('config firewall policy')||s.includes('config system global'))return parseFortiGateConfig(s);
  if(s.includes('set security policies from-zone')||s.includes('set security nat source rule-set')||s.includes('set security zones security-zone'))return parseSRXConfig(s);
  return parsePAConfig(s);
};

module.exports = { parseConfig, parsePAConfig, parseFortiGateConfig, parseSRXConfig, parseF5Config, parseFqdnFile };
