// Informe semanal de llamadas de clientes.
//
// Lo pidio Ignacio el 15-sep-2026: "semanalmente un informe de que llamadas de
// clientes se hicieron". Sale de las reuniones con Tipo = Clientes en Zoho (las
// que crea el agente de Calendly, ver clientes-calendly.js) y de lo que el
// equipo y el agente de Fathom van cargando en cada una: si asistio, quien la
// atendio, si el problema quedo resuelto y el resumen de la llamada.
//
// SOLO LECTURA. No toca ningun registro.
//
// La semana va de lunes 00:00 a domingo 23:59 hora de Argentina (UTC-3 fijo,
// Argentina no cambia de hora). Se corre el lunes a la manana sobre la semana
// que termino.
import { get } from './zoho.js';
import { ZOHO_UI } from './config.js';

const ART_OFFSET_MS = 3 * 3600e3; // Argentina es UTC-3 todo el año
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const CAMPOS =
  'id,Event_Title,Start_DateTime,End_DateTime,Tipo_de_reuni_n,Status_del_Meet,Confirmaci_n,Who_Id,What_Id,$se_module,' +
  'Motivo_de_la_consulta,Por_qui_n_fue_abordado,Problema_estuvo_resuelto,Hora_local_del_cliente,Zona_horaria_del_cliente,Description';

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';
const cancelada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');

/** Lunes 00:00 ART de la semana que contiene `fecha` (o la anterior si `semanasAtras` = 1). */
export function semana(fecha = new Date(), semanasAtras = 1) {
  const enArt = new Date(fecha.getTime() - ART_OFFSET_MS);
  const dow = (enArt.getUTCDay() + 6) % 7; // lunes = 0
  const lunesArt = Date.UTC(enArt.getUTCFullYear(), enArt.getUTCMonth(), enArt.getUTCDate() - dow - 7 * semanasAtras);
  const desde = new Date(lunesArt + ART_OFFSET_MS);
  const hasta = new Date(desde.getTime() + 7 * 86400e3 - 1);
  return { desde, hasta };
}

function fechaArt(iso) {
  const d = new Date(new Date(iso).getTime() - ART_OFFSET_MS);
  return { dia: DIAS[d.getUTCDay()], num: d.getUTCDate(), mes: MESES[d.getUTCMonth()], hora: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
}
const diaCorto = (iso) => { const f = fechaArt(iso); return `${f.dia} ${f.num} ${f.hora}`; };
export const rangoTexto = ({ desde, hasta }) => { const a = fechaArt(desde), b = fechaArt(hasta); return `${a.num} de ${a.mes} al ${b.num} de ${b.mes}`; };

async function eventos(criterio) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return out.sort((a, b) => String(a.Start_DateTime).localeCompare(String(b.Start_DateTime)));
}

/**
 * Lo que hay que mirar de una semana:
 *  - clientes: reuniones Tipo = Clientes (agendaclientes / Calendly)
 *  - porVenta: Contactos (clientes) que reservaron por un link de VENTA. No son
 *    soporte formal pero son llamadas de clientes igual, y sin esto el numero
 *    queda corto (14-sep: 21 de 128 reuniones en 30 dias eran de este tipo).
 *  - proximas: las de clientes ya agendadas para la semana que arranca.
 */
export async function leerSemana({ desde, hasta }) {
  const todas = await eventos(`((Start_DateTime:greater_equal:${isoZoho(desde)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`);
  // Las fichas de prueba del equipo (ej. "Camila Salazar (prueba circuito clientes)") no van al informe.
  const real = (e) => !/prueba/i.test(`${e.Who_Id?.name || ''} ${e.Event_Title || ''}`);
  const clientes = todas.filter((e) => e.Tipo_de_reuni_n === 'Clientes' && real(e));
  const porVenta = todas.filter((e) => e.Tipo_de_reuni_n !== 'Clientes' && e.Who_Id?.id && !cancelada(e) && real(e));
  const semanaQueViene = { desde: new Date(hasta.getTime() + 1), hasta: new Date(hasta.getTime() + 7 * 86400e3) };
  const proximas = (await eventos(`((Start_DateTime:greater_equal:${isoZoho(semanaQueViene.desde)})and(Start_DateTime:less_equal:${isoZoho(semanaQueViene.hasta)})and(Tipo_de_reuni_n:equals:Clientes))`)).filter((e) => !cancelada(e) && real(e));
  return { clientes, porVenta, proximas, semanaQueViene };
}

// El resumen que deja el agente de Fathom en la Description de la reunion
// (ver llamadas-crm/src/clientes.js: "Resumen de la llamada (Fathom, ...): ...").
function resumenFathom(desc) {
  const m = /Resumen de la llamada \(Fathom[^)]*\):\s*([\s\S]*?)(?:\n|$)/.exec(desc || '');
  if (!m) return null;
  const t = m[1].trim();
  return t.length > 220 ? t.slice(0, 217).trimEnd() + '…' : t;
}
function proximoPaso(desc) {
  const m = /Próximo paso:\s*(.*)/.exec(desc || '');
  return m ? m[1].trim() : null;
}
// Lo que el cliente escribio al reservar (sirve cuando todavia no hay Fathom).
function consultaDelCliente(desc) {
  const m = /Consulta:\s*(.*)/.exec(desc || '');
  const t = m ? m[1].trim() : '';
  if (!t || /^(-|n\/a|no|\.)$/i.test(t)) return null;
  return t.length > 140 ? t.slice(0, 137).trimEnd() + '…' : t;
}

function estadoDe(e, ahora) {
  if (cancelada(e)) return 'cancelada';
  if (e.Status_del_Meet === 'Asistió') return 'asistió';
  if (e.Status_del_Meet === 'No asistió' || e.Confirmaci_n === 'No asiste') return 'no asistió';
  if (new Date(e.End_DateTime || e.Start_DateTime) > ahora) return 'pendiente';
  return 'sin marcar';
}

const linkContacto = (e) => (e.Who_Id?.id ? `<${ZOHO_UI}/Contacts/${e.Who_Id.id}|${e.Who_Id.name}>` : (e.What_Id?.name || (e.Event_Title || '').replace(/^(\[\w+\] )?SOPORTE \(cliente\) - /, '').split(' - ')[0]));
const linkReunion = (e) => `<${ZOHO_UI}/Events/${e.id}|reunión>`;
const empresaDe = (e) => (e.$se_module === 'Deals' ? e.What_Id?.name : e.$se_module === 'Accounts' ? e.What_Id?.name : null);

function lineaCliente(e, ahora) {
  const estado = estadoDe(e, ahora);
  const icono = { asistió: ':white_check_mark:', 'no asistió': ':x:', cancelada: ':no_entry_sign:', 'sin marcar': ':grey_question:', pendiente: ':calendar:' }[estado];
  const partes = [`${icono} *${diaCorto(e.Start_DateTime)}* · ${linkContacto(e)}`];
  const emp = empresaDe(e);
  if (emp) partes.push(emp);
  if (e.Motivo_de_la_consulta) partes.push(e.Motivo_de_la_consulta);
  if (estado === 'asistió' || estado === 'sin marcar') {
    partes.push(e.Por_qui_n_fue_abordado ? `atendió ${e.Por_qui_n_fue_abordado}` : 'atendió _(sin cargar)_');
  }
  if (estado === 'asistió') {
    partes.push(e.Problema_estuvo_resuelto ? `resuelto: ${e.Problema_estuvo_resuelto}` : 'resuelto: _(sin cargar)_');
  } else if (estado !== 'pendiente') {
    partes.push(estado);
  }
  partes.push(linkReunion(e));
  const lineas = [partes.join(' · ')];
  const res = resumenFathom(e.Description);
  const paso = proximoPaso(e.Description);
  const consulta = consultaDelCliente(e.Description);
  if (res) lineas.push(`      _${res}_${paso ? ` → ${paso}` : ''}`);
  else if (consulta) lineas.push(`      _pidió: ${consulta}_`);
  return lineas.join('\n');
}

function conteo(lista, clave) {
  const m = {};
  for (const x of lista) m[clave(x) || '(sin cargar)'] = (m[clave(x) || '(sin cargar)'] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

/** El texto para Slack (mrkdwn). */
export function armarInforme({ rango, clientes, porVenta, proximas, ahora = new Date() }) {
  const L = [];
  // "Cerradas" = las que ya tienen un desenlace: pasaron, se cancelaron o el
  // cliente avisó que no viene. Las que todavía no llegaron no cuentan.
  const pasadas = clientes.filter((e) => estadoDe(e, ahora) !== 'pendiente');
  const estados = pasadas.map((e) => estadoDe(e, ahora));
  const n = (s) => estados.filter((x) => x === s).length;
  const asistidas = pasadas.filter((e) => estadoDe(e, ahora) === 'asistió');

  L.push(`:telephone_receiver: *Llamadas de clientes · semana del ${rangoTexto(rango)}*`);
  if (!clientes.length && !porVenta.length) {
    L.push('No hubo reuniones de clientes esta semana (ni por agendaclientes ni por los links de venta).');
  } else {
    L.push(`*${clientes.length}* agendadas por agendaclientes: *${n('asistió')}* asistieron · *${n('no asistió')}* no asistieron · *${n('cancelada')}* canceladas${n('sin marcar') ? ` · *${n('sin marcar')}* sin marcar` : ''}`);
  }

  if (clientes.length) {
    L.push('');
    for (const e of clientes) L.push(lineaCliente(e, ahora));
  }

  if (asistidas.length) {
    L.push('');
    const resueltas = asistidas.filter((e) => e.Problema_estuvo_resuelto === 'Sí').length;
    const cargadas = asistidas.filter((e) => e.Problema_estuvo_resuelto).length;
    L.push(`*Resueltas en la llamada:* ${resueltas} de ${cargadas} con dato${cargadas < asistidas.length ? ` (${asistidas.length - cargadas} sin cargar)` : ''}`);
    L.push(`*Por motivo:* ${conteo(clientes, (e) => e.Motivo_de_la_consulta).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    L.push(`*Quién atendió:* ${conteo(asistidas, (e) => e.Por_qui_n_fue_abordado).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }

  // Reincidencia: el mismo contacto con dos reuniones en la semana suele ser un
  // problema que no se resolvio a la primera.
  const porContacto = {};
  for (const e of clientes.filter((e) => !cancelada(e))) if (e.Who_Id?.id) (porContacto[e.Who_Id.id] ||= []).push(e);
  const repetidos = Object.values(porContacto).filter((l) => l.length > 1);
  if (repetidos.length) {
    L.push('');
    L.push(`*Volvieron a agendar en la misma semana:* ${repetidos.map((l) => `${linkContacto(l[0])} (${l.length})`).join(', ')}`);
  }

  const faltan = pasadas.filter((e) => {
    const s = estadoDe(e, ahora);
    return s === 'sin marcar' || (s === 'asistió' && (!e.Por_qui_n_fue_abordado || !e.Problema_estuvo_resuelto));
  });
  if (faltan.length) {
    L.push('');
    L.push(`:pencil2: *Falta cargar en ${faltan.length}:* ${faltan.map((e) => {
      const f = [];
      if (!e.Status_del_Meet && !cancelada(e)) f.push('asistió/no');
      if (!e.Por_qui_n_fue_abordado) f.push('quién atendió');
      if (!e.Problema_estuvo_resuelto) f.push('resuelto');
      return `${linkContacto(e)} (${f.join(', ')})`;
    }).join(' · ')}`);
  }

  if (porVenta.length) {
    L.push('');
    L.push(`*Clientes que reservaron por el link de venta (${porVenta.length}):* ${porVenta.map((e) => `${diaCorto(e.Start_DateTime)} ${linkContacto(e)}${e.Status_del_Meet ? ` (${e.Status_del_Meet.toLowerCase()})` : ''}`).join(' · ')}`);
  }

  L.push('');
  L.push(proximas.length
    ? `:calendar: *Agendadas para esta semana (${proximas.length}):* ${proximas.map((e) => `${diaCorto(e.Start_DateTime)} ${linkContacto(e)}${e.Motivo_de_la_consulta ? ` · ${e.Motivo_de_la_consulta}` : ''}`).join(' · ')}`
    : ':calendar: No hay reuniones de clientes agendadas para esta semana todavía.');

  return L.join('\n');
}

/** Todo junto: lee la semana y arma el texto. */
export async function informeSemanal({ ahora = new Date(), semanasAtras = 1 } = {}) {
  const rango = semana(ahora, semanasAtras);
  const datos = await leerSemana(rango);
  return { rango, ...datos, texto: armarInforme({ rango, ...datos, ahora }) };
}
