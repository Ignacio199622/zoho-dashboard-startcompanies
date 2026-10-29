/*
 * Reconciliador Cal.com → Zoho. La red de seguridad para cuando Cal NO entrega
 * el webhook al Flow "Cal" (pasó el 13-sep-2026 con Daniel Gates, calendario
 * socios: la reserva quedó en Google Calendar y nunca llegó al CRM, la cadencia
 * siguió y Matías le escribió).
 *
 * CÓMO FUNCIONA (cada 15 min, pocas llamadas)
 *   1. Cal: las reservas creadas en las últimas 24 h (1 llamada).
 *   2. Las que ya se vieron (Blobs `cal-reconciliar`) se saltan. Las de menos
 *      de 10 min se dejan para la próxima pasada: el webhook real merece su tiempo.
 *   3. Zoho: ¿hay un lead con `eventId` = uid de la reserva? (1 búsqueda por
 *      reserva nueva). Si hay, se marca vista y listo.
 *   4. Si NO hay, se reenvía la reserva al Flow con el MISMO formato de webhook
 *      que manda Cal (visto en el Historial del Flow), así convertCal hace lo de
 *      siempre: lead + reunión + reserva + Calendario. No se duplica lógica.
 *      El 9 argentino: si el teléfono viene sin 9 y en Zoho existe un lead con
 *      el 9, se reenvía con ese número para que lo encuentre y no cree otro.
 *   5. Avisa en #control-crm qué reserva se reenvió.
 *
 * Con CAL_RECONCILIAR_APLICAR distinto de "1" corre en sombra: mira, avisa lo
 * que haría y no reenvía.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { tokenZoho } from './aprobacion.js';
import { api as slack } from './slack.js';
import { clienteDe } from './cal-cliente.js';

const CAL = 'https://api.cal.com/v2';
const ZOHO = 'https://www.zohoapis.com/crm/v6';
const ESPERA_MIN = 10;
const CANAL = env.SLACK_CANAL_FALLAS || '#control-crm';

const H = () => ({ Authorization: `Bearer ${env.CALCOM_API_KEY}` });
const almacen = () => getStore({ name: 'cal-reconciliar', consistency: 'strong' });

async function zohoGet(path) {
  const r = await fetch(`${ZOHO}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${await tokenZoho()}` } });
  if (r.status === 204) return { data: [] };
  const j = await r.json();
  if (j.status === 'error') throw new Error(`Zoho ${j.code}: ${j.message}`);
  return j;
}

/** Reservas creadas en las últimas `horas` horas, más nuevas primero. */
export async function reservasRecientes(horas = 24) {
  const desde = new Date(Date.now() - horas * 3600e3).toISOString();
  const r = await fetch(`${CAL}/bookings?afterCreatedAt=${encodeURIComponent(desde)}&take=100&sortCreated=desc`, { headers: { ...H(), 'cal-api-version': '2024-08-13' } });
  const j = await r.json();
  if (j.status !== 'success') throw new Error(`Cal bookings: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data || [];
}

async function leadPorEventId(uid) {
  const j = await zohoGet(`Leads/search?criteria=(eventId:equals:${encodeURIComponent(uid)})&fields=id,Full_Name`);
  return (j.data || [])[0] || null;
}

/** El teléfono con el que conviene reenviar: el 9 argentino si ese lead ya existe. */
async function telefonoParaZoho(tel) {
  if (!tel) return tel;
  if (/^\+54(?!9)/.test(tel)) {
    const con9 = tel.replace(/^\+54/, '+549');
    const j = await zohoGet(`Leads/search?criteria=((Mobile:equals:${encodeURIComponent(con9)})or(Phone:equals:${encodeURIComponent(con9)}))&fields=id`);
    if ((j.data || []).length) return con9;
  }
  return tel;
}

/** Arma el payload con el formato del webhook BOOKING_CREATED de Cal (versión 2021-10-20). */
export async function armarPayload(b, telefono) {
  const et = (await (await fetch(`${CAL}/event-types/${b.eventTypeId}`, { headers: { ...H(), 'cal-api-version': '2024-06-14' } })).json()).data;
  const a = clienteDe(b);
  const [firstName, ...resto] = String(a.name || '').split(' ');
  const responses = {
    name: { label: 'your_name', value: a.name, isHidden: false },
    email: { label: 'email_address', value: a.email, isHidden: false },
    attendeePhoneNumber: { label: 'phone_number', value: telefono, isHidden: false },
    location: { label: 'location', value: { optionValue: '', value: 'integrations:google:meet' }, isHidden: false },
    guests: { label: 'additional_guests', value: [], isHidden: false },
    title: { label: 'what_is_this_meeting_about', isHidden: true },
    notes: { label: 'additional_notes', isHidden: true },
    rescheduleReason: { label: 'reason_for_reschedule', isHidden: false },
  };
  const userFieldsResponses = {};
  for (const [k, v] of Object.entries(b.bookingFieldsResponses || {})) {
    if (k in responses || k.startsWith('display')) continue;
    responses[k] = { label: k, value: v, isHidden: true };
    userFieldsResponses[k] = responses[k];
  }
  // lp: si la landing lo mandó solo como metadata (embed viejo), va como respuesta para que llegue a Calendario
  if (!responses.lp && b.metadata?.lp) { responses.lp = { label: 'lp', value: b.metadata.lp, isHidden: true }; userFieldsResponses.lp = responses.lp; }
  return { createdAt: b.createdAt, payload: {
    metadata: { videoCallUrl: b.meetingUrl, ...(b.metadata || {}) },
    videoCallData: { password: '', id: '', type: 'google_meet_video', url: b.meetingUrl },
    eventTypeTitle: et.title, type: et.slug, customInputs: {}, price: 0, eventDescription: et.description || '',
    requiresConfirmation: false, userFieldsResponses,
    attendees: [{ firstName, lastName: resto.join(' '), phoneNumber: telefono, name: a.name, timeZone: a.timeZone, language: { locale: a.language || 'es' }, email: a.email }],
    iCalUID: b.icsUid, status: String(b.status || 'accepted').toUpperCase(), description: et.description || '',
    title: `${et.title} entre Start Companies Business en Usa y ${a.name}`, uid: b.uid, eventTitle: et.title,
    startTime: b.start, endTime: b.end, additionalNotes: '', length: b.duration, bookingId: b.id, eventTypeId: b.eventTypeId,
    organizer: { utcOffset: -180, timeFormat: 'h:mma', name: 'Start Companies Business en Usa', timeZone: 'America/Buenos_Aires', language: { locale: 'es' }, id: 918128, email: 'administracion@startcompanies.us', username: 'startcompanies-businessenusa' },
    responses, location: 'integrations:google:meet',
  }, triggerEvent: 'BOOKING_CREATED' };
}

/** La URL del Flow se lee de los webhooks del calendario: no se guarda en ningún lado. */
async function urlDelFlow(eventTypeId) {
  const j = await (await fetch(`${CAL}/event-types/${eventTypeId}/webhooks`, { headers: H() })).json();
  return (j.data || []).find((w) => w.active && w.subscriberUrl.includes('flow.zoho.com'))?.subscriberUrl || null;
}

async function avisar(texto) {
  if (!env.SLACK_BOT_TOKEN) return;
  try { await slack('chat.postMessage', { channel: CANAL, text: texto, username: 'Control CRM', icon_emoji: ':calendar:' }); } catch (e) { console.error('slack', e.message); }
}

/*
 * ─── LA MARCA DE MATÍAS ─────────────────────────────────────────────────────
 *
 * Ignacio (14-sep-2026): hay que poder contar las reuniones que consiguió Matías.
 * Ignacio (18-sep-2026): "quien lo hizo agendar Matías de última; no meta en
 * fuente de posible cliente, ni calendario, ni lead". Hasta hoy esto escribía
 * Calendario = sdr-matias (pisó la landing en 1 lead y llenó utm_source vacíos
 * con Matías en 16). Ahora:
 *   - una reserva es de Matías si el teléfono del asistente tiene ficha
 *     `apertura-<tel>` en el store `matias` con interacción (contestó, se le
 *     ofrecieron horarios o Matías reservó), o si trae la marca vieja.
 *   - lo que se escribe es la ETIQUETA "Agendó con Matías" (sumada a las que
 *     tiene). Calendario, fuente y utm quedan como los dejó el Flow: la landing
 *     real y el anuncio con el que entró.
 *   - si el lead todavía tiene Calendario = sdr-matias o utm de Matías (los de
 *     antes del 18-sep), se corrigen acá mismo: Calendario a la landing del
 *     calendario, utm de Matías a vacío.
 * Va DESPUÉS de que el Flow escribió el lead (por eso en el reconciliador y no
 * en un webhook), con trigger vacío para no despertar reglas.
 */
const MARCA_MATIAS = 'sdr-matias';
const ETIQUETA_MATIAS = 'Agendó con Matías';
// La landing de cada calendario (igual que LANDING_POR_ORIGEN en matias-agenda.js).
// 18-sep-2026 (normalizacion de origen): la landing vive en Landing_Origen y Calendario guarda el
// calendario de Cal. Un lead viejo con Landing_Origen = sdr-matias se corrige a la landing real.
const LANDING_POR_CALENDARIO = { 3277560: 'agendamientoform', 6554416: 'lili-plataforma', 7008119: 'partners-sc' };
const digitos = (t) => String(t || '').replace(/\D/g, '');
function traeMarcaVieja(b) {
  const r = b.bookingFieldsResponses || b.responses || {};
  const v = (x) => String(x?.value ?? x ?? '').trim().toLowerCase();
  return [v(r.utm_source), v(r.lp), v(b.metadata?.origen), v(b.metadata?.utm_source)].includes(MARCA_MATIAS);
}
async function esDeMatias(b) {
  if (traeMarcaVieja(b)) return 'marca';
  const tel = digitos(clienteDe(b)?.phoneNumber || (b.bookingFieldsResponses || {}).attendeePhoneNumber);
  if (!tel) return null;
  const ficha = await getStore({ name: 'matias', consistency: 'strong' }).get(`apertura-${claveTel(tel)}`, { type: 'json' }).catch(() => null);
  if (!ficha || typeof ficha !== 'object') return null;
  if (ficha.reserva || ficha.ofrecidos?.length) return 'Matías le ofreció horarios';
  if (ficha.contesto || ficha.respondioMatias) return 'conversó con Matías';
  return null;
}
async function marcarComoDeMatias(store, reservas, ahora) {
  const hechas = [];
  for (const b of reservas) {
    if (String(b.status).toLowerCase() !== 'accepted') continue;
    const clave = `matias-${b.uid}`;
    if (await store.get(clave)) continue;
    try {
      const por = await esDeMatias(b);
      if (!por) continue;
      const j = await zohoGet(`Leads/search?criteria=(eventId:equals:${encodeURIComponent(b.uid)})&fields=id,Full_Name,Calendario,Landing_Origen,Tag,utm_source,utm_medium,utm_campaign`);
      const lead = (j.data || [])[0];
      if (!lead) continue; // el Flow todavía no la escribió: se reintenta en la próxima pasada
      const cambios = {};
      const tags = (lead.Tag || []).map((t) => t.name || t);
      if (!tags.includes(ETIQUETA_MATIAS)) cambios.Tag = [...tags, ETIQUETA_MATIAS].map((name) => ({ name }));
      // Lo que quedó de la versión anterior: Matías afuera de Calendario y de los utm.
      const arreglos = [];
      if (lead.Landing_Origen === MARCA_MATIAS) { cambios.Landing_Origen = LANDING_POR_CALENDARIO[b.eventTypeId] || null; arreglos.push(`Landing_Origen → ${cambios.Landing_Origen || 'vacío'}`); }
      if (lead.Calendario === MARCA_MATIAS) { cambios.Calendario = b.eventType?.slug || null; arreglos.push(`Calendario → ${cambios.Calendario || 'vacío'}`); }
      if (lead.utm_source === MARCA_MATIAS) { cambios.utm_source = null; arreglos.push('utm_source → vacío'); if (lead.utm_medium === 'whatsapp') { cambios.utm_medium = null; arreglos.push('utm_medium → vacío'); } }
      if (lead.utm_campaign === MARCA_MATIAS) { cambios.utm_campaign = null; arreglos.push('utm_campaign → vacío'); }
      if (Object.keys(cambios).length) {
        const r = await fetch(`${ZOHO}/Leads`, {
          method: 'PUT',
          headers: { Authorization: `Zoho-oauthtoken ${await tokenZoho()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [{ id: lead.id, ...cambios }], trigger: [] }),
        });
        if (!r.ok) throw new Error(`Zoho PUT ${r.status}`);
      }
      await store.set(clave, ahora.toISOString());
      hechas.push({ uid: b.uid, lead: lead.Full_Name, cal: b.eventType?.slug || b.eventTypeId, por, arreglos });
      const cuando = new Date(b.start).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
      const calSlug = b.eventType?.slug || b.eventTypeId;
      await slack('chat.postMessage', { channel: env.SLACK_CANAL_MATIAS || CANAL, text: `📌 Reunión de Matías: *${lead.Full_Name}* reservó en ${calSlug} (${cuando}), ${por}. En Zoho queda la etiqueta "${ETIQUETA_MATIAS}"; fuente, landing y anuncio no se tocan.${arreglos.length ? ` Corregido: ${arreglos.join(', ')}.` : ''}` }).catch(() => {});
    } catch (e) {
      hechas.push({ uid: b.uid, error: e.message });
    }
  }
  return hechas;
}

export async function pasadaReconciliar({ ahora = new Date(), aplicar = env.CAL_RECONCILIAR_APLICAR === '1' } = {}) {
  const resumen = { vistas: 0, nuevas: 0, esperando: 0, enZoho: 0, reenviadas: [], errores: [], aplicar, matias: [] };
  if (!env.CALCOM_API_KEY) { resumen.errores.push('falta CALCOM_API_KEY'); return resumen; }
  const store = almacen();
  const reservas = await reservasRecientes(24);
  resumen.vistas = reservas.length;
  resumen.matias = await marcarComoDeMatias(store, reservas, ahora).catch((e) => [{ error: e.message }]);
  for (const b of reservas) {
    if (String(b.status).toLowerCase() !== 'accepted') continue;
    const clave = `visto-${b.uid}`;
    if (await store.get(clave)) continue;
    resumen.nuevas++;
    if ((ahora - new Date(b.createdAt)) / 60000 < ESPERA_MIN) { resumen.esperando++; continue; }
    try {
      if (await leadPorEventId(b.uid)) { resumen.enZoho++; await store.set(clave, 'zoho'); continue; }
      const nombre = clienteDe(b)?.name || '?';
      const cal = b.eventType?.slug || b.eventTypeId;
      const cuando = new Date(b.start).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
      if (!aplicar) {
        // En sombra no se marca como vista: cuando se prenda, la agarra. Solo se avisa una vez.
        resumen.reenviadas.push({ uid: b.uid, nombre, cal, sombra: true });
        if (!(await store.get(`sombra-${b.uid}`))) {
          await avisar(`👀 (sombra) Reserva de *${nombre}* en \`${cal}\` (${cuando}) no está en Zoho; el reconciliador la reenviaría al Flow.`);
          await store.set(`sombra-${b.uid}`, ahora.toISOString());
        }
        continue;
      }
      const url = await urlDelFlow(b.eventTypeId);
      if (!url) { resumen.errores.push(`${cal}: sin webhook a Zoho Flow`); await store.set(clave, 'sin-webhook'); continue; }
      const telefono = await telefonoParaZoho(clienteDe(b)?.phoneNumber);
      const payload = await armarPayload(b, telefono);
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(`Flow ${r.status}`);
      resumen.reenviadas.push({ uid: b.uid, nombre, cal, telefono });
      await store.set(clave, `reenviada ${ahora.toISOString()}`);
      await avisar(`🔁 Cal no le entregó a Zoho la reserva de *${nombre}* en \`${cal}\` (${cuando}). Se reenvió al Flow; en un minuto tiene que aparecer lead + reunión. Si no aparece, revisar el Historial del Flow "Cal".`);
    } catch (e) {
      resumen.errores.push(`${b.uid}: ${e.message}`);
    }
  }
  return resumen;
}
