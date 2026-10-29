/*
 * EL REPORTE DE MATÍAS. Dos veces por día en #sdr-virtual-matias: quién recibió
 * apertura, quién contestó, quién agendó, a quién hubo que pasarle a una
 * persona, quién se cerró.
 *
 * Lee la memoria interna de Matías (Blobs, `apertura-<tel>`) y, para saber
 * quién agendó, relee cada lead en Zoho (Lead_Status / Calendario). Son pocas
 * llamadas (una por lead abierto en los últimos 7 días, tope 40 por día).
 *
 * Ignacio (13-sep): "¿cómo controlamos quién contestó y quién se comprometió?"
 * Comprometido = agendó. Es el único compromiso que existe hasta que paga.
 */
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get } from './conversaciones/zoho.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab/Leads';
const DIAS = 7;
const almacen = () => getStore({ name: 'matias', consistency: 'strong' });

const fecha = (iso) => iso ? new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

/** Junta la foto de los últimos DIAS días. */
export async function foto(ahora = new Date()) {
  const store = almacen();
  const desde = ahora - DIAS * 86400000;
  const { blobs } = await store.list({ prefix: 'apertura-' });
  const leads = [];
  // De a 25 en paralelo: con el barrido son más de 800 fichas, de a una tarda minutos.
  for (let i = 0; i < blobs.length; i += 25) {
    const lote = await Promise.all(blobs.slice(i, i + 25).map(async (b) => [b.key, await store.get(b.key, { type: 'json' }).catch(() => null)]));
    for (const [key, e] of lote) {
      if (!e || typeof e !== 'object') continue;
      const inicio = new Date(e.enviada || e.desde || 0);
      if (inicio < desde) continue;
      leads.push({ tel: key.replace('apertura-', ''), ...e });
    }
  }

  // ¿Agendó? Se relee el lead. Es la fuente de verdad, no la memoria de Matías.
  for (const l of leads) {
    if (!l.lead) continue;
    try {
      const j = await get(`Leads/${l.lead}?fields=id,Full_Name,Lead_Status,Calendario,utm_source`);
      const z = (j.data || [])[0] || {};
      l.nombre = l.nombre || z.Full_Name;
      l.agendo = /agendad/i.test(String(z.Lead_Status || '')) || Boolean(z.Calendario);
      l.porSdr = /sdr-matias/i.test(String(z.utm_source || ''));
      l.estadoZoho = z.Lead_Status;
    } catch { l.estadoZoho = '(no se pudo leer)'; }
  }

  const hoy = ahora.toISOString().slice(0, 10);
  const abiertos = leads.filter((l) => l.enviada);
  const abiertosHoy = abiertos.filter((l) => String(l.enviada).startsWith(hoy));
  const contestaron = leads.filter((l) => l.contesto);
  const agendaron = leads.filter((l) => l.agendo);
  const frenados = leads.filter((l) => l.frenado && !l.agendo);
  const cerrados = leads.filter((l) => l.cerrado && !/agend/.test(l.cerrado));
  const noQuieren = leads.filter((l) => /no le escriban/.test(l.cerrado || ''));
  const enSeguimiento = abiertos.filter((l) => !l.cerrado && !l.contesto && !l.agendo);

  // Nuevos (entraron estos días) y viejos (los retoma el barrido) por separado,
  // para que no se mezclen (Ignacio, 15-sep).
  const parte = (lista) => ({
    abiertos: lista.filter((l) => l.enviada), abiertosHoy: lista.filter((l) => l.enviada && String(l.enviada).startsWith(hoy)),
    contestaron: lista.filter((l) => l.contesto), agendaron: lista.filter((l) => l.agendo),
  });
  const nuevos = parte(leads.filter((l) => !l.barrido));
  const viejos = parte(leads.filter((l) => l.barrido));
  const meses = {};
  for (const l of leads) if (l.barrido && l.enviada) meses[l.barrido] = (meses[l.barrido] || 0) + 1;
  return { leads, abiertos, abiertosHoy, contestaron, agendaron, frenados, cerrados, noQuieren, enSeguimiento, nuevos, viejos, meses, dias: DIAS };
}

const linea = (l) => `• ${l.barrido ? '🧹 ' : ''}${l.nombre || `+${l.tel}`}${l.lead ? ` · <${ZOHO_UI}/${l.lead}|Zoho>` : ''}${l.origen ? ` · ${l.origen}` : ''}${l.toques ? ` · ${l.toques} toque${l.toques > 1 ? 's' : ''}` : ''}`;
const pct = (a, b) => (b ? ` (${Math.round((100 * a) / b)}%)` : '');

/** Arma el mensaje de Slack. */
export function armar(f, ahora = new Date()) {
  const cabecera = `📊 *Matías · reporte ${fecha(ahora.toISOString())}* (últimos ${f.dias} días)`;
  const renglon = (t, x) => `${t}: aperturas *${x.abiertos.length}* (hoy ${x.abiertosHoy.length}) · contestaron *${x.contestaron.length}*${pct(x.contestaron.length, x.abiertos.length)} · agendaron *${x.agendaron.length}*${pct(x.agendaron.length, x.abiertos.length)}`;
  const mesesTxt = Object.entries(f.meses || {}).map(([m, n]) => `${m} ${n}`).join(', ');
  const numeros = [
    renglon('🆕 Nuevos', f.nuevos),
    renglon(`🧹 Viejos (barrido${mesesTxt ? `: ${mesesTxt}` : ''})`, f.viejos),
    `Total: aperturas *${f.abiertos.length}* · contestaron *${f.contestaron.length}* · agendaron *${f.agendaron.length}*`,
    `Lo tomó una persona: *${f.frenados.length}* · Dijeron que no: *${f.noQuieren.length}* · Cerrados sin respuesta: *${f.cerrados.length - f.noQuieren.length}*`,
    `En seguimiento ahora: *${f.enSeguimiento.length}*`,
  ].join('\n');
  const bloques = [
    { type: 'section', text: { type: 'mrkdwn', text: `${cabecera}\n${numeros}` } },
  ];
  const seccion = (titulo, lista) => {
    if (!lista.length) return;
    bloques.push({ type: 'section', text: { type: 'mrkdwn', text: `*${titulo}*\n${lista.slice(0, 25).map(linea).join('\n')}${lista.length > 25 ? `\n…y ${lista.length - 25} más` : ''}` } });
  };
  seccion('🎯 Agendaron', f.agendaron);
  seccion('💬 Contestaron y siguen en conversación', f.contestaron.filter((l) => !l.agendo && !l.frenado && !l.cerrado));
  seccion('🙋 Los tiene que tomar una persona', f.frenados.map((l) => ({ ...l, origen: l.frenado })));
  return { text: `Matías: ${f.abiertos.length} aperturas, ${f.contestaron.length} contestaron, ${f.agendaron.length} agendaron`, blocks: bloques, unfurl_links: false };
}

export async function publicar(ahora = new Date()) {
  const f = await foto(ahora);
  const cuerpo = armar(f, ahora);
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
  try { await post({ username: 'Matías · SDR', icon_emoji: ':male-office-worker:' }); }
  catch (e) { if (/missing_scope|invalid_arguments/.test(e.message)) await post({}); else throw e; }
  return f;
}
