/*
 * MATÍAS Y EL NO-SHOW (Ignacio, 14-sep-2026): de todo lo que pasa alrededor de
 * una reunión, lo único que toma Matías es el que NO ENTRÓ a la asesoría de
 * venta. "Como soy Matías, más humano: ¿pasó algo?". El resto (confirmación de
 * 24 h, el link a la hora, las reuniones de clientes) lo sigue haciendo Zoho.
 *
 *   1. Cada hora se buscan en Zoho las reuniones de venta marcadas
 *      `Status_del_Meet = No asistió` (lo marca el operador o el Coach) en las
 *      últimas 48 h. Las de clientes (`Tipo_de_reuni_n = Clientes`) no.
 *   2. Si el lead ya tiene otra reunión futura, ya reagendó: no se le escribe.
 *      Si habla por el 786, tampoco. Si pidió que no le escriban, tampoco.
 *   3. Sale la plantilla `sdr_matias_no_asistio` por la línea de su ficha (si esa
 *      línea está caída, por la actual: es alguien que reservó, no puede quedar
 *      sin el mensaje). Cuando contesta, el webhook lo lleva al cerebro, que
 *      ofrece horarios reales y reserva (matias-agenda.js).
 *   4. Si no contesta, un seguimiento CORTO (Ignacio, 21-sep: "al que no show sí
 *      hacerle un pequeño seguimiento"): +1 día horarios, +3 días el último con
 *      un dato, y silencio. Lo corre lib/matias-seguimiento.js (cadencia `noshow`).
 *
 * Una reunión se toca una sola vez (blob `noshow-<idEvento>`). Sale con el mismo
 * interruptor que todo Matías (`MATIAS_ENVIAR=1`); `MATIAS_NOSHOW_ENVIAR=0` lo
 * apaga solo a él. Vale para cualquier origen (meta, Lili, socios, partner): los
 * horarios se ofrecen del calendario de ese origen.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get, conversacionesDesde } from './conversaciones/zoho.js';
import { LINEAS, LINEA_ACTUAL, lineaDe, mandar, plantilla as armarPlantilla, registrar, enHilo, fusible, estadoDe } from './matias.js';
import { origenDe, paisDe, PLANTILLAS, nombreDe, plantillaPara, textoDe } from './matias-cerebro.js';
import { esHoraDeAbrir, estadoPlantillas, conviveCon786 } from './matias-apertura.js';
import * as hilo from './hilo.js';
import { ofrecer } from './matias-agenda.js';

// v2 (Ignacio, 14-sep: "ofrezca todo"): el mensaje ya trae horarios reales.
// v4 (Ignacio, 16-sep): "te estuve esperando", un empujón más desde la empresa.
// Mientras Meta revisa la v4 sale la v3; `plantillaNoShow` elige según el estado.
export const PLANTILLA = PLANTILLAS.noAsistio;
// v4 (o su gemela _tu) si Meta ya la aprobó; si no, la v3. Los textos viven en el cerebro.
export function plantillaNoShow(estados, numero) {
  const v4 = plantillaPara('noAsistio', numero, estados);
  return estados[v4] === 'APPROVED' ? { clave: 'noAsistio', plantilla: v4 } : { clave: 'noAsistioAnterior', plantilla: plantillaPara('noAsistioAnterior', numero, estados) };
}

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const digitos = (t) => String(t || '').replace(/\D/g, '');
const H = 3600000;
const isoZoho = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const CAMPOS_EVENTO = 'id,Event_Title,Start_DateTime,Status_del_Meet,Confirmaci_n,Tipo_de_reuni_n,What_Id,Who_Id,Modified_Time';
const CAMPOS_LEAD = 'id,First_Name,Full_Name,Mobile,Phone,Email,Lead_Status,Calendario,Tag,Tipo';
// Estados del lead en los que la cancelada ya la sigue otro (o no hay que seguirla).
const ESTADOS_CON_OTRO_SEGUIMIENTO = ['No Show', 'Retargeting', 'Retargeting Lili', 'Nurturing', 'No Interesado', 'Fuera de flujo', 'Convertido', 'Cliente'];

// Sale por la línea que se resolvió abajo (la de la ficha, o la actual si aquélla está caída).
const enviarPlantilla = (numero, primerNombre, libres, plantilla = PLANTILLA, linea = null) => mandar(numero, armarPlantilla(plantilla, [primerNombre, libres]), { linea });

/** Reuniones de venta marcadas "No asistió" en las últimas `horas`. */
export async function noShowsRecientes(ahora = new Date(), horas = 48) {
  const criterio = `((Status_del_Meet:equals:No asistió)and(Modified_Time:greater_equal:${isoZoho(ahora - horas * H)}))`;
  const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_EVENTO}&per_page=200`);
  return (j.data || []).filter((e) =>
    e.Tipo_de_reuni_n !== 'Clientes' &&
    !/^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '') &&
    e.What_Id?.id &&
    new Date(e.Start_DateTime) < ahora);
}

/**
 * Reuniones de venta CANCELADAS en las últimas `horas` (Ignacio, 11-oct-2026: "si el cliente
 * la cancela ahí sí debería ir Matías"). Entran las que el lead canceló en Cal y las que el
 * agente liberó por no confirmar; las dos quedan `[CANCELADA]`. Las de clientes no (soporte
 * va por Calendly y su propio circuito). Las `[REAGENDADA]` tampoco: ya tienen otra reserva.
 * Pueden ser de una hora todavía futura: el lead canceló antes de la reunión.
 * Entra también el "No" del Sí/No (Status_del_Meet = 'Cancelada', lo marca conversaciones/cancelaciones.js
 * al cancelar en Cal). Ignacio (11-oct): "el que dijo que no debería entrar, ofrecerle al toque y después
 * tiene que ir al no show": Matías le ofrece horarios en la pasada siguiente y, si no contesta, su cadencia
 * corta termina en el No Show del CRM. Cuando cancelaciones.js le pone "No asistió" a las 72 h es la misma
 * reunión: el blob `noshow-<id>` ya está y no se repite. Las que liberó el agente quedan [CANCELADA] +
 * "No asistió" y noShowsRecientes las saltea por el título.
 */
export async function canceladasRecientes(ahora = new Date(), horas = 48) {
  const criterio = `((Event_Title:starts_with:[CANCELADA])and(Modified_Time:greater_equal:${isoZoho(ahora - horas * H)}))`;
  const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_EVENTO}&per_page=200`);
  return (j.data || []).filter((e) =>
    e.Tipo_de_reuni_n !== 'Clientes' &&
    /^\[CANCELADA\]/.test(e.Event_Title || '') &&
    e.Status_del_Meet !== 'Asistió' &&
    e.What_Id?.id);
}

/** ¿La última respuesta del 786 a este número la dio una persona (no el bot "Start Companies Staff")? */
function atendidoPorPersona(conversaciones, numero) {
  const nueve = (t) => String(t || '').replace(/\D/g, '').slice(-9);
  const c = conversaciones.find((x) => nueve(x.mobile_number__s) === nueve(numero));
  const quien = c?.replied_by__s?.name || '';
  return Boolean(quien) && !/start companies staff/i.test(quien);
}

export async function tieneReunionFutura(leadId, ahora) {
  const j = await get(`Leads/${leadId}/Events?fields=Start_DateTime,Event_Title&per_page=50`).catch(() => ({ data: [] }));
  return (j.data || []).some((e) => new Date(e.Start_DateTime) > ahora && !/^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || ''));
}

export async function pasadaNoShow({ ahora = new Date(), enviar = false, horasCanceladas = 48 } = {}) {
  const resumen = { vistos: 0, tocados: 0, propuestos: 0, salteados: [] };
  if (!esHoraDeAbrir(ahora)) { resumen.motivo = 'fuera de horario'; return resumen; }
  const sano = fusible(ahora);
  const plantillasPor = {};
  const plantillasDe = async (linea) => (plantillasPor[linea] ||= await estadoPlantillas(LINEAS[linea].waba));

  // Las canceladas se suman al mismo recorrido y a los mismos frenos; cambian el texto y la
  // plantilla. Si la búsqueda de canceladas falla, el no-show sigue igual que antes.
  const eventos = [
    ...(await noShowsRecientes(ahora)).map((ev) => ({ ...ev, motivo: 'noshow' })),
    ...(await canceladasRecientes(ahora, horasCanceladas).catch(() => [])).map((ev) => ({ ...ev, motivo: 'cancelada' })),
  ];
  // Un lead con dos reuniones en la lista (Alberto Cortina: dos canceladas) recibe un solo mensaje por pasada.
  const yaEscritos = new Set();
  resumen.vistos = eventos.length;
  if (!eventos.length) return resumen;

  const store = almacen();
  const conversaciones = await conversacionesDesde(new Date(ahora - 24 * H));

  for (const ev of eventos) {
    const clave = `noshow-${ev.id}`;
    if (await store.get(clave)) continue; // ya tocada
    const saltear = async (motivo) => { resumen.salteados.push(`${ev.Event_Title}: ${motivo}`); await store.set(clave, motivo); };

    const lead = ((await get(`Leads/${ev.What_Id.id}?fields=${CAMPOS_LEAD}`)).data || [])[0];
    if (!lead) { await saltear('lead no encontrado'); continue; }
    const tel = lead.Mobile || lead.Phone;
    if (!tel || !String(tel).trim().startsWith('+') || !paisDe(tel)) { await saltear('sin teléfono con prefijo'); continue; }
    if (yaEscritos.has(claveTel(tel))) { await saltear('ya le escribió por otra reunión en esta pasada'); continue; }
    if (await tieneReunionFutura(lead.id, ahora)) { await saltear('ya tiene otra reunión agendada'); continue; }
    const motivo786 = conviveCon786(conversaciones, tel);
    // El "No" del Sí/No deja la charla del 786 como respondida (contestó el bot: "liberamos ese horario").
    // A la cancelada solo la frena un vendedor de verdad, no esa respuesta automática.
    if (motivo786 && (ev.motivo !== 'cancelada' || atendidoPorPersona(conversaciones, tel))) { await saltear(`786: ${motivo786}`); continue; }
    const estado = await estadoDe(tel);
    if (estado.humano) { await saltear('lo tiene una persona en el portal'); continue; }
    if (/no le escriban/.test(estado.cerrado || '')) { await saltear('pidió que no le escriban'); continue; }
    // A la cancelada no se le escribe si su ficha quedó cerrada por algo que dijo (un "no" cierra:
    // feedback 14-sep). Solo se reabre la que se cerró por silencio ("3 toques sin respuesta").
    const cancelada = ev.motivo === 'cancelada';
    if (cancelada && estado.cerrado && !/toques sin respuesta/.test(estado.cerrado)) { await saltear(`ficha cerrada: ${estado.cerrado}`); continue; }
    // Tampoco si ya está en otra cadencia del CRM (No Show, Retargeting, Nurturing) o salió de la
    // venta: le caerían dos seguimientos juntos (medido 11-oct: 13 de 21 canceladas ya estaban en una).
    if (cancelada && ESTADOS_CON_OTRO_SEGUIMIENTO.includes(lead.Lead_Status)) { await saltear(`ya en ${lead.Lead_Status}`); continue; }
    // Miriam (28-sep) avisó por el chat que no podía ir y pidió reprogramar; una hora después le
    // llegó "te estuve esperando". Si el lead escribió en las últimas 24 h, la charla ya está viva:
    // la sigue el webhook (que ahora sí reprograma), no la plantilla.
    const suyos = (await hilo.leer(digitos(tel), ahora).catch(() => [])).filter((h) => h.de === 'cliente');
    if (suyos.length) {
      await saltear('el lead escribió por el chat en las últimas horas');
      await enHilo(digitos(tel), `ℹ️ No-show sin plantilla: el lead ya escribió por el chat ("${suyos.at(-1).texto.slice(0, 80)}"). Si pidió reprogramar y nadie le contestó, contestale a mano.`).catch(() => {});
      continue;
    }
    // Fusible por línea: si la línea de este lead está tocada, se propone y no se manda.
    // Salvo que la actual esté sana: el no-show es un toque a alguien que reservó y no
    // puede quedar colgado de una línea RED (el +52 desde el 19-sep). En ese caso sale
    // por la actual y la ficha pasa a esa línea, así la conversación sigue por ahí.
    const lineaPropia = await lineaDe(tel, estado);
    let linea = lineaPropia;
    let salud = await sano(linea);
    if (!(salud.ok || salud.cuidado) && linea !== LINEA_ACTUAL) {
      const saludActual = await sano(LINEA_ACTUAL);
      if (saludActual.ok || saludActual.cuidado) { linea = LINEA_ACTUAL; salud = saludActual; }
    }
    const plantillas = await plantillasDe(linea);
    // Con la línea en cuidado (YELLOW) también sale: es un solo toque a alguien que reservó.
    const enviarPorLinea = enviar && (salud.ok || salud.cuidado);

    const nombre = nombreDe(lead, estado);
    let of = { opciones: [], frase: '' };
    try { of = await ofrecer({ origen: origenDe(lead), numero: tel, dia: '', franja: '', ahora }); } catch (e) { resumen.salteados.push(`${ev.Event_Title}: sin horarios (${e.message})`); }
    if (!of.opciones.length) { await saltear('sin horarios libres para ofrecer'); continue; }
    const { clave: claveTexto, plantilla } = cancelada
      ? { clave: 'cancelada', plantilla: plantillaPara('cancelada', tel, plantillas) }
      : plantillaNoShow(plantillas, tel);
    if (!plantilla) { await saltear('portugués: sin plantilla _pt aprobada'); continue; } // Brasil: nunca en español
    const que = cancelada ? 'Cancelada' : 'No-show';
    const aprobada = plantillas[plantilla] === 'APPROVED';
    const texto = textoDe(claveTexto, plantilla, nombre, of.frase);
    const sale = enviarPorLinea && aprobada;
    await registrar({ numero: digitos(tel), de: 'matias', texto: `${sale ? '' : `[${que.toUpperCase()} PROPUESTO, no enviado] `}${texto}`, cuando: ahora });
    if (!sale) {
      await enHilo(digitos(tel), `💡 ${que} *${origenDe(lead)}* propuesto (no se mandó: ${!enviar ? 'MATIAS_ENVIAR apagado' : !(salud.ok || salud.cuidado) ? `fusible, ${salud.motivo}` : `plantilla ${plantilla} en estado ${plantillas[plantilla] || 'inexistente'}`}). Reunión: ${ev.Event_Title} · ${ev.Start_DateTime}`);
      await store.set(clave, `propuesta ${ahora.toISOString()}`);
      resumen.propuestos++;
      continue;
    }
    try {
      await store.set(clave, `en curso ${ahora.toISOString()}`);
      await enviarPlantilla(tel, nombre, of.frase, plantilla, linea);
      yaEscritos.add(claveTel(tel));
      await hilo.agregar(digitos(tel), 'nosotros', texto, ahora);
      // La ficha del lead queda lista para que el webhook ofrezca horarios y
      // reserve cuando conteste. Este mensaje es el toque 1 de la cadencia corta
      // de no-show (ver matias-seguimiento.js); `sinSeguimiento` se levanta porque
      // la confirmación previa de esta misma reunión lo había puesto.
      await store.setJSON(`apertura-${claveTel(tel)}`, { ...estado, enviada: estado.enviada || ahora.toISOString(), origen: estado.origen || origenDe(lead), lead: lead.id, noshow: { evento: ev.id, titulo: ev.Event_Title, inicio: ev.Start_DateTime, tocado: ahora.toISOString() }, ofrecidos: of.opciones, linea, toques: 1, ultimoToque: ahora.toISOString(), sinSeguimiento: undefined, cerrado: undefined, cerradoEl: undefined });
      await store.setJSON(clave, { enviada: ahora.toISOString(), lead: lead.id, tel: digitos(tel) });
      await enHilo(digitos(tel), `${cancelada ? '🗓️ Se canceló' : '📵 No asistió a'} *${ev.Event_Title}* (${ev.Start_DateTime}). Matías le escribió${linea !== lineaPropia ? ' por la línea actual (la suya está caída)' : ''}; si contesta, le ofrece horarios y reserva. Si no, un seguimiento corto: +1 día y +3 días.`);
      resumen.tocados++;
    } catch (e) {
      await store.delete(clave).catch(() => {});
      await enHilo(digitos(tel), `⚠️ El mensaje de ${cancelada ? 'cancelada' : 'no-show'} no salió: ${e.message}`);
      resumen.salteados.push(`${ev.Event_Title}: Meta ${e.message}`);
    }
  }
  return resumen;
}
