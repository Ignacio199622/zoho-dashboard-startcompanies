/*
 * MATÍAS Y LA CONFIRMACIÓN (Ignacio, 14-sep-2026): "un toque a los que no
 * confirmaron la reserva, DESPUÉS del de CRM; si confirma, que le avise al CRM;
 * no las cancelemos".
 *
 * Zoho ya manda por el 786 el "¿confirmás?" (Hora_de_confirmaci_n) y el
 * "recordá responder" (Hora_de_recordatorio), y `Confirmaci_n` queda vacía
 * mientras el lead no contesta. Matías entra recién después:
 *
 *   1. Cada media hora: reuniones de venta que empiezan entre 1 y 26 h, con
 *      `Confirmaci_n` vacía y cuyo recordatorio de Zoho salió hace 2 h o más.
 *   2. Sale la plantilla `sdr_matias_confirmacion` por el +52 con la hora local
 *      del cliente tal como la escribe Zoho (`Hora_local_del_cliente`).
 *   3. Cuando contesta, el cerebro (matias-cerebro.js) sabe que tiene esa
 *      reunión pendiente: "sí" → `Confirmaci_n = Confirmó` en el Event (sin
 *      disparar el "gracias" del 786, Matías agradece él); "no puedo" → ofrece
 *      horarios reales, reserva la nueva y cancela la vieja en Cal.com (el Flow
 *      Cal→Zoho marca la vieja como reagendada solo).
 *
 * RESERVA NUEVA (12-oct-2026, Ignacio: "no espere tanto, que Matías lo mande"; "que confirme
 * al momento de agendar, si no a las 3 horas queda liberado el turno"): si la reunión es dentro
 * de los 7 días y se reservó hace menos de 3 h, en la próxima pasada (cada 5 min) Matías manda UN
 * mensaje: video de pre-llamada (LLC, socios o Lili según el calendario) + "¿me confirmás?" +
 * botones. Se vacía el Sí/No de Zoho (apagarSiNoZoho) y, si no confirma en 3 h, lo libera
 * liberar-sin-confirmar.js. Sin la plantilla aprobada, Zoho sigue como siempre.
 *
 * Un toque por reunión (blob `confirma-<idEvento>`), sin seguimientos. Con
 * `MATIAS_CONFIRMACION_ENVIAR` distinto de 1 propone en #sdr-virtual-matias.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get, conversacionesDesde } from './conversaciones/zoho.js';
import { LINEAS, lineaDe, mandar, plantilla as armarPlantilla, plantillaVideo, registrar, enHilo, fusible, estadoDe } from './matias.js';
import { origenDe, paisDe, PLANTILLAS, nombreDe, plantillaPara, textoDe } from './matias-cerebro.js';
import { esHoraDeAbrir, estadoPlantillas, conviveCon786 } from './matias-apertura.js';
import * as hilo from './hilo.js';
import { ofrecer, enZona, zonaDe } from './matias-agenda.js';
import { apagarSiNoZoho } from './conversaciones/escritura.js';

// v2 (Ignacio, 14-sep: "ofrezca todo"): el toque ya trae horarios alternativos reales.
export const PLANTILLA = PLANTILLAS.confirmacion;
// El texto (vos/tú) vive en el cerebro: TEXTOS.confirmacion.

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const digitos = (t) => String(t || '').replace(/\D/g, '');
const H = 3600000;
// Cuánto se espera después del recordatorio de Zoho antes de que entre Matías.
const ESPERA_TRAS_ZOHO_H = 2;
// 12-oct noche: APAGADO. Ignacio prefiere que el video y el "confirmá o en 4 h se libera" vayan en el
// aviso de agendado de Zoho por el 786 (una plantilla por calendario). Queda por si se vuelve atrás.
const RESERVA_NUEVA_ACTIVA = env.MATIAS_RESERVA_VIDEO === '1';
// Reserva nueva: Matías entra apenas se reservó (pasada cada 5 min) y hasta 3 h después, sin esperar a Zoho.
const RESERVA_NUEVA_MIN = 1;
const RESERVA_NUEVA_MAX_H = 3;
// Lo que dice el mensaje: sin confirmación en estas horas se libera el turno (liberar-sin-confirmar.js).
export const LIBERAR_RESERVA_H = 3;
// La reserva nueva recibe el video aunque la reunión sea dentro de varios días.
const DIAS_RESERVA_NUEVA = 7;
const SITIO = process.env.URL || 'https://metricastart.netlify.app';
/** El video de pre-llamada según el calendario que reservó. */
const videoDe = (lead) => {
  const cal = String(lead.Calendario || '');
  const k = /socio|partner/i.test(cal) ? 'socios' : /lili/i.test(cal) ? 'lili' : 'llc';
  return `${SITIO}/videos/pre-llamada-${k}.mp4`;
};
const isoZoho = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const CAMPOS_EVENTO = 'id,Event_Title,Start_DateTime,Created_Time,Confirmaci_n,Tipo_de_reuni_n,What_Id,Who_Id,Hora_de_confirmaci_n,Hora_de_recordatorio,Hora_local_del_cliente';
const CAMPOS_LEAD = 'id,First_Name,Full_Name,Mobile,Phone,Email,Lead_Status,Calendario,Tag,Tipo,eventId';

// Sale por la línea de la ficha del lead (si no tiene, por la actual).
const enviarPlantilla = (numero, primerNombre, cuando, libres, plantilla = PLANTILLA) => mandar(numero, armarPlantilla(plantilla, [primerNombre, cuando, libres]));

/** "lunes 14 de septiembre, 16:30 hs (hora de Argentina)" sin la coma rara si Zoho no la puso. */
const cuandoLegible = (ev) => String(ev.Hora_local_del_cliente || '').trim() || new Date(ev.Start_DateTime).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Reuniones de venta sin confirmar, entre 1 y 26 h, con el recordatorio de Zoho ya pasado. */
export async function sinConfirmar(ahora = new Date()) {
  const criterio = `((Start_DateTime:greater_equal:${isoZoho(ahora.getTime() + 1 * H)})and(Start_DateTime:less_equal:${isoZoho(ahora.getTime() + DIAS_RESERVA_NUEVA * 24 * H)}))`;
  const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_EVENTO}&per_page=200`);
  return (j.data || []).filter((e) => {
    if (e.Tipo_de_reuni_n === 'Clientes' || e.Confirmaci_n || !e.What_Id?.id) return false;
    if (/^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '')) return false;
    // Reserva nueva: Matías pide la confirmación ya, antes del Sí/No de Zoho.
    const desdeReserva = e.Created_Time ? ahora - new Date(e.Created_Time) : Infinity;
    const siNoPendiente = !e.Hora_de_confirmaci_n || new Date(e.Hora_de_confirmaci_n) > ahora;
    if (RESERVA_NUEVA_ACTIVA && siNoPendiente && desdeReserva >= RESERVA_NUEVA_MIN * 60000 && desdeReserva <= RESERVA_NUEVA_MAX_H * H) { e._nueva = true; return true; }
    if (new Date(e.Start_DateTime) - ahora > 26 * H) return false;
    // Recién después del último aviso de Zoho (recordatorio, o confirmación si no hay recordatorio).
    const aviso = e.Hora_de_recordatorio || e.Hora_de_confirmaci_n;
    if (!aviso) return new Date(e.Start_DateTime) - ahora < 20 * H; // reunión vieja sin campos: entra a 20 h
    return ahora - new Date(aviso) >= ESPERA_TRAS_ZOHO_H * H;
  });
}

export async function pasadaConfirmacion({ ahora = new Date(), enviar = false } = {}) {
  const resumen = { vistos: 0, tocados: 0, propuestos: 0, salteados: [] };
  if (!esHoraDeAbrir(ahora)) { resumen.motivo = 'fuera de horario'; return resumen; }
  const sano = fusible(ahora);
  const plantillasPor = {};
  const plantillasDe = async (linea) => (plantillasPor[linea] ||= await estadoPlantillas(LINEAS[linea].waba));

  const eventos = await sinConfirmar(ahora);
  resumen.vistos = eventos.length;
  if (!eventos.length) return resumen;

  const store = almacen();
  const conversaciones = await conversacionesDesde(new Date(ahora - 24 * H));

  for (const ev of eventos) {
    const clave = `confirma-${ev.id}`;
    if (await store.get(clave)) continue;
    const saltear = async (motivo) => { resumen.salteados.push(`${ev.Event_Title}: ${motivo}`); await store.set(clave, motivo); };

    const lead = ((await get(`Leads/${ev.What_Id.id}?fields=${CAMPOS_LEAD}`)).data || [])[0];
    if (!lead) { await saltear('lead no encontrado'); continue; }
    const tel = lead.Mobile || lead.Phone;
    if (!tel || !String(tel).trim().startsWith('+') || !paisDe(tel)) { await saltear('sin teléfono con prefijo'); continue; }
    const motivo786 = conviveCon786(conversaciones, tel);
    if (motivo786) { await saltear(`786: ${motivo786}`); continue; }
    const estado = await estadoDe(tel);
    if (estado.humano) { await saltear('lo tiene una persona en el portal'); continue; }
    if (/no le escriban/.test(estado.cerrado || '')) { await saltear('pidió que no le escriban'); continue; }
    // Fusible por línea: si la línea de este lead está tocada, se propone y no se manda.
    const linea = await lineaDe(tel, estado);
    const salud = await sano(linea);
    const plantillas = await plantillasDe(linea);
    // Con la línea en cuidado (YELLOW) también sale: es un solo toque a alguien que reservó.
    const enviarPorLinea = enviar && (salud.ok || salud.cuidado);

    const nombre = nombreDe(lead, estado);
    const cuando = cuandoLegible(ev);

    // Reserva nueva (12-oct, Ignacio: "que confirme al momento de agendar, si no a las 3 horas queda
    // liberado el turno"): UN solo mensaje con el video de pre-llamada según el calendario, el pedido
    // de confirmación y los botones "Sí, confirmo" / "Otro horario". La respuesta la toma el cerebro
    // (ficha.confirmacion). Si no confirma, liberar-sin-confirmar.js corta a las 3 h (blob confirma-<id>).
    // Sin la plantilla aprobada no se marca nada: queda el Sí/No de Zoho como siempre.
    if (ev._nueva) {
      const pVideo = plantillaPara('reservaVideo', tel, plantillas);
      if (plantillas[pVideo] !== 'APPROVED') continue;
      if (!enviarPorLinea) { await saltear('reserva nueva: video propuesto, envío apagado'); continue; }
      const texto = textoDe('reservaVideo', pVideo, nombre, cuando);
      try {
        await store.set(clave, `en curso ${ahora.toISOString()}`);
        await mandar(tel, plantillaVideo(pVideo, videoDe(lead), [nombre, cuando]));
        await registrar({ numero: digitos(tel), de: 'matias', texto: `[video pre-llamada] ${texto}`, cuando: ahora });
        await hilo.agregar(digitos(tel), 'nosotros', texto, ahora);
        await store.setJSON(`apertura-${claveTel(tel)}`, {
          ...estado, enviada: estado.enviada || ahora.toISOString(), origen: estado.origen || origenDe(lead), lead: lead.id,
          confirmacion: { evento: ev.id, titulo: ev.Event_Title, inicio: ev.Start_DateTime, cuando, uidCal: lead.eventId || null, tocado: ahora.toISOString() },
          ofrecidos: [], linea,
          sinSeguimiento: true, cerrado: undefined, cerradoEl: undefined,
        });
        await store.setJSON(clave, { enviada: ahora.toISOString(), lead: lead.id, tel: digitos(tel), reserva: true, plazoH: LIBERAR_RESERVA_H });
        await enHilo(digitos(tel), `🎬 Reserva nueva *${ev.Event_Title}* (${cuando}): le mandé el video de pre-llamada con el Sí/No. Si no confirma en ${LIBERAR_RESERVA_H} h, se libera el turno (si es de Meta y el día está lleno).`);
        // Solo si el Sí/No de Zoho iba a salir en las próximas horas: para una reunión de dentro de
        // varios días, el del día anterior queda como recordatorio.
        if (new Date(ev.Start_DateTime) - ahora <= 26 * H) {
          const z = await apagarSiNoZoho(ev.id).catch((e) => ({ ok: false, error: e.message }));
          if (!z.ok) await enHilo(digitos(tel), `⚠️ No pude sacar el Sí/No de Zoho de esta reunión (${z.error}): le puede llegar también esa confirmación.`);
        }
        resumen.tocados++;
      } catch (e) {
        await store.delete(clave).catch(() => {});
        await enHilo(digitos(tel), `⚠️ El video de pre-llamada no salió: ${e.message}`);
        resumen.salteados.push(`${ev.Event_Title}: Meta ${e.message}`);
      }
      continue;
    }
    // Horarios alternativos reales (el día siguiente a la reunión, en la hora del lead), para que elija en el momento.
    const diaSiguiente = enZona(new Date(new Date(ev.Start_DateTime).getTime() + 24 * H), zonaDe(tel)).fecha;
    let of = { opciones: [], frase: '' };
    try { of = await ofrecer({ origen: origenDe(lead), numero: tel, dia: diaSiguiente, franja: '', ahora }); } catch (e) { resumen.salteados.push(`${ev.Event_Title}: sin horarios (${e.message})`); }
    if (!of.opciones.length) { await saltear('sin horarios libres para ofrecer'); continue; }
    const clavePl = 'confirmacion';
    const plantilla = plantillaPara(clavePl, tel, plantillas);
    if (!plantilla) { await saltear('portugués: sin plantilla _pt aprobada'); continue; } // Brasil: nunca en español
    const aprobada = plantillas[plantilla] === 'APPROVED';
    const texto = textoDe(clavePl, plantilla, nombre, cuando, of.frase);
    const sale = enviarPorLinea && aprobada;
    await registrar({ numero: digitos(tel), de: 'matias', texto: `${sale ? '' : '[CONFIRMACIÓN PROPUESTA, no enviada] '}${texto}`, cuando: ahora });
    if (!sale) {
      await enHilo(digitos(tel), `💡 Confirmación *${origenDe(lead)}* propuesta (no se mandó: ${!enviar ? 'MATIAS_CONFIRMACION_ENVIAR apagado' : !(salud.ok || salud.cuidado) ? `fusible, ${salud.motivo}` : `plantilla ${plantilla} en estado ${plantillas[plantilla] || 'inexistente'}`}). Reunión: ${ev.Event_Title} · ${cuando}`);
      await store.set(clave, `propuesta ${ahora.toISOString()}`);
      resumen.propuestos++;
      continue;
    }
    try {
      await store.set(clave, `en curso ${ahora.toISOString()}`);
      await enviarPlantilla(tel, nombre, cuando, of.frase, plantilla);
      await hilo.agregar(digitos(tel), 'nosotros', texto, ahora);
      // La ficha queda lista para el webhook: sabe qué reunión está pendiente
      // (para confirmarla o reagendarla) y no recibe seguimientos de apertura.
      await store.setJSON(`apertura-${claveTel(tel)}`, {
        ...estado, enviada: estado.enviada || ahora.toISOString(), origen: estado.origen || origenDe(lead), lead: lead.id,
        confirmacion: { evento: ev.id, titulo: ev.Event_Title, inicio: ev.Start_DateTime, cuando, uidCal: lead.eventId || null, tocado: ahora.toISOString() },
        ofrecidos: of.opciones, linea,
        sinSeguimiento: true, cerrado: undefined, cerradoEl: undefined,
      });
      await store.setJSON(clave, { enviada: ahora.toISOString(), lead: lead.id, tel: digitos(tel) });
      await enHilo(digitos(tel), `📅 Sin confirmar *${ev.Event_Title}* (${cuando}). Matías le preguntó; si dice que sí lo marca en el CRM, si no puede le ofrece horarios y reagenda.`);
      resumen.tocados++;
    } catch (e) {
      await store.delete(clave).catch(() => {});
      await enHilo(digitos(tel), `⚠️ El mensaje de confirmación no salió: ${e.message}`);
      resumen.salteados.push(`${ev.Event_Title}: Meta ${e.message}`);
    }
  }
  return resumen;
}
