const fs = require('fs');
const path = require('path');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map(header => header.replace(/^\uFEFF/, ''));
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}
function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}
const STOP = new Set('communications communication telecom telecommunications technologies technology systems system inc incorporated llc ltd limited co corp corporation service services solutions security group company the and of dba fka c o voice data'.split(' '));
function norm(value) { return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
function compact(value) { return norm(value).replace(/\s+/g, ''); }
function tokens(value) { return norm(value).split(' ').filter(token => token && !STOP.has(token)); }
function score(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (compact(a) === compact(b)) return 97;
  const at = tokens(a), bt = tokens(b);
  if (!at.length || !bt.length) return 0;
  const A = new Set(at), B = new Set(bt);
  const intersection = [...A].filter(token => B.has(token));
  if (!intersection.length) return 0;
  const unionSize = new Set([...at, ...bt]).size;
  const jaccard = unionSize ? intersection.length / unionSize : 0;
  const smaller = at.length <= bt.length ? at : bt;
  const otherSet = at.length <= bt.length ? B : A;
  const subset = smaller.length >= 1 && smaller.every(token => otherSet.has(token));
  let value = Math.round(jaccard * 80);
  if (subset) value = Math.max(value, smaller.length === 1 ? 82 : 92);
  if (intersection.length >= 2) value += 8;
  return Math.min(value, 99);
}
function mrrRow(row) {
  return {
    accountMrr: parseMoney(row['Average MRR']),
    averageMrr: parseMoney(row['Average MRR']),
    billingMrr: parseMoney(row['Billing MRR']),
    odinMrr: parseMoney(row['Odin MRR']),
    psaWebMrr: parseMoney(row['PSA Web MRR']),
    paymentsMrr: parseMoney(row['Payments MRR']),
    tigerpawMrr: parseMoney(row['Tigerpaw MRR']),
    sourceClient: row.Client || '',
    sourceCustomerId: row.Customer_ID || '',
    sourceProduct: row['Rev.io Product'] || '',
    sourceStatus: row.Status || ''
  };
}
function bestMatch(account, rows) {
  const candidates = rows.map(row => ({ row, score: score(account.name, row.Client) }))
    .filter(candidate => candidate.score >= 82)
    .sort((a, b) => b.score - a.score || String(a.row.Client).localeCompare(String(b.row.Client)));
  return candidates[0] || null;
}
function attachToAccount(account, match) {
  const mrr = match ? mrrRow(match.row) : null;
  account.mrr = mrr?.accountMrr ?? null;
  account.averageMrr = mrr?.averageMrr ?? null;
  account.billingMrr = mrr?.billingMrr ?? null;
  account.odinMrr = mrr?.odinMrr ?? null;
  account.psaWebMrr = mrr?.psaWebMrr ?? null;
  account.paymentsMrr = mrr?.paymentsMrr ?? null;
  account.tigerpawMrr = mrr?.tigerpawMrr ?? null;
  account.mrrSourceClient = mrr?.sourceClient || '';
  account.mrrSourceCustomerId = mrr?.sourceCustomerId || '';
  account.mrrSourceProduct = mrr?.sourceProduct || '';
  account.mrrMatchScore = match?.score || 0;
}

const dir = __dirname;
const masterPath = path.join(dir, 'master-data.json');
const keyStatsPath = path.join(dir, 'key-stats.json');
const csvPath = process.argv[2] || path.join(dir, 'client-master-mrr.csv');
const rows = parseCsv(fs.readFileSync(csvPath, 'utf8')).filter(row => row.Client);
const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
let matched = 0;
for (const account of master.accounts || []) {
  const match = bestMatch(account, rows);
  if (match) matched++;
  attachToAccount(account, match);
}
const enrichedAccountById = new Map((master.accounts || []).map(account => [account.id, account]));
for (const group of master.statusBreakdown || []) {
  group.accounts = (group.accounts || []).map(account => enrichedAccountById.get(account.id) || account);
  group.mrr = group.accounts.reduce((sum, account) => sum + (account.mrr || 0), 0);
}
master.filters = master.filters || {};
master.filters.mrr = `Cross-referenced from ${path.basename(csvPath)} (${matched} matched of ${(master.accounts || []).length} accounts)`;
master.totals = master.totals || {};
master.totals.accountMrr = (master.accounts || []).reduce((sum, account) => sum + (account.mrr || 0), 0);
master.totals.accountsWithMrr = (master.accounts || []).filter(account => account.mrr !== null && account.mrr !== undefined).length;
fs.writeFileSync(masterPath, JSON.stringify(master, null, 2));

if (fs.existsSync(keyStatsPath)) {
  const keyStats = JSON.parse(fs.readFileSync(keyStatsPath, 'utf8'));
  const byId = new Map((master.accounts || []).map(account => [account.id, account]));
  for (const touch of keyStats.touchpointsByAccount || []) touch.mrr = byId.get(touch.accountId)?.mrr ?? null;
  const oppAccountIds = new Set((master.opportunities || []).map(opp => opp.accountId).filter(Boolean));
  const accountById = enrichedAccountById;
  for (const row of keyStats.noOppGameplan?.statusBreakdown || []) {
    row.mrr = (keyStats.touchpointsByAccount || [])
      .filter(touch => ((accountById.get(touch.accountId)?.webMigrationStatus || 'Unknown') === row.status) && !oppAccountIds.has(touch.accountId) && ((touch.email || 0) > 0 || (touch.phone || 0) > 0))
      .reduce((sum, touch) => sum + (accountById.get(touch.accountId)?.mrr || 0), 0);
  }
  keyStats.contactStats = keyStats.contactStats || {};
  keyStats.contactStats.relatedMrr = master.totals.accountMrr;
  keyStats.contactStats.accountsWithMrr = master.totals.accountsWithMrr;
  keyStats.caveats = (keyStats.caveats || []).filter(note => !/Client Master\/MRR databases|account MRR are left/i.test(note));
  keyStats.caveats.unshift(`Account MRR is cross-referenced from ${path.basename(csvPath)} (${matched} matched of ${(master.accounts || []).length} dashboard accounts).`);
  fs.writeFileSync(keyStatsPath, JSON.stringify(keyStats, null, 2));
}
console.log(JSON.stringify({ csvRows: rows.length, dashboardAccounts: (master.accounts || []).length, matched, accountMrr: master.totals.accountMrr, accountsWithMrr: master.totals.accountsWithMrr }, null, 2));
