/*
 * Agente post-reunión: nadie se pierde después de una reunión de venta.
 * (Pedido de Ignacio, 11-oct-2026. La regla y sus excepciones están en
 * lib/post-reunion.js.)
 *
 * A las 24 h de una reunión marcada "Asistió" / "Asistió sin interes", si el lead
 * no compró y quedó en un estado sin cadencia, lo pasa a Retargeting o a Nurturing.
 *
 * ESCRIBE EN ZOHO, y con trigger workflow: el cambio de estado ES lo que arranca
 * la cadencia de WhatsApp. Por eso:
 *   - Arranca en SECO. Sin POST_REUNION_APLICAR=1 en el entorno del sitio no
 *     escribe nada y solo publica en Slack lo que haría (como bajas).
 *   - Tope de 15 leads por corrida: si algo sale mal, sale mal en 15, no en 200.
 *   - Cada evento resuelto queda en Blobs ('post-reunion') para no repetirlo.
 *     En seco no se anota nada: se vuelve a ver la misma lista hasta que alguien
 *     prenda la variable, que es lo que se quiere durante la sombra.
 */
import { getStore } from '@netlify/blobs';
import { get } from './lib/conversaciones/zoho.js';
import { moverLeadA } from './lib/conversaciones/escritura.js';
import { env } from './lib/conversaciones/entorno.js';
import { ZOHO_UI } from './lib/conversaciones/config.js';
import { unaPasada, MAX_POR_CORRIDA } from './lib/post-reunion.js';

const MAX_BITACORA = 60;
const MAX_LINEAS = 12;
const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const link = (id, nombre) => `<${ZOHO_UI}/Leads/${id}|${nombre || id}>`;
const dia = (iso) => String(iso || '').slice(5, 10).split('-').reverse().join('/');

async function aSlack(texto) {
  const url = env.SLACK_WEBHOOK_CONTROL_CRM || env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  return r.ok;
}

/** El mensaje del canal. Exportado para que el ensayo local lo imprima igual. */
export function armarResumen(r) {
  const seco = !r.aplicar;
  const lineas = [];
  if (r.movidos.length) {
    lineas.push(
      seco
        ? `:eyes: *Post-reunión (modo sombra):* movería ${r.movidos.length} lead${r.movidos.length > 1 ? 's' : ''} que vinieron a la reunión y no compraron`
        : `:arrows_counterclockwise: *Post-reunión:* ${r.movidos.filter((m) => m.ok).length} lead${r.movidos.length > 1 ? 's' : ''} a su cadencia`
    );
    for (const m of r.movidos.slice(0, MAX_LINEAS)) {
      const fallo = !seco && !m.ok ? ` :warning: ${m.error}` : '';
      lineas.push(`• ${link(m.leadId, m.nombre)} · reunión ${dia(m.reunion)} "${m.meet}" · _${m.estado}_ → *${m.destino}*${m.socios ? ' (socios: entra al flujo de Socios por la etiqueta)' : ''}${fallo}`);
    }
    if (r.movidos.length > MAX_LINEAS) lineas.push(`   …y ${r.movidos.length - MAX_LINEAS} más`);
  }
  if (r.pendientes) lineas.push(`:hourglass: ${r.pendientes} más quedan para mañana (tope de ${MAX_POR_CORRIDA} por corrida)`);
  if (r.reportados.length) {
    lineas.push(`\n:mag: *${r.reportados.length} para mirar a mano* (no se movieron)`);
    for (const p of r.reportados.slice(0, MAX_LINEAS)) lineas.push(`• ${link(p.leadId, p.nombre)} · ${p.motivo}`);
  }
  return lineas.join('\n');
}

export default async () => {
  const store = getStore({ name: 'post-reunion', consistency: 'strong' });
  // La escritura se enciende con una variable del sitio, no con un default del
  // codigo: asi deployar no puede prenderla sin querer.
  const aplicar = env.POST_REUNION_APLICAR === '1';
  const inicio = Date.now();

  try {
    const r = await unaPasada(
      {
        get,
        mover: moverLeadA,
        yaProcesado: async (id) => Boolean(await store.get(`ev-${id}`)),
        marcar: (id, motivo) => store.set(`ev-${id}`, `${new Date().toISOString()} ${motivo}`),
      },
      { aplicar }
    );

    console.log(
      `${sello()}  reuniones=${r.reuniones} movidos=${r.movidos.length} reportados=${r.reportados.length} ` +
        `salteados=${r.salteados.length} pendientes=${r.pendientes}${aplicar ? '' : ' (seco)'}`
    );

    if (r.movidos.length || r.reportados.length) await aSlack(armarResumen(r));

    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    await store.setJSON(
      'bitacora',
      [
        {
          id: new Date(inicio).toISOString(),
          agente: 'post-reunion',
          segundos: Math.round((Date.now() - inicio) / 1000),
          reuniones: r.reuniones,
          movidos: r.movidos.map((m) => ({ nombre: m.nombre, de: m.estado, a: m.destino, ok: m.ok ?? null })),
          reportados: r.reportados.length,
          salteados: r.salteados.length,
          pendientes: r.pendientes,
          seco: !aplicar,
          estado: 'ok',
        },
        ...previa,
      ].slice(0, MAX_BITACORA)
    );
    return new Response('ok');
  } catch (e) {
    console.error(`${sello()}  FALLO: ${e.message}`);
    // Un agente mudo es indistinguible de "no hubo nadie para mover".
    try {
      await aSlack(`:rotating_light: El agente post-reunión falló: ${e.message}`);
    } catch {}
    return new Response('fallo', { status: 500 });
  }
};
