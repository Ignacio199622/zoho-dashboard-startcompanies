/*
 * Bajas de WhatsApp, corriendo en la nube.
 *
 * Cuando el cliente toca el boton "Baja" / "No me interesa" de la plantilla,
 * apaga su cadencia con la transicion `Desactivar Retargeting` del blueprint.
 *
 * ESTE ES EL UNICO PROCESO DE LA CASA QUE ESCRIBE EN ZOHO. Todo lo demas
 * (conversaciones, llamadas, coach) es de solo lectura. La escritura esta
 * acotada a `lib/conversaciones/escritura.js`, que ademas hace los PUT con
 * `trigger: []` para que editar un lead no dispare un WhatsApp.
 *
 * Arranca en SECO: sin la variable BAJAS_APLICAR=1 en el entorno del sitio, no
 * escribe nada y solo publica en Slack lo que haria. Es a proposito: la fase de
 * sombra es donde se ven los falsos positivos antes de que apaguen la cadencia
 * de alguien que estaba comprando.
 */
import { getStore } from '@netlify/blobs';
import { unaPasada, usarMemoria, contenido } from './lib/conversaciones/bajas.js';
import { env } from './lib/conversaciones/entorno.js';
import { ZOHO_UI } from './lib/conversaciones/config.js';

const MAX_BITACORA = 60;
const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const link = (id) => `${ZOHO_UI}/Leads/${id}`;

async function aSlack(texto) {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  return r.ok;
}

export default async (req) => {
  const store = getStore({ name: 'conversaciones', consistency: 'strong' });
  const url = new URL(req.url);

  // La escritura se enciende con una variable del sitio, no con un default del
  // codigo: asi deployar no puede prenderla sin querer.
  const seco = url.searchParams.get('seco') === '1' || env.BAJAS_APLICAR !== '1';

  usarMemoria(await store.get('bajas', { type: 'json' }));

  const ahora = new Date();
  const inicio = Date.now();

  try {
    const r = await unaPasada({ escribir: !seco });

    let bajas = 0;
    let yaEstaban = 0;
    const aplicadas = [];
    const paraRevisar = [];

    for (const f of r.resultados) {
      if (f.sinLead) {
        paraRevisar.push({ f, motivo: 'sin lead con ese telefono' });
        continue;
      }
      for (const { lead, decision, ejecucion } of f.leads) {
        if (decision.accion === 'ya_estaba') yaEstaban++;
        else if (decision.accion === 'revisar') paraRevisar.push({ f, lead, motivo: decision.motivo });
        else if (ejecucion.aplicado) {
          bajas++;
          aplicadas.push({ f, lead, ejecucion });
        } else if (!seco) {
          paraRevisar.push({ f, lead, motivo: ejecucion.error || 'la transicion no aplico' });
        } else {
          aplicadas.push({ f, lead, ejecucion, seco: true });
        }
      }
    }

    console.log(
      `${sello()}  leidas=${r.leidas} pedidos=${r.pedidos} bajas=${bajas} ` +
        `ya_estaban=${yaEstaban} a_revisar=${paraRevisar.length}${seco ? ' (seco)' : ''}`
    );

    if (aplicadas.length || paraRevisar.length) {
      const lineas = [];
      if (aplicadas.length) {
        lineas.push(
          seco
            ? `:eyes: *Modo sombra:* daria de baja ${aplicadas.length} lead${aplicadas.length > 1 ? 's' : ''} por boton de WhatsApp`
            : `:no_entry_sign: *${bajas} baja${bajas > 1 ? 's' : ''} aplicada${bajas > 1 ? 's' : ''}* por boton de WhatsApp`
        );
        for (const a of aplicadas) {
          lineas.push(`• <${link(a.lead.id)}|${a.lead.Full_Name || a.lead.id}> · "${a.f.texto}" · salio de _${a.lead.Lead_Status}_`);
        }
      }
      if (paraRevisar.length) {
        lineas.push(`\n:warning: *${paraRevisar.length} para revisar a mano*`);
        for (const p of paraRevisar) {
          const quien = p.lead ? `<${link(p.lead.id)}|${p.lead.Full_Name || p.lead.id}>` : p.f.telefono;
          lineas.push(`• ${quien} · "${p.f.texto}" · ${p.motivo}`);
        }
      }
      await aSlack(lineas.join('\n'));
    }

    // El corte de lectura solo avanza cuando la corrida escribe. En seco se
    // vuelve a mirar la misma ventana, que es lo que se quiere durante la
    // sombra: ver el caso hasta que alguien decida.
    if (!seco) await store.setJSON('bajas', contenido());

    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    await store.setJSON(
      'bitacora',
      [
        {
          id: ahora.toISOString(),
          agente: 'bajas',
          segundos: Math.round((Date.now() - inicio) / 1000),
          leidas: r.leidas,
          pedidos: r.pedidos,
          bajas,
          aRevisar: paraRevisar.length,
          seco,
          estado: 'ok',
        },
        ...previa,
      ].slice(0, MAX_BITACORA)
    );
    return new Response('ok');
  } catch (e) {
    console.error(`${sello()}  FALLO: ${e.message}`);
    // Un proceso de bajas mudo es indistinguible de "no hubo bajas", y mientras
    // tanto la cadencia sigue andando. El fallo tiene que verse.
    try {
      await aSlack(`:rotating_light: El proceso de bajas de WhatsApp fallo: ${e.message}`);
    } catch {}
    return new Response('fallo', { status: 500 });
  }
};
