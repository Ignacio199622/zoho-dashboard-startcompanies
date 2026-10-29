/*
 * LIBERAR EL TURNO DEL QUE NO CONFIRMA (solo leads de Meta).
 *
 * Ignacio (6-oct-2026): "es muy pelotudo el que no confirma", y que se libere bastante
 * antes que el aviso de agenda llena de 4 h. Lo medido ese día (crm/auditoria/_noshow_oct.mjs,
 * reuniones de venta 6-sep a 6-oct, una por persona):
 *   - Form de Meta que no contestó el Sí/No: vino el 16% (6 de 38). Landing de Meta: 38%.
 *   - Orgánicos que no contestaron: 77%. Por eso esto NO los toca.
 *
 * La regla, decidida con él:
 *   - Reunión de venta futura, colgada de un lead de Meta, sin Confirmación ni Estatus.
 *   - Ya le salió el Sí/No (Hora_de_confirmaci_n) y pasaron HORAS_PLAZO sin respuesta
 *     (en el medio le salió el "recordá responder" de +3 h). Para una reunión normal
 *     queda unas 18 h antes; para la del lunes, el sábado a la tarde.
 *   - Si el lead escribió CUALQUIER cosa después del Sí/No, no se libera: puede ser un
 *     "voy" que el lector no entendió. Se avisa a Slack para que lo mire una persona.
 *   - Nada entre las 22 y las 7 del cliente: se espera a la mañana.
 *
 *   - Solo si ese día quedan MAX_LIBRES_PARA_CORTAR horarios libres o menos en Cal (12-oct).
 *
 * Qué hace al liberar, en este orden:
 *   1. Zoho: `[CANCELADA]` en el título + Confirmación = No asiste, con trigger [] (no
 *      sale el "entendido, liberamos ese horario" que es para el que avisó). Con eso la
 *      dejan de lado el de 30 min (criterio Confirmación != No asiste), el agenda llena,
 *      el lector de Sí/No y cancelaciones.js (un [CANCELADA] sin Estatus 'Cancelada' no
 *      es "nuestra"), así no le llega el "ayer nos avisaste que no podías".
 *   2. Cal: cancela la reserva (libera el hueco de verdad, ver cal.js) con un motivo que
 *      le llega por mail. Zoho primero: si no, el Flow de Cal le pone otro [CANCELADA].
 *
 * RESERVA NUEVA CON MATÍAS (12-oct-2026, Ignacio: "que confirme al momento de agendar, si no a
 * las 3 horas queda liberado el turno"): matias-confirmacion.js le manda al que acaba de reservar
 * el video + Sí/No por el +52 y vacía el Sí/No de Zoho (Hora_de_confirmaci_n queda vacía). Para esas
 * la hora del pedido sale del blob `confirma-<idEvento>` (reserva: true) y el plazo es de 3 h. Si le
 * escribió algo a Matías después del pedido (hilo), no se libera: va a revisar.
 *
 *
 * DESDE LA RESERVA (12-oct-2026, Ignacio: "que confirme, si no en 4 horas queda liberado", en el
 * aviso de agendado de Zoho por el 786 con botones Confirmo / Necesito reprogramar): para las
 * reuniones creadas desde la fecha de LIBERAR_DESDE_RESERVA (env, ISO, la del día que el aviso
 * nuevo quedó activo) el plazo corre desde que reservó (Created_Time) y es de HORAS_DESDE_RESERVA.
 * Las creadas antes siguen con el plazo de 6 h desde el Sí/No: su aviso no prometía nada.
 *
 *   3. WhatsApp por Zoho (14-oct-2026): se escribe Aviso_agente = "Turno liberado" y la
 *      regla "SC Aviso agente" manda la plantilla turno_liberado_v2. Antes iba por Graph
 *      y nunca salió (#200: el 786 está onboardeado con Zoho). Si falla, el turno queda
 *      liberado igual y queda el mail de Cal.
 */
import { get, conversacionesDesde } from './zoho.js';
import { liberarReunion, avisoAgente } from './escritura.js';
import { reservaViva, cancelarReserva, horariosLibres } from './cal.js';
import { primerNombre, LINEA_786 } from './reprogramar.js';
import { linkAgendaDe } from './respuestas.js';
import { env } from './entorno.js';
import { getStore } from '@netlify/blobs';
import * as hilo from '../hilo.js';

export const HORAS_PLAZO = 6; // desde el Sí/No de Zoho
export const HORAS_PLAZO_MATIAS = 3; // desde el video + Sí/No de Matías a la reserva nueva
export const HORAS_DESDE_RESERVA = 4; // desde que reservó, con el aviso de agendado nuevo (ver arriba)
export const HORAS_MINIMAS_ANTES = 2; // más cerca que esto ya no vale la pena: que corra el agenda llena
export const PLANTILLA = 'turno_liberado_sin_confirmar';
// Ignacio (12-oct-2026): liberar solo si el día está lleno. "Ponele solo 4 lugares; un viernes
// que hay 3 no lo corte." Con huecos libres, cancelar no le da el lugar a nadie y se pierde
// el 16% que viene igual. Si Cal no responde, no se libera.
export const MAX_LIBRES_PARA_CORTAR = 4;
const diaAR = (iso) => new Date(new Date(iso).getTime() - 3 * H).toISOString().slice(0, 10);
const TZ_DEFECTO = 'America/Argentina/Buenos_Aires';
const H = 36e5;
const CAMPOS =
  'id,Event_Title,Start_DateTime,Created_Time,Confirmaci_n,Status_del_Meet,Tipo_de_reuni_n,Hora_de_confirmaci_n,Hora_local_del_cliente,Zona_horaria_del_cliente,What_Id,Who_Id,Idioma';
const CAMPOS_LEAD =
  'id,Full_Name,First_Name,Mobile,Landing_Origen,Lead_Source,utm_source,utm_content,Anuncio,leadchain0__Social_Lead_ID';

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';
const cerrada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');

/** Mismo criterio que la medición del 6-oct (_noshow_oct.mjs). */
export function esDeMeta(l) {
  if (!l) return false;
  if (l.leadchain0__Social_Lead_ID || /orm/i.test(l.Landing_Origen || '')) return true;
  if (l.utm_content || l.Anuncio) return true;
  return /meta|facebook|instagram/i.test(`${l.Landing_Origen || ''} ${l.Lead_Source || ''} ${l.utm_source || ''}`);
}

/** Cuándo se le pidió la confirmación: el Sí/No de Zoho, o el de Matías a la reserva nueva. */
const pedidoDe = (e) =>
  e._matias ? new Date(e._matias) : e._reserva ? new Date(e._reserva) : e.Hora_de_confirmaci_n ? new Date(e.Hora_de_confirmaci_n) : null;

const horaDelCliente = (d, tz) =>
  +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d) % 24;

/** Decide sobre una reunión ya filtrada. Sin red, para poder probarla. */
export function decidir({ evento, lead, hablo, ahora }) {
  const inicio = new Date(evento.Start_DateTime);
  const conf = pedidoDe(evento);
  const plazo = evento._matias ? HORAS_PLAZO_MATIAS : evento._reserva ? HORAS_DESDE_RESERVA : HORAS_PLAZO;
  const tz = evento.Zona_horaria_del_cliente || TZ_DEFECTO;
  if (!esDeMeta(lead)) return { accion: 'no', motivo: 'no es de Meta' };
  // 29-oct-2026, Ignacio: "no cancelarlo". Brasil tiene su propia cuenta de Cal, que no se llena, y
  // horariosLibres() mide la agenda de ventas en español: un día lleno en español cortaba una
  // reunión BR (Sauer, Tiago). Las de Brasil no se liberan solas.
  if (evento.Idioma === 'Português') return { accion: 'no', motivo: 'Brasil: no se libera' };
  if (!conf || conf > ahora) return { accion: 'no', motivo: 'todavía no le salió el Sí/No' };
  if (ahora - conf < plazo * H) return { accion: 'esperar', motivo: `plazo hasta ${new Date(conf.getTime() + plazo * H).toISOString().slice(0, 16)}Z` };
  if (inicio - ahora < HORAS_MINIMAS_ANTES * H) return { accion: 'no', motivo: 'faltan menos de 2 h' };
  if (hablo) return { accion: 'revisar', motivo: `escribió "${String(hablo.last_message__s || '').slice(0, 60)}"` };
  const h = horaDelCliente(ahora, tz);
  if (h < 7 || h >= 22) return { accion: 'esperar', motivo: 'de noche para el cliente' };
  if (!lead.Mobile) return { accion: 'revisar', motivo: 'sin celular' };
  return { accion: 'liberar', motivo: `sin respuesta ${Math.round((ahora - conf) / H)} h después ${evento._reserva ? 'de reservar' : `del Sí/No${evento._matias ? ' de Matías' : ''}`}` };
}

async function mandarAviso({ telefono, nombre, hora }) {
  if (!env.META_WHATSAPP_TOKEN) return { ok: false, error: 'falta META_WHATSAPP_TOKEN' };
  const cuerpo = {
    messaging_product: 'whatsapp',
    to: String(telefono).replace(/\D/g, ''),
    type: 'template',
    template: {
      name: PLANTILLA,
      language: { code: 'es' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: nombre || 'hola' }, { type: 'text', text: hora }] }],
    },
  };
  const r = await fetch(`https://graph.facebook.com/v21.0/${LINEA_786}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  const id = j.messages?.[0]?.id || null;
  return { ok: r.ok && Boolean(id), id, error: r.ok ? null : JSON.stringify(j.error || j).slice(0, 200) };
}

/**
 * Una pasada. escribir=false: solo dice qué haría. `avisados` (Set) evita repetir en
 * Slack los "revisar" en cada corrida.
 */
export async function unaPasada({ escribir = false, ahora = new Date(), solo = null } = {}) {
  const hasta = new Date(ahora.getTime() + 72 * H); // el del lunes se libera el sábado
  const criterio = `((Start_DateTime:greater_than:${isoZoho(ahora)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`;
  const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200`);
  const vivas = (j.data || []).filter(
    (e) => e.Tipo_de_reuni_n !== 'Clientes' && e.What_Id?.id && !cerrada(e) && !e.Confirmaci_n && !e.Status_del_Meet && (!solo || e.id === solo)
  );
  // Sin Sí/No de Zoho (o todavía no salió): ¿se lo pidió Matías al reservar? (blob confirma-<id>, ver matias-confirmacion.js)
  const sinZoho = vivas.filter((e) => !e.Hora_de_confirmaci_n || new Date(e.Hora_de_confirmaci_n) > ahora);
  if (sinZoho.length) {
    const store = getStore({ name: 'matias', consistency: 'strong' });
    for (const e of sinZoho) {
      const b = await store.get(`confirma-${e.id}`, { type: 'json' }).catch(() => null);
      if (b?.reserva && b.enviada) { e._matias = b.enviada; e._tel = b.tel; }
    }
  }
  const desdeReserva = env.LIBERAR_DESDE_RESERVA ? new Date(env.LIBERAR_DESDE_RESERVA) : null;
  // 28-oct-2026: inglés todavía no recibe el aviso de agendado con confirmación (reserva_confirmada_v2_en espera a Meta),
  // así que no corre el plazo de 4 h desde la reserva. Español y portugués sí lo reciben (PT por la regla "BR Reserva confirmada").
  const conAvisoDeReserva = (e) => e.Idioma !== 'English';
  if (desdeReserva && !isNaN(desdeReserva)) for (const e of vivas) if (!e._matias && conAvisoDeReserva(e) && e.Created_Time && new Date(e.Created_Time) >= desdeReserva) e._reserva = e.Created_Time;
  const reuniones = vivas.filter((e) => { const c = pedidoDe(e); return c && c <= ahora; });
  const r = { vistas: reuniones.length, liberadas: [], esperando: [], revisar: [], fallidas: [], noLlena: [] };
  const libresPorDia = {};
  if (!reuniones.length) return r;

  const ids = [...new Set(reuniones.map((e) => e.What_Id.id))];
  const leads = {};
  for (let i = 0; i < ids.length; i += 100) {
    const l = await get(`Leads?ids=${ids.slice(i, i + 100).join(',')}&fields=${CAMPOS_LEAD}`);
    for (const x of l.data || []) leads[x.id] = x;
  }
  // Lo que escribieron después del Sí/No más viejo de la tanda. 1-2 llamadas.
  const masVieja = new Date(Math.min(...reuniones.map((e) => pedidoDe(e).getTime())));
  const convs = await conversacionesDesde(masVieja);
  const hablaron = new Map();
  for (const c of convs) if (c.conversation_status__s === 'Responded' && c.sender__s?.id) hablaron.set(c.sender__s.id, c);

  for (const evento of reuniones) {
    const lead = leads[evento.What_Id.id];
    const c = hablaron.get(evento.What_Id.id);
    let hablo = c && new Date(c.message_time__s) > pedidoDe(evento) ? c : null;
    // A Matías le contestan por el +52: eso no está en las conversaciones de Zoho, está en el hilo.
    // Se mira siempre, no solo con el pedido de Matías (14-oct, caso Andres: le reservó Matías,
    // el lead le dijo "Gracias" por el +52 y se le liberó el turno por "no responder").
    if (!hablo && (evento._matias || lead?.Mobile)) {
      const m = (await hilo.leer(evento._tel || lead?.Mobile || '', ahora)).filter((x) => x.de === 'cliente' && new Date(x.cuando) > pedidoDe(evento)).pop();
      if (m) hablo = { last_message__s: m.texto, message_time__s: m.cuando };
    }
    const d = decidir({ evento, lead, hablo, ahora });
    const fila = { evento, lead, decision: d };
    if (d.accion === 'no') continue;
    if (d.accion === 'esperar') { r.esperando.push(fila); continue; }
    if (d.accion === 'revisar') { r.revisar.push(fila); continue; }

    const dia = diaAR(evento.Start_DateTime);
    if (!(dia in libresPorDia)) libresPorDia[dia] = await horariosLibres(dia).catch((e) => ({ _error: e.message }));
    const libres = libresPorDia[dia];
    if (libres?._error) { r.esperando.push({ ...fila, decision: { accion: 'esperar', motivo: `no pude medir la agenda: ${libres._error}` } }); continue; }
    if (libres > MAX_LIBRES_PARA_CORTAR) { r.noLlena.push({ ...fila, decision: { accion: 'no', motivo: `el ${dia} tiene ${libres} horarios libres` } }); continue; }
    fila.decision = { ...d, motivo: `${d.motivo}; el ${dia} quedan ${libres} libres` };

    // La reserva de Cal se busca ANTES de tocar Zoho (12-oct): si la hora de Zoho no coincide
    // con la de Cal (pasó con las reagendadas del feriado), se marcaba [CANCELADA] en Zoho y la
    // reserva seguía viva en Cal: el hueco no se liberaba y el cliente seguía agendado.
    const reserva = await reservaViva(evento.Start_DateTime, evento).catch((e) => ({ _error: e.message }));
    if (reserva?._error) { r.esperando.push({ ...fila, decision: { accion: 'esperar', motivo: `Cal no respondió: ${reserva._error}` } }); continue; }
    if (!reserva) { r.revisar.push({ ...fila, decision: { accion: 'revisar', motivo: 'no hay reserva en Cal a esa hora (¿Zoho y Cal tienen horas distintas?)' } }); continue; }
    // La reservó Matías en la charla y no le mandó su pedido de Sí/No: el horario lo eligió el
    // lead hablando con él, así que no se corta sola por el plazo desde la reserva (14-oct, Andres).
    if (!evento._matias && reserva.metadata?.origen === 'sdr-matias') { r.revisar.push({ ...fila, decision: { accion: 'revisar', motivo: 'la reservó Matías en la charla: no se libera sola' } }); continue; }

    const hora = evento.Hora_local_del_cliente || evento.Start_DateTime;
    if (!escribir) { r.liberadas.push(fila); continue; }
    try {
      const z = await liberarReunion(evento.id, evento.Event_Title);
      if (!z.ok) { r.fallidas.push({ ...fila, paso: 'Zoho', error: z.error }); continue; }
      // Ya NO se marca "No asistió" (11-oct, caso Emsabri): la reunión todavía no pasó y la marca
      // (por la transición del blueprint) disparaba la cadencia de no-show del CRM: "vi que no llegamos
      // a conectar" el domingo por una llamada del lunes. Queda [CANCELADA] y la sigue Matías con
      // "vi que tu asesoría quedó cancelada" (lib/matias-noshow.js, canceladasRecientes).
      fila.noShow = 'la sigue Matías (cancelada)';
      // El link según el calendario de la reunión: el /agendar genérico mandaba a los de Lili al
      // calendario de LLC (16-oct, Luis Navas y Alberto reagendaron desde este mail de Cal).
      const motivo = `No recibimos la confirmación de tu asistencia, así que liberamos el horario. Si todavía querés la llamada, reservá otro en ${linkAgendaDe(evento.Event_Title)}`;
      const k = await cancelarReserva(reserva.uid, motivo, reserva._cuenta);
      fila.cal = k.ok ? 'liberado en Cal' : `Cal falló: ${k.error}`;
      const w = await avisoAgente(evento.id, 'Turno liberado');
      fila.wa = w.ok ? 'WhatsApp enviado' : `WhatsApp no salió: ${w.error}`;
      r.liberadas.push(fila);
    } catch (e) {
      r.fallidas.push({ ...fila, paso: '?', error: e.message });
    }
  }
  return r;
}
