/*
 * Informe semanal de llamadas de clientes -> Slack.
 *
 * Lo pidio Ignacio el 15-sep-2026. Lee las reuniones Tipo = Clientes de la
 * semana pasada (lunes a domingo, hora Argentina) y lo que el equipo/Fathom
 * cargo en cada una, y publica un solo mensaje. La logica esta en
 * `lib/conversaciones/informe-clientes.js` (se prueba en la maquina con
 * `node informe-clientes.js` desde agentes/conversaciones).
 *
 * SOLO LECTURA sobre Zoho. Canal: SLACK_WEBHOOK_INFORME_CLIENTES si existe,
 * si no el general (SLACK_WEBHOOK_URL, el mismo donde avisa el agente de
 * Calendly cuando entra una reserva).
 *
 * A mano:  POST .../informe-clientes-background?seco=1          devuelve el texto, no publica
 *          POST .../informe-clientes-background?semanas=0        la semana en curso
 */
import { getStore } from '@netlify/blobs';
import { informeSemanal } from './lib/conversaciones/informe-clientes.js';
import { env } from './lib/conversaciones/entorno.js';

const MAX_BITACORA = 60;
const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const seco = q.get('seco') === '1';
  const semanasAtras = q.has('semanas') ? Number(q.get('semanas')) : 1;
  const inicio = Date.now();
  const store = getStore({ name: 'conversaciones', consistency: 'strong' });

  try {
    const r = await informeSemanal({ semanasAtras });
    console.log(`${sello()}  informe-clientes: clientes=${r.clientes.length} porVenta=${r.porVenta.length} proximas=${r.proximas.length}${seco ? ' (seco)' : ''}`);

    let publicado = false;
    const url = env.SLACK_WEBHOOK_INFORME_CLIENTES || env.SLACK_WEBHOOK_URL;
    if (!seco && url) {
      const s = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: r.texto }) });
      publicado = s.ok;
      if (!s.ok) console.error(`Slack contesto ${s.status}`);
    }

    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    await store.setJSON('bitacora', [{ id: new Date().toISOString(), agente: 'informe-clientes', segundos: Math.round((Date.now() - inicio) / 1000), clientes: r.clientes.length, porVenta: r.porVenta.length, proximas: r.proximas.length, publicado, seco, estado: 'ok' }, ...previa].slice(0, MAX_BITACORA));
    return new Response(seco ? r.texto : 'ok', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (e) {
    console.error(`${sello()}  FALLO: ${e.message}`);
    try {
      const url = env.SLACK_WEBHOOK_INFORME_CLIENTES || env.SLACK_WEBHOOK_URL;
      if (url && !seco) await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `:rotating_light: El informe semanal de llamadas de clientes fallo: ${e.message}` }) });
    } catch {}
    return new Response('fallo', { status: 500 });
  }
};
