const https = require('https');
const { cabeceras, exigirAuth } = require('../lib/auth');

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

// Fetch one page of a module sorted by Created_Time desc, retrying on rate limit.
async function crmGetPage(token, module, fields, page) {
  const path = `${module}?fields=${encodeURIComponent(fields)}&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await crmGet(token, path);
    // rate limited -> back off and retry the same page
    if (r.statusCode === 429 || (r.json && r.json.code === 'TOO_MANY_REQUESTS')) {
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    if (r.statusCode === 204 || !r.json || !r.json.data) return null;
    return r.json;
  }
  return null;
}

// Paginate a module sorted by Created_Time desc, stopping as soon as records
// fall before `since`. Pages are fetched in small parallel batches: sequential
// paging costs ~25s for a 12-month window (over the Netlify function timeout),
// batching brings the same window down to ~7s. The cost is up to batchSize-1
// wasted pages past the cutoff, which is cheap compared to the latency saved.
async function crmGetSince(token, module, fields, since, maxPages = 80, batchSize = 4) {
  const out = [];
  let page = 1;
  let done = false;
  while (page <= maxPages && !done) {
    const nums = [];
    for (let i = 0; i < batchSize && page + i <= maxPages; i++) nums.push(page + i);
    const pages = await Promise.all(nums.map(p => crmGetPage(token, module, fields, p)));
    for (const json of pages) {
      if (!json) { done = true; break; }
      let reachedOld = false;
      for (const rec of json.data) {
        if (rec.Created_Time && new Date(rec.Created_Time) < since) { reachedOld = true; break; }
        out.push(rec);
      }
      if (reachedOld || !json.info || !json.info.more_records) { done = true; break; }
    }
    page += batchSize;
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

// ---------------------------------------------------------------------------
// Atribución de landing
//
// Diccionario tomado de "MAPA AGENDAS LANDINGS - ATRIBUCION.csv". Zoho guarda el
// path de la landing en `Calendario` y el calendario de Cal.com usado en el
// `Event_Title` del meeting, así que entre los dos se puede decir de dónde vino
// cada lead en lugar del genérico "Landing Page".
// ---------------------------------------------------------------------------
const MAPA_LANDING = {
  'asesoria-llc': 'Meta Ads',
  'presentacion': 'Meta Ads',
  'llc-7-dias': 'Meta Ads',
  'abre-tu-llc': 'Meta Ads',
  'agendamientoform': 'Meta Ads',
  'abre-tu-llc-ads': 'Reddit',
  'reddit-llc': 'Reddit',
  'abrir-llc-estados-unidos': 'YouTube Ads',
  'calendarioyoutube': 'YouTube Ads',
  'crear-llc-usa': 'Google Ads',
  'calendariogoogle': 'Google Ads',
  'agenda-organica': 'Web Orgánica',
  'consulta-gratuita': 'Web Orgánica',
  'agendaorganica': 'WhatsApp / Manual',
  'agenda-ignacio': 'Marca Personal',
  'agendaignacio': 'Marca Personal',
  'agendaclientes': 'Cliente actual',
  'agenda-consulta-clientes': 'Cliente actual',
  'reunion-gratuita': 'Partner',
  'calendario-cole-startcompanies': 'Partner',
  'calendario-crea-tu-llc': 'SEO Satélite',
  'creatullc': 'SEO Satélite',
  'consulta-mailcamp': 'Email Marketing',
  'ai-event': 'Evento / AI',
  'apertura-banco-relay': 'Relay / Banco',
  'rescate-relay': 'Relay / Rescate'
};

// Paths que el propio mapa marca como "a clasificar": existen en los datos pero
// no identifican un canal por sí solos.
const LANDING_AMBIGUA = ['agendar', 'agenda', 'evaluar-caso', 'quiero-mi-llc'];

// Calendario de Cal.com -> canal. Cada fila se validó cruzando los eventos reales
// contra el Calendario y el Lead_Source de sus leads, no sólo contra el CSV.
const MAPA_CALENDARIO = [
  { re: /asesor[íi]a estrat[ée]gica/i, canal: 'Meta Ads', seguro: true },
  { re: /^30 min meeting/i, canal: 'Meta Ads', seguro: false },   // mismo /30min, con el nombre por defecto
  { re: /pocos lugares/i, canal: 'Meta Ads', seguro: true },      // Lead Form Meta / retargeting
  { re: /consulta gratuita de 30 min sobre tu llc/i, canal: 'Web Orgánica', seguro: true },
  { re: /agenda con ignacio/i, canal: 'Marca Personal', seguro: true },
  { re: /cobros en usd.*google|google$/i, canal: 'Google Ads', seguro: true },
  { re: /1:1 con santiago|con santiago/i, canal: 'Reddit', seguro: true },
  { re: /consulta de seguimiento/i, canal: 'Cliente actual', seguro: true },
  { re: /business en usa/i, canal: 'Partner', seguro: true },
  { re: /discontinuado/i, canal: 'WhatsApp / Manual', seguro: false }
];

// Lead_Source que ya nombran un canal real: no hace falta derivar nada.
const FUENTE_ES_CANAL = {
  'Reddit Ads': 'Reddit',
  'Marca Personal': 'Marca Personal',
  'Clientes Actuales': 'Cliente actual',
  'Referidos': 'Referidos',
  'Instagram Bot': 'Instagram Bot',
  'Meta Retargeting': 'Meta Ads'
};

function limpiarPath(v) {
  return String(v || '').trim().toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/^\/+|\/+$/g, '').split('?')[0];
}

// "✨Consulta Gratuita ... entre Start Companies y Juan" -> "Consulta Gratuita ...".
// Los emoji llegan de Cal.com y varios se ven como "?" porque el encoding ya vino
// roto de Zoho, así que se corta todo lo que no sea letra o número al principio.
function limpiarTitulo(t) {
  return String(t || '')
    .replace(/\s+entre\s+.*$/i, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canalDeCalendario(titulo) {
  const t = limpiarTitulo(titulo);
  if (!t) return null;
  for (const m of MAPA_CALENDARIO) if (m.re.test(t)) return m;
  return null;
}

// Devuelve de dónde vino el lead y con qué grado de certeza, en este orden:
// lo que ya cargó Zoho > el path de la landing > el calendario de la PRIMERA
// llamada > la fuente cuando ya nombra un canal.
function atribuir(lead, primerEvento) {
  const path = limpiarPath(lead.Calendario);
  const titulo = limpiarTitulo(primerEvento && primerEvento.Event_Title);
  // La landing siempre es lo más concreto que haya: el path si existe, si no el
  // calendario con el que agendó. Nunca el nombre del canal, que ya va aparte.
  const landing = path || titulo || '';

  const zoho = lead.Landing_Origen;
  if (zoho && zoho !== 'A clasificar') {
    return { canal: zoho, landing, origen: 'Zoho', seguro: true };
  }

  if (path && MAPA_LANDING[path]) {
    return { canal: MAPA_LANDING[path], landing, origen: 'Landing', seguro: true };
  }

  const cal = canalDeCalendario(primerEvento && primerEvento.Event_Title);
  if (cal) {
    return { canal: cal.canal, landing, origen: 'Calendario', seguro: cal.seguro };
  }

  if (path && LANDING_AMBIGUA.includes(path)) {
    return { canal: null, landing, origen: 'Sin clasificar', seguro: false };
  }

  const fuente = FUENTE_ES_CANAL[lead.Lead_Source];
  if (fuente) return { canal: fuente, landing, origen: 'Fuente', seguro: true };

  return { canal: null, landing, origen: '', seguro: false };
}

// Lead_Source arrives with the same channel spelled several ways (the WhatsApp
// number, the wwebjs bridge, TimelinesAI...). Collapse the variants so "leads by
// channel" stops splitting one channel into five rows.
const CANAL_ALIAS = [
  [/^whatsapp\s*(-|\s)/i, 'WhatsApp'],
  [/wwebjs/i, 'WhatsApp'],
  [/^timelinesai/i, 'WhatsApp'],
  [/^web organic$/i, 'Web Orgánica'],
  [/^landing page$/i, 'Landing Page'],
  [/^meta ads$/i, 'Meta Ads'],
  [/^meta retargeting$/i, 'Meta Retargeting'],
  [/^forma captacion apertura$/i, 'Meta Ads'],
  [/^instagram bot$/i, 'Instagram Bot'],
  [/^reddit ads$/i, 'Reddit Ads'],
  [/^marca personal$/i, 'Marca Personal'],
  [/^referidos$/i, 'Referidos']
];

function normalizarCanal(src) {
  if (!src) return 'NO SE ASIGNÓ CANAL';
  const s = String(src).trim();
  for (const [re, name] of CANAL_ALIAS) if (re.test(s)) return name;
  return s;
}

// NOTE: this used to guess the Meta Ads sub-form from `Tipo` ("Forma Captación
// Apertura" vs "Form LiliBank"). That was a made-up label — which landing a lead
// came from lives in `Landing_Origen`, so we report the source as-is and expose
// Landing_Origen as its own column.
function deriveCanal(lead) {
  return normalizarCanal(lead.Lead_Source);
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

// `Modalidad de Cierre` is a real CRM picklist (Llamada / Retargeting de vendedor
// / Retargeting empresa). It used to be INVENTED here from `agendó` + Lead_Status,
// which is why 67% of the dashboard read "Formulario Directo" — a label that does
// not exist in Zoho. Empty stays empty: an honest gap beats a fabricated value.
const SIN_DATO = 'Sin dato';
function valorReal(v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return SIN_DATO;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

// Which retargeting sequence the lead is in, if any.
function estadoRetargeting(lead) {
  if (lead.Nombre_retargeting) return String(lead.Nombre_retargeting);
  if (lead.En_Nurturing === true) return 'Nurturing';
  if (lead.Retargeting === true) return 'Sí (sin secuencia)';
  return 'No';
}

// Start of the leads window: first day of the month N months back (N = 6 by
// default, i.e. current month + 5 previous). Override with ZOHO_LEADS_MONTHS=N
// or, for an exact date, ZOHO_LEADS_SINCE=YYYY-MM-DD.
//
// The boundary is pinned to 00:00 Argentina (UTC-3, no DST) instead of the
// server's timezone: Netlify runs in UTC, so a plain local-month start let the
// last 3 hours of the previous month in and the dashboard grew a bogus extra
// month with a handful of leads in it.
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
function leadsWindowStart() {
  if (process.env.ZOHO_LEADS_SINCE) {
    return new Date(process.env.ZOHO_LEADS_SINCE + 'T00:00:00-03:00');
  }
  const months = Math.max(1, parseInt(process.env.ZOHO_LEADS_MONTHS, 10) || 6);
  const nowAR = new Date(Date.now() - AR_OFFSET_MS);  // UTC getters now read the AR calendar
  return new Date(Date.UTC(nowAR.getUTCFullYear(), nowAR.getUTCMonth() - (months - 1), 1, 3, 0, 0));
}

// Fields pulled from CRM Leads. The attribution ones (Landing_Origen,
// Modalidad_de_*, Nombre_retargeting) were NOT requested before, so the dashboard
// had no way to show them even where the CRM had them filled in.
const LEAD_FIELDS = [
  'First_Name', 'Last_Name', 'Full_Name', 'Email', 'Phone', 'Mobile',
  'Lead_Source', 'Lead_Status', 'Created_Time', 'Description', 'Tipo',
  'Owner', 'Retargeting', 'Landing_Origen', 'Modalidad_de_Cierre',
  'Modalidad_de_Pago', 'Nombre_retargeting', 'Inicio_Retargeting',
  'N_mero_de_mensaje', 'En_Nurturing', 'Qui_n_lo_trajo_a_la_llamada', 'fbclid',
  'Calendario'   // el path de la landing: la atribución más precisa que hay
];

// Build the `leads` dataset from CRM, restricted to the relevant recent window.
// The deleted Analytics view only carried the current month; we pull several
// months so the dashboard can compare periods month over month.
async function buildLeads(token) {
  const leadFields = LEAD_FIELDS.join(',');
  const eventFields = ['Who_Id', 'What_Id', 'Start_DateTime', 'Status_del_Meet', 'Created_Time', 'Event_Title'].join(',');

  const since = leadsWindowStart();

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

  const enVentana = leads
    .filter(l => l.Created_Time && new Date(l.Created_Time) >= since)
    .filter(esLeadReal)
    .sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));

  const rows = enVentana
    .map(l => {
      const evs = evById[l.id] || [];
      const agendo = evs.length ? 'Sí' : 'No';
      const mstate = meetingState(evs);
      // La atribución sale SIEMPRE de la primera llamada agendada: si después
      // reagenda por otro calendario, el origen real sigue siendo el primero.
      const primero = evs.slice().sort((a, b) =>
        new Date(a.Start_DateTime || a.Created_Time) - new Date(b.Start_DateTime || b.Created_Time))[0];
      const atr = atribuir(l, primero);
      return {
        'Fecha': fmtDate(l.Created_Time),
        'Servicio': l.Tipo || 'NO SE ASIGNÓ SERVICIO',
        'Nombre y Apellido': l.Full_Name || '',
        // El canal atribuido gana sobre Lead_Source: "Landing Page" no dice de
        // qué landing vino, que es justamente lo que hay que saber.
        'Canal': atr.canal || deriveCanal(l),
        'Landing Origen': atr.landing || SIN_DATO,
        'Origen del dato': atr.origen ? (atr.seguro ? atr.origen : atr.origen + ' (a confirmar)') : SIN_DATO,
        'Calificación': deriveCalificacion(l, agendo, mstate),
        'Teléfono': l.Phone || '',
        'Móvil': l.Mobile || '',
        'Mail': l.Email || '',
        '¿Agendó?': agendo,
        // Estado del meeting salido de los Events del propio lead. El embudo lo
        // calculaba cruzando mails contra la vista de Seguimientos, que cubre otra
        // ventana y solo alcanza a los leads con email: daba "asistieron" mas bajo
        // que "SQL" y el embudo subia en vez de bajar.
        'Estado del meeting': mstate,
        'Retargeting': estadoRetargeting(l),
        'Posibilidad de cierre': derivePosibilidad(l, agendo),
        'Modalidad de cierre': valorReal(l.Modalidad_de_Cierre),
        'Modalidad de pago': valorReal(l.Modalidad_de_Pago),
        'Vendedor asignado': (l.Owner && l.Owner.name) || '',
        'Descripción (antes de contactar)': l.Description || ''
      };
    });

  // `raw` feeds the data-quality tab; the dashboard itself only uses `rows`.
  return { rows, raw: enVentana };
}

// ---------------------------------------------------------------------------
// Data quality: how much of each field is actually filled in, month by month.
//
// Most of what the dashboard cannot show is not a dashboard problem — the CRM
// fields exist but nobody fills them (`Quien_lo_vendio` sat at 0% since forever,
// `Pago` collapsed from ~30% to 0% in Feb 2026). This makes the gap measurable,
// which is the only way to know when the numbers can be trusted again.
// ---------------------------------------------------------------------------
const OWNER_GENERICO = 'Start Companies Staff';

const CALIDAD_LEADS = [
  { key: 'Landing_Origen', label: 'Landing Origen' },
  { key: '__vendedor', label: 'Vendedor real' },
  { key: 'Modalidad_de_Cierre', label: 'Modalidad de Cierre' },
  { key: 'Modalidad_de_Pago', label: 'Modalidad de Pago' },
  { key: 'Nombre_retargeting', label: 'Retargeting' },
  { key: 'Lead_Status', label: 'Estado del Lead' },
  { key: 'Tipo', label: 'Servicio' },
  { key: 'Email', label: 'Email' },
  { key: 'fbclid', label: 'fbclid (Meta)' }
];

const DEAL_FIELDS = ['Created_Time', 'Deal_Name', 'Stage', 'Quien_lo_vendio', 'Landing_Origen',
  'Pago', 'Medios_de_pago', 'Producto', 'Estado_de_Registro', 'Fecha_de_constituci_n'];

const CALIDAD_DEALS = [
  { key: 'Quien_lo_vendio', label: '¿Quién lo vendió?' },
  { key: 'Landing_Origen', label: 'Landing Origen' },
  { key: 'Pago', label: 'Confirmación de pago' },
  { key: 'Medios_de_pago', label: 'Medios de pago' },
  { key: 'Producto', label: 'Producto' },
  { key: 'Estado_de_Registro', label: 'Estado de Registro' },
  { key: 'Fecha_de_constituci_n', label: 'Fecha de constitución' }
];

function estaLleno(rec, key) {
  // The generic owner is not an answer to "who sold this", so it counts as empty.
  if (key === '__vendedor') return !!(rec.Owner && rec.Owner.name && rec.Owner.name !== OWNER_GENERICO);
  const v = rec[key];
  if (v === null || v === undefined || v === '' || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return !!(v.name || v.id);
  return true;
}

// Created_Time comes as ISO with the org offset (…-03:00), so the first 7 chars
// are already the Argentine month.
function completitud(records, campos) {
  const porMes = {};
  records.forEach(rec => {
    const mes = String(rec.Created_Time || '').slice(0, 7);
    if (!mes) return;
    if (!porMes[mes]) porMes[mes] = { mes, total: 0, llenos: campos.map(() => 0) };
    porMes[mes].total++;
    campos.forEach((c, i) => { if (estaLleno(rec, c.key)) porMes[mes].llenos[i]++; });
  });
  return Object.keys(porMes).sort().map(m => {
    const b = porMes[m];
    return { mes: b.mes, total: b.total, pct: b.llenos.map(n => Math.round(n / b.total * 100)) };
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

// Test rows created in the CRM ("Ejemplo", no contact data) were being counted as
// real LLCs. They can only be deleted in Zoho — this token is read-only — so we
// keep them out of the dashboard instead. Deliberately conservative: a row is
// only dropped when it looks like a placeholder AND carries no contact at all.
const NOMBRES_PRUEBA = /^(ejemplo|test|testing|prueba|demo)\b/i;
function esRegistroReal(row) {
  const llc = (row['LLC'] || '').trim();
  const nombre = (row['Nombre'] || '').trim();
  const email = (row['Email'] || '').trim();
  if (!llc && !nombre && !email) return false;
  if (NOMBRES_PRUEBA.test(llc) && !email && !nombre) return false;
  return true;
}

// La app de facturación gratis escribe un lead en el CRM en cada prueba, así que
// entraron "asdasdasd", "qa-fields", "qa.cur.1785337196", "Probando
// administracion"... 17 de sus 21 leads de julio son basura de testeo. Se filtran
// acá, pero el arreglo de verdad es que la app deje de escribir en producción.
const BASURA_TESTEO = [
  /^(asd|sad|dsa|qwe|zxc|aaa|sss|ddd|xxx)/i,
  /\b(qa|test|testing|prueba|probando|demo|dummy)\b/i,
  /^qa[.\-_]/i,
  /@(example|test|mailinator|yopmail)\.(com|org|net)$/i
];
function esLeadReal(l) {
  const nombre = String(l.Full_Name || '').trim();
  const mail = String(l.Email || '').trim();
  if (!nombre && !mail && !l.Mobile && !l.Phone) return false;
  // Nadie del equipo es un lead: los @startcompanies.io son pruebas internas.
  // Sirve además para los que el resto de las reglas no agarra ("administracioasdn1").
  if (/@startcompanies\.(io|us|net)$/i.test(mail)) return false;
  // Ojo con no pasarse: "Matiasdamianavila@gmail.com" tiene "asd" en el medio y es
  // una persona real, por eso los patrones van anclados y no sueltos.
  const texto = nombre + ' ' + mail;
  return !BASURA_TESTEO.some(re => re.test(texto));
}

// Cuánto hace que no llega un registro nuevo a cada dataset. Las vistas de
// Analytics sincronizan por su cuenta y se atrasan sin avisar; sin esto el panel
// muestra datos viejos como si fueran de hoy.
function ultimaFecha(rows, campo) {
  let max = null;
  rows.forEach(r => {
    const raw = r[campo] || r['Fecha'];
    const d = raw ? new Date(raw) : null;
    if (d && !isNaN(d) && (!max || d > max)) max = d;
  });
  return max ? max.toISOString() : null;
}

exports.handler = async (event) => {
  const headers = cabeceras(event.headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // This payload carries names, emails and phones of every lead: it does not
  // leave the function without a valid token.
  const rechazo = exigirAuth(event.headers, headers);
  if (rechazo) return rechazo;

  try {
    if (cache && (Date.now() - cacheTimestamp) < CACHE_TTL) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: cache };
    }

    const token = await getAccessToken();

    const since = leadsWindowStart();

    const [leadsData, llcsRaw, seguimientos, deals] = await Promise.all([
      buildLeads(token),                         // CRM-derived (view deleted)
      exportView(token, LLCS_VIEW_ID),           // surviving Analytics view
      exportView(token, SEGUIMIENTOS_VIEW_ID),   // surviving Analytics view
      crmGetSince(token, 'Deals', DEAL_FIELDS.join(','), since)  // only for the quality tab
    ]);

    const llcs = llcsRaw.filter(esRegistroReal);

    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      leadsSince: since.toISOString(),  // start of the leads window (for the UI)
      leads: leadsData.rows,
      llcs,
      seguimientos,
      // Los llcs/seguimientos salen de vistas de Analytics que sincronizan solas:
      // si la sync se atrasa, el panel tiene que decirlo en vez de mostrar datos
      // viejos como si fueran de hoy.
      frescura: {
        leads: ultimaFecha(leadsData.raw, 'Created_Time'),
        llcs: ultimaFecha(llcs, 'Fecha'),
        seguimientos: ultimaFecha(seguimientos, 'Fecha último meeting')
      },
      calidad: {
        desde: since.toISOString(),
        leads: { campos: CALIDAD_LEADS.map(c => c.label), meses: completitud(leadsData.raw, CALIDAD_LEADS) },
        llcs: { campos: CALIDAD_DEALS.map(c => c.label), meses: completitud(deals, CALIDAD_DEALS) }
      }
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
