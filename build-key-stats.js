const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
});

const INSTANCE_URL = process.env.SF_INSTANCE_URL;
const CLIENT_ID = process.env.SF_CLIENT_ID;
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET;

const ACTIVE_CONVERSIONS = [
  'Bridge Communications',
  'Bank-Tec South',
  'All Secure Lock',
  'Fire Team Security',
  'Xclutel',
  'Sunrise Solutions',
  'Pilothouse Communications',
  'IMC Facility Management',
  'Vanran Communications Services'
];
const GRADUATED_EXCLUDE = new Set(['trilogy', 'midwest technology specialists']);

function sfHost() { return new URL(INSTANCE_URL).hostname; }
function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400 || parsed.error || parsed[0]?.errorCode) reject(new Error(JSON.stringify(parsed).slice(0, 1000)));
          else resolve(parsed);
        } catch (err) { reject(new Error(`Parse error: ${data.slice(0, 1000)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function getToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString();
  const result = await requestJson({ hostname: sfHost(), path: '/services/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
  return result.access_token;
}
async function sfQuery(token, soqlOrPath) {
  const pathPart = soqlOrPath.startsWith('/services/') ? soqlOrPath : '/services/data/v59.0/query?q=' + encodeURIComponent(soqlOrPath);
  return requestJson({ hostname: sfHost(), path: pathPart, headers: { Authorization: `Bearer ${token}` } });
}
async function sfQueryAll(token, soql) {
  const records = [];
  let result = await sfQuery(token, soql);
  records.push(...(result.records || []));
  while (!result.done && result.nextRecordsUrl) {
    result = await sfQuery(token, result.nextRecordsUrl);
    records.push(...(result.records || []));
  }
  return records;
}
const chunk = (arr, size) => Array.from({length: Math.ceil(arr.length/size)}, (_,i)=>arr.slice(i*size, i*size+size));
const q = s => `'${String(s).replace(/'/g, "\\'")}'`;
const norm = s => String(s || '').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();
const money = n => Math.round((Number(n)||0)*100)/100;
const daysBetween = (a, b) => Math.floor((a - b) / 86400000);
const compact = s => norm(s).replace(/\s+/g, '');
const STOP_TOKENS = new Set('communications communication telecom telecommunications technologies technology systems system inc llc ltd co corp corporation service services solutions security group company the and of'.split(' '));
function meaningfulTokens(value) {
  return norm(value).split(' ').filter(token => token && !STOP_TOKENS.has(token));
}
function isLikelySameCompany(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || compact(a) === compact(b)) return true;
  const at = meaningfulTokens(a);
  const bt = meaningfulTokens(b);
  if (!at.length || !bt.length) return false;
  const aSet = new Set(at), bSet = new Set(bt);
  const intersection = [...aSet].filter(token => bSet.has(token));
  const smaller = at.length <= bt.length ? at : bt;
  const smallerIsSubset = smaller.length >= 2 && smaller.every(token => (at.length <= bt.length ? bSet : aSet).has(token));
  const unionSize = new Set([...at, ...bt]).size;
  const jaccard = unionSize ? intersection.length / unionSize : 0;
  return smallerIsSubset || (intersection.length >= 2 && jaccard >= 0.67);
}
function bucketLabel(bucket) {
  return ({ activeClients: 'Actively Onboarding', onHoldClients: 'On Hold', rtsClients: 'RTS', canceledClients: 'Canceled' })[bucket] || bucket;
}
function onboardingClientRow(client, bucket, statusFallback = 'Unknown', account = null) {
  return {
    account: client.name,
    psaAccountStatus: account?.psaAccountStatus || account?.accountStatus || 'Blank',
    opportunity: '',
    amount: client.mrru || 0,
    closeDate: client.dateSold || null,
    owner: '',
    onboardingName: client.name,
    onboardingStatus: client.status || statusFallback,
    onboardingBucket: bucket,
    onboardingOwner: client.owner || client.projectManager || client.solutionsAnalyst || '',
    salesRep: client.salesRep || '',
    forecastedGraduationDate: client.actualGraduationDate || client.currentGraduationDate || client.forecastedGraduationDate || null,
    startKoDate: client.startKoDate || null,
    notionUrl: client.notionUrl || ''
  };
}
async function fetchOnboardingDashboard() {
  try {
    const result = await requestJson({
      hostname: 'green-river-03f870c10.4.azurestaticapps.net',
      path: '/api/dashboard?lob=psa',
      headers: { Accept: 'application/json' }
    });
    return result || {};
  } catch (err) {
    console.warn(`Unable to fetch onboarding dashboard: ${err.message}`);
    return null;
  }
}
function isCbrTask(t) {
  const hay = [t.Subject, t.Type, t.TaskSubtype, t.CallDisposition, t.Call_Disposition2__c, t.Description].filter(Boolean).join(' ').toLowerCase();
  return /\bcbr\b|client business review|business review/.test(hay);
}

function classifyTask(t) {
  const hay = [t.Subject, t.Type, t.TaskSubtype, t.CallType, t.CallDisposition, t.Call_Disposition2__c, t.SalesLoft_Email_Template_Title__c].filter(Boolean).join(' ').toLowerCase();
  if (hay.includes('email')) return 'email';
  if (hay.includes('call') || hay.includes('phone') || t.CallDurationInSeconds || t.Call_Duration_seconds__c) return 'phone';
  return 'other';
}

async function main() {
  const token = await getToken();
  const master = JSON.parse(fs.readFileSync(path.join(__dirname, 'master-data.json'), 'utf8'));
  const webinar = JSON.parse(fs.readFileSync(path.join(__dirname, 'webinar-data.json'), 'utf8'));
  const accounts = master.accounts || [];
  const accountIds = accounts.map(a => a.id);
  const accountById = Object.fromEntries(accounts.map(a => [a.id, a]));

  console.log(`Querying contacts for ${accountIds.length} migration accounts...`);
  let contacts = [];
  for (const ids of chunk(accountIds, 200)) {
    contacts.push(...await sfQueryAll(token, `SELECT Id, AccountId, Email, LastActivityDate FROM Contact WHERE AccountId IN (${ids.map(q).join(',')})`));
  }
  const contactAccount = Object.fromEntries(contacts.map(c => [c.Id, c.AccountId]));
  const contactIds = contacts.map(c => c.Id);

  console.log('Querying account/contact tasks...');
  let tasks = [];
  for (const ids of chunk(accountIds, 200)) {
    tasks.push(...await sfQueryAll(token, `SELECT Id, WhatId, WhoId, Subject, Type, TaskSubtype, ActivityDate, Status, CreatedDate, CallType, CallDisposition, CallDurationInSeconds, Call_Disposition2__c, Call_Duration_seconds__c, SalesLoft_Email_Template_Title__c, Description FROM Task WHERE WhatId IN (${ids.map(q).join(',')})`));
  }
  for (const ids of chunk(contactIds, 200)) {
    tasks.push(...await sfQueryAll(token, `SELECT Id, WhatId, WhoId, Subject, Type, TaskSubtype, ActivityDate, Status, CreatedDate, CallType, CallDisposition, CallDurationInSeconds, Call_Disposition2__c, Call_Duration_seconds__c, SalesLoft_Email_Template_Title__c, Description FROM Task WHERE WhoId IN (${ids.map(q).join(',')})`));
  }
  const seenTask = new Set();
  tasks = tasks.filter(t => !seenTask.has(t.Id) && seenTask.add(t.Id));

  const touchByAccount = {};
  for (const a of accounts) touchByAccount[a.id] = { accountId: a.id, account: a.name, mrr: a.mrr ?? null, email: 0, phone: 0, other: 0, total: 0, webinarRegistrants: 0, lastTouch: null, lastContact: null, lastContactKind: null, lastCbr: null };
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const t of tasks) {
    const aid = accountById[t.WhatId] ? t.WhatId : contactAccount[t.WhoId];
    if (!aid || !touchByAccount[aid]) continue;
    const kind = classifyTask(t);
    touchByAccount[aid][kind]++;
    touchByAccount[aid].total++;
    const dt = t.ActivityDate || (t.CreatedDate || '').slice(0,10);
    if (dt && dt <= todayIso && (!touchByAccount[aid].lastTouch || dt > touchByAccount[aid].lastTouch)) touchByAccount[aid].lastTouch = dt;
    if (dt && dt <= todayIso && (kind === 'email' || kind === 'phone') && (!touchByAccount[aid].lastContact || dt > touchByAccount[aid].lastContact || (dt === touchByAccount[aid].lastContact && kind === 'phone'))) {
      touchByAccount[aid].lastContact = dt;
      touchByAccount[aid].lastContactKind = kind;
    }
    if (dt && dt <= todayIso && isCbrTask(t) && (!touchByAccount[aid].lastCbr || dt > touchByAccount[aid].lastCbr)) touchByAccount[aid].lastCbr = dt;
  }

  const webinarCompanyNames = new Set();
  const webinarEvents = Object.values(webinar.events || {});
  const firstWebinarDate = webinarEvents.map(e => e.eventDate || e.startDate).filter(Boolean).sort()[0] || null;
  for (const event of webinarEvents) {
    for (const r of event.registrants || []) if (r.company) webinarCompanyNames.add(norm(r.company));
  }
  const webinarAccountIds = new Set();
  for (const a of accounts) {
    if (webinarCompanyNames.has(norm(a.name))) {
      webinarAccountIds.add(a.id);
      touchByAccount[a.id].webinarRegistrants += 1;
      touchByAccount[a.id].total += 1;
      touchByAccount[a.id].email += 1;
    }
  }

  const webinarOpps = (master.opportunities || []).filter(o => webinarAccountIds.has(o.accountId));
  const cbrTaskIds = new Set();
  const cbrAccountIds = new Set();
  let latestCbrDate = null;
  for (const t of tasks) {
    const aid = accountById[t.WhatId] ? t.WhatId : contactAccount[t.WhoId];
    if (!aid || !webinarAccountIds.has(aid) || !isCbrTask(t)) continue;
    const dt = t.ActivityDate || (t.CreatedDate || '').slice(0, 10);
    if (firstWebinarDate && dt && dt < firstWebinarDate) continue;
    cbrTaskIds.add(t.Id);
    cbrAccountIds.add(aid);
    if (dt && dt <= todayIso && (!latestCbrDate || dt > latestCbrDate)) latestCbrDate = dt;
  }

  const asOf = new Date();
  const contacted = Object.values(touchByAccount).filter(x => x.email > 0 || x.phone > 0);
  const unreached = Object.values(touchByAccount).filter(x => x.email === 0 && x.phone === 0);
  const contactedWithDates = contacted
    .filter(x => x.lastTouch)
    .map(x => ({ ...x, lastTouchDate: new Date(`${x.lastTouch}T00:00:00Z`) }));
  const latestTouchDate = contactedWithDates.reduce((latest, x) => !latest || x.lastTouch > latest ? x.lastTouch : latest, null);
  const touchedWithin = days => contactedWithDates.filter(x => { const diff = daysBetween(asOf, x.lastTouchDate); return diff >= 0 && diff <= days; }).length;
  const sortedTouchDates = contactedWithDates.map(x => x.lastTouch).sort();
  const medianLastTouchDate = sortedTouchDates.length ? sortedTouchDates[Math.floor(sortedTouchDates.length / 2)] : null;
  const soldOpps = (master.opportunities || []).filter(o => o.isWon || o.stage === 'Closed Won');
  const accountForName = name => accounts.find(account => isLikelySameCompany(name, account.name)) || null;

  console.log('Fetching PSA onboarding dashboard for Tigerpaw status match...');
  const onboardingDashboard = await fetchOnboardingDashboard();
  const onboardingBuckets = ['activeClients', 'onHoldClients', 'rtsClients'];
  const tigerpawOnboardingClients = onboardingDashboard ? onboardingBuckets.flatMap(bucket =>
    (onboardingDashboard[bucket] || [])
      .filter(client => ['yes', 'true', '1'].includes(String(client.existingTigerpaw || '').trim().toLowerCase()))
      .map(client => ({ ...client, onboardingBucket: bucketLabel(bucket) }))
  ) : [];
  const matchedOnboardingClientIds = new Set();
  const wonCurrentlyOnboarding = soldOpps.flatMap(opp => {
    const client = tigerpawOnboardingClients.find(client => !matchedOnboardingClientIds.has(client.id) && isLikelySameCompany(opp.account, client.name));
    if (!client) return [];
    matchedOnboardingClientIds.add(client.id);
    return [{
      account: opp.account,
      opportunity: opp.name,
      psaAccountStatus: accountById[opp.accountId]?.psaAccountStatus || accountById[opp.accountId]?.accountStatus || 'Blank',
      amount: opp.amount,
      closeDate: opp.closeDate,
      owner: opp.owner,
      onboardingName: client.name,
      onboardingStatus: client.status || 'Unknown',
      onboardingBucket: client.onboardingBucket,
      onboardingOwner: client.owner || client.projectManager || client.solutionsAnalyst || '',
      salesRep: client.salesRep || '',
      forecastedGraduationDate: client.forecastedGraduationDate || client.currentGraduationDate || null,
      startKoDate: client.startKoDate || null,
      notionUrl: client.notionUrl || ''
    }];
  });
  const onboardingStatusBreakdown = Object.values(wonCurrentlyOnboarding.reduce((acc, row) => {
    const status = row.onboardingStatus || 'Unknown';
    if (!acc[status]) acc[status] = { status, count: 0, rows: [] };
    acc[status].count++;
    acc[status].rows.push(row);
    return acc;
  }, {})).sort((a,b) => b.count - a.count || a.status.localeCompare(b.status));
  const tigerpawGraduatedClients = onboardingDashboard ? (onboardingDashboard.graduatedClients || [])
    .filter(client => ['yes', 'true', '1'].includes(String(client.existingTigerpaw || '').trim().toLowerCase()))
    .filter(client => !GRADUATED_EXCLUDE.has(norm(client.name)))
    .map(client => onboardingClientRow(client, 'Graduated', 'Graduated', accountForName(client.name))) : [];
  const tigerpawCanceledClients = onboardingDashboard ? (onboardingDashboard.canceledClients || [])
    .filter(client => ['yes', 'true', '1'].includes(String(client.existingTigerpaw || '').trim().toLowerCase()))
    .map(client => onboardingClientRow(client, 'Canceled', 'Canceled', accountForName(client.name))) : [];

  const activeNorm = new Set(ACTIVE_CONVERSIONS.map(norm));
  const fuzzyMatch = (source, target) => {
    const s = norm(source), t = norm(target);
    if (!s || !t) return false;
    if (s === t) return true;
    return (s.length >= 6 && t.includes(s)) || (t.length >= 6 && s.includes(t));
  };
  const activeAccounts = accounts.filter(a => [...activeNorm].some(n => fuzzyMatch(a.name, n)));
  const activeOpps = (master.opportunities || []).filter(o => [...activeNorm].some(n => fuzzyMatch(o.account, n)));

  const activeConversionRows = ACTIVE_CONVERSIONS.map(name => {
    const n=norm(name);
    const account = accounts.find(a => fuzzyMatch(a.name, n));
    const opps = (master.opportunities || []).filter(o => fuzzyMatch(o.account, n));
    const touch = account ? touchByAccount[account.id] : null;
    return { name, sfAccount: account?.name || null, status: account?.webMigrationStatus || null, psaAccountStatus: account?.psaAccountStatus || null, touchpoints: touch ? { email: touch.email, phone: touch.phone, other: touch.other, total: touch.total, lastTouch: touch.lastTouch } : null, opportunities: opps.map(o => ({ name: o.name, stage: o.stage, amount: o.amount, closeDate: o.closeDate })) };
  });

  const oppAccountIds = new Set((master.opportunities || []).map(o => o.accountId).filter(Boolean));
  const openOpps = (master.opportunities || []).filter(o => !o.isClosed && o.stage !== 'Closed Lost' && !(o.isWon || o.stage === 'Closed Won'));
  const contactedNoOppAccounts = contacted
    .filter(x => !oppAccountIds.has(x.accountId))
    .map(x => ({ ...x, accountRecord: accountById[x.accountId] }))
    .sort((a,b) => String(b.lastTouch || '').localeCompare(String(a.lastTouch || '')) || b.total - a.total);
  const contactedNoOppStatusBreakdown = Object.values(contactedNoOppAccounts.reduce((acc, x) => {
    const status = x.accountRecord?.webMigrationStatus || 'Unknown';
    if (!acc[status]) acc[status] = { status, accounts: 0, touchpoints: 0, emailTouchpoints: 0, phoneTouchpoints: 0, latestTouchDate: null, latestContactDate: null, latestContactType: null, latestCbrDate: null };
    acc[status].accounts++;
    acc[status].mrr = (acc[status].mrr || 0) + (x.accountRecord?.mrr || 0);
    acc[status].touchpoints += x.total || 0;
    acc[status].emailTouchpoints += x.email || 0;
    acc[status].phoneTouchpoints += x.phone || 0;
    if (x.lastTouch && (!acc[status].latestTouchDate || x.lastTouch > acc[status].latestTouchDate)) acc[status].latestTouchDate = x.lastTouch;
    if (x.lastContact && (!acc[status].latestContactDate || x.lastContact > acc[status].latestContactDate || (x.lastContact === acc[status].latestContactDate && x.lastContactKind === 'phone'))) {
      acc[status].latestContactDate = x.lastContact;
      acc[status].latestContactType = x.lastContactKind;
    }
    if (x.lastCbr && (!acc[status].latestCbrDate || x.lastCbr > acc[status].latestCbrDate)) acc[status].latestCbrDate = x.lastCbr;
    return acc;
  }, {})).sort((a,b) => b.accounts - a.accounts);

  const output = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: master.generatedAt,
    caveats: [
      'Account MRR is cross-referenced from the uploaded Master Client List when a reliable account-name match is available.',
      'Account contacted = Salesforce Task classified as email/phone on the Account or related Contacts, plus matched webinar registrant company as email-confirmed.',
      'Webinar attendance is not in the current webinar export; attendance remains null until an attendance/join-duration export is available.'
    ],
    funnelStats: {
      webinarsRun: webinarEvents.length,
      cbrsSinceFirstWebinar: cbrTaskIds.size,
      accountsWithCbrSinceFirstWebinar: cbrAccountIds.size,
      contactedAccounts: contacted.length,
      accountsWithOpps: oppAccountIds.size,
      oppsCreated: (master.opportunities || []).length,
      openOpps: openOpps.length,
      wonOpps: soldOpps.length,
      currentlyOnboardingWonOpps: wonCurrentlyOnboarding.length,
      activeConversions: tigerpawGraduatedClients.length || ACTIVE_CONVERSIONS.length,
      canceledConversions: tigerpawCanceledClients.length,
      contactedNoOppAccounts: contactedNoOppAccounts.length,
      latestTouchDate,
      firstWebinarDate
    },
    wonOnboardingStats: {
      count: wonCurrentlyOnboarding.length,
      statusBreakdown: onboardingStatusBreakdown,
      rows: wonCurrentlyOnboarding
    },
    graduatedTigerpawStats: {
      count: tigerpawGraduatedClients.length,
      rows: tigerpawGraduatedClients
    },
    canceledTigerpawStats: {
      count: tigerpawCanceledClients.length,
      rows: tigerpawCanceledClients
    },
    noOppGameplan: {
      accounts: contactedNoOppAccounts.length,
      statusBreakdown: contactedNoOppStatusBreakdown,
      sampleAccounts: contactedNoOppAccounts.slice(0, 50).map(x => ({
        account: x.account,
        status: x.accountRecord?.webMigrationStatus || 'Unknown',
        owner: x.accountRecord?.owner || '',
        touchpoints: x.total,
        emailTouchpoints: x.email,
        phoneTouchpoints: x.phone,
        lastTouch: x.lastTouch,
        lastContact: x.lastContact,
        lastContactType: x.lastContactKind,
        lastCbr: x.lastCbr
      }))
    },
    webinarStats: {
      webinarsRun: webinarEvents.length,
      firstWebinarDate,
      totalExternalRegistrants: webinarEvents.reduce((s,e)=>s+(e.externalTotal||0),0),
      uniqueRegisteredCompaniesRaw: webinarCompanyNames.size,
      registeredAccountsMatchedToMigrationAccounts: webinarAccountIds.size,
      registeredAccountsPreviouslyContacted: [...webinarAccountIds].filter(id => touchByAccount[id] && (touchByAccount[id].email > 0 || touchByAccount[id].phone > 0)).length,
      attendedAccounts: null,
      attendanceSource: null,
      oppsFromRegisteredAccounts: webinarOpps.length,
      wonOppsFromRegisteredAccounts: webinarOpps.filter(o => o.isWon || o.stage === 'Closed Won').length,
      cbrsSinceFirstWebinar: cbrTaskIds.size,
      accountsWithCbrSinceFirstWebinar: cbrAccountIds.size,
      latestCbrDate,
      byEvent: webinarEvents.map(event => ({
        key: event.key,
        title: event.title,
        eventDate: event.eventDate || event.startDate || null,
        externalRegistrants: event.externalTotal || 0,
        uniqueAccounts: event.uniqueAccounts || 0
      }))
    },
    contactStats: {
      migrationAccounts: accounts.length,
      accountsContactedEmailOrPhone: contacted.length,
      accountsUnreached: unreached.length,
      totalTouchpoints: Object.values(touchByAccount).reduce((s,x)=>s+x.total,0),
      emailTouchpoints: Object.values(touchByAccount).reduce((s,x)=>s+x.email,0),
      phoneTouchpoints: Object.values(touchByAccount).reduce((s,x)=>s+x.phone,0),
      otherTouchpoints: Object.values(touchByAccount).reduce((s,x)=>s+x.other,0),
      webinarExternalRegistrants: Object.values(webinar.events || {}).reduce((s,e)=>s+(e.externalTotal||0),0),
      latestTouchDate,
      medianLastTouchDate,
      accountsTouchedLast30Days: touchedWithin(30),
      accountsTouchedLast60Days: touchedWithin(60),
      accountsTouchedLast90Days: touchedWithin(90),
      relatedMrr: money(accounts.reduce((s,a)=>s+(a.mrr||0),0)),
      accountsWithMrr: accounts.filter(a => a.mrr !== null && a.mrr !== undefined).length
    },
    conversionStats: {
      soldConversions: soldOpps.length,
      soldConversionMrr: money(soldOpps.reduce((s,o)=>s+(o.amount||0),0)),
      activeConversionsProvided: ACTIVE_CONVERSIONS.length,
      activeConversionsMatchedToSfAccounts: activeConversionRows.filter(row => row.sfAccount).length,
      activeConversionsMatchedToSfOpps: activeOpps.length,
      graduatedToCs: null
    },
    soldConversions: soldOpps.map(o => ({ account: o.account, opportunity: o.name, amount: o.amount, stage: o.stage, closeDate: o.closeDate, owner: o.owner })),
    activeConversions: activeConversionRows,
    topUnreached: unreached.slice(0, 50).map(x => ({ account: x.account, status: accountById[x.accountId]?.webMigrationStatus, owner: accountById[x.accountId]?.owner })),
    touchpointsByAccount: Object.values(touchByAccount)
  };
  fs.writeFileSync(path.join(__dirname, 'key-stats.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({contactStats: output.contactStats, conversionStats: output.conversionStats}, null, 2));
}
main().catch(err => { console.error(err); process.exit(1); });
