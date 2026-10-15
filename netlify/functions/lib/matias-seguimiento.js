/*
 * LOS SEGUIMIENTOS DE MATÍAS. "Hasta la casa al lead, así agende" (Ignacio,
 * 13-sep), pero con techo: 4 toques en 5 días y después silencio.
 *
 *   toque 1  la apertura (lib/matias-apertura.js)
 *   toque 2  +3 h sin respuesta
 *   toque 3  +1 día sin respuesta
 *   toque 4  +3 días sin respuesta, el último
 *
 * ─── REGLAS QUE CORTAN ─────────────────────────────────────────────────────
 *
 *   - Agendó (Lead_Status "Reunión Agendada", Calendario cargado o reserva=true): se calla.
 *   - Contestó después del último toque: no es seguimiento, es conversación;
 *     la maneja el webhook (proponer) y el reloj se reinicia desde su mensaje.
 *   - Pidió que no le escriban: nunca más.
 *   - Fuera de 9 a 21 h Argentina: espera.
 *
 * ─── PLANTILLA O TEXTO LIBRE ───────────────────────────────────────────────
 *
 * Si el lead escribió en las últimas 24 h, Matías puede mandar texto libre y
 * lo escribe el cerebro con todo el contexto. Si no, la ventana está cerrada y
 * sale la plantilla `sdr_matias_seguimiento` con un dato por origen y país.
 */
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get } from './conversaciones/zoho.js';
import { mandarANoShow } from './conversaciones/escritura.js';
import { LINEAS, lineaDe, mandar, plantilla as armarPlantilla, registrar, enHilo, enviarTexto, fusible, cupoCuidado, repite } from './matias.js';
import { PLANTILLAS, paisDe, proponer, nombreDe, plantillaPara, textoDe } from './matias-cerebro.js';
import { aplicarAccion, contextoDeHoy, ofrecer } from './matias-agenda.js';
import * as voz from './matias-voz.js';
import { esHoraDeAbrir, estadoPlantillas } from './matias-apertura.js';
import { tieneReunionFutura } from './matias-noshow.js';
import * as hilo from './hilo.js';

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const digitos = (t) => String(t || '').replace(/\D/g, '');
const H = 3600000;

// Cuándo toca cada seguimiento, contado desde el último toque de Matías.
// Ignacio (14-sep): "meté más seguimientos"; (18-sep): "que haga retargeting, ya sabe".
// 8 toques en ~2 meses, como la cadencia de 30 días del 786 pero con cola larga:
//   +3 h · +1 d · +3 d · +6 d · +10 d · +14 d (≈ día 34) · +30 d (≈ día 64).
// Del 3 en adelante alterna horarios reales (impar) y un dato nuevo (par), para no
// mandar cuatro veces "te paso lo que tengo libre". Todos con el botón de salida.
const ESPERAS = { 2: 3 * H, 3: 24 * H, 4: 72 * H, 5: 144 * H, 6: 240 * H, 7: 336 * H, 8: 720 * H };
const MAX_TOQUES = 8;

// El que NO ENTRÓ a la reunión (Ignacio, 21-sep: "al que no show sí hacerle un
// pequeño seguimiento, no siga con los barridos"): la cadencia es corta. Toque 1
// es el "¿pasó algo?" de lib/matias-noshow.js; +1 día horarios reales; +3 días el
// último, con un dato; y silencio. No se reabre como las aperturas.
const ESPERAS_NOSHOW = { 2: 24 * H, 3: 72 * H };
const MAX_TOQUES_NOSHOW = 3;
// Una ficha está en cadencia de no-show si el no-show fue lo último que le pasó:
// si después reservó otra vez, la confirmación de esa reunión es más nueva y
// vuelve a mandar `sinSeguimiento` (un solo toque, como siempre).
const enCadenciaNoShow = (estado) => Boolean(estado.noshow?.tocado)
  && (!estado.confirmacion?.tocado || new Date(estado.noshow.tocado) > new Date(estado.confirmacion.tocado));

// El dato del seguimiento. Uno por origen y país; nada que no esté en el prompt.
const DATOS = {
  meta: {
    AR: 'con la LLC cobrás en dólares por Stripe o PayPal sin pasar por el banco argentino.',
    CO: 'con la LLC cobras en dólares y pasas la plata a tu cuenta en Colombia cuando quieras.',
    MX: 'con la LLC le facturas a clientes de Estados Unidos y Europa sin salir de México.',
    ES: 'la LLC te deja operar en dólares y abrir cuenta en Estados Unidos sin viajar.',
    _: 'la LLC con cuenta bancaria queda lista en 7 a 12 días hábiles, todo online.',
  },
  lili: { _: 'la cuenta Lili se abre junto con la LLC, sin viajar y sin depósito mínimo.' },
  socios: { _: 'la LLC con cuenta bancaria queda lista en 7 a 12 días hábiles, todo online.' },
  partner: { _: 'los socios derivan al cliente y nosotros hacemos todo el proceso; en la llamada vemos el modelo.' },
};
// Segundo dato, para los toques tardíos (6 y 8): no repetir el del toque 2.
const DATOS_TARDE = {
  meta: {
    AR: 'en 15 minutos de asesoría sabés qué estado te conviene, cuánto tarda y qué necesitás; es gratis y sin compromiso.',
    _: 'en 15 minutos de asesoría sabes qué estado te conviene, cuánto tarda y qué necesitas; es gratis y sin compromiso.',
  },
  lili: { AR: 'la asesoría es gratis: en 15 minutos vemos si te conviene abrir la LLC con la cuenta Lili y cuánto tarda.', _: 'la asesoría es gratis: en 15 minutos vemos si te conviene abrir la LLC con la cuenta Lili y cuánto tarda.' },
  socios: { AR: 'en 15 minutos de asesoría sabés qué estado te conviene y qué necesitás para arrancar; es gratis.', _: 'en 15 minutos de asesoría sabes qué estado te conviene y qué necesitas para arrancar; es gratis.' },
  partner: { _: 'en la llamada de partnerships vemos cómo derivar clientes y qué materiales te damos; son 15 minutos.' },
};
// Brasil (14-oct-2026): el dato entra en la plantilla _pt, así que va en portugués.
const DATOS_PT = {
  cedo: { partner: 'os parceiros indicam o cliente e nós fazemos todo o processo; na ligação vemos o modelo.', _: 'a LLC com conta bancária fica pronta em 7 a 12 dias úteis, tudo online.' },
  tarde: { partner: 'na ligação de parcerias vemos como indicar clientes e quais materiais te damos; são 15 minutos.', _: 'em 15 minutos de assessoria você descobre qual estado compensa, quanto tempo leva e o que precisa; é grátis e sem compromisso.' },
};
const datoPara = (origen, tel, toque = 2) => {
  if (paisDe(tel) === 'BR') { const t = DATOS_PT[toque >= 6 ? 'tarde' : 'cedo']; return t[origen] || t._; }
  const tabla = toque >= 6 ? (DATOS_TARDE[origen] || DATOS_TARDE.meta) : (DATOS[origen] || DATOS.meta);
  return tabla[paisDe(tel)] || tabla._;
};

// Los seguimientos salen por la línea de la ficha (`mandar` la resuelve): un lead
// abierto por el +52 sigue recibiendo por el +52, uno del 863 por el 863.
const enviarPlantillaSeguimiento = (numero, nombre, dato, plantilla) => mandar(numero, armarPlantilla(plantilla, [nombre, dato]));
const enviarPlantillaHorarios = (numero, nombre, libres, plantilla) => mandar(numero, armarPlantilla(plantilla, [nombre, libres]));

/** ¿Ya agendó? Se lee el lead fresco: es la única llamada a Zoho por lead. */
async function agendo(leadId) {
  const j = await get(`Leads/${leadId}?fields=id,Lead_Status,Calendario,reserva,First_Name,Full_Name,Tag,Tipo,Email`);
  const l = (j.data || [])[0] || {};
  return { lead: l, si: /agendad/i.test(String(l.Lead_Status || '')) || Boolean(l.Calendario) || l.reserva === true };
}

/**
 * Una pasada de seguimientos. Recorre las aperturas guardadas en Blobs.
 */
export async function pasadaSeguimientos({ ahora = new Date(), enviar = false } = {}) {
  const resumen = { revisados: 0, seguidos: 0, cerrados: 0, salteados: [] };
  if (!esHoraDeAbrir(ahora)) { resumen.motivo = 'fuera de horario'; return resumen; }
  // El fusible (ver matias.js), por línea: con la línea del lead tocada, ese
  // seguimiento NO sale y tampoco se propone: si se propusiera, el reloj de
  // toques avanzaría en seco y el lead se quedaría sin ese toque cuando el
  // número vuelva. Los de la otra línea siguen.
  const sano = fusible(ahora);
  const plantillasPor = {};
  const plantillasDe = async (linea) => (plantillasPor[linea] ||= await estadoPlantillas(LINEAS[linea].waba));
  resumen.fusible = [];
  // Modo cuidado (Ignacio, 18-sep: "levantá el fusible y sé cuidadoso del +52"): con la
  // línea YELLOW los seguimientos salen igual pero a cuentagotas (cupo por día y por
  // pasada, ver cupoCuidado en matias.js). Un cupo por línea.
  const cupos = {};
  const cupoDe = (linea) => (cupos[linea] ||= cupoCuidado(linea, ahora));
  resumen.cuidado = {};

  const store = almacen();
  const { blobs } = await store.list({ prefix: 'apertura-' });
  // Se cargan todas primero para elegir el orden: con cupo, los que ya contestaron van
  // antes que los mudos, y entre iguales el más atrasado primero. Antes el orden era el
  // del store (alfabético por teléfono) y con 40 por día los +34 se llevaban todo.
  const fichas = [];
  for (const b of blobs) {
    const estado = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!estado || typeof estado !== 'object' || !estado.enviada) continue; // solo aperturas que salieron
    // Retargeting largo (18-sep): las fichas que se cerraron por "N toques sin respuesta"
    // con menos toques que el máximo de hoy se reabren y siguen la cadencia.
    if (estado.cerrado && /^\d+ toques sin respuesta$/.test(estado.cerrado) && (estado.toques || 1) < MAX_TOQUES && !estado.noshow) {
      delete estado.cerrado; delete estado.cerradoEl;
      await store.setJSON(b.key, estado);
    }
    if (estado.cerrado) continue;
    // 28-sep: el freno (enojo, "¿esto es un robot?", reclamo) solo lo respetaba el webhook;
    // el seguimiento le seguía mandando plantillas (Poncho, 10 días). Frenado = lo toma una persona.
    if (estado.frenado) continue;
    fichas.push({ key: b.key, estado });
  }
  fichas.sort((a, b) => (b.estado.contesto ? 1 : 0) - (a.estado.contesto ? 1 : 0)
    || String(a.estado.ultimoToque || a.estado.enviada).localeCompare(String(b.estado.ultimoToque || b.estado.enviada)));

  for (const { key, estado } of fichas) {
    const b = { key };
    const linea = await lineaDe(b.key.replace('apertura-', ''), estado);
    const salud = await sano(linea);
    if (enviar && !salud.ok && !salud.cuidado) { if (!resumen.fusible.includes(linea)) resumen.fusible.push(linea); continue; }
    if (estado.humano) { resumen.salteados.push(`${b.key}: lo tiene una persona en el portal`); continue; }
    const noShow = enCadenciaNoShow(estado);
    if (estado.sinSeguimiento && !noShow) continue; // confirmación: un solo toque, lo sigue el webhook si contesta
    const esperas = noShow ? ESPERAS_NOSHOW : ESPERAS;
    const maxToques = noShow ? MAX_TOQUES_NOSHOW : MAX_TOQUES;
    resumen.revisados++;
    const tel = b.key.replace('apertura-', '');
    const toques = estado.toques || 1;
    const ultimoToque = new Date(estado.ultimoToque || estado.enviada);
    const cerrar = async (motivo) => { await store.setJSON(b.key, { ...estado, cerrado: motivo, cerradoEl: ahora.toISOString() }); resumen.cerrados++; };

    // 1. ¿Contestó después del último toque? Entonces no es seguimiento.
    const conversacion = await hilo.leer(tel, ahora);
    const ultimoDelLead = [...conversacion].reverse().find((h) => h.de === 'cliente');
    const respondioDespues = ultimoDelLead && new Date(ultimoDelLead.cuando || 0) > ultimoToque;
    if (respondioDespues) {
      // el reloj arranca de nuevo desde SU mensaje, y el toque siguiente cuenta como conversación viva
      await store.setJSON(b.key, { ...estado, ultimoToque: ultimoDelLead.cuando, toques: 1 });
      continue;
    }
    if (toques >= maxToques) {
      await cerrar(`${maxToques} toques sin respuesta${noShow ? ' (no-show)' : ''}`);
      // Matías se rindió con el no-show: RECIÉN AHORA entra la cadencia de No Show del CRM
      // (Ignacio, 23-sep-2026: "ponelo en secuencia"). Antes salían las dos juntas, porque
      // marcar la reunión disparaba el workflow que movía el lead: 20 de 24 leads tenían las
      // dos encima. Si mientras tanto reservó otra reunión, no va a ningún lado.
      if (noShow && enviar && estado.lead) {
        const yaReservo = await tieneReunionFutura(estado.lead, ahora).catch(() => true);
        if (!yaReservo) {
          const r = await mandarANoShow(estado.lead);
          resumen.aNoShow = (resumen.aNoShow || 0) + (r.ok ? 1 : 0);
          await enHilo(tel, r.ok
            ? '🔁 Matías se rindió con el no-show: el lead pasa a *No Show* y arranca la cadencia del CRM.'
            : `⚠️ No se pudo pasar a No Show: ${r.error || r.quedo?.Lead_Status || 'sin detalle'}`).catch(() => {});
        }
      }
      continue;
    }
    const siguiente = toques + 1;
    if (ahora - ultimoToque < esperas[siguiente]) continue;

    // 2. Con la línea en cuidado, ¿queda cupo? Se mira ANTES de preguntarle a Zoho:
    // el 18-sep a la tarde cada pasada hacía ~500 GETs a Zoho por leads que igual no
    // iban a salir por cupo (y un corte de Zoho tumbaba la pasada entera). El que no
    // entra hoy espera; el reloj de toques no avanza.
    const conCuidado = enviar && salud.cuidado;
    if (conCuidado && !(await cupoDe(linea).queda())) { resumen.cuidadoEnEspera = (resumen.cuidadoEnEspera || 0) + 1; continue; }

    // 3. ¿Agendó? Si Zoho no contesta, este lead queda para la próxima pasada; los demás siguen.
    // Al no-show no le sirve mirar Lead_Status/Calendario (quedaron cargados por la
    // reunión a la que no fue): agendó de nuevo solo si tiene una reunión futura.
    let lead, si;
    try {
      ({ lead, si } = await agendo(estado.lead));
      if (noShow) si = await tieneReunionFutura(estado.lead, ahora);
    }
    catch (e) { resumen.salteados.push(`${tel}: Zoho ${String(e.message).slice(0, 80)}`); continue; }
    if (si) { await cerrar('agendó'); await enHilo(tel, '🎯 Agendó. Matías se calla; el día anterior le confirma.'); continue; }

    if (lead && !lead.Email && estado.email) lead.Email = estado.email; // el mail que dio por el chat (ver webhook)
    const nombre = nombreDe(lead, estado);
    const ventanaAbierta = ultimoDelLead && (ahora - new Date(ultimoDelLead.cuando || 0)) < 24 * H;

    let texto;
    let comoAudio = false;
    const datoDelToque = datoPara(estado.origen, `+${tel}`, noShow ? 6 : siguiente);
    const datoRepetido = estado.datoEnviado === datoDelToque;
    try {
      if (ventanaAbierta) {
        // Empujar lo que falta (28-sep): si ya estaba cerrando (eligió, faltaba el mail, o ya
        // tenía horarios ofrecidos), el toque retoma ESO; el "dato nuevo" es para el que no avanzó.
        const pedido = estado.pendienteMail
          ? 'ya eligió horario y solo falta su mail: pedíselo en una línea, sin vender nada ni dar datos nuevos'
          : estado.ofrecidos?.length
            ? 'ya le ofreciste horarios (están en la FICHA): retomalos en una línea, preguntale cuál le queda o si prefiere otro día (accion ofrecer_horarios); sin datos nuevos ni pitch'
            : `hacé el seguimiento ${siguiente} de ${maxToques}, corto, con un dato nuevo, y cerrá con la reunión. Si en la conversación ya dijo un día o una franja, no le pidas que reserve: ofrecele horarios concretos con accion ofrecer_horarios`;
        const p = await proponer({ lead, numero: tel, hilo: conversacion, estado, hoy: contextoDeHoy(tel, ahora), ultimo: `(el lead no volvió a escribir hace ${Math.round((ahora - ultimoToque) / H)} h; ${noShow ? 'no entró a la reunión que había reservado y ya le preguntaste qué pasó; ' : ''}${pedido})` });
        if (!p.responde) { resumen.salteados.push(`${tel}: ${p.motivo}`); continue; }
        if (p.accion?.tipo === 'descartar') { await cerrar(`no califica (${p.motivo || 'no busca una LLC'})`); await enHilo(tel, `🚫 No califica: _${p.motivo || 'no busca una LLC'}_. Sin más seguimientos.`); continue; }
        texto = p.texto;
        // En un seguimiento Matías puede ofrecer horarios, pero nunca reservar
        // (reservar es solo cuando el lead acaba de elegir uno).
        if (p.accion?.tipo === 'ofrecer_horarios') {
          try {
            const ag = await aplicarAccion({ p, origen: estado.origen, lead, numero: tel, estado, ahora });
            texto = ag.texto;
            if (ag.ofrecidos?.length) estado.ofrecidos = ag.ofrecidos;
          } catch (e) { await enHilo(tel, `⚠️ La agenda falló en el seguimiento (${e.message}); va el texto pelado.`); }
        }
        if (!texto) { resumen.salteados.push(`${tel}: texto vacío`); continue; }
        // El push, si es conversacional (sin horarios ni link), va como NOTA DE VOZ
        // (Ignacio, 14-sep: "solo cuando sea necesario un push, en audio"). Si el
        // audio falla, sale escrito.
        if (enviar) {
          if (voz.activa() && voz.conviene(texto)) {
            try { await voz.enviarNotaDeVoz(tel, texto); comoAudio = true; }
            catch (e) { await enHilo(tel, `⚠️ La nota de voz no salió (${e.message}); fue escrito.`); }
          }
          if (!comoAudio) {
            if (repite(texto, conversacion)) { resumen.salteados.push(`${tel}: iba a repetir un mensaje`); await store.setJSON(b.key, { ...estado, toques: siguiente, ultimoToque: ahora.toISOString() }); continue; }
            await enviarTexto(tel, texto);
          }
        }
      } else if (datoRepetido || (noShow ? siguiente === 2 : (siguiente >= 3 && siguiente % 2 === 1))) {
        // Si el dato de este toque ya se lo mandamos (hay uno por país: Poncho lo recibió 3
        // veces igual), en vez de repetirlo van horarios reales.
        // Ignacio (14-sep): "repushea todo, ofrezca todo". Del toque 3 en adelante el
        // push fuera de ventana va con horarios reales del día siguiente (plantilla
        // sdr_matias_horarios), no con el dato.
        // La plantilla de horarios se rehizo el 15-sep: hasta que Meta apruebe la
        // nueva, el toque queda para la próxima pasada (no se manda la rota).
        const estados = enviar ? await plantillasDe(linea) : {};
        const plantilla = plantillaPara('horarios', tel, estados);
        if (!plantilla) { resumen.salteados.push(`${tel}: portugués sin plantilla _pt aprobada`); continue; } // Brasil: nunca en español
        if (enviar && estados[plantilla] !== 'APPROVED') { resumen.salteados.push(`${tel}: plantilla ${plantilla} sin aprobar`); continue; }
        const of = await ofrecer({ origen: estado.origen || 'meta', numero: `+${tel}`, dia: '', franja: '', ahora });
        if (!of.opciones.length) { resumen.salteados.push(`${tel}: sin horarios para ofrecer`); continue; }
        texto = textoDe('horarios', plantilla, nombre, of.frase);
        if (enviar) await enviarPlantillaHorarios(tel, nombre, of.frase, plantilla);
        estado.ofrecidos = of.opciones;
      } else {
        // El último del no-show lleva el dato "tardío" (la asesoría son 15 minutos gratis), no el de apertura.
        const dato = datoDelToque;
        const plantilla = plantillaPara('seguimiento', tel, enviar ? await plantillasDe(linea) : {});
        if (!plantilla) { resumen.salteados.push(`${tel}: portugués sin plantilla _pt aprobada`); continue; } // Brasil: nunca en español
        texto = textoDe('seguimiento', plantilla, nombre, dato);
        if (enviar) await enviarPlantillaSeguimiento(tel, nombre, dato, plantilla);
        estado.datoEnviado = dato;
      }
    } catch (e) {
      resumen.salteados.push(`${tel}: Meta ${e.message}`);
      await enHilo(tel, `⚠️ El seguimiento ${siguiente} no salió: ${e.message}`);
      continue;
    }

    await hilo.agregar(tel, 'nosotros', texto, ahora);
    await registrar({ numero: tel, de: 'matias', texto: `${enviar ? '' : '[SEGUIMIENTO PROPUESTO, no enviado] '}${comoAudio ? '🎙️ (nota de voz) ' : ''}${texto}`, cuando: ahora });
    await store.setJSON(b.key, { ...estado, toques: siguiente, ultimoToque: ahora.toISOString() });
    resumen.seguidos++;
    if (conCuidado) { await cupoDe(linea).gasto(); resumen.cuidado[linea] = cupoDe(linea).usados(); }
  }
  return resumen;
}
