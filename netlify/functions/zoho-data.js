const https = require('https');

/*
 * zoho-data.js — Dashboard data source for Start Companies metrics panel.
 *
 * The "LEAD TOTALES Y FLUJOS" Analytics view was DELETED, so the `leads`
 * dataset is now rebuilt DIRECTLY from the Zoho CRM API (Leads + Events
 * modules) with derivation rules reverse-engineered from a ground-truth
 * snapshot (validated 90-99% per column).
 *
 * The "LLCs Apertura Mes Actual" and "Seguimientos" Analytics views are
 * still alive and authoritative (they carry derived columns such as
 * `Canal de Origen` that cannot be reconstructed from the live CRM API,
 * because converted Leads are removed and Campaign_Source is not exposed),
 * so those two are still exported from Analytics.
 *
 * Output shape is unchanged so the frontend works without modification:
 *   { timestamp, leads:[...], llcs:[...], seguimientos:[...] }
 */

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CSV parsing (for the surviving Analytics views)
// ---------------------------------------------------------------------------
function parseCSV(csv) {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0].replace(/^﻿/, ''));
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
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function getAccessToken() {
  const data = `grant_type=refresh_token&client_id=${process.env.ZOHO_CLIENT_ID}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`;
  const res = await request({
    hostname: 'accounts.zoho.com',
    path: '/oauth/v2/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, data);
  const j = JSON.parse(res.body);
  if (!j.access_token) throw new Error('Token error: ' + res.body);
  return j.access_token;
}

// ---------------------------------------------------------------------------
// Zoho CRM (REST v2) — paginated GET with rate-limit handling
// ---------------------------------------------------------------------------
function crmGet(token, path) {
  return request({
    hostname: 'www.zohoapis.com',
    path: '/crm/v2/' + path,
    method: 'GET',
    headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
  }).then(r => {
    let json = null;
    try { json = JSON.parse(r.body); } catch (e) { /* 204 No Content => empty */ }
    return { statusCode: r.statusCode, json };
  });
}

// Paginate a module sorted by Created_Time desc, stopping as soon as records
// fall before `since`. This keeps us to a few pages (current window) instead of
// pulling the whole module — important to stay under the Netlify function timeout.
async function crmGetSince(token, module, fields, since, maxPages = 60) {
  const out = [];
  let page = 1;
  while (page <= maxPages) {
    const path = `${module}?fields=${encodeURIComponent(fields)}&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc`;
    const r = await crmGet(token, path);
    // rate limited -> back off and retry the same page
    if (r.statusCode === 429 || (r.json && r.json.code === 'TOO_MANY_REQUESTS')) {
      await new Promise(res => setTimeout(res, 3000));
      continue;
    }
    if (r.statusCode === 204 || !r.json || !r.json.data) break;
    let reachedOld = false;
    for (const rec of r.json.data) {
      if (rec.Created_Time && new Date(rec.Created_Time) < since) { reachedOld = true; break; }
      out.push(rec);
    }
    if (reachedOld) break;
    if (!r.json.info || !r.json.info.more_records) break;
    page++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zoho Analytics — bulk export of a view to CSV (for surviving views)
// ---------------------------------------------------------------------------
async function exportView(token, viewId) {
  const orgId = process.env.ZOHO_ORG_ID;
  const wsId = '3030785000000097001';
  const cfg = encodeURIComponent(JSON.stringify({ responseFormat: 'csv' }));

  const headers = { 'Authorization': 'Zoho-oauthtoken ' + token, 'ZANALYTICS-ORGID': orgId };

  const bulkRes = await request({
    hostname: 'analyticsapi.zoho.com',
    path: `/restapi/v2/bulk/workspaces/${wsId}/views/${viewId}/data?CONFIG=${cfg}`,
    headers
  });
  const bulkData = JSON.parse(bulkRes.body);
  if (bulkData.status !== 'success') throw new Error('Bulk export failed: ' + bulkRes.body);
  const jobId = bulkData.data.jobId;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await request({
      hostname: 'analyticsapi.zoho.com',
      path: `/restapi/v2/bulk/workspaces/${wsId}/exportjobs/${jobId}`,
      headers
    });
    let statusData;
    try { statusData = JSON.parse(statusRes.body); } catch (e) { continue; }
    if (statusData.data && statusData.data.jobStatus === 'JOB COMPLETED') {
      const dataRes = await request({
        hostname: 'analyticsapi.zoho.com',
        path: `/restapi/v2/bulk/workspaces/${wsId}/exportjobs/${jobId}/data`,
        headers
      });
      return parseCSV(dataRes.body);
    }
  }
  throw new Error('Export job timed out');
}

// ---------------------------------------------------------------------------
// Leads derivation (rebuilt from CRM Leads + Events)
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a CRM datetime to the Analytics display "Apr 22, 2026 01:19 AM".
// CRM returns ISO8601 already in the org's local offset (e.g. ...T01:19:32-03:00),
// so we read the calendar fields straight from the string. This keeps Argentina
// local time regardless of the (UTC) server timezone Netlify runs in.
function fmtDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  const [, Y, Mo, D, H, Min] = m;
  let h = parseInt(H, 10);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${MONTHS[parseInt(Mo, 10) - 1]} ${D}, ${Y} ${String(h).padStart(2, '0')}:${Min} ${ap}`;
}

// Resolve the latest meeting state for a lead from its related Events.
// Event.Status_del_Meet: Asistió | No asistió | Reagendar | Asistió sin interes | (empty)
function meetingState(events) {
  if (!events || !events.length) return 'Sin meeting';
  const withStatus = events.filter(e => e.Status_del_Meet);
  const pool = withStatus.length ? withStatus : events;
  const chosen = pool.slice().sort((a, b) =>
    new Date(b.Start_DateTime || b.Created_Time) - new Date(a.Start_DateTime || a.Created_Time))[0];
  const st = chosen.Status_del_Meet;
  if (st === 'No asistió') return 'No Asistió';
  if (st === 'Reagendar') return 'Reagendó';
  if (st === 'Asistió' || st === 'Asistió sin interes') return 'Asistió';
  return 'Sin información';
}

function deriveCanal(lead) {
  const src = lead.Lead_Source;
  if (!src) return 'NO SE ASIGNÓ CANAL';
  // Meta Ads splits: leads with a Tipo (service) come from the apertura capture form;
  // leads without a Tipo come from the LiliBank form.
  if (src === 'Meta Ads') return lead.Tipo ? 'Forma Captación Apertura' : 'Form LiliBank';
  return src;
}

function deriveCalificacion(lead, agendo, mstate) {
  const st = lead.Lead_Status;
  if (st === 'SQL Calificado') return 'SQL Calificado';
  if (st === 'No Calificado' || st === 'No Interesado') return 'No Calificado';
  if (st === 'No Show') return 'No Show';
  if (st === 'Retargeting') return 'No Show';            // retargeting implies a prior no-show
  if (agendo === 'No') return st ? 'Form Nunca Agendó' : 'No se detectó';
  // agendó === 'Sí'
  if (mstate === 'No Asistió') return 'No Show';
  if (st === 'En Calificación') return 'En Calificación';
  return 'Sin clasificar';
}

function derivePosibilidad(lead, agendo) {
  const st = lead.Lead_Status;
  if (st === 'SQL Calificado') return 'Sí';
  if (st === 'Retargeting') return 'No';
  if (agendo === 'No') return 'Seguimiento';
  return 'Sí';
}

function deriveModalidad(lead, agendo) {
  if (lead.Lead_Status === 'SQL Calificado') return 'Retargeting';
  return agendo === 'No' ? 'Formulario Directo' : 'Cierre en Llamada';
}

// Build the `leads` dataset from CRM, restricted to the relevant recent window.
// Window default = current calendar month (this is what the deleted Analytics
// view did). Override with ZOHO_LEADS_SINCE=YYYY-MM-DD to widen the window.
async function buildLeads(token) {
  const leadFields = [
    'First_Name', 'Last_Name', 'Full_Name', 'Email', 'Phone', 'Mobile',
    'Lead_Source', 'Lead_Status', 'Created_Time', 'Description', 'Tipo',
    'Owner', 'Retargeting'
  ].join(',');
  const eventFields = ['Who_Id', 'What_Id', 'Start_DateTime', 'Status_del_Meet', 'Created_Time'].join(',');

  // Determine the window start (default = first day of current month; the deleted
  // Analytics view behaved this way). Override with ZOHO_LEADS_SINCE=YYYY-MM-DD.
  let since;
  if (process.env.ZOHO_LEADS_SINCE) {
    since = new Date(process.env.ZOHO_LEADS_SINCE + 'T00:00:00-03:00');
  } else {
    const now = new Date();
    since = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0); // first day of current month
  }

  // Events for in-window leads are created on/after the lead, so fetching events
  // back to the same window covers them (with a small safety margin).
  const evSince = new Date(since.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [leads, events] = await Promise.all([
    crmGetSince(token, 'Leads', leadFields, since),
    crmGetSince(token, 'Events', eventFields, evSince)
  ]);

  // Index events by their related record id (What_Id is the Lead/Contact lookup).
  const evById = {};
  events.forEach(ev => {
    const id = (ev.What_Id && ev.What_Id.id) || (ev.Who_Id && ev.Who_Id.id);
    if (id) (evById[id] = evById[id] || []).push(ev);
  });

  return leads
    .filter(l => l.Created_Time && new Date(l.Created_Time) >= since)
    .sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time))
    .map(l => {
      const evs = evById[l.id] || [];
      const agendo = evs.length ? 'Sí' : 'No';
      const mstate = meetingState(evs);
      return {
        'Fecha': fmtDate(l.Created_Time),
        'Servicio': l.Tipo || 'NO SE ASIGNÓ SERVICIO',
        'Nombre y Apellido': l.Full_Name || '',
        'Canal': deriveCanal(l),
        'Calificación': deriveCalificacion(l, agendo, mstate),
        'Teléfono': l.Phone || '',
        'Móvil': l.Mobile || '',
        'Mail': l.Email || '',
        '¿Agendó?': agendo,
        '¿Se contactó por WhatsApp?': l.Retargeting === true ? 'Sí' : 'No',
        'Posibilidad de cierre': derivePosibilidad(l, agendo),
        'Modalidad de cierre': deriveModalidad(l, agendo),
        'Vendedor asignado': (l.Owner && l.Owner.name) || '',
        'Descripción (antes de contactar)': l.Description || ''
      };
    });
}

// ---------------------------------------------------------------------------
// Handler with 5-min in-memory cache + stale-on-error fallback (unchanged)
// ---------------------------------------------------------------------------
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const LLCS_VIEW_ID = '3030785000001507660';          // "LLCs Apertura Mes Actual" (still live)
const SEGUIMIENTOS_VIEW_ID = '3030785000001401002';  // "Seguimientos" (still live)

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
    if (cache && (Date.now() - cacheTimestamp) < CACHE_TTL) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: cache };
    }

    const token = await getAccessToken();

    const [leads, llcs, seguimientos] = await Promise.all([
      buildLeads(token),                       // CRM-derived (view deleted)
      exportView(token, LLCS_VIEW_ID),         // surviving Analytics view
      exportView(token, SEGUIMIENTOS_VIEW_ID)  // surviving Analytics view
    ]);

    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      leads,
      llcs,
      seguimientos
    });

    cache = body;
    cacheTimestamp = Date.now();

    return { statusCode: 200, headers: { ...headers, 'X-Cache': 'MISS' }, body };
  } catch (err) {
    if (cache) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'STALE' }, body: cache };
    }
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
