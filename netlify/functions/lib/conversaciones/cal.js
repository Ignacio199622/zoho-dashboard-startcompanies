/*
 * CANCELAR LA RESERVA EN CAL. Es lo unico que libera el hueco de verdad.
 *
 * Medido el 22-sep-2026: borrar el evento de Google NO alcanza. Cal bloquea el
 * horario por su PROPIA reserva y no mira el calendario para eso. La prueba:
 * en el event type 5455190, el 25-sep Cal ofrecia libres 10:30/12:30/15:00/15:30/
 * 16:30/17:00/17:30 y tenia una reserva aceptada a las 09:30; las 09:30 no estaban
 * entre los libres. Y las reservas de Gustavo (23-sep 14:30) y Carlos Montanez
 * (24-sep 09:30) seguian `accepted` en Cal aunque sus eventos de Google ya no
 * existian: en el calendario se veia el agujero y nadie podia reservarlo.
 *
 * Zoho no guarda el uid de la reserva (no hay campo), asi que la reserva se busca
 * por el instante exacto de inicio.
 *
 * 27-oct-2026: DOS cuentas de Cal. La de ventas (CALCOM_API_KEY) y la de Administracion
 * (CALCOM_API_KEY_BR: cal.com/startcompanies, Brasil y soporte) con horarios separados, asi
 * que ahora SI puede haber dos reservas aceptadas en el mismo minuto, una en cada cuenta.
 * Se busca en las dos y, si a esa hora hay mas de una, se elige por el nombre de la reunion
 * de Zoho (`quien`); si no se puede decidir, se devuelve null y el caso va a revisar.
 * Cada reserva lleva `_cuenta` para cancelarla o rehacerla con la clave de su cuenta.
 */
import { env } from './entorno.js';
import { clienteDe } from '../cal-cliente.js';

const CUENTAS = () => [
  ['ventas', env.CALCOM_API_KEY],
  ['br', env.CALCOM_API_KEY_BR],
].filter(([, k]) => k);
const clave = (cuenta) => (cuenta === 'br' ? env.CALCOM_API_KEY_BR : env.CALCOM_API_KEY);
const V = (v, cuenta = 'ventas') => ({ Authorization: `Bearer ${clave(cuenta)}`, 'Content-Type': 'application/json', 'cal-api-version': v });

const palabras = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

/** De varias reservas al mismo minuto, la del lead de la reunion de Zoho (o null si no se sabe). */
function elegir(lista, quien) {
  if (lista.length <= 1) return lista[0] || null;
  if (!quien) return null;
  const deZoho = palabras(quien.What_Id?.name || quien.Event_Title);
  const coinciden = lista.filter((b) => {
    const deCal = new Set(palabras(clienteDe(b)?.name));
    return deZoho.some((w) => deCal.has(w));
  });
  return coinciden.length === 1 ? coinciden[0] : null;
}

/** Reservas de las dos cuentas que arrancan exactamente en `inicio`. 1 llamada por cuenta. */
async function reservasEn(inicio, status = '') {
  if (!env.CALCOM_API_KEY) throw new Error('falta CALCOM_API_KEY');
  const t = new Date(inicio).getTime();
  // La ventana no puede cerrar en el inicio: `beforeEnd` mira el FIN de la reserva,
  // y una de 30 min termina despues. Se pide holgado y se filtra por instante exacto.
  const desde = new Date(t - 60e3).toISOString();
  const hasta = new Date(t + 4 * 36e5).toISOString();
  const todas = [];
  for (const [cuenta, k] of CUENTAS()) {
    const r = await fetch(`https://api.cal.com/v2/bookings?afterStart=${desde}&beforeEnd=${hasta}&take=50${status ? `&status=${status}` : ''}`, {
      headers: { Authorization: `Bearer ${k}`, 'cal-api-version': '2024-08-13' },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Cal bookings (${cuenta}) ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    for (const b of j.data || []) if (new Date(b.start).getTime() === t) todas.push({ ...b, _cuenta: cuenta });
  }
  return todas;
}

/**
 * La reserva viva (accepted) que arranca exactamente en `inicio`, o null. `quien` es la
 * reunion de Zoho: decide si a esa hora hay una reserva en cada cuenta. 1 llamada por cuenta.
 */
export async function reservaViva(inicio, quien = null) {
  return elegir((await reservasEn(inicio)).filter((b) => b.status === 'accepted'), quien);
}

/** Cancela la reserva con la clave de su cuenta. Cal le manda su mail de cancelacion al cliente. 1 llamada. */
export async function cancelarReserva(uid, motivo, cuenta = 'ventas') {
  const r = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}/cancel`, {
    method: 'POST',
    headers: V('2024-08-13', cuenta),
    body: JSON.stringify({ cancellationReason: motivo }),
  });
  const j = await r.json().catch(() => ({}));
  const estado = j.data?.status || j.status;
  return { ok: r.ok, http: r.status, estado, error: r.ok ? null : JSON.stringify(j).slice(0, 160) };
}

/**
 * La reserva CANCELADA que arrancaba exactamente en `inicio` (puede haber varias en el
 * mismo minuto: Cal libera el hueco y otro lo toma). Devuelve todas. 1 llamada.
 */
export async function reservasCanceladas(inicio) {
  return reservasEn(inicio, 'cancelled');
}

// Lo que Cal arma solo a partir del asistente: no se reenvia en bookingFieldsResponses.
const CAMPOS_DEL_ASISTENTE = new Set(['email', 'name', 'displayEmail', 'location', 'guests', 'rescheduleReason', 'notes']);

/**
 * Crea de nuevo una reserva cancelada: mismo calendario, mismo horario, mismos datos
 * (idcrm, lp, utm...). El Flow de Cal en Zoho crea la reunion y manda el "¡Listo! Tu
 * llamada quedo reservada" como con cualquier reserva. Si el hueco ya lo tomo otro,
 * Cal la rechaza. 1 llamada.
 */
export async function reservarDeNuevo(b, origen = 'si-tardio') {
  const a = clienteDe(b) || {};
  const campos = Object.fromEntries(Object.entries(b.bookingFieldsResponses || {}).filter(([k]) => !CAMPOS_DEL_ASISTENTE.has(k)));
  const cuerpo = {
    eventTypeId: b.eventTypeId,
    start: new Date(b.start).toISOString(),
    attendee: { name: a.name, email: a.email, timeZone: a.timeZone, language: a.language || 'es', ...(a.phoneNumber ? { phoneNumber: a.phoneNumber } : {}) },
    bookingFieldsResponses: campos,
    metadata: { ...(b.metadata || {}), origen },
  };
  const r = await fetch('https://api.cal.com/v2/bookings', { method: 'POST', headers: V('2024-08-13', b._cuenta), body: JSON.stringify(cuerpo) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, uid: j.data?.uid || null, error: r.ok ? null : (j.error?.message || JSON.stringify(j)).slice(0, 200) };
}

/**
 * Horarios libres que le quedan a un día (YYYY-MM-DD, hora Argentina). Se mide con
 * agenda-organica (3198734): aviso mínimo 0 y sin ventana de días hábiles, así que un
 * día cercano no da 0 por reglas del calendario sino porque está lleno. Todos los
 * calendarios cuelgan del mismo anfitrión, así que los huecos son los mismos. 1 llamada.
 */
export const TIPO_PARA_MEDIR = 3198734;
export async function horariosLibres(dia) {
  if (!env.CALCOM_API_KEY) throw new Error('falta CALCOM_API_KEY');
  const r = await fetch(
    `https://api.cal.com/v2/slots?eventTypeId=${TIPO_PARA_MEDIR}&start=${dia}&end=${dia}&timeZone=America/Argentina/Buenos_Aires`,
    { headers: V('2024-09-04') }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cal slots ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return (j.data?.[dia] || []).length;
}
