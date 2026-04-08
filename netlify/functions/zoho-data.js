const https = require('https');

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCSV(csv) {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] || '');
    return obj;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

async function getAccessToken() {
  const data = `grant_type=refresh_token&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`;
  const res = await request({
    hostname: 'accounts.zoho.com',
    path: '/oauth/v2/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, data);
  return JSON.parse(res.body).access_token;
}

async function exportView(token, viewId) {
  const orgId = process.env.ZOHO_ORG_ID;
  const wsId = '3030785000000097001';

  // Start bulk export job
  const bulkRes = await request({
    hostname: 'analyticsapi.zoho.com',
    path: `/restapi/v2/bulk/workspaces/${wsId}/views/${viewId}/data`,
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'ZANALYTICS-ORGID': orgId
    }
  });

  const bulkData = JSON.parse(bulkRes.body);
  if (bulkData.status !== 'success') {
    throw new Error('Bulk export failed: ' + bulkData.summary);
  }

  const jobId = bulkData.data.jobId;

  // Poll for completion
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await request({
      hostname: 'analyticsapi.zoho.com',
      path: `/restapi/v2/bulk/workspaces/${wsId}/exportjobs/${jobId}`,
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token,
        'ZANALYTICS-ORGID': orgId
      }
    });
    const statusData = JSON.parse(statusRes.body);
    if (statusData.data?.jobStatus === 'JOB COMPLETED') {
      // Download data
      const dataRes = await request({
        hostname: 'analyticsapi.zoho.com',
        path: `/restapi/v2/bulk/workspaces/${wsId}/exportjobs/${jobId}/data`,
        headers: {
          'Authorization': 'Zoho-oauthtoken ' + token,
          'ZANALYTICS-ORGID': orgId
        }
      });
      return parseCSV(dataRes.body);
    }
  }
  throw new Error('Export job timed out');
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const token = await getAccessToken();

    const [leads, llcs, seguimientos] = await Promise.all([
      exportView(token, '3030785000001379003'),
      exportView(token, '3030785000001507660'),
      exportView(token, '3030785000001401002')
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        leads,
        llcs,
        seguimientos
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
