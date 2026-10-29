/*
 * Lo que queda colgado despues de una reunion, corriendo en la nube.
 *
 *  1. Reuniones que pasaron hace 2 h y nadie marco "Asistio / No asistio":
 *     aviso en el canal de ventas para que alguien lo haga (sin esa marca no
 *     corre el plan de accion de no-show). Solo avisa, no escribe.
 *
 *  2. Leads cuya reunion se cayo (dijo No, pidio reagendar, cancelo en Cal)
 *     hace 3 dias o mas, siguen en "Reunion Agendada" y no reagendaron: vuelven
 *     a la secuencia de Agendamiento por la misma puerta que usa la guardia
 *     (`ponerEnSecuencia`, que escribe Lead_Status con workflows prendidos: es
 *     lo que arranca la cadencia). Arranca en SOMBRA: sin RESCATE_APLICAR=1 en
 *     el sitio solo publica en Slack lo que haria.
 *
 * Todo lo ya avisado/rescatado queda en el blob `reuniones-pendientes` para no
 * repetirlo en cada corrida.
 */
import { getStore } from '@netlify/blobs';
import { unaPasada } from './lib/conversaciones/reuniones-pendientes.js';
import { env } from './lib/conversaciones/entorno.js';
import { ZOHO_UI, webhookDe, nombrar, SLACK_WEBHOOK_URL } from './lib/conversaciones/config.js';
import { aQuienLeToca, VENTAS } from './lib/conversaciones/guardia.js';

const MAX_BITACORA = 60;
const ROBOT = 'Start Companies Staff';
const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const linkReunion = (id) => `${ZOHO_UI}/Events/${id}`;
const linkLead = (id) => `${ZOHO_UI}/Leads/${id}`;

async function aSlack(texto) {
  const url = webhookDe('ventas') || SLACK_WEBHOOK_URL;
  if (!url) return false;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  return r.ok;
}

// A quien se le habla: al dueño del lead si es una persona, si no al que esta
// de guardia de ventas ese dia.
function responsable(lead, ahora) {
  const dueño = lead?.Owner?.name || '';
  if (dueño && dueño !== ROBOT) return nombrar(dueño.split(' ')[0]);
  const guardia = aQuienLeToca(VENTAS, ahora);
  return nombrar(guardia ? guardia.nombre.split(' ')[0] : 'Ventas');
}

const horaAR = (iso) =>
  new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
const fechaAR = (iso) =>
  new Date(iso).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });

export default async (req) => {
  const store = getStore({ name: 'conversaciones', consistency: 'strong' });
  const url = new URL(req.url);
  const seco = url.searchParams.get('seco') === '1' || env.RESCATE_APLICAR !== '1';

  const memoria = (await store.get('reuniones-pendientes', { type: 'json' })) || {};
  const avisados = new Set(memoria.avisados || []);
  const rescatados = new Set(memoria.rescatados || []);
  const ahora = new Date();
  const inicio = Date.now();

  try {
    const r = await unaPasada({ escribir: !seco, ahora });
    const lineas = [];

    // 1) Sin estado
    const nuevos = r.reclamos.filter((e) => !avisados.has(e.id));
    for (const e of nuevos) {
      const quien = e.What_Id?.name || e.Who_Id?.name || '?';
      lineas.push(
        `:clock2: ${responsable(e.lead, ahora)} la reunion de *${quien}* de las ${horaAR(e.Start_DateTime)} no tiene estado. ` +
          `Marca Asistio / No asistio para que corra el seguimiento: <${linkReunion(e.id)}|ver reunion>`
      );
      avisados.add(e.id);
    }

    // 2) Rescate
    let hechos = 0;
    for (const x of r.rescates) {
      if (rescatados.has(x.lead.id)) continue;
      const nombre = x.lead.Full_Name || x.lead.id;
      const cuando = fechaAR(x.evento.Start_DateTime);
      if (seco) {
        lineas.push(
          `:eyes: *Modo sombra:* devolveria a Agendamiento a <${linkLead(x.lead.id)}|${nombre}> (su reunion del ${cuando} se cayo y no reagendo en ${3} dias)`
        );
        rescatados.add(x.lead.id);
      } else if (x.ejecucion?.ok) {
        hechos++;
        lineas.push(
          `:repeat: <${linkLead(x.lead.id)}|${nombre}> volvio a la secuencia de *Agendamiento*: su reunion del ${cuando} se cayo y no reagendo en 3 dias`
        );
        rescatados.add(x.lead.id);
      } else {
        lineas.push(
          `:warning: No pude devolver a Agendamiento a <${linkLead(x.lead.id)}|${nombre}>: ${x.ejecucion?.error || `quedo en ${x.ejecucion?.estado}`}`
        );
      }
    }

    console.log(
      `${sello()}  sin_estado=${r.reclamos.length} (nuevos ${nuevos.length}) candidatos=${r.candidatos.length} ` +
        `rescates=${r.rescates.length} hechos=${hechos}${seco ? ' (seco)' : ''}`
    );
    if (lineas.length) await aSlack(lineas.join('\n'));

    await store.setJSON('reuniones-pendientes', {
      avisados: [...avisados].slice(-500),
      rescatados: [...rescatados].slice(-500),
      ultima: ahora.toISOString(),
    });

    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    await store.setJSON(
      'bitacora',
      [
        {
          id: ahora.toISOString(),
          agente: 'reuniones-pendientes',
          segundos: Math.round((Date.now() - inicio) / 1000),
          sinEstado: r.reclamos.length,
          avisadosNuevos: nuevos.length,
          candidatos: r.candidatos.length,
          rescates: r.rescates.length,
          hechos,
          seco,
          estado: 'ok',
        },
        ...previa,
      ].slice(0, MAX_BITACORA)
    );
    return new Response('ok');
  } catch (e) {
    console.error(`${sello()}  FALLO: ${e.message}`);
    try {
      await aSlack(`:rotating_light: El agente de reuniones pendientes fallo: ${e.message}`);
    } catch {}
    return new Response('fallo', { status: 500 });
  }
};
