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
const NOTION_DATABASE_ID = process.env.NOTION_ROADMAP_DATABASE_ID || '2a8a59b7-e7b2-8009-9371-f50bc2d4db48';

function sfHost() {
  return new URL(INSTANCE_URL).hostname;
}

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error || parsed[0]?.errorCode) {
            reject(new Error(JSON.stringify(parsed).slice(0, 500)));
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error(`Parse error: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;

  try {
    const configPath = '/home/openclaw/.openclaw/openclaw.json';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.mcp?.servers?.notionApi?.env?.NOTION_TOKEN || '';
  } catch (err) {
    return '';
  }
}

async function notionRequest(token, pathPart, body) {
  const payload = body ? JSON.stringify(body) : '';
  return requestJson({
    hostname: 'api.notion.com',
    path: pathPart,
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
}

async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  }).toString();

  const result = await requestJson({
    hostname: sfHost(),
    path: '/services/oauth2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  return result.access_token;
}

async function sfQuery(token, soqlOrPath) {
  const pathPart = soqlOrPath.startsWith('/services/')
    ? soqlOrPath
    : '/services/data/v59.0/query?q=' + encodeURIComponent(soqlOrPath);

  return requestJson({
    hostname: sfHost(),
    path: pathPart,
    headers: { Authorization: `Bearer ${token}` }
  });
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

const MRR_STOP_TOKENS = new Set('communications communication telecom telecommunications technologies technology systems system inc incorporated llc ltd limited co corp corporation service services solutions security group company the and of dba fka c o voice data'.split(' '));
function mrrNorm(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}
function mrrCompact(value) { return mrrNorm(value).replace(/\s+/g, ''); }
function mrrMeaningfulTokens(value) {
  return mrrNorm(value).split(' ').filter(token => token && !MRR_STOP_TOKENS.has(token));
}
function mrrMatchScore(a, b) {
  const na = mrrNorm(a), nb = mrrNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (mrrCompact(a) === mrrCompact(b)) return 97;
  const at = mrrMeaningfulTokens(a);
  const bt = mrrMeaningfulTokens(b);
  if (!at.length || !bt.length) return 0;
  const aSet = new Set(at), bSet = new Set(bt);
  const intersection = [...aSet].filter(token => bSet.has(token));
  if (!intersection.length) return 0;
  const unionSize = new Set([...at, ...bt]).size;
  const jaccard = unionSize ? intersection.length / unionSize : 0;
  const smaller = at.length <= bt.length ? at : bt;
  const otherSet = at.length <= bt.length ? bSet : aSet;
  const subset = smaller.length >= 1 && smaller.every(token => otherSet.has(token));
  let score = Math.round(jaccard * 80);
  if (subset) score = Math.max(score, smaller.length === 1 ? 82 : 92);
  if (intersection.length >= 2) score += 8;
  return Math.min(score, 99);
}

function loadMrrLookup() {
  const csvPath = path.join(__dirname, 'client-master-mrr.csv');
  if (!fs.existsSync(csvPath)) return { enrich(account) { return account; }, summary: { matched: 0, source: null } };
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'))
    .map(row => ({
      client: row.Client || '',
      customerId: row.Customer_ID || '',
      averageMrr: parseMoney(row['Average MRR']),
      billingMrr: parseMoney(row['Billing MRR']),
      odinMrr: parseMoney(row['Odin MRR']),
      psaWebMrr: parseMoney(row['PSA Web MRR']),
      paymentsMrr: parseMoney(row['Payments MRR']),
      tigerpawMrr: parseMoney(row['Tigerpaw MRR']),
      product: row['Rev.io Product'] || '',
      status: row.Status || ''
    }))
    .filter(row => row.client);

  let matched = 0;
  return {
    summary: { matched: 0, rows: rows.length, source: 'client-master-mrr.csv' },
    enrich(account) {
      const candidates = rows.map(row => ({ row, score: mrrMatchScore(account.Name, row.client) }))
        .filter(candidate => candidate.score >= 82)
        .sort((a, b) => b.score - a.score || String(a.row.client).localeCompare(String(b.row.client)));
      const best = candidates[0];
      if (!best) return { ...account, __mrr: null };
      matched++;
      this.summary.matched = matched;
      return {
        ...account,
        __mrr: {
          accountMrr: best.row.averageMrr,
          averageMrr: best.row.averageMrr,
          billingMrr: best.row.billingMrr,
          odinMrr: best.row.odinMrr,
          psaWebMrr: best.row.psaWebMrr,
          paymentsMrr: best.row.paymentsMrr,
          tigerpawMrr: best.row.tigerpawMrr,
          sourceClient: best.row.client,
          sourceCustomerId: best.row.customerId,
          sourceProduct: best.row.product,
          matchScore: best.score
        }
      };
    }
  };
}

function clean(value, fallback = 'Unknown') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function notionText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return prop.title.map(part => part.plain_text).join('');
  if (prop.type === 'rich_text') return prop.rich_text.map(part => part.plain_text).join('');
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'multi_select') return prop.multi_select.map(item => item.name).join(', ');
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'formula') return prop.formula?.string || String(prop.formula?.number ?? prop.formula?.boolean ?? '');
  return '';
}

async function fetchRoadmapItems() {
  const token = getNotionToken();
  if (!token) {
    console.warn('No Notion token found; skipping Viking One roadmap enrichment.');
    return [];
  }

  const items = [];
  let cursor = null;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const result = await notionRequest(token, `/v1/databases/${NOTION_DATABASE_ID}/query`, body);
    items.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);

  return items.map(page => {
    const props = page.properties || {};
    return {
      id: page.id,
      url: page.url,
      feature: notionText(props.Feature),
      release: notionText(props.Release),
      status: notionText(props['Feature Status']),
      description: notionText(props.Description),
      marketingDescription: notionText(props['Marketing Description'])
    };
  });
}

function currencyValue(opp) {
  return Number(opp.Renewal_Amount__c || opp.Amount || 0);
}

function groupBy(records, keyFn, valueFn) {
  const groups = new Map();
  records.forEach(record => {
    const key = clean(keyFn(record));
    if (!groups.has(key)) groups.set(key, { label: key, count: 0, amount: 0, records: [] });
    const group = groups.get(key);
    group.count += 1;
    group.amount += valueFn ? valueFn(record) : 0;
    group.records.push(record);
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function stageSortValue(label) {
  const value = clean(label, 'Unknown');
  const numbered = value.match(/^(\d+)/);
  if (numbered) return Number(numbered[1]);
  if (value === 'Closed Lost') return 100;
  if (value === 'Closed Won') return 101;
  return 1000;
}

function sortStageGroups(groups) {
  return groups.sort((a, b) =>
    stageSortValue(a.label) - stageSortValue(b.label) ||
    a.label.localeCompare(b.label)
  );
}

function pct(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function webMigrationStatus(account) {
  return clean(account.Web_Migration__c, 'Blank');
}

function roadmapMatcher(roadmapItems) {
  const vikingOneItems = roadmapItems.filter(item => /viking\s*(1|one)\b/i.test(item.release || ''));

  function findFeatures(patterns) {
    return vikingOneItems.map(item => {
      const haystack = normalize([
        item.feature,
        item.description,
        item.marketingDescription
      ].join(' '));
      const matchIndex = patterns.findIndex(pattern => pattern.test(haystack));
      return { item, matchIndex };
    })
      .filter(match => match.matchIndex >= 0)
      .sort((a, b) => a.matchIndex - b.matchIndex)
      .map(match => match.item)
      .slice(0, 4);
  }

  function formatMatch(item) {
    return {
      feature: item.feature,
      release: item.release,
      status: item.status,
      detail: item.marketingDescription || item.description
    };
  }

  return function classifyVikingOneUnlock(opp) {
    if (opp.stage !== 'Closed Lost') return null;

    const text = normalize([opp.lossReason, opp.lossDetail].join(' '));

    function result(status, summary, patterns) {
      return {
        status,
        summary,
        matches: findFeatures(patterns).map(formatMatch)
      };
    }

    if (/password|pw keeper|keeper|credential/.test(text)) {
      return result('Yes', 'Credential vault/password management is in Viking 1.', [/credential vault/, /password/]);
    }

    if (/pricing rules|dispatch|payroll/.test(text)) {
      return result('Partial', 'Dispatch and payroll-adjacent QBD time export work is in Viking 1; pricing rules are not a clear match.', [/dispatch board/, /time log export/]);
    }

    if (/data usage|contract expiration|contracts|agreements|notifications/.test(text)) {
      return result('Partial', 'Agreement and notification work is in Viking 1, but data-usage-through-contracts is not an exact roadmap match.', [/agreement/, /notification/]);
    }

    if (/qbd|quickbooks|quick books|g l|gl code/.test(text)) {
      return result('Yes', 'QuickBooks Desktop export and GL mapping work is in Viking 1.', [/qbd/, /quickbooks desktop/, /gl account/]);
    }

    if (/d tools|quote import/.test(text)) {
      return result('Partial', 'Quote search improvements are in Viking 1; D-Tools quotes are listed for Viking 2.', [/product search by part number/]);
    }

    if (/meter billing|metered|qb desktop/.test(text)) {
      return result('Partial', 'Metered usage rating and QBD work appear in Viking 1, but full meter billing plus QBD is broader than one item.', [/metered usage/, /qbd/, /quickbooks desktop/]);
    }

    if (/part number|p n|item id|customer facing doc/.test(text)) {
      return result('Partial', 'Part-number quote search is in Viking 1; customer-facing document Item ID display is not an exact match.', [/product search by part number/, /proposal options/]);
    }

    if (/child billing|quote reports/.test(text)) {
      return {
        status: 'No clear match',
        summary: 'No clear Viking 1 roadmap item found for child billing or quote reports.',
        matches: []
      };
    }

    if (/not ready|not the right time|october|jan|non responsive|stopped responding|decision maker|no show|duplicate/.test(text)) {
      return {
        status: 'No',
        summary: 'Loss reason is timing, engagement, or duplicate rather than a Viking 1 feature blocker.',
        matches: []
      };
    }

    return {
      status: 'Review',
      summary: 'Needs manual review against the Viking 1 roadmap.',
      matches: []
    };
  };
}

function enrichOppsWithRoadmap(opps, roadmapItems) {
  const classify = roadmapMatcher(roadmapItems);
  return opps.map(opp => ({
    ...opp,
    vikingOneUnlock: classify(opp)
  }));
}

function publicAccount(account) {
  const psaAccountStatus = account.TigerPaw_Account_Status__c || '';
  const mrr = account.__mrr || null;
  return {
    id: account.Id,
    name: account.Name,
    type: clean(account.Type, 'Blank'),
    webMigrationStatus: webMigrationStatus(account),
    webMigrationDetails: account.Web_Migration_Status_Details__c || '',
    psaAccountStatus,
    // Backward-compatible alias for older dashboard/data consumers.
    accountStatus: psaAccountStatus,
    owner: account.Owner?.Name || account.Tigerpaw_Owner__c || '',
    vertical: account.Tigerpaw_Vertical__c || '',
    psaWeb: !!account.PSA_Web__c,
    mrr: mrr?.accountMrr ?? null,
    averageMrr: mrr?.averageMrr ?? null,
    billingMrr: mrr?.billingMrr ?? null,
    odinMrr: mrr?.odinMrr ?? null,
    psaWebMrr: mrr?.psaWebMrr ?? null,
    paymentsMrr: mrr?.paymentsMrr ?? null,
    tigerpawMrr: mrr?.tigerpawMrr ?? null,
    mrrSourceClient: mrr?.sourceClient || '',
    mrrSourceCustomerId: mrr?.sourceCustomerId || '',
    mrrSourceProduct: mrr?.sourceProduct || '',
    mrrMatchScore: mrr?.matchScore || 0
  };
}

function publicOpp(opp) {
  return {
    id: opp.Id,
    name: opp.Name,
    accountId: opp.AccountId,
    account: opp.Account?.Name || '',
    stage: clean(opp.StageName, 'Unknown'),
    amount: currencyValue(opp),
    owner: opp.Owner?.Name || '',
    nextStep: opp.NextStep || '',
    createdDate: opp.CreatedDate,
    closeDate: opp.CloseDate,
    isClosed: !!opp.IsClosed,
    isWon: !!opp.IsWon,
    lossReason: clean(opp.Loss_Reason__c, 'Unspecified'),
    lossDetail: opp.Reason_Lost_Detail__c || '',
    competitor: opp.If_Lost_to_Competitor__c || '',
    stageLoss: opp.Stage_Loss__c || '',
    smc: opp.Strategic_Partner_Source__c || ''
  };
}

async function main() {
  console.log('Authenticating with Salesforce...');
  const token = await getToken();

  console.log('Fetching Notion roadmap for Viking One enrichment...');
  const roadmapItems = await fetchRoadmapItems();
  console.log(`  Found ${roadmapItems.length} roadmap items`);

  const mrrLookup = loadMrrLookup();

  console.log('Fetching accounts with Web Migration Status populated...');
  const accounts = (await sfQueryAll(token, `
    SELECT Id, Name, Type, Tigerpaw__c, Web_Migration__c, Web_Migration_Status_Details__c,
           TigerPaw_Account_Status__c, Tigerpaw_Vertical__c, Tigerpaw_Owner__c, PSA_Web__c, Owner.Name
    FROM Account
    WHERE Web_Migration__c != null
    ORDER BY Name
  `)).map(account => mrrLookup.enrich(account));

  const accountIds = accounts.map(account => account.Id);
  console.log(`  Found ${accounts.length} accounts with Web Migration Status populated`);

  const allOpps = [];
  for (let i = 0; i < accountIds.length; i += 200) {
    const chunk = accountIds.slice(i, i + 200);
    const inClause = chunk.map(id => `'${id}'`).join(',');
    console.log(`Fetching Legacy Migration opps for accounts ${i + 1}-${Math.min(i + 200, accountIds.length)}...`);
    const opps = await sfQueryAll(token, `
      SELECT Id, Name, Type, StageName, Amount, Renewal_Amount__c, AccountId, Account.Name,
             Owner.Name, NextStep, CreatedDate, CloseDate, IsClosed, IsWon, Loss_Reason__c,
             Reason_Lost_Detail__c, If_Lost_to_Competitor__c, Stage_Loss__c,
             Strategic_Partner_Source__c
      FROM Opportunity
      WHERE Type = 'Legacy Migration'
        AND AccountId IN (${inClause})
      ORDER BY CreatedDate DESC
    `);
    allOpps.push(...opps);
  }

  const publicAccounts = accounts.map(publicAccount);
  const publicOpps = enrichOppsWithRoadmap(allOpps.map(publicOpp), roadmapItems);
  const closedLostOpps = publicOpps.filter(opp => opp.stage === 'Closed Lost');
  const totalAmount = publicOpps.reduce((sum, opp) => sum + opp.amount, 0);

  const statusBreakdown = groupBy(publicAccounts, account => account.webMigrationStatus, account => account.mrr || 0).map(group => ({
    label: group.label,
    count: group.count,
    mrr: group.amount,
    pct: pct(group.count, publicAccounts.length),
    accounts: group.records
  }));

  const stageBreakdown = sortStageGroups(groupBy(publicOpps, opp => opp.stage, opp => opp.amount)).map(group => ({
    label: group.label,
    count: group.count,
    amount: group.amount,
    pct: pct(group.count, publicOpps.length),
    opportunities: group.records
  }));

  const lossBreakdown = groupBy(closedLostOpps, opp => opp.lossReason, opp => opp.amount).map(group => ({
    label: group.label,
    count: group.count,
    amount: group.amount,
    opportunities: group.records
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    filters: {
      account: "Web_Migration__c != null",
      mrr: `Cross-referenced from ${mrrLookup.summary.source || 'no local MRR CSV'} (${mrrLookup.summary.matched || 0} matched of ${publicAccounts.length} accounts)`,
      opportunity: "Type = 'Legacy Migration'",
      closedLost: "StageName = 'Closed Lost'"
    },
    totals: {
      tigerpawAccounts: publicAccounts.length,
      legacyMigrationOpps: publicOpps.length,
      legacyMigrationAmount: totalAmount,
      closedLostOpps: closedLostOpps.length,
      accountMrr: publicAccounts.reduce((sum, account) => sum + (account.mrr || 0), 0),
      accountsWithMrr: publicAccounts.filter(account => account.mrr !== null && account.mrr !== undefined).length
    },
    statusBreakdown,
    stageBreakdown,
    lossBreakdown,
    accounts: publicAccounts,
    opportunities: publicOpps
  };

  fs.writeFileSync(path.join(__dirname, 'master-data.json'), JSON.stringify(output, null, 2));
  console.log('Saved master-data.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
