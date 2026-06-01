const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
});

const HS_TOKEN = process.env.HS_ACCESS_TOKEN;
const WEBINAR_NAME = 'Webinar: See it for yourself. Introducing Rev.io PSA.';
const EVENTS = [
  { key: 'may21', title: 'May 21 Webinar', eventDate: '2026-05-21T18:00:00Z' },
  { key: 'june10', title: 'June 10 Webinar', eventDate: '2026-06-10T19:00:00Z' }
];
const LAST_WEEK = { start: '2026-05-25', end: '2026-05-31' };
const CAMPAIGN_AUDIENCE = {
  '418179386': 'Ready to Migrate',
  '418566767': 'Ready to Migrate',
  '419250252': 'Ready to Migrate',
  '418566191': 'Unknown',
  '418622481': 'Unknown',
  '418777581': 'Unknown',
  '418932593': 'Unknown',
  '418954930': 'Unknown',
  '419249857': 'Unknown'
};

function requestJson(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const bodyString = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.hubapi.com',
      path: requestPath,
      method,
      headers: {
        Authorization: `Bearer ${HS_TOKEN}`,
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString)
        } : {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.message || data.slice(0, 500)));
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error(`HubSpot parse error: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyString);
    req.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getCampaignAudienceMap() {
  const emailAudience = {};
  for (const [campaignId, audience] of Object.entries(CAMPAIGN_AUDIENCE)) {
    let hasMore = true;
    let offset = null;
    while (hasMore) {
      const url = `/email/public/v1/events?campaignId=${campaignId}&eventType=SENT&limit=1000${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
      const result = await requestJson('GET', url);
      (result.events || []).forEach(event => {
        if (!event.recipient) return;
        const email = event.recipient.toLowerCase();
        if (!emailAudience[email] || audience === 'Ready to Migrate') {
          emailAudience[email] = audience;
        }
      });
      hasMore = result.hasMore;
      offset = result.offset;
      if (hasMore) await sleep(150);
    }
  }
  return emailAudience;
}

async function getRegistrants(eventDate) {
  const results = [];
  let after = null;
  do {
    const result = await requestJson('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{
        filters: [
          { propertyName: 'contrast_last_registration', operator: 'EQ', value: WEBINAR_NAME },
          { propertyName: 'contrast_last_event_date', operator: 'EQ', value: eventDate }
        ]
      }],
      properties: [
        'email',
        'firstname',
        'lastname',
        'company',
        'associatedcompanyid',
        'contrast_last_registration_date',
        'contrast_last_event_date'
      ],
      limit: 100,
      ...(after ? { after } : {})
    });
    results.push(...(result.results || []));
    after = result.paging?.next?.after || null;
    if (after) await sleep(150);
  } while (after);
  return results;
}

async function getCompanyMap(companyIds) {
  const companyMap = {};
  const uniqueIds = [...new Set(companyIds.filter(Boolean))];
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const result = await requestJson('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: uniqueIds.slice(i, i + 100).map(id => ({ id })),
      properties: ['name', 'vertical', 'industry']
    });
    (result.results || []).forEach(company => {
      companyMap[company.id] = company.properties || {};
    });
    if (i + 100 < uniqueIds.length) await sleep(150);
  }
  return companyMap;
}

function normalizeVertical(company) {
  const raw = `${company.vertical || ''} ${company.industry || ''}`.toLowerCase();
  if (raw.includes('integrat') || raw.includes('var') || raw.includes('security') || raw.includes('audio') || raw.includes('home automation') || raw.includes('cctv') || raw.includes('surveillance')) {
    return 'Integrator';
  }
  return 'MSP';
}

function displayName(properties) {
  return [properties.firstname, properties.lastname].filter(Boolean).join(' ') || properties.email || 'Unknown';
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    counts[row[key]] = (counts[row[key]] || 0) + 1;
    return counts;
  }, {});
}

async function buildEvent(eventConfig, emailAudience) {
  const contacts = await getRegistrants(eventConfig.eventDate);
  const externalContacts = contacts.filter(contact => !(contact.properties.email || '').toLowerCase().endsWith('@rev.io'));
  const companyMap = await getCompanyMap(externalContacts.map(contact => contact.properties.associatedcompanyid));

  const registrants = externalContacts.map(contact => {
    const properties = contact.properties || {};
    const email = (properties.email || '').toLowerCase();
    const company = companyMap[properties.associatedcompanyid] || {};
    return {
      name: displayName(properties),
      email,
      company: company.name || properties.company || '',
      vertical: normalizeVertical(company),
      audience: emailAudience[email] || 'Migrate Later',
      registrationDate: properties.contrast_last_registration_date || ''
    };
  }).sort((a, b) =>
    a.registrationDate.localeCompare(b.registrationDate) ||
    a.company.localeCompare(b.company) ||
    a.name.localeCompare(b.name)
  );

  const lastWeek = registrants.filter(registrant =>
    registrant.registrationDate >= LAST_WEEK.start && registrant.registrationDate <= LAST_WEEK.end
  );

  return {
    ...eventConfig,
    rawTotal: contacts.length,
    externalTotal: registrants.length,
    internalExcluded: contacts.length - externalContacts.length,
    uniqueAccounts: new Set(registrants.map(registrant => registrant.company).filter(Boolean)).size,
    byAudience: countBy(registrants, 'audience'),
    byVertical: countBy(registrants, 'vertical'),
    lastWeek: {
      ...LAST_WEEK,
      externalTotal: lastWeek.length,
      uniqueAccounts: new Set(lastWeek.map(registrant => registrant.company).filter(Boolean)).size,
      byAudience: countBy(lastWeek, 'audience'),
      byVertical: countBy(lastWeek, 'vertical'),
      registrants: lastWeek
    },
    registrants
  };
}

async function main() {
  const emailAudience = await getCampaignAudienceMap();
  const events = {};
  for (const eventConfig of EVENTS) {
    events[eventConfig.key] = await buildEvent(eventConfig, emailAudience);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    webinarName: WEBINAR_NAME,
    events
  };

  fs.writeFileSync(path.join(__dirname, 'webinar-data.json'), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(__dirname, 'june10-webinar-data.json'), JSON.stringify(events.june10, null, 2));
  console.log(JSON.stringify(events.june10, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
