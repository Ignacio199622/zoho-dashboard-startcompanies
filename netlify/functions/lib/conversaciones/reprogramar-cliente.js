// "NECESITO REPROGRAMAR" DE UN CLIENTE (reuniones Tipo = Clientes).
//
// El caso (11-nov-2026, Julio Rodriguez): cliente con consulta de soporte por
// Calendly. Tocó "Necesito reprogramar" dos veces y escribió "jueves no puedo, como
// lo cambio al viernes?". Para clientes no había flujo: quedaba en "revisar" en
// Slack, el equipo le mandó /agendar (calendario de VENTAS) a mano y le quedaron
// dos reuniones vivas.
//
// Ahora (decisión de Ignacio 11-nov-2026: "el mismo link y no jodemos, pero controlemos
// lo otro"): en el momento le sale por WhatsApp, en su idioma (es/pt/en), SIEMPRE el
// mismo link: agendaclientes.startcompanies.io, que elige el idioma y el calendario por
// IP (español = Calendly, portugués/inglés = formulario propio en Cal .net).
// La reunión vieja NO se cancela al pedir: su lugar sigue hasta que reserve otra.
// "Lo otro" (la red): cuando ese mismo Contacto tiene una reunión de clientes NUEVA,
// la vieja se cierra en Zoho ([REAGENDADA], sin reglas) y se cancela donde se reservó
// (Calendly o Cal), con el motivo. Ver cerrarViejasClientes().
//
// El mensaje sale con la regla "zz Marcos respuesta automatica" del Contacto
// (Respuesta_Automatica + Enviar_Respuesta), que ya excluye clientes de socios y
// Bloqueo de envío. Texto libre, por eso el idioma lo pone el agente.
import { env } from './entorno.js';
import { get } from './zoho.js';
import { reservaViva, cancelarReserva } from './cal.js';
import { cerrarReunionReagendada } from './escritura.js';
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
export const LINK_AGENDA = 'https://agendaclientes.startcompanies.io/';

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

async function calendly(path, opciones = {}) {
  const url = path.startsWith('http') ? path : `https://api.calendly.com${path}`;
  const r = await fetch(url, { ...opciones, headers: { Authorization: `Bearer ${env.CALENDLY_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`Calendly ${r.status}`);
  return r.status === 204 ? {} : r.json();
}

/** Manda agendaclientes al Contacto de la reunión, en el idioma de la reunión. { ok, idioma, error } */
export async function mandarLinkCliente(evento) {
  if (!evento.Who_Id?.id) return { ok: false, error: 'la reunión no tiene Contacto' };
  const idioma = (await get(`Events/${evento.id}?fields=Idioma`)).data?.[0]?.Idioma || null;
  const texto = textoCliente({ nombre: evento.Who_Id.name, hora: evento.Hora_local_del_cliente, link: LINK_AGENDA, idioma });
  const r = await porZoho({ modulo: 'Contacts', id: evento.Who_Id.id })(null, texto);
  return { ...r, idioma: idioma || 'Español' };
}

const abierta = (e) => e.Tipo_de_reuni_n === 'Clientes' && e.Who_Id?.id && !e.Status_del_Meet && !/^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');

/**
 * Pura: de las reuniones a las que se les mandó el link (ids en `pedidas`), las que ya
 * tienen una reunión de clientes MÁS NUEVA del mismo Contacto. [{ cerrar, queda, duplicada }]
 */
export function viejasClientes(todas, pedidas, ahora = new Date()) {
  const out = [];
  for (const vieja of todas) {
    if (!pedidas.has(vieja.id) || !abierta(vieja)) continue;
    const nuevas = todas
      .filter((e) => e.id !== vieja.id && abierta(e) && e.Who_Id.id === vieja.Who_Id.id)
      .filter((e) => new Date(e.Created_Time) > new Date(vieja.Created_Time) && new Date(e.Start_DateTime) > ahora)
      .sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
    if (!nuevas.length) continue;
    const queda = nuevas[0];
    out.push({ cerrar: vieja, queda, duplicada: new Date(queda.Start_DateTime).getTime() === new Date(vieja.Start_DateTime).getTime() });
  }
  return out;
}

/** Cancela la reserva de origen de una reunión de clientes (Calendly o Cal). */
async function cancelarOrigen(evento, motivo) {
  const d = (await get(`Events/${evento.id}?fields=Description`)).data?.[0] || {};
  const uri = String(d.Description || '').match(/Reservado por Calendly[^:]*:\s*(https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+)/)?.[1];
  if (uri) {
    if (!env.CALENDLY_TOKEN) return { ok: false, error: 'falta CALENDLY_TOKEN' };
    const ev = (await calendly(uri)).resource;
    if (ev?.status !== 'active') return { ok: true, nota: 'ya estaba cancelada en Calendly' };
    await calendly(`${uri}/cancellation`, { method: 'POST', body: JSON.stringify({ reason: motivo }) });
    return { ok: true, donde: 'Calendly' };
  }
  const b = await reservaViva(evento.Start_DateTime, evento);
  if (!b) return { ok: true, nota: 'sin reserva viva en Cal' };
  const deCal = new Set(normalizar(clienteDe(b)?.name).split(/\W+/).filter((w) => w.length >= 3));
  const deZoho = normalizar(`${evento.Who_Id?.name || ''} ${evento.Event_Title || ''}`).split(/\W+/).filter((w) => w.length >= 3);
  if (!deZoho.some((w) => deCal.has(w))) return { ok: false, error: 'la reserva de Cal a esa hora es de otra persona' };
  const c = await cancelarReserva(b.uid, motivo, b._cuenta);
  return { ...c, donde: 'Cal' };
}

/**
 * La red: cierra la vieja (Zoho primero, sin reglas; después el origen, así el Flow /
 * clientes-calendly encuentran el título [REAGENDADA] y no mandan nada). Un duplicado del
 * mismo horario es la misma reserva: solo se cierra en Zoho.
 */
export async function cerrarViejasClientes({ todas, pedidas, escribir = false, ahora = new Date() }) {
  const hechas = [];
  for (const p of viejasClientes(todas, pedidas, ahora)) {
    const fila = { ...p, zoho: null, origen: null };
    if (!escribir) { hechas.push(fila); continue; }
    try {
      fila.zoho = await cerrarReunionReagendada(p.cerrar.id, p.cerrar.Event_Title);
    } catch (e) {
      fila.zoho = { ok: false, error: e.message };
    }
    if (fila.zoho.ok && !p.duplicada) {
      const motivo = `Reprogramaste tu consulta${p.queda.Hora_local_del_cliente ? ` para el ${p.queda.Hora_local_del_cliente}` : ''}. Esta reserva quedó sin efecto.`;
      try {
        fila.origen = await cancelarOrigen(p.cerrar, motivo);
      } catch (e) {
        fila.origen = { ok: false, error: e.message };
      }
    }
    hechas.push(fila);
  }
  return hechas;
}
