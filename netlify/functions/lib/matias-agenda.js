/*
 * LA AGENDA DE MATÍAS: ofrece horarios reales y reserva él (Ignacio, 14-sep-2026:
 * "que tome el horario de él por número, le ofrezca en el calendario y lo agende").
 *
 * Antes Matías mandaba el link y el lead tenía que abrir Cal.com desde el
 * celular: Zenelia dijo "mañana 11 am", Osmany "el viernes a la mañana", y las
 * dos reuniones quedaron flotando. Ahora:
 *
 *   1. La zona horaria sale del prefijo del teléfono (34 → Madrid, 52 → México...).
 *   2. Los horarios libres se leen de Cal.com (API v2 /slots) EN LA HORA DEL LEAD,
 *      del calendario que corresponde a su origen (el mismo al que lo mandaba el link).
 *   3. Cuando elige uno, la reserva se crea por API (/bookings) con lp=sdr-matias:
 *      el Flow "Cal" de Zoho la recibe igual que una reserva hecha a mano y el
 *      Calendario del lead queda marcado como de Matías. Ojo: agendaformmeta no
 *      tiene campos utm_* (medido el 14-sep), por eso la atribución va por `lp`.
 *
 * El cerebro decide la acción (ofrecer horarios / reservar) y este módulo la
 * ejecuta: el modelo nunca inventa un horario, solo elige entre los ofrecidos.
 */
import { env } from './entorno.js';
import { paisDe, registroDe } from './matias-cerebro.js';
import { confirmarReunion } from './conversaciones/escritura.js';

// Calendarios de Cal.com por origen (id del event type). Medidos el 14-sep en el
// HTML de cada landing: agendamientoform → agendaformmeta, Lili → lili-bank-plataforma,
// socios → socios. El que llegó por socios pero quiere una LLC va al de LLC.
export const CALENDARIOS = { meta: 3277560, lili: 6554416, socios: 3277560, partner: 7008119, ctwa: 3277560 };
// La landing que corresponde a cada calendario, tal como la escribe el Flow en Calendario.
export const LANDING_POR_ORIGEN = { meta: 'agendamientoform', ctwa: 'agendamientoform', socios: 'agendamientoform', lili: 'lili-plataforma', partner: 'partners-sc' };
// Brasil (27-oct-2026): los de LLC van a agendaformmeta-br de la cuenta Cal de Administracion
// (cal.com/startcompanies, horarios propios, en portugués). Lili y partner no tienen copia BR.
export const CALENDARIOS_BR = { meta: 7661489, socios: 7661489, ctwa: 7661489 };
const esBR = (numero) => paisDe(numero) === 'BR';
const calendarioDe = (origen, numero) => (esBR(numero) && CALENDARIOS_BR[origen || 'meta']) || CALENDARIOS[origen] || CALENDARIOS.meta;

// Zona horaria por prefijo. México y Argentina tienen una sola zona útil para
// esto; Estados Unidos queda en la del este.
const ZONAS = {
  54: 'America/Argentina/Buenos_Aires', 52: 'America/Mexico_City', 57: 'America/Bogota', 34: 'Europe/Madrid',
  56: 'America/Santiago', 51: 'America/Lima', 58: 'America/Caracas', 593: 'America/Guayaquil', 598: 'America/Montevideo',
  595: 'America/Asuncion', 591: 'America/La_Paz', 507: 'America/Panama', 506: 'America/Costa_Rica', 502: 'America/Guatemala',
  503: 'America/El_Salvador', 504: 'America/Tegucigalpa', 505: 'America/Managua', 55: 'America/Sao_Paulo', 1: 'America/New_York',
};
const NOMBRE_ZONA = {
  'Europe/Madrid': 'España', 'America/Mexico_City': 'México', 'America/Argentina/Buenos_Aires': 'Argentina', 'America/Bogota': 'Colombia',
  'America/Santiago': 'Chile', 'America/Lima': 'Perú', 'America/Caracas': 'Venezuela', 'America/Guayaquil': 'Ecuador',
  'America/Montevideo': 'Uruguay', 'America/Asuncion': 'Paraguay', 'America/La_Paz': 'Bolivia', 'America/Panama': 'Panamá',
  'America/Costa_Rica': 'Costa Rica', 'America/Guatemala': 'Guatemala', 'America/El_Salvador': 'El Salvador',
  'America/Tegucigalpa': 'Honduras', 'America/Managua': 'Nicaragua', 'America/Sao_Paulo': 'Brasil', 'America/New_York': 'Miami',
};

export function zonaDe(numero) {
  const n = String(numero || '').replace(/\D/g, '');
  for (const len of [3, 2, 1]) if (ZONAS[n.slice(0, len)]) return ZONAS[n.slice(0, len)];
  return 'America/Argentina/Buenos_Aires';
}
export const nombreZona = (tz) => NOMBRE_ZONA[tz] || tz;

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Brasil (27-oct-2026): la oferta y la reserva van en portugués, también dentro de las plantillas _pt.
const DIAS_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** "na terça", "no sábado". */
const naDia = (dia) => (dia === 'sábado' || dia === 'domingo' ? 'no' : 'na');

/** Partes de una fecha en una zona: { fecha: 'YYYY-MM-DD', hora: 'HH:mm', dia: 'viernes', num: 18, mes: 'septiembre' }. */
export function enZona(fecha, tz, pt = false) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(new Date(fecha)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const d = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dia: (pt ? DIAS_PT : DIAS)[d.getUTCDay()], num: Number(p.day), mes: (pt ? MESES_PT : MESES)[d.getUTCMonth()] };
}

/** "viernes 18 a las 10:00"; en portugués "na sexta 18 às 10:00" (ya con el artículo). */
export function describir(fecha, tz, pt = false) {
  const z = enZona(fecha, tz, pt);
  return pt ? `${naDia(z.dia)} ${z.dia} ${z.num} às ${z.hora}` : `${z.dia} ${z.num} a las ${z.hora}`;
}

/** Lo que el cerebro necesita saber de "hoy" para calcular "mañana", "el viernes". */
export function contextoDeHoy(numero, ahora = new Date()) {
  const tz = zonaDe(numero);
  const z = enZona(ahora, tz);
  return `Hoy es ${z.dia} ${z.num} de ${z.mes} de ${z.fecha.slice(0, 4)}, ${z.hora} en la hora del lead (${nombreZona(tz)}).`;
}

const CAL = (extra = {}, k = env.CALCOM_API_KEY) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...extra });
const CLAVES = () => [env.CALCOM_API_KEY, env.CALCOM_API_KEY_BR].filter(Boolean);

/**
 * Horarios libres del calendario del origen entre dos fechas (YYYY-MM-DD,
 * inclusive), en la zona del lead. Devuelve ISO con offset, ordenados.
 */
export async function horariosLibres({ origen, tz, desde, hasta, numero = '' }) {
  const id = calendarioDe(origen, numero);
  const u = `https://api.cal.com/v2/slots?eventTypeId=${id}&start=${desde}&end=${hasta}&timeZone=${encodeURIComponent(tz)}`;
  const r = await fetch(u, { headers: CAL({ 'cal-api-version': '2024-09-04' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cal slots ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return Object.values(j.data || {}).flat().map((s) => s.start || s).sort();
}

const sumarDias = (fecha, n) => new Date(new Date(`${fecha}T12:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);

/**
 * Elige hasta 3 horarios para ofrecer: los del día pedido (y franja, si la
 * dijo), repartidos a lo largo del día para no ofrecer 10:00, 10:30 y 11:00.
 * Si ese día no hay nada, busca en los 7 días siguientes y lo dice (con 3 no
 * alcanzaba: el 17-sep el viernes y el lunes estaban llenos, el finde no abre, y
 * Matías mandó el link "sin horarios" teniendo 12 turnos el martes).
 */
export async function ofrecer({ origen, numero, dia, franja = '', ahora = new Date() }) {
  const tz = zonaDe(numero);
  const pt = registroDe(numero) === 'pt';
  const hoy = enZona(ahora, tz).fecha;
  let fecha = dia && /^\d{4}-\d{2}-\d{2}$/.test(dia) && dia >= hoy ? dia : sumarDias(hoy, 1);
  const enFranja = (iso) => {
    const h = Number(enZona(iso, tz).hora.slice(0, 2));
    return franja === 'manana' ? h < 13 : franja === 'tarde' ? h >= 13 : true;
  };
  // Solo horarios humanos en la hora del lead: a Omar (México) se le ofreció 06:30
  // el 14-sep porque la agenda abre 9:00 Argentina. Entre 8:00 y 20:59 locales.
  const humano = (iso) => { const h = Number(enZona(iso, tz).hora.slice(0, 2)); return h >= 8 && h < 21; };
  const futuro = (iso) => new Date(iso).getTime() > ahora.getTime() + 45 * 60000 && humano(iso);
  const repartir = (lista, n = 3) => {
    if (lista.length <= n) return lista;
    // Ignacio (14-sep): "o a la tarde también": el primero, el del medio y el último
    // del día, así la oferta cubre mañana y tarde (el techo de 20:59 ya lo pone `humano`).
    const paso = (lista.length - 1) / (n - 1);
    return [...new Set([...Array(n)].map((_, i) => lista[Math.round(i * paso)]))];
  };

  let libres = (await horariosLibres({ origen, tz, desde: fecha, hasta: fecha, numero })).filter(futuro);
  let opciones = repartir(libres.filter(enFranja));
  let nota = '';
  if (!opciones.length && libres.length) { opciones = repartir(libres); nota = pt ? (franja === 'manana' ? 'De manhã não tenho nada livre nesse dia, ' : 'À tarde não tenho nada livre nesse dia, ') : franja === 'manana' ? 'A la mañana no tengo nada libre ese día, ' : 'A la tarde no tengo nada libre ese día, '; }
  if (!opciones.length) {
    const otros = (await horariosLibres({ origen, tz, desde: sumarDias(fecha, 1), hasta: sumarDias(fecha, 7), numero })).filter(futuro);
    opciones = repartir(otros.filter(enFranja).length ? otros.filter(enFranja) : otros);
    const diaPedido = enZona(`${fecha}T12:00:00Z`, 'UTC', pt).dia;
    nota = pt ? `${naDia(diaPedido) === 'no' ? 'No' : 'Na'} ${diaPedido} não tenho nada livre, ` : `El ${diaPedido} no tengo nada libre, `;
  }
  if (!opciones.length) return { opciones: [], texto: '', tz };
  if (pt) {
    const o = (l) => l.join(', ').replace(/, ([^,]*)$/, ' ou $1');
    const z0 = enZona(opciones[0], tz, true);
    const mismoDia = opciones.every((x) => enZona(x, tz).fecha === z0.fecha);
    const frase = `${mismoDia ? `${naDia(z0.dia)} ${z0.dia} ${z0.num} às ${o(opciones.map((x) => enZona(x, tz).hora))}` : o(opciones.map((x) => describir(x, tz, true)))}, no horário de ${nombreZona(tz) === 'Brasil' ? 'Brasília' : nombreZona(tz)}`;
    return { opciones, tz, nota: Boolean(nota), frase, texto: `${nota ? `${nota}te passo o mais próximo: ` : 'Tenho livre '}${frase}. Qual fica melhor? Eu reservo e a confirmação chega por e-mail.` };
  }

  const o = (l) => l.join(', ').replace(/, ([^,]*)$/, ' o $1');
  const prefijo = nota ? `${nota}te paso lo más cercano: ` : 'Tengo libre el ';
  const z0 = enZona(opciones[0], tz);
  const mismoDia = opciones.every((x) => enZona(x, tz).fecha === z0.fecha);
  // La zona va como frase, no entre paréntesis: "…a las 14:30, 18:00 o 20:30, en tu horario de España".
  // Daniel (16-sep): decirle de una a qué hora le cae en su país, sin que tenga que sacar cuentas;
  // Ignacio: que sea sutil, no un aviso técnico.
  const enSuHora = `, en tu horario de ${nombreZona(tz)}`;
  // `frase` es la lista pelada, para meterla en una plantilla.
  const frase = `${mismoDia ? `el ${z0.dia} ${z0.num} a las ${o(opciones.map((x) => enZona(x, tz).hora))}` : o(opciones.map((x) => `el ${describir(x, tz)}`))}${enSuHora}`;
  const cuerpo = mismoDia ? `${prefijo}${z0.dia} ${z0.num} a las ${o(opciones.map((x) => enZona(x, tz).hora))}` : `${prefijo}${o(opciones.map((x) => describir(x, tz)))}`;
  return { opciones, tz, nota: Boolean(nota), frase, texto: `${cuerpo}${enSuHora}. ¿Cuál te va? Lo reservo yo y te llega la confirmación por mail.` };
  // ("¿Cuál te va?" y "te llega" valen igual en vos y en tú.)
}

/**
 * El número como lo acepta Cal (E.164 moderno). WhatsApp manda el mexicano con el
 * "1" viejo después del 52 (+52 1 55 4080 3840): Cal lo rechaza con
 * "attendeePhoneNumber invalid_number" (Deavy, 16-sep). Se saca ese 1. El 9 de
 * Argentina (+54 9 11…) sí es válido y se deja.
 */
export function telefonoE164(numero) {
  let d = String(numero).replace(/\D/g, '');
  if (d.startsWith('521') && d.length === 13) d = '52' + d.slice(3);
  return `+${d}`;
}

/**
 * Crea la reserva en Cal.com. `inicio` es ISO con offset (uno de los ofrecidos).
 * Devuelve { uid, start, meetingUrl }. Tira si Cal la rechaza (horario tomado, mail inválido).
 */
export async function reservar({ origen, inicio, lead, numero, email, respuestas = {} }) {
  const tz = zonaDe(numero);
  const id = calendarioDe(origen, numero);
  const br = id !== (CALENDARIOS[origen] || CALENDARIOS.meta);
  const nombre = [lead?.First_Name, lead?.Last_Name].filter(Boolean).join(' ') || lead?.Full_Name || 'Lead WhatsApp';
  const tel = telefonoE164(numero);
  // lp = la landing real del calendario (Ignacio, 18-sep: Matías no va en Calendario ni en
  // los utm). El Flow escribe Calendario = lp solo si estaba vacío y no toca la fuente.
  const campos = { attendeePhoneNumber: tel, lp: LANDING_POR_ORIGEN[origen] || LANDING_POR_ORIGEN.meta, pais: paisDe(numero) || '' };
  if (lead?.id) campos.idcrm = String(lead.id);
  if (br) campos.idioma = 'pt';
  if (origen === 'lili') { campos['-Tienes-una-LLC-en-US'] = [respuestas.tieneLLC ? 'Si' : 'No']; campos['-Quieres-panel-de-facturacion-y-Contabilidad'] = ['Si']; }
  if (origen === 'partner') { campos.que_haces_hoy = 'Otro'; campos.clientes_ultimo_ano = 'Ninguno todavía, pero quiero ofrecerlo'; campos.como_ofrecerlo = 'Quiero conocer las dos opciones'; }
  const cuerpo = {
    eventTypeId: id,
    start: new Date(inicio).toISOString(),
    attendee: { name: nombre, email, phoneNumber: tel, timeZone: tz, language: br ? 'pt' : 'es' },
    bookingFieldsResponses: campos,
    metadata: { origen: 'sdr-matias' },
  };
  const r = await fetch('https://api.cal.com/v2/bookings', { method: 'POST', headers: CAL({ 'cal-api-version': '2024-08-13' }), body: JSON.stringify(cuerpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cal ${r.status}: ${(j.error?.message || JSON.stringify(j)).slice(0, 200)}`);
  const b = j.data || {};
  return { uid: b.uid, start: b.start, meetingUrl: b.meetingUrl || b.location || null, tz };
}

/** Cancela una reserva en Cal.com. El webhook de Cal avisa a Zoho, que marca la reunión sola. */
export async function cancelarReserva(uid, motivo = 'Reagendada por WhatsApp con Matías') {
  // Se prueba con la clave de cada cuenta: la reserva puede ser de ventas o de Administracion (Brasil).
  let error = '';
  for (const k of CLAVES()) {
    const r = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}/cancel`, { method: 'POST', headers: CAL({ 'cal-api-version': '2024-08-13' }, k), body: JSON.stringify({ cancellationReason: motivo }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return true;
    error = `Cal cancel ${r.status}: ${(j.error?.message || JSON.stringify(j)).slice(0, 200)}`;
  }
  throw new Error(error);
}

/**
 * Reservas futuras y vivas de ese mail en Cal, menos `excepto`. Para cuando Matías reprograma y
 * no tiene guardado el uid de la vieja (14-oct, Andres: la vieja quedó viva y le llegó todo doble).
 */
export async function reservasVivasDe(email, excepto) {
  const todas = [];
  for (const k of CLAVES()) {
    const r = await fetch(`https://api.cal.com/v2/bookings?attendeeEmail=${encodeURIComponent(email)}&status=upcoming&take=20`, { headers: CAL({ 'cal-api-version': '2024-08-13' }, k) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Cal bookings ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    todas.push(...(j.data || []));
  }
  return todas.filter((b) => b.status === 'accepted' && b.uid !== excepto && new Date(b.start) > new Date());
}

const MAIL_VALIDO = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
/** El primer mail que aparece en un texto del lead, o ''. */
export function mailEn(texto) {
  const m = String(texto || '').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  return m ? m[0].replace(/\.+$/, '').toLowerCase() : '';
}

/**
 * Ejecuta la acción que pidió el cerebro y devuelve el texto final a mandar.
 * `p` es lo que devolvió `proponer`; `estado` es la ficha `apertura-<tel>` (para
 * validar que el horario elegido fue ofrecido). Devuelve { texto, reservado, ofrecidos, aviso }.
 */
export async function aplicarAccion({ p, origen, lead, numero, estado = {}, ahora = new Date() }) {
  const a = p?.accion || {};
  const tz = zonaDe(numero);
  if (a.tipo === 'confirmar' && estado.confirmacion?.evento) {
    const c = estado.confirmacion;
    const r = await confirmarReunion(c.evento, 'Confirmó', { disparar: false });
    if (!r.ok) throw new Error(`Zoho no guardó la confirmación (quedó ${r.quedo})`);
    return { texto: String(p.texto || '').trim() || (registroDe(numero) === 'pt' ? `Perfeito, esperamos você ${c.cuando ? `em ${c.cuando}` : describir(c.inicio, tz, true)}.` : `Perfecto, te esperamos el ${c.cuando || describir(c.inicio, tz)}.`), confirmado: { evento: c.evento, cuando: c.cuando || c.inicio } };
  }
  if (a.tipo === 'ofrecer_horarios') {
    const of = await ofrecer({ origen, numero, dia: a.dia, franja: a.franja, ahora });
    // Sin horarios libres: NO se manda la intro del modelo ("te paso los espacios:") porque
    // queda vacía (17-sep: salió tres veces seguidas y el lead pidió que no le escriban más).
    // El que llama pone el link del calendario.
    if (!of.opciones.length) return { texto: '', ofrecidos: [], sinHorarios: true };
    // Si no había nada en el día o la franja que pidió, la línea previa del modelo
    // ("te paso lo de mañana a la mañana:") contradice la oferta: va solo la oferta.
    const intro = of.nota ? (registroDe(numero) === 'pt' ? 'Certo.' : 'Dale.') : String(p.texto || '').trim().replace(/https?:\/\/\S+/g, '').trim();
    return { texto: [intro, of.texto].filter(Boolean).join(' '), ofrecidos: of.opciones };
  }
  if (a.tipo === 'reservar') {
    const ofrecidos = estado.ofrecidos || [];
    const pedido = String(a.inicio || '').slice(0, 16); // YYYY-MM-DDTHH:mm en hora del lead
    let inicio = ofrecidos.find((o) => enZona(o, tz).fecha + 'T' + enZona(o, tz).hora === pedido);
    if (!inicio) {
      // No estaba entre los ofrecidos (o se vencieron): se verifica contra Cal ese día.
      const fecha = pedido.slice(0, 10);
      const libres = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? await horariosLibres({ origen, tz, desde: fecha, hasta: fecha, numero }) : [];
      inicio = libres.find((o) => enZona(o, tz).fecha + 'T' + enZona(o, tz).hora === pedido);
    }
    if (!inicio) {
      const of = await ofrecer({ origen, numero, dia: pedido.slice(0, 10), franja: '', ahora });
      return { texto: registroDe(numero) === 'pt' ? `Esse horário não está mais livre. ${of.texto || 'Escolha outro e eu reservo.'}` : `Ese horario ya no lo tengo libre. ${of.texto || 'Elegí otro acá y queda reservado.'}`, ofrecidos: of.opciones, aviso: 'horario pedido no disponible' };
    }
    // 28-sep: el modelo casi nunca copiaba el mail en accion.email y Zoho no lo tenía:
    // M&K y Poncho lo mandaron 3 veces y la frase de abajo salió en loop (12 reservas
    // perdidas). Ahora vale también el mail que quedó en la ficha (lo guarda el webhook
    // apenas el lead lo escribe, y no vence con el hilo de 12 h).
    const email = [a.email, estado.email, lead?.Email].map((x) => String(x || '').trim()).find((x) => MAIL_VALIDO.test(x)) || '';
    if (!email) {
      return { texto: registroDe(numero) === 'pt' ? `Certo, reservo ${describir(inicio, tz, true)} para você. Para qual e-mail eu mando a confirmação com o link da videochamada?` : `Dale, te lo reservo para el ${describir(inicio, tz)}. ¿A qué mail te mando la confirmación con el link de la videollamada?`, ofrecidos: [inicio], pendienteMail: pedido };
    }
    const r = await reservar({ origen, inicio, lead, numero, email, respuestas: a });
    // Si venía de una reunión pendiente (confirmación), la vieja se cancela en Cal:
    // el webhook de Cal le avisa a Zoho y la marca como reagendada.
    let cancelada = null;
    const uidVieja = estado.confirmacion?.uidCal || lead?.eventId;
    const mueve = Boolean(estado.confirmacion || a.reprograma);
    if (mueve && uidVieja && uidVieja !== r.uid) {
      cancelada = await cancelarReserva(uidVieja).then(() => uidVieja).catch((e) => `falló: ${e.message}`);
    } else if (mueve && !uidVieja) {
      // Sin uid guardado: se buscan en Cal las otras reservas vivas de ese mail y se cancelan.
      cancelada = await reservasVivasDe(email, r.uid)
        .then((viejas) => Promise.all(viejas.map((b) => cancelarReserva(b.uid).then(() => b.uid))))
        .then((uids) => uids.join(',') || null)
        .catch((e) => `falló: ${e.message}`);
    }
    const nombre = lead?.First_Name || String(lead?.Full_Name || '').split(' ')[0] || '';
    return {
      // Sin el nombre (Ignacio, 18-sep: "un poquito más humano"; venía "Dale…" y "Listo Edgar…" seguidos).
      texto: registroDe(numero) === 'pt'
        ? `Pronto, ${mueve ? 'passei' : 'reservei'} sua assessoria para ${describir(inicio, tz, true)}, horário de Brasília. A confirmação com o link da videochamada vai chegar em ${email}. Qualquer coisa, me escreve por aqui.`
        : `Listo, te ${mueve ? 'pasé' : 'reservé'} la asesoría ${mueve ? 'al' : 'para el'} ${describir(inicio, tz)}, hora de ${nombreZona(tz)}. Te va a llegar la confirmación con el link de la videollamada a ${email}. ${registroDe(numero) === 'vos' ? 'Cualquier cosa, me escribís por acá.' : 'Cualquier cosa, me escribes por aquí.'}`,
      reservado: { ...r, inicio, email, cancelada },
    };
  }
  return { texto: p?.texto || '' };
}
