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
    // Sin timeout una conexion colgada deja la funcion esperando hasta que
    // Netlify la corta, y el usuario ve el spinner para siempre.
    req.setTimeout(20000, () => req.destroy(new Error('timeout de ' + options.hostname)));
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
async function crmGetPage(token, module, fields, page, extra) {
  const path = `${module}?fields=${encodeURIComponent(fields)}&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc${extra || ''}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await crmGet(token, path);
    } catch (err) {
      // Un "socket hang up" suelto tiraba abajo el payload entero y el panel
      // quedaba sirviendo cache vieja. Es un corte de red, no una respuesta:
      // se reintenta igual que el rate limit.
      if (attempt === 3) throw err;
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
      continue;
    }
    // rate limited -> back off and retry the same page
    if (r.statusCode === 429 || (r.json && r.json.code === 'TOO_MANY_REQUESTS')) {
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    // 5xx de Zoho: tambien es transitorio
    if (r.statusCode >= 500 && attempt < 3) {
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
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
async function crmGetSince(token, module, fields, since, maxPages = 80, batchSize = 4, extra) {
  const out = [];
  let page = 1;
  let done = false;
  while (page <= maxPages && !done) {
    const nums = [];
    for (let i = 0; i < batchSize && page + i <= maxPages; i++) nums.push(page + i);
    const pages = await Promise.all(nums.map(p => crmGetPage(token, module, fields, p, extra)));
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

// Las etiquetas del CRM traen canal donde no hay ni landing ni calendario. Es lo
// único que identifica a los leads de YouTube y a buena parte de los orgánicos.
const MAPA_TAG = [
  { re: /youtube/i, canal: 'YouTube' },
  { re: /google/i, canal: 'Google Ads' },
  { re: /reddit/i, canal: 'Reddit' },
  { re: /organico|orgánico/i, canal: 'Web Orgánica' },
  { re: /form nov meta|meta/i, canal: 'Meta Ads' }
];

function canalDeTag(tag) {
  if (!tag) return null;
  // Zoho manda las etiquetas como array de objetos o como texto separado por comas.
  const texto = Array.isArray(tag) ? tag.map(t => (t && t.name) || t).join(',') : String(tag);
  // "Lead Cal" / "LLC Apertura - Cal" sólo dicen que reservó por Cal.com, no de dónde
  // vino, así que no cuentan como canal.
  for (const m of MAPA_TAG) if (m.re.test(texto)) return m.canal;
  return null;
}

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

  const fuente = FUENTE_ES_CANAL[lead.Lead_Source];
  if (fuente) return { canal: fuente, landing, origen: 'Fuente', seguro: true };

  const tag = canalDeTag(lead.Tag);
  if (tag) return { canal: tag, landing, origen: 'Etiqueta', seguro: true };

  // Último recurso: si trae identificador de Meta, vino de Meta aunque nadie haya
  // cargado nada. No dice de qué anuncio, pero el canal es seguro.
  if (lead.leadchain0__Social_Lead_ID || lead.fbclid || lead.fbc) {
    return { canal: 'Meta Ads', landing, origen: 'ID de Meta', seguro: true };
  }

  if (path && LANDING_AMBIGUA.includes(path)) {
    return { canal: null, landing, origen: 'Sin clasificar', seguro: false };
  }

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
// Regla explícita de Ignacio, y la más importante de este archivo: si la cascada
// de atribución no puede decir de dónde vino el lead, va N/A. NO se cae para
// atrás a `Lead_Source`, porque "WhatsApp" y "Landing Page" dicen por dónde
// entró el mensaje, no de qué anuncio vino. Contarlos como canal ensucia
// cualquier comparación de rendimiento: dan 0% o 100% y nunca algo en el medio.
const NO_DETERMINABLE = 'N/A (no determinable)';

function deriveCanal(lead) {
  return NO_DETERMINABLE;
}

// OJO: esto es una etiqueta DERIVADA, no un campo de Zoho. Dos versiones
// anteriores mentían y hubo que corregirlas; si se toca, sostener la regla de
// que la etiqueta no puede afirmar nada que el dato no diga.
//
//   - "Form Nunca Agendó" se le ponía a CUALQUIERA que no hubiera agendado,
//     dijera de dónde vino o no. De 870 así etiquetados, sólo 275 venían de un
//     formulario: 433 eran de WhatsApp y 113 de YouTube. La palabra "Form" era
//     inventada, así que se fue. Ahora dice sólo lo que pasó: nunca agendó.
//   - "No Show" salía del Lead_Status `Retargeting`, asumiendo que estar en
//     retargeting implicaba un no-show previo. Ya no: el retargeting también se
//     usa con gente que nunca agendó (263 de los 565 etiquetados No Show no
//     tenían NINGUNA reunión). Ahora No Show sale del meeting real, y de
//     `Lead_Status = No Show` si Zoho lo dice explícitamente.
function deriveCalificacion(lead, agendo, mstate) {
  const st = lead.Lead_Status;
  if (st === 'SQL Calificado') return 'SQL Calificado';
  if (st === 'No Calificado' || st === 'No Interesado') return 'No Calificado';
  // Que la reunión se haya caído lo dice el meeting, no el estado del lead.
  if (mstate === 'No Asistió') return 'No Show';
  if (st === 'No Show') return 'No Show';
  if (agendo === 'No') return st ? 'Nunca agendó' : 'Sin estado cargado';
  // Agendó: de acá para abajo lo que manda es qué pasó con la reunión, que es
  // un hecho, y no el estado del lead, que se reescribe. "Sin clasificar" le
  // tocaba a 215 personas que en realidad habían asistido.
  if (mstate === 'Asistió') return 'Asistió';
  if (mstate === 'Reagendó') return 'Reagendó';
  if (st === 'En Calificación') return 'En Calificación';
  return 'Sin resultado cargado';
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
// Para los campos donde el hueco tiene que leerse como hueco.
function valorRealONA(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'N/A';
  return String(v);
}

function valorReal(v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return SIN_DATO;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

// En qué secuencia de retargeting está y en qué mensaje va, que es la etapa real:
// "30 días" solo no dice si recién arrancó o si ya está por terminar.
// Cuánto tiempo pasa entre que reserva y la hora de la llamada. Medido sobre 448
// reuniones, el no-show sube parejo de 35% (menos de 6h) a 60% (más de 4 días),
// así que la ventana de agenda es una palanca real y no una curiosidad.
function anticipacion(evento) {
  if (!evento || !evento.Start_DateTime || !evento.Created_Time) return '';
  const h = (new Date(evento.Start_DateTime) - new Date(evento.Created_Time)) / 3600000;
  if (h < 0) return '';
  if (h < 6) return 'Menos de 6h';
  if (h < 24) return '6 a 24h';
  if (h < 48) return '1 a 2 días';
  if (h < 96) return '2 a 4 días';
  return 'Más de 4 días';
}

function estadoRetargeting(lead) {
  const msj = lead.N_mero_de_mensaje;
  if (lead.Nombre_retargeting) {
    return String(lead.Nombre_retargeting) + (msj ? ' · msj ' + msj : '');
  }
  if (lead.En_Nurturing === true) {
    return 'Nurturing' + (lead.N_mero_de_mensaje_Nurturing ? ' · msj ' + lead.N_mero_de_mensaje_Nurturing : '');
  }
  if (lead.Retargeting === true) return 'Sí (sin secuencia)';
  return 'No';
}

function proximoMensaje(lead) {
  const f = lead.Fecha_Siguiente_Mensaje || lead.Siguiente_Mensaje;
  return f ? String(f).slice(0, 10) : '';
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
// ---------------------------------------------------------------------------
// Desde cuándo se puede confiar en cada cosa
//
// Medido sobre todo el histórico del CRM el 2026-08-25. El piso duro es
// abril-2025: no hay ni un lead, evento ni deal anterior. Pero cada dato tiene
// su propia fecha a partir de la cual está lo bastante cargado como para sacar
// un porcentaje:
//
//   Reuniones y cierres   oct-2025   `Status_del_Meet` venía al 24-44% entre
//                                    jun y sep-2025; desde octubre está sobre 70%.
//   Vínculo del cierre    jul-2025   `Contact_Name` en Deals salta de 1% a 97%.
//   Landing / calendario  jun-2026   `Calendario` y `Landing_Origen` no existían
//                                    antes de may-2026 (0% en 13 meses seguidos).
//   Estado del lead       nunca      92% de los leads viejos fueron modificados
//                                    después del mes de alta (3.165 sólo en
//                                    abr-2026). Lead_Status dice dónde está el
//                                    lead HOY, no qué pasó ese mes: no sirve para
//                                    comparar meses.
//   ¿Quién lo vendió?     nunca      0% en 17 meses.
//
// Las reuniones se piden desde mucho más atrás que los leads a propósito: salen
// de Events + Deals, que no se borran al convertir, así que dan 11 meses de
// historia de cierres donde los leads sólo dan 6.
// ---------------------------------------------------------------------------
const DESDE = {
  reuniones: '2025-10-01',
  landing: '2026-06-01',
  pisoCRM: '2025-04-01'
};

function reunionesWindowStart() {
  const v = process.env.ZOHO_REUNIONES_SINCE || DESDE.reuniones;
  return new Date(v + 'T00:00:00-03:00');
}

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
  'N_mero_de_mensaje', 'Fecha_Siguiente_Mensaje', 'N_mero_de_mensaje_Nurturing',
  'En_Nurturing', 'Qui_n_lo_trajo_a_la_llamada', 'fbclid', 'fbc',
  'Calendario',   // el path de la landing: la atribución más precisa que hay
  'Tag', 'leadchain0__Social_Lead_ID'   // canal donde no hay landing ni calendario
];

// Build the `leads` dataset from CRM, restricted to the relevant recent window.
// The deleted Analytics view only carried the current month; we pull several
// months so the dashboard can compare periods month over month.
async function buildLeads(token) {
  const leadFields = LEAD_FIELDS.join(',');
  const eventFields = ['Who_Id', 'What_Id', 'Start_DateTime', 'Status_del_Meet', 'Created_Time', 'Event_Title'].join(',');

  const since = leadsWindowStart();

  // Los Events se piden desde la ventana de REUNIONES, que arranca mucho antes
  // que la de leads: los eventos sobreviven a la conversión y son la única
  // historia de cierres que hay. El margen de 7 días cubre el evento creado
  // justo antes del corte para un lead que sí entra.
  // Se piden desde el piso del CRM (abr-2025) y no desde la ventana de reuniones:
  // son ~3.500 registros en total, cuestan ~18 páginas, y con eso la serie del
  // formulario de Meta puede llegar hasta el principio en vez de arrancar en
  // octubre. `reuniones` igual se recorta después a su propia ventana.
  const evSince = new Date(Math.min(
    since.getTime() - 7 * 24 * 60 * 60 * 1000,
    new Date(DESDE.pisoCRM + 'T00:00:00-03:00').getTime()
  ));

  // Los leads CONVERTIDOS no vienen en la respuesta por defecto: Zoho los
  // esconde salvo que se los pida con `converted=true`. No se borran, no se los
  // estaba pidiendo. Son justamente los que compraron, así que sin ellos toda
  // medición de conversión sale corta y sesgada para el mismo lado.
  const [leads, convertidos, events] = await Promise.all([
    crmGetSince(token, 'Leads', leadFields, since),
    crmGetSince(token, 'Leads', leadFields, since, 80, 4, '&converted=true'),
    crmGetSince(token, 'Events', eventFields, evSince)
  ]);
  const idsConvertidos = new Set(convertidos.map(l => l.id));

  // Index events by their related record id. OJO: cuando el lead convierte, su
  // evento deja de colgar del lead (What_Id) y pasa a colgar del contacto
  // (Who_Id, con $se_module = Contacts). Si sólo se miran los del lead, TODO
  // cierre parece no haber agendado nunca.
  const evById = {}, evPorContacto = {};
  events.forEach(ev => {
    if (ev['$se_module'] === 'Contacts') {
      const c = ev.Who_Id && ev.Who_Id.id;
      if (c) (evPorContacto[c] = evPorContacto[c] || []).push(ev);
      return;
    }
    const id = (ev.What_Id && ev.What_Id.id) || (ev.Who_Id && ev.Who_Id.id);
    if (id) (evById[id] = evById[id] || []).push(ev);
  });

  const enVentana = leads.concat(convertidos)
    .filter(l => l.Created_Time && new Date(l.Created_Time) >= since)
    .filter(esLeadReal)
    .sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));

  // Índice por id de lead con lo ya resuelto (canal, landing, retargeting), para
  // que `reuniones` no tenga que recalcular la atribución lead por lead.
  const infoLead = {};

  const rows = enVentana
    .map(l => {
      const evs = evById[l.id] || [];
      const agendo = evs.length ? 'Sí' : 'No';
      const mstate = meetingState(evs);
      const convertido = idsConvertidos.has(l.id);
      // La atribución sale SIEMPRE de la primera llamada agendada: si después
      // reagenda por otro calendario, el origen real sigue siendo el primero.
      const primero = evs.slice().sort((a, b) =>
        new Date(a.Start_DateTime || a.Created_Time) - new Date(b.Start_DateTime || b.Created_Time))[0];
      const atr = atribuir(l, primero);
      infoLead[l.id] = {
        canal: atr.canal || deriveCanal(l),
        landing: atr.landing || SIN_DATO,
        retargeting: estadoRetargeting(l),
        servicio: l.Tipo || '',
        vendedor: (l.Owner && l.Owner.name) || ''
      };
      return {
        'Fecha': fmtDate(l.Created_Time),
        // Vacío es vacío: "N/A" y no una etiqueta que parezca un valor real.
        'Servicio': valorRealONA(l.Tipo),
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
        // El formulario instantáneo de Meta (campaña de clientes potenciales) no
        // pasa por ninguna landing: la persona deja el dato dentro de Facebook o
        // Instagram y después hay que traerla a agendar. Sin esta marca no se
        // podían aislar, y son 566 de los últimos 6 meses con 12% de agendamiento.
        'Formulario de Meta': l.leadchain0__Social_Lead_ID ? 'Sí' : 'No',
        // Zoho marca el lead como convertido cuando pasa a Contacto. Si además
        // tiene un Deal de apertura, cerró: eso se completa más abajo, cuando
        // los deals ya están traídos.
        'Convertido': convertido ? 'Sí' : 'No',
        '¿Cerró?': 'No',
        'Próximo mensaje': proximoMensaje(l),
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

  // Seguimientos salía de una vista de Analytics que sincroniza sola y se quedó
  // clavada el 24-jul: 38 meetings de los últimos 4 días hábiles no aparecían.
  // Se arma acá con los mismos datos en vivo, y de paso el canal sale de la
  // atribución nueva en lugar del genérico "Landing Page".
  const seguimientos = enVentana.map(l => {
    const evs = evById[l.id] || [];
    const ultimo = evs.slice().sort((a, b) =>
      new Date(b.Start_DateTime || b.Created_Time) - new Date(a.Start_DateTime || a.Created_Time))[0];
    const primero = evs.slice().sort((a, b) =>
      new Date(a.Start_DateTime || a.Created_Time) - new Date(b.Start_DateTime || b.Created_Time))[0];
    const atr = atribuir(l, primero);
    return {
      // Sin meeting cae la fecha de alta del lead, que es cuándo entró a la lista.
      'Fecha último meeting': fmtDate((ultimo && (ultimo.Start_DateTime || ultimo.Created_Time)) || l.Created_Time),
      'Nombre': l.First_Name || l.Full_Name || '',
      'Apellido': l.First_Name ? (l.Last_Name || '') : '',
      'Mail': l.Email || '',
      'Descripción': l.Description || '',
      'Estatus del Lead': l.Lead_Status || SIN_DATO,
      'Vendedor': (l.Owner && l.Owner.name) || '',
      'Canal de Origen': atr.canal || deriveCanal(l),
      'Landing Origen': atr.landing || SIN_DATO,
      'Origen del dato': atr.origen ? (atr.seguro ? atr.origen : atr.origen + ' (a confirmar)') : SIN_DATO,
      'Retargeting': estadoRetargeting(l),
      'Próximo mensaje': proximoMensaje(l),
      // Se mide sobre el meeting que tiene resultado cargado, que es el que cuenta.
      'Anticipación': anticipacion(evs.filter(e => e.Status_del_Meet)[0] || ultimo),
      'Estado del Meeting': meetingState(evs),
      'Modalidad de Cierre': valorReal(l.Modalidad_de_Cierre)
    };
  }).sort((a, b) => new Date(b['Fecha último meeting']) - new Date(a['Fecha último meeting']));

  // `raw` feeds the data-quality tab; the dashboard itself only uses `rows`.
  // `events` e `infoLead` los consume buildReuniones, que necesita TODOS los
  // eventos (no sólo los de leads vivos) para no perder a los que ya cerraron.
  return { rows, raw: enVentana, seguimientos, events, infoLead, since,
           convertidos: enVentana.filter(l => idsConvertidos.has(l.id)), evPorContacto };
}

// ---------------------------------------------------------------------------
// Reuniones
//
// Por qué existe este dataset aparte de `leads` y `seguimientos`: los dos se
// arman del módulo Leads, y Zoho SACA al lead de Leads en cuanto se convierte en
// cliente. O sea que las reuniones que terminaron en venta son justamente las
// que faltan. Medido sobre 6 meses: el panel veía 276 asistencias cuando fueron
// 384, y el no-show le daba 47% cuando el real es 42%. El sesgo no es aleatorio,
// se lleva puesto exactamente al que compró.
//
// Los Events sí sobreviven a la conversión: cambian de módulo. `$se_module` dice
// si el evento cuelga de un Lead (no cerró) o de un Contact (convirtió), y en el
// segundo caso el id del contacto viene en `Who_Id`, no en `What_Id`.
//
// Con eso se puede calcular la tasa de cierre como la pidió Bauti: sobre
// llamadas presentadas, no sobre leads calificados.
// ---------------------------------------------------------------------------
function idDelEvento(ev) {
  if (ev['$se_module'] === 'Contacts') return (ev.Who_Id && ev.Who_Id.id) || null;
  return (ev.What_Id && ev.What_Id.id) || (ev.Who_Id && ev.Who_Id.id) || null;
}

function estadoReunion(ev) {
  const st = ev.Status_del_Meet;
  if (!st) return 'Sin resultado';
  if (st === 'No asistió') return 'No asistió';
  if (st === 'Reagendar') return 'Reagendó';
  if (st === 'Asistió sin interes') return 'Asistió sin interés';
  if (st === 'Asistió') return 'Asistió';
  return String(st);
}

// "Presentada" incluye "Asistió sin interés": la persona apareció. Que no haya
// comprado es justamente lo que mide la tasa de cierre, no un motivo para
// sacarla del denominador.
function sePresento(estado) {
  return estado === 'Asistió' || estado === 'Asistió sin interés';
}

function buildReuniones(events, deals, infoLead, fuentePorContacto) {
  const since = reunionesWindowStart();
  // Un contacto puede tener varios deals; alcanza con saber si tiene al menos uno
  // y de qué tipo es el primero de apertura.
  const dealsPorContacto = {};
  deals.forEach(d => {
    const id = d.Contact_Name && d.Contact_Name.id;
    if (id) (dealsPorContacto[id] = dealsPorContacto[id] || []).push(d);
  });

  return events
    .filter(ev => {
      const f = ev.Start_DateTime || ev.Created_Time;
      return f && new Date(f) >= since;
    })
    .map(ev => {
      const mod = ev['$se_module'];
      const id = idDelEvento(ev);
      const info = (mod === 'Leads' && infoLead[id]) || null;
      const misDeals = mod === 'Contacts' ? (dealsPorContacto[id] || []) : [];
      const estado = estadoReunion(ev);
      const presentada = sePresento(estado);
      // Sólo tiene sentido preguntarse si cerró cuando la reunión se dio.
      const cerro = presentada && misDeals.length > 0;
      const apertura = misDeals.filter(d => (d.Type || '').toLowerCase().indexOf('apertura') === 0)[0];
      // Al convertido se le corre la misma cascada de atribución que al lead, con
      // el calendario de ESTA reunión, que es el dato que sobrevive en los dos
      // lados. Sin esto los dos grupos hablan idiomas distintos.
      // Tres casos, todos con la MISMA cascada de atribución para que los
      // porcentajes sean comparables entre sí:
      //   - lead dentro de la ventana de leads -> `info`, la cascada completa
      //   - contacto convertido -> cascada con su Lead_Source y este calendario
      //   - lead más viejo que la ventana de leads -> sólo el calendario del
      //     evento, que es el único dato que tenemos de él (y está al 100%)
      const atrEvento = info ? null
        : atribuir({ Lead_Source: (mod === 'Contacts' && fuentePorContacto && fuentePorContacto[id]) || '' }, ev);
      return {
        'Fecha': fmtDate(ev.Start_DateTime || ev.Created_Time),
        'Nombre': (ev.Who_Id && ev.Who_Id.name) || (ev.What_Id && ev.What_Id.name) || '',
        'Calendario': limpiarTitulo(ev.Event_Title),
        'Estado': estado,
        '¿Se presentó?': presentada ? 'Sí' : (estado === 'Sin resultado' ? 'Sin resultado' : 'No'),
        '¿Cerró?': presentada ? (cerro ? 'Sí' : 'No') : '',
        'Servicio': apertura ? (apertura.Deal_Name || 'Apertura') : (misDeals[0] ? misDeals[0].Type || '' : ''),
        // El retargeting sí se pierde al convertir: ese campo sólo existe en
        // Leads y no se arrastra a Contactos.
        'Canal': info ? info.canal : ((atrEvento && atrEvento.canal) || SIN_DATO),
        'Landing Origen': info ? info.landing : ((atrEvento && atrEvento.landing) || SIN_DATO),
        'Retargeting': info ? info.retargeting : '',
        'Anticipación': anticipacion(ev),
        'Estado del registro': mod === 'Contacts' ? 'Contacto' : (mod === 'Leads' ? 'Lead' : (mod || SIN_DATO))
      };
    })
    // Las reuniones de prueba se agendan contra el CRM igual que las reales
    // ("Prueba template agenda", "status meet agenda"), así que se filtran por
    // nombre con la misma lista que los leads.
    .filter(r => r['Nombre'] && !BASURA_TESTEO.some(re => re.test(r['Nombre'])))
    .sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha));
}

// ---------------------------------------------------------------------------
// Serie del formulario de Meta (campaña de clientes potenciales)
//
// Es el único canal que se puede medir de punta a punta con una tasa honesta,
// y por eso vale una serie propia: el lead del formulario se crea cuando la
// persona deja el dato DENTRO de Meta, así que "cuántos de estos agendaron" es
// una tasa de verdad.
//
// Con el resto no pasa: el registro de quien entra por la landing se crea RECIÉN
// al reservar, así que su "tasa de agendamiento" da 90-100% siempre. No es una
// tasa, es una clasificación. Por eso acá no se compara contra nada, se muestra
// el embudo del formulario contra sí mismo mes a mes.
//
// Se pide con tres campos nada más para que traer 16 meses cueste poco, y va en
// paralelo al resto de las llamadas.
// ---------------------------------------------------------------------------
const FORM_FIELDS = ['Created_Time', 'leadchain0__Social_Lead_ID', 'Lead_Source'].join(',');

async function pullLeadsFormulario(token) {
  const desde = new Date(DESDE.pisoCRM + 'T00:00:00-03:00');
  return crmGetSince(token, 'Leads', FORM_FIELDS, desde, 60, 6);
}

function buildSerieFormMeta(leadsLigeros, events) {
  // Un lead agendó si tiene al menos un Event colgando mientras seguía siendo
  // Lead. Ojo: el que cerró ya salió del módulo, así que estos porcentajes
  // quedan apenas por debajo del real (son ~168 cierres sobre miles de leads).
  const eventosPorLead = {};
  events.forEach(ev => {
    if (ev['$se_module'] && ev['$se_module'] !== 'Leads') return;
    const id = ev.What_Id && ev.What_Id.id;
    if (id) (eventosPorLead[id] = eventosPorLead[id] || []).push(ev);
  });

  const sePresento = ev => ev.Status_del_Meet
    && /asist/i.test(ev.Status_del_Meet) && !/no asist/i.test(ev.Status_del_Meet);

  const meses = {};
  leadsLigeros.forEach(l => {
    if (!l.leadchain0__Social_Lead_ID || !l.Created_Time) return;
    const mes = String(l.Created_Time).slice(0, 7);
    const m = meses[mes] = meses[mes] || { mes, leads: 0, agendaron: 0, presentaron: 0 };
    m.leads++;
    const evs = eventosPorLead[l.id] || [];
    if (evs.length) m.agendaron++;
    if (evs.some(sePresento)) m.presentaron++;
  });

  return Object.keys(meses).sort().map(k => meses[k]);
}

// ---------------------------------------------------------------------------
// Partners
//
// Casi la mitad de las aperturas las trae un partner, y el panel las mostraba
// como "WhatsApp" u "Orgánica" porque ese es el canal por el que el partner
// manda el mensaje, no de dónde vino el cliente.
//
// Se identifican por MAIL y TELÉFONO, nunca por nombre: el mismo partner está
// cargado en el CRM como "Angel Andreu" y como "Comunicaciones Tax Solutions
// Daniela Parra" (56 aperturas en jun-2026 entre los dos), y los dos contactos
// comparten tax.solutions.latam@gmail.com. Con nombres habría que mantener una
// lista de variantes que nunca termina.
//
// Esto es la red de seguridad, no la fuente de verdad: si el Deal tiene cargado
// el campo `Partner` de Zoho, gana ese. A medida que el equipo lo complete, la
// lista de acá abajo se va usando cada vez menos y se puede borrar.
// ---------------------------------------------------------------------------
const PARTNERS = [
  { nombre: 'Angel Andreu / Tax Solutions', mails: ['tax.solutions.latam@gmail.com'], tels: ['584144676809', '34689417749'] },
  { nombre: 'Giancarlos Weill', mails: ['giancarlosweill@gmail.com', 'supp@getnexomind.com'], tels: ['14099953371'] },
  { nombre: 'Lucas Rayyan Carmona', mails: ['worldlegalconsulting@gmail.com'], tels: ['34639373551'] },
  { nombre: 'Xavier Massana', mails: ['xmpoma@gmail.com'], tels: ['34624830341'] },
  // Este está en el CRM como contacto "MaríaAugusta DaSilvaJorge"; el mail es el
  // del partner. Mismo caso que Angel/Daniela: por eso la lista va por mail.
  { nombre: 'Federico', mails: ['madeirasweethome7@gmail.com'], tels: ['351926402093'] }
];

// Los teléfonos se comparan por los últimos 8 dígitos: el mismo número aparece
// con y sin prefijo de país, con espacios y con guiones.
const ultimos8 = t => String(t || '').replace(/[^0-9]/g, '').slice(-8);

function partnerDe(deal, contacto) {
  const delCampo = deal && deal.Partner;
  if (delCampo) return typeof delCampo === 'object' ? (delCampo.name || '') : String(delCampo);
  const mail = String((contacto && contacto.Email) || '').trim().toLowerCase();
  const tels = [contacto && contacto.Mobile, contacto && contacto.Phone].map(ultimos8).filter(Boolean);
  for (const p of PARTNERS) {
    if (mail && p.mails.indexOf(mail) !== -1) return p.nombre;
    if (tels.some(t => p.tels.some(pt => pt.endsWith(t)))) return p.nombre;
  }
  return '';
}

// Lead_Source del CRM -> etiqueta única (el mismo canal está escrito de varias
// formas y con mayúsculas distintas según quién cargó el registro).
const CANAL_CRM = {
  'whatsapp - start companies': 'WhatsApp',
  'whatsapp': 'WhatsApp',
  'landing page': 'Landing Page',
  'web organic': 'Orgánica',
  'web orgánica': 'Orgánica',
  'referidos': 'Referido',
  'referido': 'Referido',
  'meta ads': 'Meta Ads',
  'clientes actuales': 'Cliente actual'
};

// ---------------------------------------------------------------------------
// LLCs desde el CRM
//
// Misma historia que Seguimientos: la vista de Analytics quedó al 22-jul. Las
// filas y todas las columnas operativas salen ahora de Deals + Contacts en vivo.
//
// El "Canal de Origen" se resuelve en cascada, de lo más confiable a lo menos:
//   1. partner (campo `Partner` del Deal, o mail/teléfono conocido)
//   2. `Lead_Source` del contacto, que es el dato vivo del CRM
//   3. la vista vieja de Analytics, sólo para el histórico que el CRM ya no tiene
//   4. "Sin dato"
// El paso 3 va último a propósito: esa vista trae valores como "Formulario
// Directo" que no existen en ningún picklist del CRM, así que no puede pisar
// a un Lead_Source real.
// ---------------------------------------------------------------------------
async function buildLLCs(token, deals, canalPorMail) {
  // Los contactos traen mail y teléfono; se piden por páginas hasta cubrir los
  // que referencian estos deals, con tope para no colgar la función.
  const necesarios = new Set(deals.map(d => d.Contact_Name && d.Contact_Name.id).filter(Boolean));
  const contactos = {};
  const campos = ['Full_Name', 'Email', 'Phone', 'Mobile', 'Created_Time', 'Lead_Source'].join(',');
  // En lotes paralelos, igual que el resto: secuencial sumaba ~6s a la respuesta.
  const LOTE = 5;
  for (let page = 1; page <= 21 && necesarios.size > 0; page += LOTE) {
    const nums = [];
    for (let i = 0; i < LOTE; i++) nums.push(page + i);
    const paginas = await Promise.all(nums.map(p => crmGetPage(token, 'Contacts', campos, p)));
    let fin = false;
    for (const json of paginas) {
      if (!json) { fin = true; break; }
      json.data.forEach(c => { if (necesarios.has(c.id)) { contactos[c.id] = c; necesarios.delete(c.id); } });
      if (!json.info || !json.info.more_records) { fin = true; break; }
    }
    if (fin) break;
  }

  const pagoTexto = d => {
    if (d.Medios_de_pago && d.Medios_de_pago.length) return d.Medios_de_pago.join(', ');
    if (d.Pago) return d.Pago;
    return 'Sin pago';
  };

  const rows = deals
    .filter(d => (d.Type || '').toLowerCase().indexOf('apertura') === 0 || !d.Type)
    .map(d => {
      const c = (d.Contact_Name && contactos[d.Contact_Name.id]) || {};
      const mail = c.Email || '';
      const partner = partnerDe(d, c);
      // El mismo canal viene escrito de formas distintas en el CRM y en la vista
      // de Analytics ("Web Organic" / "Orgánica"): si no se unifican, el panel
      // los cuenta como dos canales separados.
      const unificar = v => v ? (CANAL_CRM[String(v).trim().toLowerCase()] || String(v)) : '';
      const delCRM = unificar(c.Lead_Source);
      const delHistorico = unificar(canalPorMail[mail.trim().toLowerCase()]);
      const canal = partner ? 'Partner · ' + partner
        : (delCRM || delHistorico || SIN_DATO);
      return {
        'Fecha': fmtDate(d.Created_Time),
        'LLC': (d.Account_Name && d.Account_Name.name) || d.Deal_Name || '',
        'Etapa': d.Stage || SIN_DATO,
        'Nombre': (d.Contact_Name && d.Contact_Name.name) || c.Full_Name || '',
        'Email': mail,
        'Teléfono': c.Mobile || c.Phone || d.Tel_fono || '',
        'Canal de Origen': canal,
        // Columnas nuevas: permiten agrupar Partner vs Directo sin parsear el
        // texto del canal, y ver de qué partner se trata sin abrir la fila.
        'Tipo de Origen': partner ? 'Partner' : (canal === SIN_DATO ? SIN_DATO : 'Directo'),
        'Partner': partner || '',
        'Vendedor': (d.Quien_lo_vendio && d.Quien_lo_vendio.name) || (d.Owner && d.Owner.name) || '',
        'Confirmación de pago': pagoTexto(d)
      };
    })
    .filter(esRegistroReal)
    .sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha));

  // Los contactos se devuelven junto con las filas porque `reuniones` los
  // necesita: cuando un lead convierte, su canal ya no está en Leads. Va el
  // Lead_Source CRUDO a propósito, no el canal ya resuelto: `reuniones` tiene
  // que atribuirlo con las MISMAS reglas que usa para los leads, o los dos
  // grupos quedan en vocabularios distintos y el porcentaje de cierre por canal
  // se vuelve una clasificación disfrazada de tasa (todo "Landing Page" cerró,
  // todo "Meta Ads" no, porque cada valor viene de una población distinta).
  const fuentePorContacto = {};
  Object.keys(contactos).forEach(id => {
    fuentePorContacto[id] = contactos[id].Lead_Source || '';
  });

  return { rows, fuentePorContacto, contactos };
}

// ---------------------------------------------------------------------------
// Cerrar el círculo: qué lead terminó comprando
//
// El lead convertido pasa a ser Contacto y su Event se muda con él. Con los
// contactos y los deals ya traídos se puede completar, sobre las MISMAS filas de
// leads, si agendó (contando también los eventos que quedaron del lado del
// contacto) y si cerró. Sin esto la solapa de leads no puede medir conversión:
// le faltan justo los que compraron.
// ---------------------------------------------------------------------------
function completarConversion(rows, raw, deals, contactos, evPorContacto) {
  const ult8 = v => String(v || '').replace(/\D/g, '').slice(-8);
  const porMail = {}, porTel = {};
  Object.keys(contactos).forEach(id => {
    const c = contactos[id];
    const m = String(c.Email || '').trim().toLowerCase();
    if (m) porMail[m] = c;
    [c.Phone, c.Mobile].forEach(t => { const k = ult8(t); if (k.length === 8) porTel[k] = c; });
  });
  const dealsPorContacto = {};
  deals.forEach(d => {
    const id = d.Contact_Name && d.Contact_Name.id;
    if (id) (dealsPorContacto[id] = dealsPorContacto[id] || []).push(d);
  });

  let cerrados = 0, agendaronRecuperados = 0, atribucionRecuperada = 0;
  rows.forEach((r, i) => {
    if (r['Convertido'] !== 'Sí') return;
    const l = raw[i] || {};
    const mail = String(l.Email || '').trim().toLowerCase();
    const c = (mail && porMail[mail]) || porTel[ult8(l.Mobile)] || porTel[ult8(l.Phone)];
    if (!c) return;
    const evs = evPorContacto[c.id] || [];
    if (evs.length && r['¿Agendó?'] === 'No') {
      r['¿Agendó?'] = 'Sí';
      r['Estado del meeting'] = meetingState(evs);
      r['Calificación'] = deriveCalificacion(l, 'Sí', r['Estado del meeting']);
      agendaronRecuperados++;
      // Y se rehace la atribución: el calendario de la primera reunión es un
      // escalón de la cascada, y para el convertido recién aparece acá. Sin esto
      // el que compró se iba a N/A y su canal perdía justo el cierre.
      const primero = evs.slice().sort((x, y) =>
        new Date(x.Start_DateTime || x.Created_Time) - new Date(y.Start_DateTime || y.Created_Time))[0];
      const atr = atribuir(l, primero);
      if (atr.canal) {
        r['Canal'] = atr.canal;
        r['Landing Origen'] = atr.landing || SIN_DATO;
        r['Origen del dato'] = atr.origen ? (atr.seguro ? atr.origen : atr.origen + ' (a confirmar)') : SIN_DATO;
        atribucionRecuperada++;
      }
    }
    const ds = dealsPorContacto[c.id] || [];
    if (ds.some(d => (d.Type || '').toLowerCase().indexOf('apertura') === 0)) {
      r['¿Cerró?'] = 'Sí';
      cerrados++;
    }
  });
  return { cerrados, agendaronRecuperados, atribucionRecuperada };
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
  'Pago', 'Medios_de_pago', 'Producto', 'Estado_de_Registro', 'Fecha_de_constituci_n',
  'Type', 'Account_Name', 'Contact_Name', 'Tel_fono', 'Owner', 'Partner'];

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
// Ojo con las reuniones agendadas a futuro: si se cuentan, el dataset parece
// fresquísimo (había un meeting al 2-nov) y el aviso de atraso nunca saltaría.
function ultimaFecha(rows, campo) {
  const ahora = Date.now();
  let max = null;
  rows.forEach(r => {
    const raw = r[campo] || r['Fecha'];
    const d = raw ? new Date(raw) : null;
    if (d && !isNaN(d) && d.getTime() <= ahora && (!max || d > max)) max = d;
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

    // Todo sale del CRM en vivo. La vista de LLCs se sigue leyendo pero SOLO para
    // rescatar el "Canal de Origen" histórico: si falla o se atrasa, el resto del
    // panel no se entera. Antes las filas mismas venían de ahí y por eso faltaban
    // 4 días hábiles de datos sin ninguna señal.
    // Las LLCs se miran hacia atrás mucho más que los leads: una apertura de hace
    // un año sigue siendo un cliente. La vista vieja traía desde may-2025, así que
    // se pide una ventana larga para no perder ese histórico.
    const desdeLLCs = new Date(since.getTime() - 18 * 30 * 24 * 60 * 60 * 1000);

    const [leadsData, deals, vistaLLCs, leadsFormulario] = await Promise.all([
      buildLeads(token),
      crmGetSince(token, 'Deals', DEAL_FIELDS.join(','), desdeLLCs),
      exportView(token, LLCS_VIEW_ID).catch(() => []),
      // Si esta falla, el panel pierde una tarjeta y nada más: no bloquea.
      pullLeadsFormulario(token).catch(() => [])
    ]);

    const canalPorMail = {};
    vistaLLCs.forEach(r => {
      const m = String(r['Email'] || '').trim().toLowerCase();
      const c = r['Canal de Origen'];
      if (m && c) canalPorMail[m] = c;
    });

    const llcsData = await buildLLCs(token, deals, canalPorMail);
    const [llcs, seguimientos] = [llcsData.rows, leadsData.seguimientos];

    const conversion = completarConversion(
      leadsData.rows, leadsData.raw, deals, llcsData.contactos, leadsData.evPorContacto);

    // Se arma con TODOS los deals (ventana larga), no sólo los del período: una
    // reunión de marzo puede haber cerrado en mayo y sigue contando como cierre.
    const reuniones = buildReuniones(leadsData.events, deals, leadsData.infoLead, llcsData.fuentePorContacto);

    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      leadsSince: since.toISOString(),  // start of the leads window (for the UI)
      // Desde cuándo cada dato está lo bastante cargado como para sacar un
      // porcentaje. El panel lo muestra en vez de dejar que el usuario asuma que
      // todas las series arrancan en el mismo lugar.
      desde: {
        reuniones: reunionesWindowStart().toISOString(),
        landing: DESDE.landing,
        pisoCRM: DESDE.pisoCRM
      },
      leads: leadsData.rows,
      llcs,
      seguimientos,
      reuniones,
      // Serie propia del formulario de Meta, desde el piso del CRM.
      conversion,
      formMeta: {
        desde: DESDE.pisoCRM,
        meses: buildSerieFormMeta(leadsFormulario, leadsData.events)
      },
      // Los llcs/seguimientos salen de vistas de Analytics que sincronizan solas:
      // si la sync se atrasa, el panel tiene que decirlo en vez de mostrar datos
      // viejos como si fueran de hoy.
      frescura: {
        leads: ultimaFecha(leadsData.raw, 'Created_Time'),
        llcs: ultimaFecha(llcs, 'Fecha'),
        seguimientos: ultimaFecha(seguimientos, 'Fecha último meeting'),
        // Sin esto la solapa Reuniones era la única sin aviso de atraso.
        reuniones: ultimaFecha(reuniones.filter(r => new Date(r.Fecha) <= new Date()), 'Fecha')
      },
      calidad: {
        desde: since.toISOString(),
        leads: { campos: CALIDAD_LEADS.map(c => c.label), meses: completitud(leadsData.raw, CALIDAD_LEADS) },
        // La matriz de calidad se queda en la ventana de leads aunque los Deals se
        // traigan desde mucho antes, para que las dos tablas sean comparables.
        llcs: { campos: CALIDAD_DEALS.map(c => c.label), meses: completitud(deals.filter(d => new Date(d.Created_Time) >= since), CALIDAD_DEALS) }
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
