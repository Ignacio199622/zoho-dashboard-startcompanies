/*
 * MATÍAS APRENDE (Ignacio, 14-sep-2026: "que vaya aprendiendo").
 *
 * Una vez por día, con el reporte de las 18:00, se leen las conversaciones
 * reales del día (los hilos de #sdr-virtual-matias de los leads que
 * contestaron) y Gemini destila reglas cortas de TONO y MANEJO: qué objeción
 * apareció y qué respuesta funcionó, qué mensaje consiguió respuesta o reserva,
 * qué hizo que alguien se cortara. Las reglas viven en el blob `aprendizajes`
 * (máximo 15, se reescriben con las nuevas y las viejas) y el cerebro las lee
 * en cada respuesta.
 *
 * Lo que NUNCA aprende: precios, plazos, promesas, datos de la empresa ni
 * nada que no esté en el prompt. Eso está fijo en matias-cerebro.js y el
 * filtro de salida sigue vigente. Aprende cómo decirlo, no qué decir.
 *
 * APROBACIÓN (11-oct-2026): las conversaciones traen texto de los leads, así que
 * una regla podría venir "plantada". Por eso lo que destila Gemini queda como
 * PROPUESTA (blob `aprendizajes-propuesta`) y recién entra al prompt cuando una
 * persona responde "aprobar" en el hilo de Slack (lo revisa matias-aprende-revisar
 * cada hora). "rechazar" o 3 días sin respuesta la descartan.
 */
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { generar } from './conversaciones/gemini.js';
import { MODELO_GEMINI } from './conversaciones/config.js';

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const MAX_REGLAS = 15;

/** Las reglas vigentes, para el cerebro. Vacío si todavía no aprendió nada. */
export async function reglas() {
  const j = await almacen().get('aprendizajes', { type: 'json' }).catch(() => null);
  return Array.isArray(j?.reglas) ? j.reglas : [];
}

async function slack(metodo, params) {
  const r = await fetch(`https://slack.com/api/${metodo}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  return r.json();
}

/** El hilo de Slack de un lead, como texto LEAD:/MATÍAS:/SISTEMA:. */
async function hiloDe(tel) {
  const h = await almacen().get(`hilo-${tel}`, { type: 'json' }).catch(() => null);
  if (!h?.ts) return '';
  const j = await slack('conversations.replies', { channel: h.canal?.startsWith('C') ? h.canal : (env.SLACK_CANAL_MATIAS_ID || 'C0C1C7PC691'), ts: h.ts, limit: 100 });
  const lineas = [];
  for (const m of (j.messages || []).slice(1)) {
    const t = String(m.text || '').replace(/<(https?:[^|>]+)\|[^>]*>/g, '$1').replace(/<(https?:[^>]+)>/g, '$1');
    let x;
    if ((x = t.match(/^:robot_face:\s*\*Matías\*:\s*([\s\S]*)$/))) lineas.push(`MATÍAS: ${x[1].trim()}`);
    else if ((x = t.match(/^:speech_balloon:\s*\*[^*]+\*:\s*([\s\S]*)$/))) lineas.push(`LEAD: ${x[1].trim()}`);
    else if (/^:dart:|^:octagonal_sign:|^:white_check_mark:/.test(t)) lineas.push(`SISTEMA: ${t.replace(/^:[a-z_]+:\s*/, '').replace(/_/g, '').trim()}`);
  }
  return lineas.join('\n');
}

const INSTRUCCIONES = `Sos el coach de Matías, un SDR virtual que escribe por WhatsApp a personas que pidieron
info para abrir una LLC en Estados Unidos. Su único objetivo es que agenden una asesoría gratuita
de 15 minutos; él ofrece horarios reales y reserva.

Te doy las conversaciones de hoy y las reglas que ya tenía. Devolvé la lista ACTUALIZADA de
reglas (máximo ${MAX_REGLAS}), fusionando las viejas con lo nuevo: quedan las que siguen siendo
útiles, se ajustan las que contradice la evidencia de hoy, entran las nuevas.

QUÉ ES UNA REGLA VÁLIDA: cómo manejar una objeción concreta que apareció ("cuando dicen X,
funcionó Y"), qué tipo de mensaje consiguió respuesta o reserva, qué hizo que un lead se cortara,
tono y largo que funcionan, cuándo ofrecer horarios. Una línea cada una, concreta, en español
rioplatense neutro, empezando con "Cuando..." o "Si...".

LO MÁS IMPORTANTE (28-sep): las QUEJAS del lead ("ya te lo pasé", "repetís lo mismo", "es una
vergüenza", "¿esto es un robot?") y los mensajes de Matías repetidos casi iguales son la señal más
fuerte del día: cada una se convierte en una regla de qué NO volver a hacer. También mirá qué
empujón consiguió una reserva y qué lead quedó a mitad de camino (eligió y no reservó).

QUÉ NO ES UNA REGLA: precios, plazos, promesas, datos de la empresa, nada que Matías no sepa ya,
nada que contradiga sus límites (no vende por chat, no da info interna, no insiste al que dijo
que no). Si el día no aporta nada nuevo, devolvé las reglas viejas tal cual.

Devolvé JSON: { "reglas": ["...", ...], "resumen": "2 líneas de qué se vio hoy" }.`;

const ESQUEMA = { type: 'object', properties: { reglas: { type: 'array', items: { type: 'string' } }, resumen: { type: 'string' } }, required: ['reglas', 'resumen'] };

/**
 * Aprende del día: `contestaron` son los leads (con `tel`) que escribieron hoy.
 * Devuelve { reglas, resumen, conversaciones } y guarda el blob.
 */
export async function aprender(contestaron, ahora = new Date()) {
  const viejas = await reglas();
  const hilos = [];
  for (const l of contestaron.slice(0, 25)) {
    const h = await hiloDe(l.tel).catch(() => '');
    if (h && /LEAD:/.test(h)) hilos.push(`--- ${l.nombre || l.tel} (${l.origen || 'meta'}${l.cerrado ? `, ${l.cerrado}` : ''}${l.reserva ? ', RESERVÓ' : ''})\n${h}`);
  }
  if (!hilos.length) return { reglas: viejas, resumen: 'Hoy no hubo conversaciones nuevas.', conversaciones: 0 };
  const contenido = [
    `Reglas que ya tenía:\n${viejas.length ? viejas.map((r) => `- ${r}`).join('\n') : '(ninguna)'}`,
    `Conversaciones de hoy (${hilos.length}):\n${hilos.join('\n\n')}`,
  ].join('\n\n');
  const { datos: r } = await generar({ modelo: MODELO_GEMINI, instrucciones: INSTRUCCIONES, contenido, esquema: ESQUEMA, maxTokens: 4000 });
  // Las reglas son de tono y manejo: cualquier cifra, precio o dato de la empresa se
  // descarta acá aunque el modelo lo haya colado (eso vive fijo en el prompt).
  const esDato = (x) => /\d{3,}|USD|d[oó]lares|hábiles|radicad|Estados Unidos/i.test(x);
  const nuevas = (Array.isArray(r?.reglas) ? r.reglas : viejas)
    .map((x) => String(x).trim())
    .filter((x) => x && x.length <= 300 && !esDato(x) && !pareceInstruccion(x))
    .slice(0, MAX_REGLAS);
  const propuesta = {
    reglas: nuevas,
    vigentes: viejas,
    resumen: r?.resumen || '',
    fecha: ahora.toISOString(),
    conversaciones: hilos.length,
    estado: 'pendiente',
  };
  await almacen().setJSON('aprendizajes-propuesta', propuesta);
  return { reglas: nuevas, vigentes: viejas, resumen: propuesta.resumen, conversaciones: hilos.length };
}

/**
 * Una regla de tono no trae links, mails, menciones a instrucciones o sistemas,
 * ni órdenes de saltear reglas. Si trae algo de eso, no se propone.
 */
export function pareceInstruccion(x) {
  return /https?:|www\.|@|prompt|instrucci|ignor|system|sistema|\bapi\b|clave|token|contraseñ|password|modo desarrollador|olvid[aá] (todo|lo)/i.test(x);
}

/** La propuesta del día, si hay. */
export async function propuesta() {
  return almacen().get('aprendizajes-propuesta', { type: 'json' }).catch(() => null);
}

/** Guarda dónde se publicó la propuesta en Slack, para leer la respuesta en el hilo. */
export async function marcarPublicada(canal, ts) {
  const p = await propuesta();
  if (!p) return;
  await almacen().setJSON('aprendizajes-propuesta', { ...p, canal, ts });
}

/** Pasa la propuesta a vigente: desde ahí la usa el cerebro. */
export async function aprobarPropuesta(quien, ahora = new Date()) {
  const p = await propuesta();
  if (!p || p.estado !== 'pendiente') return null;
  await almacen().setJSON('aprendizajes', {
    reglas: p.reglas,
    resumen: p.resumen,
    fecha: ahora.toISOString(),
    conversaciones: p.conversaciones,
    aprobadoPor: quien,
  });
  await almacen().setJSON('aprendizajes-propuesta', { ...p, estado: 'aprobada', resueltaPor: quien, resueltaEn: ahora.toISOString() });
  return p;
}

/** Descarta la propuesta: las reglas vigentes no cambian. */
export async function descartarPropuesta(quien, motivo, ahora = new Date()) {
  const p = await propuesta();
  if (!p || p.estado !== 'pendiente') return null;
  await almacen().setJSON('aprendizajes-propuesta', { ...p, estado: 'descartada', motivo, resueltaPor: quien, resueltaEn: ahora.toISOString() });
  return p;
}

/** Respuestas del hilo de la propuesta, para el revisor. */
export async function respuestasDelHilo(canal, ts) {
  const j = await slack('conversations.replies', { channel: canal, ts, limit: 50 });
  return (j.messages || []).slice(1);
}
