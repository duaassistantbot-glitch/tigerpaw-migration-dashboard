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

function clean(value, fallback = 'Unknown') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
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

function pct(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function publicAccount(account) {
  return {
    id: account.Id,
    name: account.Name,
    type: clean(account.Type, 'Blank'),
    webMigrationStatus: clean(account.Web_Migration__c, 'Blank'),
    webMigrationDetails: account.Web_Migration_Status_Details__c || '',
    accountStatus: account.TigerPaw_Account_Status__c || '',
    owner: account.Tigerpaw_Owner__c || '',
    vertical: account.Tigerpaw_Vertical__c || '',
    psaWeb: !!account.PSA_Web__c
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
    createdDate: opp.CreatedDate,
    closeDate: opp.CloseDate,
    isClosed: !!opp.IsClosed,
    isWon: !!opp.IsWon,
    lossReason: clean(opp.Loss_Reason__c, 'Unspecified'),
    lossDetail: opp.Reason_Lost_Detail__c || '',
    competitor: opp.If_Lost_to_Competitor__c || '',
    stageLoss: opp.Stage_Loss__c || ''
  };
}

async function main() {
  console.log('Authenticating with Salesforce...');
  const token = await getToken();

  console.log('Fetching active Tigerpaw client accounts...');
  const accounts = await sfQueryAll(token, `
    SELECT Id, Name, Type, Tigerpaw__c, Web_Migration__c, Web_Migration_Status_Details__c,
           TigerPaw_Account_Status__c, Tigerpaw_Vertical__c, Tigerpaw_Owner__c, PSA_Web__c
    FROM Account
    WHERE Tigerpaw__c = true
      AND (Type != 'Churn' OR Type = null)
    ORDER BY Name
  `);

  const accountIds = accounts.map(account => account.Id);
  console.log(`  Found ${accounts.length} active Tigerpaw clients`);

  const allOpps = [];
  for (let i = 0; i < accountIds.length; i += 200) {
    const chunk = accountIds.slice(i, i + 200);
    const inClause = chunk.map(id => `'${id}'`).join(',');
    console.log(`Fetching Legacy Migration opps for accounts ${i + 1}-${Math.min(i + 200, accountIds.length)}...`);
    const opps = await sfQueryAll(token, `
      SELECT Id, Name, Type, StageName, Amount, Renewal_Amount__c, AccountId, Account.Name,
             CreatedDate, CloseDate, IsClosed, IsWon, Loss_Reason__c, Reason_Lost_Detail__c,
             If_Lost_to_Competitor__c, Stage_Loss__c
      FROM Opportunity
      WHERE Type = 'Legacy Migration'
        AND AccountId IN (${inClause})
      ORDER BY CreatedDate DESC
    `);
    allOpps.push(...opps);
  }

  const publicAccounts = accounts.map(publicAccount);
  const publicOpps = allOpps.map(publicOpp);
  const closedLostOpps = publicOpps.filter(opp => opp.stage === 'Closed Lost');
  const totalAmount = publicOpps.reduce((sum, opp) => sum + opp.amount, 0);

  const statusBreakdown = groupBy(publicAccounts, account => account.webMigrationStatus).map(group => ({
    label: group.label,
    count: group.count,
    pct: pct(group.count, publicAccounts.length),
    accounts: group.records
  }));

  const stageBreakdown = groupBy(publicOpps, opp => opp.stage, opp => opp.amount).map(group => ({
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
      account: "Tigerpaw__c = true AND Type != 'Churn'",
      opportunity: "Type = 'Legacy Migration'",
      closedLost: "StageName = 'Closed Lost'"
    },
    totals: {
      tigerpawAccounts: publicAccounts.length,
      legacyMigrationOpps: publicOpps.length,
      legacyMigrationAmount: totalAmount,
      closedLostOpps: closedLostOpps.length
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
