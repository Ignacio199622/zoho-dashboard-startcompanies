/*
 * ¿QUÉ CONVERSACIÓN DE MATÍAS NECESITA UNA PERSONA?
 *
 * Una vez por día en #sdr-virtual-matias, etiquetando a Santiago. No es el
 * reporte (ese cuenta aperturas, respuestas y reservas): esto es la lista corta
 * de los chats que el bot no puede seguir solo y que, si nadie los toca, se
 * mueren. Ignacio, 22-sep-2026: "revisá cuál necesita intervención humana y
 * avisá a Santiago".
 *
 * Lo que mira, por orden de importancia:
 *   1. Matías se frenó a propósito (precio, "¿sos un robot?", sondeo) y nadie lo tomó.
 *   2. Alguien lo tomó desde el portal y no escribió nada después.
 *   3. El lead escribió último y quedó sin respuesta.
 *   4. El último envío rebotó 131047: solo sale con plantilla o llamada.
 *   5. Lo que dice el lead: precio, enojo, "quiero avanzar", duda de su caso.
 *
 * ─── TRES TRAMPAS, TODAS MEDIDAS EL 22-SEP ─────────────────────────────────
 *
 * a) `ficha.cliente` es un OBJETO (`{es:false,…}`), así que SIEMPRE es truthy.
 *    Filtrar por `Boolean(ficha.cliente)` tira afuera justo los casos que
 *    importan (Keyler, Marybel, Poncho, Mr Las). Va `cliente?.es === true`.
 * b) El store de hilos (`autorespuesta`) es COMPARTIDO con el 786. En un chat
 *    del 786 "nadie le contestó" no se puede medir: lo que manda el equipo
 *    desde Zoho no pasa por nuestro webhook. Por eso solo entran las fichas con
 *    rastro propio de Matías (`enviada`, `contesto` o `lead`), que deja afuera
 *    las del incidente del 18-sep y las de candado de cliente.
 * c) Si se avisa todos los días lo mismo, Santiago deja de leerlo. Cada caso
 *    avisado guarda su huella en `avisado-<tel>` y no vuelve a salir hasta que
 *    cambie algo o pasen REPETIR_DIAS.
 */
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get } from './conversaciones/zoho.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab/Leads';
const SANTIAGO = env.SLACK_ID_SANTIAGO || 'U0AF0PMM6KG';
const DIAS = 12;          // ventana de actividad de la ficha
const REPETIR_DIAS = 7;   // si sigue sin tocarse, se vuelve a avisar
const TOPE = 12;          // cuántos entran en el mensaje

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const chats = () => getStore({ name: 'autorespuesta', consistency: 'strong' });
const h = (ms) => ms / 3600e3;

const enTandas = async (lista, n, fn) => {
  const out = [];
  for (let i = 0; i < lista.length; i += n) out.push(...await Promise.all(lista.slice(i, i + n).map(fn)));
  return out;
};

const esLead = (m) => m.de === 'cliente' || m.de === 'lead';
const PLATA = /(precio|cuesta|cu[aá]nto (sale|cuesta|vale|cobran)|costo|caro|presupuesto|descuento|cuotas|tarifa)/i;
const ENOJO = /(no me molest|me hart|ya basta|es una estafa|los denuncio|son un robo|qu[eé] pesad|dejen de escribir|es spam)/i;
const ROBOT = /(sos un (robot|bot)|eres un (robot|bot)|hablo con una persona|persona real|esto es un rob)/i;
const CASO = /(ya tengo (una )?llc|visa|impuesto|itin|socio|banco|cuenta bancaria|contrato|factur|residen|amazon|shopify|trading)/i;
const QUIERE = /((?<!no )me interesa|quiero (avanzar|empezar|contratar|arrancar|la llc)|c[oó]mo (empiezo|arranco)|contrat[ao]r|adelantemos|estoy listo)/i;
const DICE_NO = /(no me interesa|no me escrib|no molest|ya no (me )?interesa|fue un error)/i;
const AUTORESPUESTA = /(gracias por comunicarte con|haznos saber c[oó]mo|horario de atenci[oó]n|mensaje autom)/i;
/** "Gracias", "ok", "Ah okay; gracias.", un 👍 suelto: eso cierra solo, no es una conversación colgada. */
const cortesia = (t) => {
  const s = String(t || '').trim();
  if (!s) return true;
  if (!/[a-záéíóúñ]/i.test(s)) return true;                      // solo emojis o signos
  return s.length <= 30 && !s.includes('?') && /(ok|okey|okay|listo|gracias|perfecto|dale|de acuerdo|genial)/i.test(s);
};
const CERRADA_BIEN = /no le interesa|no le escriban|no califica|sospechoso|agend|confirm|toques sin respuesta|no asisti/i;

/** El último movimiento de la ficha, sea del lado que sea. */
const cuando = (f) => {
  const t = [f.enviada, f.contesto, f.respondioMatias, f.ultimoToque, f.frenadoEl, f.cerradoEl, f.humanoDesde, f.falloEl]
    .filter(Boolean).map((x) => new Date(x).getTime()).filter(Boolean);
  return t.length ? new Date(Math.max(...t)) : null;
};

/** Junta los casos que piden una persona. No avisa ni marca nada. */
export async function foto(ahora = new Date()) {
  const store = almacen();
  const { blobs } = await store.list({ prefix: 'apertura-' });
  const fichas = (await enTandas(blobs, 50, async (b) => {
    const e = await store.get(b.key, { type: 'json' }).catch(() => null);
    return e && typeof e === 'object' ? { tel: b.key.slice(9), ...e } : null;
  })).filter(Boolean);

  const candidatas = fichas.filter((f) => {
    if (f.cliente?.es === true || /es cliente/i.test(f.cerrado || '') || /candado/i.test(f.humanoQuien || '')) return false;
    if (!(f.enviada || f.contesto || f.lead)) return false;           // ver trampa (b)
    if (f.reserva || CERRADA_BIEN.test(f.cerrado || '')) return false;
    const c = cuando(f);
    return c && h(ahora - c) < DIAS * 24;
  });

  const hilos = Object.fromEntries(await enTandas(candidatas, 50, async (f) => {
    const j = await chats().get('hilo-' + f.tel, { type: 'json' }).catch(() => null);
    return [f.tel, Array.isArray(j) ? j : []];
  }));

  const casos = [];
  for (const f of candidatas) {
    const hilo = hilos[f.tel] || [];
    const ult = hilo[hilo.length - 1];
    const ultNuestro = [...hilo].reverse().find((m) => !esLead(m));
    const dicho = hilo.filter(esLead).map((m) => m.texto).join('\n');
    const razones = [];
    let peso = 0;
    // Un caso entra SOLO si pasó algo que pide una persona (esto). Lo demás (precio,
    // "quiero avanzar", una duda, no haber reservado) agrega contexto pero no alcanza:
    // eso lo trabaja el retargeting del bot.
    let fuerte = false;

    if (f.frenado && !f.humano) { razones.push(`Matías se frenó solo: ${f.frenado}`); peso += 5; fuerte = true; }

    // Un "no", un "gracias" o la autorespuesta de un negocio no son una conversación colgada.
    const cierraSolo = ult && esLead(ult) && (DICE_NO.test(ult.texto) || AUTORESPUESTA.test(ult.texto) || cortesia(ult.texto));
    const colgado = ult && esLead(ult) && !cierraSolo && (!ultNuestro || new Date(ultNuestro.cuando) < new Date(ult.cuando));
    const horas = colgado ? h(ahora - new Date(ult.cuando)) : 0;
    if (colgado && horas > 2) {
      razones.push(`escribió hace ${horas < 48 ? Math.round(horas) + ' h' : Math.round(horas / 24) + ' días'} y quedó sin respuesta`);
      peso += horas < 48 ? 4 : 2;
      fuerte = true;
    }
    if (f.humano) {
      const escribio = ultNuestro && f.humanoDesde && new Date(ultNuestro.cuando) > new Date(f.humanoDesde);
      if (!escribio) { razones.push(`lo tomó ${f.humanoQuien || 'alguien'} y no hay mensaje suyo después`); peso += 4; fuerte = true; }
    }
    // Solo 131047 (se cerró la ventana de 24 h de una conversación que existía). El 131049
    // es Meta bloqueándole el marketing al número: eso no lo arregla una persona y son cientos.
    if (/131047/.test(String(f.fallo || ''))) { razones.push('el último envío rebotó: solo sale con plantilla o llamada'); peso += 2; }
    if (ENOJO.test(dicho)) { razones.push('está molesto'); peso += 4; fuerte = true; }
    if (ROBOT.test(dicho)) { razones.push('preguntó si habla con una persona'); peso += 3; fuerte = true; }
    if (PLATA.test(dicho)) { razones.push('preguntó por precio'); peso += 2; }
    if (QUIERE.test(dicho)) { razones.push('dijo que quiere avanzar'); peso += 2; }
    if (CASO.test(dicho)) { razones.push('duda concreta de su caso'); peso += 1; }
    if (f.ofrecidos?.length && f.contesto) { razones.push('le ofrecimos horarios y no reservó'); peso += 2; }

    // El "no" que no cerró la ficha es un bug del bot, no un caso para una persona.
    if (ult && esLead(ult) && DICE_NO.test(ult.texto) && !f.cerrado) continue;
    if (!fuerte) continue;

    casos.push({
      tel: f.tel, nombre: f.nombre || null, lead: f.lead || null,
      estado: f.cerrado ? `cerrada: ${f.cerrado}` : f.humano ? `la tiene ${f.humanoQuien || 'una persona'}` : f.frenado ? 'frenada' : 'abierta',
      peso, razones, ultimo: cuando(f)?.toISOString() || null,
      ultimoTexto: ult ? { de: esLead(ult) ? 'el lead' : 'Matías', texto: String(ult.texto).replace(/\s+/g, ' ').slice(0, 160), cuando: ult.cuando } : null,
    });
  }

  // Los que ya agendaron por otro lado (Cal, el 786) no van: la ficha no se entera.
  await enTandas(casos.filter((c) => c.lead), 5, async (c) => {
    try {
      const j = await get(`Leads/${c.lead}?fields=id,Full_Name,Lead_Status,Calendario`);
      const z = (j.data || [])[0] || {};
      c.nombre = c.nombre || z.Full_Name;
      c.agendo = /agendad/i.test(String(z.Lead_Status || '')) || Boolean(z.Calendario);
    } catch { /* si Zoho está caído, se avisa igual */ }
  });

  casos.sort((a, b) => b.peso - a.peso || new Date(b.ultimo) - new Date(a.ultimo));
  return casos.filter((c) => !c.agendo);
}

/** La huella de un caso: si no cambió, no se vuelve a avisar. */
const huella = (c) => `${c.ultimo}|${c.estado}|${c.razones.join('·')}`;

const fecha = (iso) => new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function armar(nuevos, repetidos) {
  const linea = (c) => {
    const quien = c.nombre ? `*${c.nombre}*` : c.tel ? `*+${c.tel}*` : '*Sin número*';
    const tel = c.nombre && c.tel ? ` +${c.tel}` : '';
    const dijo = c.ultimoTexto ? ` · último, ${c.ultimoTexto.de} el ${fecha(c.ultimoTexto.cuando)}: "${c.ultimoTexto.texto}"` : '';
    const zoho = c.lead ? ` · <${ZOHO_UI}/${c.lead}|Zoho>` : '';
    return `• ${quien}${tel} · ${c.razones.join(' · ')}${dijo}${zoho}`;
  };
  const cabecera = `🙋 <@${SANTIAGO}> *Matías: ${nuevos.length} conversaci${nuevos.length === 1 ? 'ón' : 'ones'} que necesita${nuevos.length === 1 ? '' : 'n'} una persona*`;
  const bloques = [{ type: 'section', text: { type: 'mrkdwn', text: `${cabecera}\n${nuevos.slice(0, TOPE).map(linea).join('\n')}` } }];
  if (nuevos.length > TOPE) bloques.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…y ${nuevos.length - TOPE} más en la lista.` }] });
  if (repetidos.length) bloques.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Además siguen sin tocarse, ya avisados: ${repetidos.map((c) => c.nombre || '+' + c.tel).join(', ')}.` }] });
  return { text: `Matías: ${nuevos.length} conversaciones necesitan una persona`, blocks: bloques, unfurl_links: false };
}

async function aSlack(cuerpo) {
  const canal = env.SLACK_CANAL_MATIAS || env.SLACK_CANAL;
  const post = async (extra) => {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: canal, ...cuerpo, ...extra }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j;
  };
  try { return await post({ username: 'Matías · SDR', icon_emoji: ':male-office-worker:' }); }
  catch (e) { if (/missing_scope|invalid_arguments/.test(e.message)) return post({}); throw e; }
}

/**
 * La pasada del día. `ensayo` arma todo y no manda ni marca nada.
 */
export async function publicar(ahora = new Date(), { ensayo = false } = {}) {
  const store = almacen();
  const casos = await foto(ahora);
  const nuevos = [];
  const repetidos = [];
  for (const c of casos) {
    const clave = `avisado-${c.tel || 'sin-numero'}`;
    const previo = await store.get(clave, { type: 'json' }).catch(() => null);
    const viejo = previo && h(ahora - new Date(previo.cuando)) > REPETIR_DIAS * 24;
    if (previo && previo.huella === huella(c) && !viejo) repetidos.push(c);
    else nuevos.push({ ...c, clave });
  }
  if (!nuevos.length) return { casos, nuevos, repetidos, mandado: false };
  const cuerpo = armar(nuevos, repetidos);
  if (ensayo) return { casos, nuevos, repetidos, cuerpo, mandado: false };
  await aSlack(cuerpo);
  for (const c of nuevos) await store.setJSON(c.clave, { cuando: ahora.toISOString(), huella: huella(c) });
  return { casos, nuevos, repetidos, mandado: true };
}
