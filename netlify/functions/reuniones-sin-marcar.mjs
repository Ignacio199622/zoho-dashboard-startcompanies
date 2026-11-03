/*
 * Aviso diario de REUNIONES SIN MARCAR.
 *
 * Pedido de Ignacio (2-nov-2026): a las 19 h Argentina, un solo mensaje en
 * #control-crm con las reuniones de HOY que ya pasaron y siguen sin
 * "Status del Meet" (Asistio / No asistio / ...). Sin esa marca no corre el
 * seguimiento de no-show ni el post-reunion.
 *
 *   - Lee Zoho (Events) y nada mas: SOLO LECTURA, no escribe en el CRM.
 *   - Agrupa por Tipo de reunion, con hasta 30 links a las reuniones.
 *   - REUNIONES_SIN_MARCAR_ENABLED=0 lo apaga.
 *   - ?dry=1 (o dry:true al llamarla a mano) arma el mensaje y lo devuelve sin
 *     postear.
 *
 * Distinto de reuniones-pendientes: ese avisa una por una, 2 h despues, en el
 * canal de ventas. Este es el resumen del dia para el control del CRM.
 */
import { env } from './lib/entorno.js';
import { get } from './lib/control-crm/zoho.js';
import { avisarFalla } from './lib/aviso-falla.js';

const CANAL = env.REUNIONES_SIN_MARCAR_CANAL || 'C0BUSC1K8TY'; // #control-crm, el mismo de estatales
const ZOHO_EVENTO = 'https://crm.zoho.com/crm/org881745849/tab/Events/';
const MAX_LINKS = 30;
const CAMPOS = 'id,Event_Title,Start_DateTime,Status_del_Meet,Tipo_de_reuni_n,What_Id,Who_Id,Owner';
const FIRMA = { username: 'Reuniones sin marcar · Start Companies', icon_emoji: ':clipboard:' };
const AR_MS = 3 * 3600e3; // Argentina es UTC-3 todo el año

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
const horaAR = (s) =>
  new Date(s).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Argentina/Buenos_Aires' });

/** Las reuniones de hoy (hora Argentina) que ya empezaron y no tienen Status del Meet. */
export async function sinMarcar(ahora = new Date()) {
  const ar = new Date(ahora.getTime() - AR_MS);
  const desde = new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate()) + AR_MS); // 00:00 AR
  const criteria = `((Start_DateTime:greater_equal:${iso(desde)})and(Start_DateTime:less_equal:${iso(ahora)}))`;
  const todas = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get(`Events/search?criteria=${encodeURIComponent(criteria)}&fields=${CAMPOS}&per_page=200&page=${page}`);
    if (j._error) throw new Error(`Zoho Events: ${j._error} ${j._mensaje || ''}`);
    todas.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  const pendientes = todas
    .filter((e) => !e.Status_del_Meet && new Date(e.Start_DateTime) <= ahora)
    .sort((a, b) => new Date(a.Start_DateTime) - new Date(b.Start_DateTime));
  return { total: todas.length, pendientes };
}

export function armarMensaje(pendientes) {
  if (!pendientes.length) return null;
  const porTipo = {};
  for (const e of pendientes) {
    const t = e.Tipo_de_reuni_n || 'Sin tipo';
    porTipo[t] = (porTipo[t] || 0) + 1;
  }
  const conteo = Object.entries(porTipo)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `• ${t}: *${n}*`)
    .join('\n');
  const links = pendientes.slice(0, MAX_LINKS).map((e) => {
    const quien = e.What_Id?.name || e.Who_Id?.name || e.Event_Title || 'reunion';
    const dueño = e.Owner?.name && e.Owner.name !== 'Start Companies Staff' ? ` · ${e.Owner.name.split(' ')[0]}` : '';
    return `• ${horaAR(e.Start_DateTime)} <${ZOHO_EVENTO}${e.id}|${quien}> (${e.Tipo_de_reuni_n || 'sin tipo'}${dueño})`;
  });
  const resto = pendientes.length > MAX_LINKS ? `\n_…y ${pendientes.length - MAX_LINKS} mas._` : '';
  return (
    `:clipboard: *${pendientes.length} reunion(es) de hoy sin marcar* (ya pasaron y no tienen Status del Meet)\n` +
    `${conteo}\n\n${links.join('\n')}${resto}\n\n` +
    `_Marcar Asistio / No asistio para que corra el seguimiento._`
  );
}

async function postear(text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANAL, text, unfurl_links: false, ...FIRMA }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${CANAL}: ${j.error}`);
}

export default async (req) => {
  if (env.REUNIONES_SIN_MARCAR_ENABLED === '0') return new Response('apagado (REUNIONES_SIN_MARCAR_ENABLED=0)');
  let dry = false;
  try { dry = new URL(req?.url || 'http://x').searchParams.get('dry') === '1'; } catch { /* programada: sin url util */ }
  try {
    const { total, pendientes } = await sinMarcar();
    const texto = armarMensaje(pendientes);
    if (!texto) return new Response(`nada sin marcar (reuniones de hoy ya pasadas: ${total})`);
    if (dry) return new Response(texto, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    await postear(texto);
    console.log(`reuniones-sin-marcar: ${pendientes.length} avisadas`);
    return new Response(`avisadas ${pendientes.length}`);
  } catch (e) {
    await avisarFalla('Aviso de reuniones sin marcar', e, 'Mirar netlify/functions/reuniones-sin-marcar.mjs y el token de Zoho');
    return new Response(String(e.message), { status: 500 });
  }
};

// 19:00 Argentina = 22:00 UTC, todos los dias.
export const config = { schedule: '0 22 * * *' };
