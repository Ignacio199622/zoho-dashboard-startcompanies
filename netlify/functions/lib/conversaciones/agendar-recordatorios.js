// LA HORA DEL SI / NO, CALCULADA POR NOSOTROS.
//
// El WhatsApp de confirmacion de 24 h (regla `Recordatorio 1 dia`) y el
// "recorda responder" (`Recordatorio responder`) salen a la hora que dicen dos
// campos de la reunion: `Hora_de_confirmaci_n` y `Hora_de_recordatorio`. Los
// tenia que llenar la funcion Deluge `SC hora local respaldo` desde la regla
// `Add Meeting`... pero esa regla NO dispara para las reuniones que crea el
// Flow de Cal (medido el 14-sep-2026: 5 reuniones creadas por convertCal,
// ninguna con `Add Meeting` en el timeline). Resultado: ninguna reserva nueva
// recibia el Si/No. Escrito por la REST API con trigger workflow, la regla si
// dispara (verificado: la de 15-sep 10:00 recibio el Si/No a las 10:01).
//
// Asi que lo hace este modulo, cada 5 minutos junto con las confirmaciones:
// busca las reuniones de venta futuras sin hora de confirmacion y se las
// escribe. Misma regla que `crm/auditoria/agenda_recordatorios.mjs` (y que la
// funcion Deluge), copiada aca para que la nube no dependa de esa carpeta:
//
//  - 24 h o mas de anticipacion: Si/No 24 h antes, "recorda" +3 h; lo que
//    caiga entre 22:00 y 07:00 del cliente pasa a las 07:00.
//  - menos de 24 h: se toma el tiempo despierto (07-22 del cliente) entre
//    ahora y el aviso de 30 min y se reparte en tercios: Si/No al primero,
//    "recorda" al segundo. Menos de 60 min despiertos: solo el Si/No. Menos de
//    30: nada (ya sale el de 30 min).
import { get } from './zoho.js';
import { agendarRecordatorio } from './escritura.js';

const TZ_DEFECTO = 'America/Argentina/Buenos_Aires';
const CAMPOS =
  'id,Event_Title,Start_DateTime,Created_Time,Zona_horaria_del_cliente,Tipo_de_reuni_n,Confirmaci_n,Hora_de_confirmaci_n,Hora_de_recordatorio,Hora_local_del_cliente,Status_del_Meet,What_Id,Who_Id';

const partes = (d, tz) => {
  const p = {};
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return p;
};
// Ese horario del dia local de d (+masDias), como instante UTC.
const enLocal = (d, tz, masDias, hora, minuto) => {
  const p = partes(d, tz);
  const offset = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - d.getTime()) / 60000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + masDias, hora, minuto) - offset * 60000);
};
const hora = (d, tz) => +partes(d, tz).hour % 24;
/** ¿Cae en lunes en la zona del cliente? */
export const esLunes = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d) === 'Mon';
export const sinMadrugada = (d, tz) => {
  const h = hora(d, tz);
  if (h >= 22) return enLocal(d, tz, 1, 7, 0);
  if (h < 7) return enLocal(d, tz, 0, 7, 0);
  return d;
};

/** { conf, rec, motivo }: cuando sale el Si/No y el "recorda". Pura, sin red. */
export function agenda(inicio, desde, tz) {
  const min = (a, b) => (b - a) / 60000;
  const H = 36e5;
  const faltan = min(desde, inicio);
  // Reunion de LUNES (Ignacio, 21-sep-2026): dos toques en vez de uno. El SABADO a la hora
  // de la reunion sale el mensaje de Santiago con Si/No (regla `Recordatorio 1 dia`, que elige
  // esa plantilla cuando Hora local del cliente empieza con "lunes"), y el DOMINGO a la misma
  // hora, a los que no contestaron, el Si/No generico + mail (regla `Recordatorio responder`,
  // misma condicion). Si ya estamos a menos de 48 h, sigue la regla de siempre.
  if (esLunes(inicio, tz) && faltan >= 2880) {
    const conf = sinMadrugada(new Date(inicio - 48 * H), tz);
    return { conf, rec: sinMadrugada(new Date(inicio - 24 * H), tz), motivo: 'lunes: sabado' };
  }
  if (faltan >= 1440) {
    const conf = sinMadrugada(new Date(inicio - 24 * H), tz);
    return { conf, rec: sinMadrugada(new Date(conf.getTime() + 3 * H), tz), motivo: '' };
  }
  const a = sinMadrugada(desde, tz);
  let b = new Date(inicio - 30 * 60000);
  const hb = hora(b, tz);
  if (hb >= 22) b = enLocal(b, tz, 0, 22, 0);
  else if (hb < 7) b = enLocal(b, tz, -1, 22, 0);
  const qs1 = enLocal(a, tz, 0, 22, 0);
  const qe1 = new Date(qs1.getTime() + 9 * H);
  const qs2 = new Date(qs1.getTime() + 24 * H);
  const qe2 = new Date(qs2.getTime() + 9 * H);
  const solapa = (qs, qe) => Math.max(0, Math.min(b, qe) - Math.max(a, qs)) / 60000;
  const despierto = min(a, b) - solapa(qs1, qe1) - solapa(qs2, qe2);
  const avanzar = (m) => {
    let r = new Date(a.getTime() + Math.floor(m) * 60000);
    if (r >= qs1) r = new Date(r.getTime() + 9 * H);
    if (r >= qs2) r = new Date(r.getTime() + 9 * H);
    return r;
  };
  if (despierto >= 60) return { conf: avanzar(despierto / 3), rec: avanzar((2 * despierto) / 3), motivo: '' };
  if (despierto >= 30) return { conf: avanzar(despierto / 2), rec: null, motivo: 'solo entra el Si/No' };
  return { conf: null, rec: null, motivo: `solo ${Math.round(despierto)} min despiertos antes del de 30 min` };
}

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';
const cerrada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');

/** Reuniones futuras (venta y clientes, hasta 30 dias) que todavia no tienen hora de confirmacion. 1 llamada. */
export async function sinAgenda(ahora = new Date()) {
  const hasta = new Date(ahora.getTime() + 30 * 86400e3);
  const criterio = `((Start_DateTime:greater_than:${isoZoho(ahora)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`;
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  // Entran las de venta Y las de clientes (Tipo = Clientes, colgadas del Contacto):
  // desde el 14-sep-2026 los clientes tambien reciben el Si/No, por sus propias reglas
  // ("SC Cliente 24h") con el telefono del Contacto. Las reglas de venta leen el
  // telefono del lead, que en una reunion de cliente esta vacio: no mandan nada.
  // Excepcion: una reunion de Clientes colgada de un LEAD (la crea convertCal cuando
  // un cliente reserva por un link de venta, caso Kelyt) NO se programa: la regla de
  // venta le mandaria el Si/No de venta al telefono de ese lead.
  const clienteSinContacto = (e) => e.Tipo_de_reuni_n === 'Clientes' && !e.Who_Id;
  // Una reunion que ya tiene Estatus (Cancelada por el boton del Circuito de Clientes,
  // Asistio, etc.) no se programa: el cliente no tiene que recibir nada mas.
  // Agenda Ignacio (17-oct-2026) tiene sus propias reglas en Zoho por fecha de inicio: no se programa ni se avisa como venta sin lead.
  const agendaIgnacio = (e) => e.Tipo_de_reuni_n === 'Agenda Ignacio';
  return out.filter((e) => !e.Hora_de_confirmaci_n && !e.Confirmaci_n && !e.Status_del_Meet && !cerrada(e) && !clienteSinContacto(e) && !agendaIgnacio(e));
}

/**
 * Reunion de VENTA colgada de un Contacto en vez de un lead (What_Id vacio). No se programa.
 *
 * Todas las notificaciones de venta mandan al `${!Events.What_Id->Leads.Mobile}`: sin lead ese
 * destinatario queda vacio y Zoho no manda nada, pero el campo igual se escribe y la reunion
 * queda marcada como atendida. Nadie se entera.
 *
 * Caso real (Carolina Henao, 25-sep-2026): dos reuniones de venta (16-sep y 24-sep), las dos
 * estampadas, cero mensajes en todo el historial de WhatsApp, cero confirmaciones. Es un
 * Contacto que reservo por un link de venta, asi que no tiene lead del que colgar.
 *
 * OJO: no confundir con la reunion cuyo lead se convirtio DESPUES (el lead desaparece y What_Id
 * queda en null a posteriori). Esas ya tienen `Hora_de_confirmaci_n` y ni llegan hasta aca.
 */
export const ventaSinLead = (e) => e.Tipo_de_reuni_n !== 'Clientes' && !e.What_Id?.id;

/**
 * Una pasada. Devuelve { vistas, programadas: [{evento, conf, rec, tz}], sinEntrar: [{evento, motivo}], fallidas }.
 * Con escribir=false solo calcula.
 */
export async function unaPasada({ escribir = false, ahora = new Date() } = {}) {
  const lista = await sinAgenda(ahora);
  const r = { vistas: lista.length, programadas: [], sinEntrar: [], sinLead: [], fallidas: [] };
  for (const e of lista) {
    // Sin lead no hay a quien mandarle: se avisa a Slack y se deja sin estampar, asi la
    // proxima pasada la vuelve a ver (y si alguien le engancha el lead, arranca sola).
    if (ventaSinLead(e)) {
      r.sinLead.push({ evento: e });
      continue;
    }
    const tz = e.Zona_horaria_del_cliente || TZ_DEFECTO;
    const plan = agenda(new Date(e.Start_DateTime), ahora, tz);
    if (!plan.conf) {
      r.sinEntrar.push({ evento: e, motivo: plan.motivo });
      continue;
    }
    const fila = { evento: e, conf: plan.conf, rec: plan.rec, tz };
    if (escribir) {
      const w = await agendarRecordatorio(e.id, plan.conf, plan.rec);
      if (!w.ok) {
        r.fallidas.push({ ...fila, error: w.error || `quedo ${w.quedo}` });
        continue;
      }
    }
    r.programadas.push(fila);
  }
  return r;
}

/** "14/09 18:15" en la zona del cliente, para el log y Slack. */
export const horaLocal = (d, tz) => {
  if (!d) return '-';
  const p = partes(d, tz);
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};
