// "NECESITO REPROGRAMAR" DE UN CLIENTE (reuniones Tipo = Clientes).
//
// El caso (11-nov-2026, Julio Rodriguez): cliente con consulta de soporte por
// Calendly. Tocó "Necesito reprogramar" dos veces y escribió "jueves no puedo, como
// lo cambio al viernes?". Para clientes no había flujo: quedaba en "revisar" en
// Slack, el equipo le mandó /agendar (calendario de VENTAS) a mano y le quedaron
// dos reuniones vivas.
//
// Ahora: en el momento le sale por WhatsApp, en su idioma (es/pt/en), el link para
// mover ESA MISMA reserva:
//   - Calendly (agendaclientes en español): `reschedule_url` del invitado. Calendly
//     cancela la vieja y crea la nueva; clientes-calendly.js lo pasa a Zoho.
//   - Cal (agendaclientes pt/en, o un cliente que reservó por Cal): cal.com/reschedule/<uid>.
//     Cal manda BOOKING_RESCHEDULED y el Flow cierra la vieja y crea la nueva.
// La reunión NO se cancela ni se marca No asiste: su lugar sigue hasta que elija otro.
//
// El mensaje sale con la regla "zz Marcos respuesta automatica" del Contacto
// (Respuesta_Automatica + Enviar_Respuesta), que ya excluye clientes de socios y
// Bloqueo de envío. Texto libre, por eso el idioma lo pone el agente.
import { env } from './entorno.js';
import { get } from './zoho.js';
import { reservaViva } from './cal.js';
import { porZoho } from './enviar-zoho.js';
import { clienteDe } from '../cal-cliente.js';

const normalizar = (t) =>
  String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Pide otro horario. Acepta preguntas ("como lo cambio al viernes?"): a un cliente
// responderle con el link para moverla no tiene costo si no era eso.
const PIDE_CAMBIO = new RegExp(
  [
    'reag\\w*ndar', 'reprogram\\w*', 'otro (dia|horario)', 'cambi(o|ar|arla|arlo)\\b.*\\b(dia|fecha|hora|horario|reunion|consulta|llamada|lunes|martes|miercoles|jueves|viernes)',
    'no (voy a )?pod(er|re|ria) (asistir|ir|conectarme)', '\\bno puedo\\b',
    // pt
    'remarc\\w*', 'reagend\\w*', 'nao (vou )?(poder|consigo)', 'mudar (o )?(dia|horario|data)', 'outro (dia|horario)', 'preciso reagendar',
    // en
    'reschedul\\w*', "can'?t make it", 'cannot make it', 'another (day|time)', 'change (the )?(day|date|time)', 'need to reschedule',
  ].join('|')
);

export function pideCambioCliente(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  return PIDE_CAMBIO.test(t);
}

const primer = (n) => {
  const p = String(n || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
};

/** Texto en el idioma de la reunión (Idioma de Events: Português / English / vacío = español).
 * La hora solo va en español: Hora_local_del_cliente se arma en español. */
export function textoCliente({ nombre, hora, link, idioma }) {
  const n = primer(nombre);
  if (idioma === 'Português') {
    return `Olá${n ? ' ' + n : ''}! Sem problema. Para mudar sua consulta, escolha o novo horário neste link: ${link} Ao confirmar, o horário anterior é liberado automaticamente.`;
  }
  if (idioma === 'English') {
    return `Hi${n ? ' ' + n : ''}! No problem. To move your call, pick a new time here: ${link} Once you confirm, the previous time is released automatically.`;
  }
  return `¡Hola${n ? ' ' + n : ''}! No hay problema. Para cambiar tu consulta${hora ? ' del ' + hora : ''}, elegí el nuevo horario en este link: ${link} Al confirmar, el horario anterior se libera solo.`;
}

async function calendly(path) {
  const url = path.startsWith('http') ? path : `https://api.calendly.com${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.CALENDLY_TOKEN}` } });
  if (!r.ok) throw new Error(`Calendly ${r.status}`);
  return r.json();
}

/**
 * El link para mover esta reunión de cliente, o null.
 * Calendly: la reunión guarda "Reservado por Calendly (agendaclientes): <uri>" en Description.
 * Cal: la reserva viva que arranca en ese minuto y es de esta persona.
 */
export async function linkReprogramarCliente(evento) {
  const j = await get(`Events/${evento.id}?fields=Description,Idioma`);
  const d = j.data?.[0] || {};
  const uri = String(d.Description || '').match(/Reservado por Calendly[^:]*:\s*(https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+)/)?.[1];
  if (uri) {
    if (!env.CALENDLY_TOKEN) return { link: null, idioma: d.Idioma, error: 'falta CALENDLY_TOKEN' };
    const ev = (await calendly(uri)).resource;
    if (ev?.status !== 'active') return { link: null, idioma: d.Idioma, error: 'la reserva de Calendly ya no está activa' };
    const inv = ((await calendly(`${uri}/invitees`)).collection || []).find((i) => i.status === 'active');
    return { link: inv?.reschedule_url || null, idioma: d.Idioma, origen: 'calendly', error: inv ? null : 'sin invitado activo' };
  }
  const b = await reservaViva(evento.Start_DateTime, evento);
  if (!b) return { link: null, idioma: d.Idioma, error: 'no encontré la reserva en Cal ni en Calendly' };
  const deCal = new Set(normalizar(clienteDe(b)?.name).split(/\W+/).filter((w) => w.length >= 3));
  const deZoho = normalizar(`${evento.Who_Id?.name || ''} ${evento.Event_Title || ''}`).split(/\W+/).filter((w) => w.length >= 3);
  if (!deZoho.some((w) => deCal.has(w))) return { link: null, idioma: d.Idioma, error: 'la reserva de Cal a esa hora es de otra persona' };
  return { link: `https://cal.com/reschedule/${encodeURIComponent(b.uid)}`, idioma: d.Idioma, origen: 'cal' };
}

/** Manda el link al Contacto de la reunión. { ok, link, idioma, error } */
export async function mandarLinkCliente(evento) {
  if (!evento.Who_Id?.id) return { ok: false, error: 'la reunión no tiene Contacto' };
  const l = await linkReprogramarCliente(evento);
  if (!l.link) return { ok: false, ...l };
  const texto = textoCliente({ nombre: evento.Who_Id.name, hora: evento.Hora_local_del_cliente, link: l.link, idioma: l.idioma });
  const r = await porZoho({ modulo: 'Contacts', id: evento.Who_Id.id })(null, texto);
  return { ...r, link: l.link, idioma: l.idioma || 'Español', origen: l.origen };
}
