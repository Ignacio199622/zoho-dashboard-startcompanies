/*
 * Lista de espera de Start Global (getstartglobal.com, 29-oct-2026).
 *
 * La landing manda nombre, mail, país, WhatsApp opcional y para qué la usaría.
 * Se guarda en Blobs (store `start-global`, una clave por mail, así no hay
 * duplicados) y se avisa en Slack. No escribe en Zoho: cuando se abra la app,
 * la lista se exporta de una.
 *
 *   POST /api/start-global-lista
 *   GET  /api/start-global-lista?clave=<LLAMAR_CLAVE>  → la lista completa (JSON)
 */
import { getStore } from '@netlify/blobs';

const env = process.env;
const ORIGENES = ['https://getstartglobal.com', 'https://www.getstartglobal.com', 'https://startglobal.lat', 'https://www.startglobal.lat', 'https://startglobalapp.com', 'https://www.startglobalapp.com'];
const AVISAR_A = env.SG_LISTA_SLACK || 'U0869LQ3G4C'; // Ignacio

function cors(req) {
  const o = req.headers.get('origin') || '';
  const ok = ORIGENES.includes(o) || /\.workers\.dev$|\.pages\.dev$|localhost/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : ORIGENES[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const limpio = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);

export default async (req) => {
  const h = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const store = getStore('start-global');

  if (req.method === 'GET') {
    const clave = new URL(req.url).searchParams.get('clave');
    if (!env.LLAMAR_CLAVE || clave !== env.LLAMAR_CLAVE) return new Response('no', { status: 401, headers: h });
    const { blobs } = await store.list({ prefix: 'lista-' });
    const filas = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
    return Response.json(filas.filter(Boolean), { headers: h });
  }
  if (req.method !== 'POST') return new Response('método', { status: 405, headers: h });

  let b = {};
  try { b = await req.json(); } catch { return new Response('cuerpo', { status: 400, headers: h }); }
  if (b.web) return Response.json({ ok: true }, { headers: h }); // trampa para bots
  const email = limpio(b.email, 160).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || !limpio(b.nombre) || !limpio(b.pais) || b.acepto !== true) {
    return new Response('datos', { status: 400, headers: h });
  }
  const clave = `lista-${email}`;
  const previo = await store.get(clave, { type: 'json' }).catch(() => null);
  const fila = {
    nombre: limpio(b.nombre),
    email,
    pais: limpio(b.pais, 40),
    whatsapp: limpio(b.whatsapp, 30),
    uso: limpio(b.uso, 20),
    origen: limpio(b.origen, 60),
    utm: limpio(b.utm, 60),
    campana: limpio(b.campana, 60),
    acepto: true,
    creado: previo?.creado || new Date().toISOString(),
    actualizado: new Date().toISOString(),
  };
  await store.setJSON(clave, fila);

  if (!previo && env.SLACK_BOT_TOKEN) {
    const uso = { persona: 'persona que cobra del exterior', llc: 'tiene LLC', 'sin-llc': 'negocio sin LLC' }[fila.uso] || fila.uso;
    const text = `🌎 *Nuevo en la lista de Start Global*: ${fila.nombre} · ${fila.pais} · ${fila.email}${fila.whatsapp ? ` · ${fila.whatsapp}` : ''} · ${uso}${fila.utm ? ` · vino de ${fila.utm}` : ''}`;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: AVISAR_A, text, username: 'Start Global', icon_emoji: ':earth_americas:' }),
    }).catch(() => {});
  }
  return Response.json({ ok: true }, { headers: h });
};

export const config = { path: '/api/start-global-lista' };
