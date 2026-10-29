// LAS REUNIONES DE CLIENTES, DE CALENDLY A ZOHO.
//
// agendaclientes.startcompanies.io es Calendly ("Consulta de Seguimiento –
// Clientes Start Companies", 30 min, cuenta administracion@startcompanies.io).
// Calendly no habla con Zoho: al 14-sep-2026, 50 reservas en 30 dias (39
// activas, 11 canceladas) y ninguna existia en el CRM. La cuenta es plan
// basico, sin webhooks, asi que esto se lee por API cada 5 minutos.
//
// ─── LO QUE PIDIO IGNACIO (14-sep-2026) ────────────────────────────────────
//
//  - La reunion cuelga del CONTACTO (Who_Id), nunca de un lead. Asi no despierta
//    ninguna cadencia de venta ni a Matias.
//  - Se busca por el mail de la reserva; si no, por el nombre de la LLC que el
//    cliente escribe en Calendly (dueña -> contacto). Medido: 47 de 50 por mail,
//    3 por LLC, 0 sin match. Desde el 15-sep-2026 Calendly tambien pide el
//    WhatsApp (obligatorio, tipo telefono): es el tercer camino de match, y si
//    el Contacto no tenia Mobile se le completa con ese (nunca se pisa uno
//    cargado: es el que ata las conversaciones de WhatsApp en el CRM).
//  - Si no matchea: aviso a Slack y NADA mas. "Nunca manche los no match de
//    posibles clientes": no se crea lead, no se crea contacto.
//  - Tipo = Clientes: por eso no cuenta en el no-show de venta y no la toca la
//    baja automatica.
//  - El motivo que pregunta Calendly (Renovacion / Cuenta Bancaria / ...) ata
//    la reunion al trato de ese tipo si el cliente lo tiene; si no, a la LLC.
//
// ─── LO QUE (TODAVIA) NO HACE ──────────────────────────────────────────────
//
// (14-sep-2026, fase 2) La reunion se crea con trigger vacio y DESPUES se le pone
// Tipo = Clientes con trigger workflow: esa edicion dispara la regla "SC Cliente
// agendada" (WhatsApp de reserva al telefono del Contacto). El Si/No de 24 h lo
// programa agendar-recordatorios.js; el de 30 min y el de no-show son reglas por
// fecha / por Status del Meet, todas con criterio Tipo = Clientes.
import { get } from './zoho.js';
import { env } from './entorno.js';
import { crearReunionCliente, cancelarReunionCliente, completarMobileContacto } from './escritura.js';

const CALENDLY = 'https://api.calendly.com';
const HORAS_ATRAS = 3; // una reserva para "dentro de 10 minutos" tambien entra
const DIAS_ADELANTE = 60;

// Lo que elige el cliente en Calendly -> el picklist `Motivo_de_la_consulta` de Reuniones
// (creado el 14-sep-2026 con las mismas opciones).
const MOTIVO_A_PICKLIST = {
  'on-boardin soy cliente nuevo :)': 'Onboarding (cliente nuevo)',
  renovacion: 'Renovación',
  contabilidad: 'Contabilidad',
  itin: 'ITIN',
  'cuenta bancaria': 'Cuenta Bancaria',
  otro: 'Otro',
};
export const motivoPicklist = (m) => MOTIVO_A_PICKLIST[String(m || '').toLowerCase().trim()] || 'Otro';

const MOTIVO_A_TIPO_TRATO = {
  renovacion: 'Renovación',
  'cuenta bancaria': 'Cuenta Bancaria',
  'on-boardin soy cliente nuevo :)': 'Apertura',
};

const DIAS = { Sunday: 'domingo', Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles', Thursday: 'jueves', Friday: 'viernes', Saturday: 'sábado' };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Misma tabla que convertCal (Flow de Cal), para que el texto sea identico.
const CIUDADES_ES = {
  'Mexico City': 'Ciudad de México', Bogota: 'Bogotá', Cordoba: 'Córdoba', Tucuman: 'Tucumán', 'Sao Paulo': 'San Pablo',
  Santiago: 'Santiago de Chile', Panama: 'Panamá', Asuncion: 'Asunción', Cancun: 'Cancún', Merida: 'Mérida', Mazatlan: 'Mazatlán',
  Havana: 'La Habana', 'New York': 'Nueva York', 'Los Angeles': 'Los Ángeles', London: 'Londres', Paris: 'París', Rome: 'Roma',
  Berlin: 'Berlín', Lisbon: 'Lisboa', Dublin: 'Dublín', Zurich: 'Zúrich', Brussels: 'Bruselas', Amsterdam: 'Ámsterdam', Vienna: 'Viena',
  Warsaw: 'Varsovia', Prague: 'Praga', Athens: 'Atenas', Istanbul: 'Estambul', Dubai: 'Dubái', Tokyo: 'Tokio', Shanghai: 'Shanghái',
  Sydney: 'Sídney', Stockholm: 'Estocolmo', Copenhagen: 'Copenhague', Moscow: 'Moscú', Belem: 'Belém', Bahia: 'Bahía',
  Buenos_Aires: 'Argentina', 'Buenos Aires': 'Argentina',
};

/** "martes 15 de septiembre, 12:30 hs (hora de Berlín)" en la zona del cliente. */
export function horaLocalTexto(inicio, tz) {
  try {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(inicio)) p[x.type] = x.value;
    const dia = DIAS[p.weekday] || p.weekday;
    let ciudad = tz.includes('/') ? tz.slice(tz.lastIndexOf('/') + 1).replace(/_/g, ' ') : tz;
    ciudad = CIUDADES_ES[ciudad] || CIUDADES_ES[tz.slice(tz.lastIndexOf('/') + 1)] || ciudad;
    return `${dia} ${p.day} de ${MESES[+p.month - 1]}, ${p.hour}:${p.minute} hs (hora de ${ciudad})`;
  } catch {
    return '';
  }
}

async function calendly(path) {
  const r = await fetch(path.startsWith('http') ? path : `${CALENDLY}${path}`, { headers: { Authorization: `Bearer ${env.CALENDLY_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly ${r.status} ${path.slice(0, 60)}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}

/** El link real de Meet: Calendly da un redirect propio (calendly.com/events/<id>/google_meet). */
async function linkDeMeet(loc) {
  const url = loc?.join_url || '';
  if (!url) return '';
  if (!/calendly\.com\/events/.test(url)) return url;
  try {
    const r = await fetch(url, { redirect: 'manual' });
    const dest = r.headers.get('location') || '';
    return dest || url;
  } catch {
    return url;
  }
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
/** El telefono como lo guarda Contactos: "+" y digitos ("+54 9 11 2345-6789" -> "+5491123456789"). */
export const telefonoE164 = (t) => {
  const d = String(t || '').replace(/\D/g, '').replace(/^00/, '');
  return d.length >= 8 ? `+${d}` : '';
};
const respuesta = (inv, empieza) => (inv.questions_and_answers || []).find((q) => norm(q.question).startsWith(norm(empieza)))?.answer?.trim() || '';

/**
 * Busca la ficha de cliente. Devuelve { contacto, cuenta, via } o null.
 * Primero el mail (Contactos lo tiene unico), despues el nombre de la LLC.
 */
export async function buscarCliente({ email, llc, telefono }) {
  if (email) {
    const r = await get(`Contacts/search?email=${encodeURIComponent(email)}&fields=id,Full_Name,Mobile,Account_Name`);
    const c = (r.data || [])[0];
    if (c) return { contacto: c, cuenta: c.Account_Name || null, via: 'mail' };
  }
  if (llc && norm(llc).length >= 4) {
    const primera = llc.trim().split(/\s+/)[0];
    const a = await get(`Accounts/search?criteria=${encodeURIComponent(`(Account_Name:starts_with:${primera})`)}&fields=id,Account_Name`);
    const lista = a.data || [];
    const cuenta = lista.find((x) => norm(x.Account_Name) === norm(llc)) || lista.find((x) => norm(x.Account_Name).includes(norm(llc).slice(0, 10)));
    if (cuenta) {
      const cs = await get(`Accounts/${cuenta.id}/Contacts?fields=id,Full_Name,Mobile`);
      const c = (cs.data || [])[0];
      if (c) return { contacto: c, cuenta: { id: cuenta.id, name: cuenta.Account_Name }, via: 'llc' };
    }
  }
  // Tercero, el WhatsApp que dejo en Calendly. Con y sin "+": el 9 argentino y el
  // 1 mexicano ya rompen bastante como para sumarle el prefijo.
  if (telefono) {
    for (const v of [...new Set([telefono, telefono.replace(/^\+/, '')])]) {
      const criterio = `((Mobile:equals:${v})or(Phone:equals:${v}))`;
      const r = await get(`Contacts/search?criteria=${encodeURIComponent(criterio)}&fields=id,Full_Name,Mobile,Account_Name`).catch(() => ({}));
      const c = (r.data || [])[0];
      if (c) return { contacto: c, cuenta: c.Account_Name || null, via: 'telefono' };
    }
  }
  return null;
}

/** El trato del tipo que dice el motivo, si el contacto (o su LLC) lo tiene. */
async function tratoPorMotivo({ contacto, cuenta }, motivo) {
  const tipo = MOTIVO_A_TIPO_TRATO[String(motivo || '').toLowerCase().trim()];
  if (!tipo) return null;
  const campos = 'id,Deal_Name,Type,Stage,Modified_Time';
  const listas = [];
  for (const [mod, id] of [['Contacts', contacto?.id], ['Accounts', cuenta?.id]]) {
    if (!id) continue;
    const j = await get(`${mod}/${id}/Deals?fields=${campos}`).catch(() => ({}));
    listas.push(...(j.data || []));
  }
  const masNuevo = (l) => l.sort((a, b) => new Date(b.Modified_Time) - new Date(a.Modified_Time))[0] || null;
  const delTipo = masNuevo(listas.filter((d) => d.Type === tipo));
  if (delTipo) return delTipo;
  // Las cuentas bancarias de casi todos viven ADENTRO del trato de Apertura (campo
  // `Cuentas_bancarias`), no en un trato tipo "Cuenta Bancaria" (eso es el layout de las
  // ventas de cuenta sola). Sin esto, una consulta por Lili quedaba colgada de la LLC.
  if (tipo === 'Cuenta Bancaria') return masNuevo(listas.filter((d) => d.Type === 'Apertura'));
  return null;
}

// Los bancos que nombra el cliente en la consulta libre de Calendly -> `Bancos_abiertos` de
// Reuniones (multiselect, mismas opciones que `Cuentas_bancarias` de Tratos). Es una
// precarga: el boton Asistio lo muestra para confirmar o corregir. No toca el trato.
const BANCOS = [[/\blili\b/i, 'Lili Bank'], [/\brelay\b/i, 'Relay'], [/\bmercury\b/i, 'Mercury'], [/\bbridge\b/i, 'Bridge'], [/\bchase\b/i, 'Chase']];
export const bancosDeTexto = (t) => BANCOS.filter(([re]) => re.test(String(t || ''))).map(([, b]) => b);

/** Reservas de Calendly (activas y canceladas) desde hace 3 h hasta 60 dias. 1 o 2 llamadas. */
export async function reservas(ahora = new Date(), userUri) {
  const min = new Date(ahora.getTime() - HORAS_ATRAS * 3600e3).toISOString();
  const max = new Date(ahora.getTime() + DIAS_ADELANTE * 86400e3).toISOString();
  const out = [];
  let url = `/scheduled_events?user=${encodeURIComponent(userUri)}&min_start_time=${min}&max_start_time=${max}&count=100&sort=start_time:asc`;
  for (let i = 0; i < 3 && url; i++) {
    const j = await calendly(url);
    out.push(...(j.collection || []));
    url = j.pagination?.next_page || null;
  }
  return out;
}

/**
 * Una pasada. `memoria` es el mapa uuid -> { zohoId, status, ... } que guarda la
 * funcion de Netlify entre corridas (se muta aca). Devuelve el resumen.
 */
export async function unaPasada({ escribir = false, ahora = new Date(), memoria = {}, filtro = null } = {}) {
  if (!env.CALENDLY_TOKEN) throw new Error('falta CALENDLY_TOKEN');
  if (!memoria._user) memoria._user = (await calendly('/users/me')).resource.uri;
  const lista = await reservas(ahora, memoria._user);
  const r = { vistas: lista.length, creadas: [], canceladas: [], sinMatch: [], fallidas: [], salteadas: 0 };

  for (const ev of lista) {
    if (filtro && !filtro(ev)) continue; // para probar con UNA reserva
    const uuid = ev.uri.slice(ev.uri.lastIndexOf('/') + 1);
    const previa = memoria[uuid];

    if (ev.status === 'canceled') {
      if (!previa?.zohoId || previa.status === 'canceled') { r.salteadas++; continue; }
      if (escribir) {
        const w = await cancelarReunionCliente(previa.zohoId, previa.titulo);
        if (!w.ok) { r.fallidas.push({ nombre: previa.nombre, error: w.error }); continue; }
      }
      memoria[uuid] = { ...previa, status: 'canceled' };
      r.canceladas.push({ nombre: previa.nombre, zohoId: previa.zohoId, inicio: ev.start_time });
      continue;
    }

    if (previa?.zohoId || previa?.sinMatch) { r.salteadas++; continue; }

    const inv = ((await calendly(`${ev.uri}/invitees`)).collection || [])[0] || {};
    const llc = respuesta(inv, 'como es el nombre');
    const motivo = respuesta(inv, 'por que motivo') || 'Otro';
    const consulta = respuesta(inv, 'cual es tu consulta');
    const telefono = telefonoE164(respuesta(inv, 'cual es tu numero de whatsapp'));
    const tz = inv.timezone || 'America/Argentina/Buenos_Aires';
    const inicio = new Date(ev.start_time);
    const fin = new Date(ev.end_time);

    const ficha = await buscarCliente({ email: inv.email, llc, telefono });
    if (!ficha) {
      memoria[uuid] = { sinMatch: true, nombre: inv.name, email: inv.email, llc, telefono, motivo, inicio: ev.start_time };
      r.sinMatch.push({ nombre: inv.name, email: inv.email, llc, telefono, motivo, inicio: ev.start_time, horaLocal: horaLocalTexto(inicio, tz) });
      continue;
    }

    // El Contacto sin Mobile no recibe ningun WhatsApp (las plantillas leen
    // Who_Id->Contacts.Mobile): se completa con el de Calendly ANTES de crear la
    // reunion, porque "SC Cliente agendada" dispara en ese momento.
    let telefonoCompletado = false;
    if (telefono && !ficha.contacto.Mobile && escribir) {
      const m = await completarMobileContacto(ficha.contacto.id, telefono).catch((e) => ({ ok: false, quedo: String(e.message) }));
      if (m.ok) { ficha.contacto.Mobile = telefono; telefonoCompletado = true; }
    }
    const telefonoDistinto = Boolean(telefono && ficha.contacto.Mobile && telefonoE164(ficha.contacto.Mobile) !== telefono);

    const trato = await tratoPorMotivo(ficha, motivo).catch(() => null);
    const meet = await linkDeMeet(ev.location);
    const titulo = `SOPORTE (cliente) - ${inv.name} - ${motivo}`;
    const datos = {
      Event_Title: titulo,
      Start_DateTime: inicio.toISOString().slice(0, 19) + '+00:00',
      End_DateTime: fin.toISOString().slice(0, 19) + '+00:00',
      Who_Id: { id: ficha.contacto.id },
      Venue: meet,
      Description: [
        `Motivo: ${motivo}`,
        llc ? `LLC (según el cliente): ${llc}` : null,
        consulta ? `Consulta: ${consulta}` : null,
        telefono ? `WhatsApp (según el cliente): ${telefono}${telefonoDistinto ? ` (distinto al del CRM: ${ficha.contacto.Mobile})` : ''}` : null,
        `Reservado por Calendly (agendaclientes): ${ev.uri}`,
      ].filter(Boolean).join('\n'),
      // Tipo_de_reuni_n NO va aca: se escribe en un segundo PUT con trigger workflow
      // (ver crearReunionCliente), y ese cambio es lo que dispara "SC Cliente agendada".
      Motivo_de_la_consulta: motivoPicklist(motivo),
      Bancos_abiertos: bancosDeTexto(consulta),
      Hora_local_del_cliente: horaLocalTexto(inicio, tz),
      Zona_horaria_del_cliente: tz,
    };
    if (trato) { datos.What_Id = { id: trato.id }; datos.$se_module = 'Deals'; }
    else if (ficha.cuenta?.id) { datos.What_Id = { id: ficha.cuenta.id }; datos.$se_module = 'Accounts'; }

    const fila = { nombre: inv.name, contacto: ficha.contacto, via: ficha.via, motivo, llc, trato: trato ? `${trato.Deal_Name} (${trato.Type})` : null, cuenta: ficha.cuenta?.name || null, inicio: ev.start_time, horaLocal: datos.Hora_local_del_cliente, meet, telefono, sinTelefono: !ficha.contacto.Mobile, telefonoCompletado, telefonoDistinto };
    if (escribir) {
      const w = await crearReunionCliente(datos);
      if (!w.ok) { r.fallidas.push({ nombre: inv.name, error: w.error }); continue; }
      fila.zohoId = w.id;
      memoria[uuid] = { zohoId: w.id, status: 'active', nombre: inv.name, titulo, contactoId: ficha.contacto.id, inicio: ev.start_time };
    }
    r.creadas.push(fila);
  }
  return r;
}
