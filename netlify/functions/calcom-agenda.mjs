/*
 * Cierra el circulo del embudo de ManyChat: cuando alguien AGENDA en Cal.com,
 * esto lo marca en Zoho con el origen correcto y le corta la secuencia en
 * ManyChat.
 *
 * POR QUE EXISTE
 * El link del calendario ya viaja con `metadata[origen]`, y esos metadata son
 * los unicos parametros que llegan a Zoho (ver la landing de Lili: `lp` y
 * `source` son tracking propio de Cal.com y NO cruzan al CRM). Pero la reserva
 * entra por la integracion nativa y **pisa el Lead_Source**, asi que el lead
 * que vino del DM termina figurando como si hubiera llegado por el calendario.
 * Esta funcion vuelve a escribir el origen despues de la reserva, y de paso
 * avisa a ManyChat para que deje de mandarle seguimientos a alguien que ya
 * agendo.
 *
 * COMO SE CONECTA
 * En Cal.com > Settings > Webhooks:
 *   URL:     https://<sitio>.netlify.app/.netlify/functions/calcom-agenda
 *   Evento:  BOOKING_CREATED  (y BOOKING_CANCELLED si se quiere revertir)
 *   Secret:  el valor de CALCOM_SECRET
 * Cal.com firma el body con HMAC SHA256 en la cabecera x-cal-signature-256.
 *
 * LOS MISMOS TRES FRENOS QUE manychat-lead
 *   1. MODO SOMBRA con CALCOM_SOMBRA=1: no escribe, devuelve lo que haria.
 *   2. NO se edita un lead que este dentro de un flujo de mensajes (seguroEditar).
 *   3. Lista blanca de campos.
 *
 * LO QUE NO HACE A PROPOSITO
 *   - No toca `Lead_Status`. Escribirlo dispara tandas de WhatsApp. La reserva
 *     ya la maneja la integracion nativa; aca solo se corrige la atribucion.
 *   - No crea Tratos. Eso lo hace el flujo comercial.
 */
import crypto from 'node:crypto';
import { tokenZoho } from './lib/aprobacion.js';
import { seguroEditar, CAMPOS_SEGURIDAD } from './lib/seguridad-leads.js';
import { clienteDe } from './lib/cal-cliente.js';

const API = 'https://www.zohoapis.com/crm/v6';

// Valores que YA existen en los picklists. Si se inventa uno, Zoho lo ignora en silencio.
// 18-sep-2026 (normalizacion de origen): Lead_Source = canal, Landing_Origen = pagina, Calendario = calendario de Cal.
const LEAD_SOURCE = 'Marca Personal';

const ESCRIBIBLES = new Set(['Lead_Source', 'Landing_Origen', 'Calendario', 'Description']);

const S = (v) => (v == null ? '' : String(v).trim());

/** Cal.com firma el cuerpo crudo. Hay que comparar contra el string, no contra el objeto. */
function firmaValida(crudo, firma, secreto) {
  if (!secreto) return true;            // sin secreto configurado no se valida
  if (!firma) return false;
  const esperado = crypto.createHmac('sha256', secreto).update(crudo).digest('hex');
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(S(firma).toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Saca lo util del payload de Cal.com. La forma cambia segun la version, asi
 * que se buscan las dos que aparecen en la practica.
 */
function normalizar(body) {
  const p = body?.payload || body || {};
  const asistente = clienteDe(p) || {};
  const md = p.metadata || {};
  const respuestas = p.responses || {};

  const tel =
    S(respuestas.phone?.value) || S(respuestas.attendeePhoneNumber?.value) ||
    S(asistente.phoneNumber) || S(p.smsReminderNumber);

  return {
    tipo:      S(body?.triggerEvent || body?.type),
    titulo:    S(p.eventTitle || p.title || p.eventType?.title),
    slug:      S(p.eventType?.slug),
    inicio:    S(p.startTime),
    uid:       S(p.uid || p.bookingId),
    nombre:    S(asistente.name || respuestas.name?.value),
    email:     S(asistente.email || respuestas.email?.value).toLowerCase(),
    telefono:  tel,
    origen:    S(md.origen),
    palabra:   S(md.utm_content || md.palabra),
    utm_source:   S(md.utm_source),
    utm_medium:   S(md.utm_medium),
    utm_campaign: S(md.utm_campaign),
    mc_id:     S(md.mc_id),
  };
}

/** Solo se toca el lead si la reserva vino del embudo organico de Instagram. */
function esDelEmbudo(b) {
  const o = b.origen.toLowerCase();
  return o.startsWith('ig-dm') || o === 'ig-bio' ||
         (b.utm_source.toLowerCase() === 'instagram' && b.utm_medium.toLowerCase() === 'organico');
}

function armarDescripcion(b) {
  const partes = [
    ['Agendo desde', b.origen],
    ['Palabra', b.palabra],
    ['Calendario', b.titulo],
    ['Fecha de la llamada', b.inicio],
    ['Reserva', b.uid],
  ].filter(([, v]) => S(v));
  return 'Agenda desde el embudo organico (@ignacio.llc)\n' +
    partes.map(([k, v]) => `${k}: ${v}`).join('\n');
}

async function zoho(t, path, opts = {}) {
  const r = await fetch(`${API}/${path}`, {
    ...opts,
    headers: { Authorization: `Zoho-oauthtoken ${t}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 204) return { data: [] };
  return r.json();
}

/** Busca el lead por email y, si no aparece, por telefono en Mobile. */
async function buscarLead(t, b) {
  const campos = CAMPOS_SEGURIDAD.join(',');
  if (b.email) {
    const r = await zoho(t, `Leads/search?email=${encodeURIComponent(b.email)}&fields=${campos},Email,Mobile`);
    const l = (r.data || [])[0];
    if (l) return l;
  }
  if (b.telefono) {
    const tel = b.telefono.replace(/[^\d+]/g, '');
    const r = await zoho(t, `Leads/search?phone=${encodeURIComponent(tel)}&fields=${campos},Email,Mobile`);
    const l = (r.data || [])[0];
    if (l) return l;
  }
  return null;
}

/** Le pone la etiqueta en ManyChat para que se corten los seguimientos. */
async function marcarEnManychat(b, etiquetas) {
  const token = process.env.MANYCHAT_API_TOKEN;
  if (!token || !b.mc_id) return { hecho: false, motivo: 'sin token o sin mc_id' };
  const puestas = [];
  for (const nombre of etiquetas) {
    const r = await fetch('https://api.manychat.com/fb/subscriber/addTagByName', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriber_id: b.mc_id, tag_name: nombre }),
    });
    puestas.push(`${nombre}:${r.status}`);
  }
  return { hecho: true, puestas };
}

export default async (req) => {
  const responder = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return responder({ error: 'solo POST' }, 405);

  const crudo = await req.text();
  if (!firmaValida(crudo, req.headers.get('x-cal-signature-256'), process.env.CALCOM_SECRET))
    return responder({ error: 'firma invalida' }, 401);

  let body;
  try { body = JSON.parse(crudo); } catch { return responder({ error: 'body no es JSON' }, 400); }

  const b = normalizar(body);
  if (b.tipo && b.tipo !== 'BOOKING_CREATED')
    return responder({ ok: true, accion: 'ignorado', motivo: `evento ${b.tipo}` });

  if (!esDelEmbudo(b))
    return responder({ ok: true, accion: 'ignorado', motivo: 'la reserva no viene del embudo organico', origen: b.origen });

  const campos = {
    Lead_Source: LEAD_SOURCE,
    Landing_Origen: b.origen || 'ig-dm-ignacio',
    Calendario: b.slug || 'agenda-ignacio',
    Description: armarDescripcion(b),
  };

  const sombra = process.env.CALCOM_SOMBRA === '1';
  if (sombra) {
    console.log('[calcom-agenda][SOMBRA]', JSON.stringify({ b, campos }));
    return responder({ ok: true, sombra: true, campos, reserva: b.uid });
  }

  const t = await tokenZoho();
  const lead = await buscarLead(t, b);

  const mc = await marcarEnManychat(b, ['agendo', b.palabra ? `kw-${b.palabra.toLowerCase()}` : null].filter(Boolean));

  if (!lead) {
    // La integracion nativa de Cal.com quizas todavia no lo creo. No se crea aca
    // para no duplicar: se reintenta con el reintento del webhook.
    console.log('[calcom-agenda] lead no encontrado todavia', b.email || b.telefono);
    return responder({ ok: false, accion: 'lead_no_encontrado', reserva: b.uid, manychat: mc }, 409);
  }

  const s = seguroEditar(lead);
  if (!s.seguro) {
    console.log('[calcom-agenda] no se edita', lead.id, s.motivos.join(' | '));
    return responder({ ok: true, accion: 'omitido', id: lead.id, motivos: s.motivos, manychat: mc });
  }

  const soloBlancos = Object.fromEntries(Object.entries(campos).filter(([k]) => ESCRIBIBLES.has(k)));
  const res = await zoho(t, `Leads/${lead.id}`, {
    method: 'PUT',
    body: JSON.stringify({ data: [soloBlancos], trigger: [] }), // trigger vacio: sin workflows
  });
  const fila = (res.data || [])[0] || {};
  return responder({
    ok: fila.code === 'SUCCESS', accion: 'atribuido', id: lead.id,
    reserva: b.uid, campos: soloBlancos, manychat: mc, zoho: fila,
  });
};

export const config = { path: '/calcom-agenda' };
