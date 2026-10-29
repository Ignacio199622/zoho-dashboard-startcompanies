/*
 * Guardia de clientes en cadencia, corriendo en la nube.
 *
 * Si un lead con mensaje programado tiene el telefono o el mail de un cliente real,
 * lo saca de la cadencia con la transicion "Desactivar Blueprint" (-> Fuera de
 * flujo), que hace que Zoho borre los mensajes programados. Vaciar la fecha no
 * alcanza en las cadencias de venta. El 1-oct-2026 les llego a dos clientes
 * (Kelyt Mora y Alvaro Chamizo) porque la regla de Zoho que debia frenarlo nunca
 * corre. Ver `lib/conversaciones/guardia-clientes.js`.
 *
 * Arranca en SECO: sin GUARDIA_CLIENTES_APLICAR=1 en el entorno del sitio no
 * escribe nada y solo avisa en Slack a quien frenaria. Avisa solo si hay casos.
 */
import { getStore } from '@netlify/blobs';
import { unaPasada } from './lib/conversaciones/guardia-clientes.js';
import { env } from './lib/conversaciones/entorno.js';
import { ZOHO_UI } from './lib/conversaciones/config.js';

const MAX_BITACORA = 60;
const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const link = (id) => `${ZOHO_UI}/Leads/${id}`;
const hora = (iso) =>
  new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

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
  const seco = url.searchParams.get('seco') === '1' || env.GUARDIA_CLIENTES_APLICAR !== '1';
  const inicio = Date.now();

  try {
    const r = await unaPasada({ escribir: !seco });
    const frenados = r.casos.filter((c) => c.ejecucion?.ok).length;
    console.log(
      `${sello()}  leads=${r.leadsMirados} reales=${r.contactosReales} casos=${r.casos.length} ` +
        `frenados=${frenados}${r.demasiados ? ' TOPE' : ''}${seco ? ' (seco)' : ''}`
    );

    if (r.casos.length) {
      const titulo = r.demasiados
        ? `:warning: *Guardia de clientes:* ${r.casos.length} clientes en cadencia de venta, más que el tope (${r.tope}). No toqué nada: revisar.`
        : seco
          ? `:eyes: *Modo sombra:* frenaría la cadencia de venta a ${r.casos.length} cliente${r.casos.length > 1 ? 's' : ''}`
          : `:shield: *${frenados} cliente${frenados === 1 ? '' : 's'} sacado${frenados === 1 ? '' : 's'} de la cadencia de venta*`;
      const lineas = r.casos.map((c) => {
        const estado = seco || r.demasiados ? '' : c.ejecucion?.ok ? ' ✔' : ` ✖ ${c.ejecucion?.error || c.ejecucion?.codigo || 'no quedó vacía'}`;
        return `• <${link(c.leadId)}|${c.lead}> (${c.estado}) es *${c.contacto}*${c.llc ? `, ${c.llc}` : ''}${c.tipo ? ` [${c.tipo}]` : ''}. Mensaje programado: ${hora(c.proximo)}${estado}`;
      });
      await aSlack([titulo, ...lineas].join('\n'));
    }

    const bitacora = (await store.get('guardia-clientes-bitacora', { type: 'json' })) || [];
    bitacora.unshift({ cuando: new Date().toISOString(), seco, leads: r.leadsMirados, casos: r.casos.length, frenados, ms: Date.now() - inicio });
    await store.setJSON('guardia-clientes-bitacora', bitacora.slice(0, MAX_BITACORA));
  } catch (e) {
    console.error('guardia-clientes fallo', e);
    await aSlack(`:x: *Guardia de clientes* falló: ${String(e.message || e).slice(0, 300)}`);
  }
};
