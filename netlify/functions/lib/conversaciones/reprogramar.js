// "NECESITO REPROGRAMAR" SIN RESERVAS DOBLES.
//
// El caso (1-oct-2026): Esteban Daza toco "Necesito reprogramar" en el WhatsApp
// de agendado, el equipo le paso /agendar a mano y reservo OTRA reunion. Quedaron
// las dos vivas (la vieja seguia tapando el hueco en Cal y mandando recordatorios).
// El Flow de Cal solo cierra la vieja cuando Cal avisa una REAGENDA; una reserva
// nueva no la toca.
//
// Dos piezas:
//
//   1. El boton. Cuando el lead pide reprogramar, en el momento le sale por el 786
//      un mensaje con un boton "Elegir otro horario" que abre SU MISMA reserva en
//      Cal para moverla (cal.com/reschedule/<uid>). Cal manda la reagenda, el Flow
//      cierra la vieja y crea la nueva, y llega la confirmacion nueva como siempre.
//      Sale por la API de Meta (mensaje interactivo, sin plantilla): el lead acaba
//      de escribir, la ventana de 24 h esta abierta. Zoho no lo muestra en el chat,
//      por eso se avisa en Slack. No se toca Confirmacion: hasta que elija otro
//      horario, su lugar sigue reservado.
//
//   2. La red. Si igual reserva otra (por /agendar, o Cal/Zoho la duplican), en cada
//      pasada se cierra la vieja: la reserva mas nueva de cada lead es la que vale.
//      La vieja queda `[REAGENDADA]` + No asiste sin disparar reglas, y si es otro
//      horario se cancela en Cal para liberar el hueco (Cal le manda su mail con el
//      motivo, que dice cual quedo). Un duplicado del mismo horario es la misma
//      reserva de Cal: ahi solo se cierra en Zoho.
//
// No es un no-show: el que pidio reprogramar avisa. Si no mueve la reunion y no
// viene, la sigue la secuencia de siempre (cancelaciones.js y Matias).
import { env } from './entorno.js';
import { get } from './zoho.js';
import { reservaViva, cancelarReserva, reservasCanceladas } from './cal.js';
import { cerrarReunionReagendada, marcarNoShow } from './escritura.js';
import { clienteDe } from '../cal-cliente.js';


// [restaurado del deploy 16-oct-2026]
export async function reservaCanceladaDe(evento) {
  const deZoho = normalizar(evento.What_Id?.name || evento.Event_Title).split(/\W+/).filter((w) => w.length >= 3);
  const idcrm = evento.What_Id?.id;
  const todas = await reservasCanceladas(evento.Start_DateTime);
  return todas.find((b) => idcrm && String(b.bookingFieldsResponses?.idcrm || "") === String(idcrm)) || todas.find((b) => {
    const deCal = new Set(normalizar(clienteDe(b)?.name).split(/\W+/).filter((w) => w.length >= 3));
    return deZoho.some((w) => deCal.has(w));
  }) || null;
}

// El 786 (+1 786-935-4213), WABA 473595902494510. Es el numero de Zoho: el lead
// recibe el boton en la misma charla donde toco "Necesito reprogramar".
export const LINEA_786 = env.WA_786_PHONE_ID || '942199205654127';
export const BOTON = 'Elegir otro horario'; // Meta: maximo 20 caracteres
export const HORAS_VENTANA = 23; // la ventana de Meta es de 24 h desde su mensaje

export const linkReprogramar = (uid) => `https://cal.com/reschedule/${encodeURIComponent(uid)}`;

const cerrada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');
const normalizar = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** "ESTEBAN daza" -> "Esteban". Si no parece un nombre, vacio (y el saludo va sin nombre). */
export function primerNombre(completo) {
  const p = String(completo || '').trim().split(/\s+/)[0] || '';
  if (!/^[\p{L}'-]{2,}$/u.test(p)) return '';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

export function textoReprogramar({ nombre, hora }) {
  const saludo = nombre ? `Hola ${nombre}, ¡claro que sí! 😊` : '¡Claro que sí! 😊';
  const reunion = hora ? `Tu reunión del ${hora} sigue reservada a tu nombre` : 'Tu reunión sigue reservada a tu nombre';
  return (
    `${saludo}\n\n${reunion} hasta que elijas otro horario.\n\n` +
    'Tocá el botón, elegí el día y la hora que mejor te queden y la movemos al instante. La confirmación nueva te llega por acá.'
  );
}

/** El mensaje con el boton, por el 786. 1 llamada. */
export async function mandarBotonReprogramar({ telefono, nombre, hora, uid }) {
  if (!env.META_WHATSAPP_TOKEN) throw new Error('falta META_WHATSAPP_TOKEN');
  const cuerpo = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(telefono || '').replace(/\D/g, ''),
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: textoReprogramar({ nombre, hora }) },
      footer: { text: 'Start Companies' },
      action: { name: 'cta_url', parameters: { display_text: BOTON, url: linkReprogramar(uid) } },
    },
  };
  const r = await fetch(`https://graph.facebook.com/v21.0/${LINEA_786}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  const id = j.messages?.[0]?.id || null;
  return { ok: r.ok && Boolean(id), http: r.status, id, error: r.ok ? null : JSON.stringify(j.error || j).slice(0, 200) };
}

/**
 * La reserva de Cal de esta reunion: la viva que arranca en ese minuto, y que sea
 * de esta persona (comparten alguna palabra del nombre). Sin eso, null.
 */
export async function reservaDe(evento) {
  const b = await reservaViva(evento.Start_DateTime, evento);
  if (!b) return null;
  const deCal = new Set(normalizar(clienteDe(b)?.name).split(/\W+/).filter((w) => w.length >= 3));
  const deZoho = normalizar(evento.What_Id?.name || evento.Event_Title).split(/\W+/).filter((w) => w.length >= 3);
  return deZoho.some((w) => deCal.has(w)) ? b : null;
}

/**
 * Reuniones de venta pisadas: por lead, todas las futuras abiertas menos la
 * reservada ultima. Pura, para probarla sin red.
 * Devuelve [{ cerrar, queda, duplicada }] (duplicada = mismo horario que la que queda).
 */
export function pisadas(todas, ahora = /* @__PURE__ */ new Date()) {
  const porLead = /* @__PURE__ */ new Map();
  for (const e of todas) {
    if (e.Tipo_de_reuni_n === "Clientes" || !e.What_Id?.id || e.Status_del_Meet || cerrada(e)) continue;
    if (new Date(e.Start_DateTime) <= ahora) continue;
    if (!porLead.has(e.What_Id.id)) porLead.set(e.What_Id.id, []);
    porLead.get(e.What_Id.id).push(e);
  }
  const out = [];
  for (const lista of porLead.values()) {
    if (lista.length < 2) continue;
    lista.sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
    const [queda, ...resto] = lista;
    for (const e of resto) {
      const duplicada = new Date(e.Start_DateTime).getTime() === new Date(queda.Start_DateTime).getTime();
      out.push({ cerrar: e, queda, duplicada, dudosa: !duplicada && e.Confirmaci_n === "Confirm\xF3" });
    }
  }
  return out;
}

/** Cierra las pisadas. `escribir=false` solo dice que haria. */
export async function cerrarPisadas({ todas, escribir = false, ahora = /* @__PURE__ */ new Date() }) {
  const hechas = [];
  for (const p of pisadas(todas, ahora)) {
    const fila = { ...p, zoho: null, cal: null };
    if (!escribir || p.dudosa) {
      hechas.push(fila);
      continue;
    }
    try {
      fila.zoho = await cerrarReunionReagendada(p.cerrar.id, p.cerrar.Event_Title);
    } catch (e) {
      fila.zoho = { ok: false, error: e.message };
    }
    if (fila.zoho.ok && !p.duplicada) {
      try {
        const b = await reservaDe(p.cerrar);
        if (b) {
          const motivo = `Reprogramaste tu reuni\xF3n${p.queda.Hora_local_del_cliente ? ` para el ${p.queda.Hora_local_del_cliente}` : ""}. Esta reserva qued\xF3 sin efecto.`;
          fila.cal = await cancelarReserva(b.uid, motivo, b._cuenta);
        } else fila.cal = { ok: true, nota: "sin reserva viva en Cal" };
      } catch (e) {
        fila.cal = { ok: false, error: e.message };
      }
    }
    hechas.push(fila);
  }
  return hechas;
}

// ─── EL QUE PIDIO REPROGRAMAR Y NUNCA LA MOVIO (Ignacio, 1-oct-2026) ─────────
//
// Su reunion sigue en pie (pedir otro horario no la cancela). Si pasa la hora, no la
// movio, nadie la marco y no tiene otra reunion por delante, se marca "No asistio"
// sola: eso es lo que hace arrancar la secuencia de no-show (Matias, +1 dia, +3 dias,
// y despues el No Show del CRM). Sin esto dependia de que alguien la marcara a mano.
//
// Se le da margen al equipo: HORAS_GRACIA despues del inicio (el aviso de reuniones
// sin marcar sale entre las 2 y las 6 h). Lo que se sigue vive en el blob de
// confirmaciones como { [eventId]: { enviado, lead } }.
export const HORAS_GRACIA = 48;
export const DIAS_OLVIDO = 10;

/**
 * Que hacer con una reunion seguida. Pura, para probarla sin red.
 * 'esperar' | 'resuelta' (la movio, la marcaron o la sigue otro flujo) | 'no_show'
 */
export function estadoReprogramada(evento, ahora, tieneOtraFutura) {
  if (!evento) return 'resuelta';
  if (/^\[/.test(evento.Event_Title || '') || evento.Status_del_Meet) return 'resuelta';
  // Toco "No" al Si/No despues: lo sigue cancelaciones.js (que tambien termina en no-show).
  if (evento.Confirmaci_n === 'No asiste') return 'resuelta';
  if (new Date(evento.Start_DateTime).getTime() + HORAS_GRACIA * 3600e3 > ahora.getTime()) return 'esperar';
  return tieneOtraFutura ? 'resuelta' : 'no_show';
}

export async function seguirReprogramados({ seguidos = {}, escribir = false, ahora = new Date() }) {
  const quedan = {};
  const marcados = [];
  for (const [id, s] of Object.entries(seguidos)) {
    if (ahora - new Date(s.enviado) > DIAS_OLVIDO * 86400e3) continue;
    const evento = (await get(`Events/${id}?fields=id,Event_Title,Start_DateTime,Status_del_Meet,Confirmaci_n,What_Id,Hora_local_del_cliente`).catch(() => ({}))).data?.[0];
    let otra = false;
    if (evento && s.lead) {
      const j = await get(`Leads/${s.lead}/Events?fields=Start_DateTime,Event_Title&per_page=50`).catch(() => ({ data: [] }));
      otra = (j.data || []).some((e) => e.id !== id && new Date(e.Start_DateTime) > ahora && !/^\[/.test(e.Event_Title || ''));
    }
    const que = estadoReprogramada(evento, ahora, otra);
    if (que === 'esperar') quedan[id] = s;
    if (que !== 'no_show') continue;
    if (!escribir) {
      marcados.push({ evento, ejecucion: null });
      quedan[id] = s;
      continue;
    }
    let ejecucion;
    try {
      ejecucion = await marcarNoShow(id, { reglas: false });
    } catch (e) {
      ejecucion = { ok: false, error: e.message };
    }
    marcados.push({ evento, ejecucion });
    if (!ejecucion.ok) quedan[id] = s; // se reintenta
  }
  return { quedan, marcados };
}
