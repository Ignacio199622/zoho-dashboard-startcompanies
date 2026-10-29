/*
 * Reuniones de clientes: de Calendly (agendaclientes.startcompanies.io) a Zoho.
 *
 * Lee las reservas de Calendly y crea la reunion en el CRM colgada del
 * CONTACTO, con Tipo = Clientes. Si la reserva se cancela, marca el titulo.
 * Si el mail no es de ningun contacto (ni la LLC que escribio), avisa a Slack
 * y no hace nada mas: nunca crea un lead ni un contacto. La logica y las
 * reglas de Ignacio estan en `lib/conversaciones/clientes-calendly.js`.
 *
 * Memoria en el blob `conversaciones/calendly`: uuid de la reserva ->
 * { zohoId, status, ... }. Se sembro a mano el 14-sep-2026 con las 4 reuniones
 * creadas desde la maquina de Ignacio para que no se dupliquen.
 *
 * Escribe siempre (no tiene modo sombra): la escritura es solo crear/renombrar
 * reuniones de Clientes con trigger vacio, no toca leads ni manda mensajes.
 * Con CLIENTES_CALENDLY_SECO=1 en el entorno solo calcula.
 */
import { getStore } from '@netlify/blobs';
import { unaPasada } from './lib/conversaciones/clientes-calendly.js';
import { env } from './lib/conversaciones/entorno.js';
import { ZOHO_UI } from './lib/conversaciones/config.js';

const MAX_BITACORA = 60;
const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

async function aSlack(texto) {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texto }) });
  return r.ok;
}

export default async () => {
  const store = getStore({ name: 'conversaciones', consistency: 'strong' });
  const seco = env.CLIENTES_CALENDLY_SECO === '1';
  const ahora = new Date();
  const inicio = Date.now();
  // El token de Calendly (un JWT de ~1 KB) vive en un blob y no en el entorno:
  // con el en las variables, el deploy se cae por el tope de 4 KB de Lambda.
  if (!env.CALENDLY_TOKEN) env.CALENDLY_TOKEN = ((await store.get('secreto-calendly-token')) || '').trim();
  // Sin token no hay nada que leer: se calla (un aviso cada 5 min a Slack seria peor).
  if (!env.CALENDLY_TOKEN) { console.log(`${sello()}  calendly: falta CALENDLY_TOKEN en el entorno, no se hace nada`); return new Response('sin token'); }
  const memoria = (await store.get('calendly', { type: 'json' })) || {};

  try {
    const r = await unaPasada({ escribir: !seco, ahora, memoria });
    console.log(`${sello()}  calendly: vistas=${r.vistas} creadas=${r.creadas.length} canceladas=${r.canceladas.length} sinMatch=${r.sinMatch.length} fallidas=${r.fallidas.length} salteadas=${r.salteadas}${seco ? ' (seco)' : ''}`);

    const lineas = [];
    for (const c of r.creadas) {
      lineas.push(`:busts_in_silhouette: ${seco ? '*Modo sombra:* crearia' : 'Reunion de cliente'} <${ZOHO_UI}/Contacts/${c.contacto.id}|${c.contacto.Full_Name}> · ${c.motivo} · ${c.horaLocal}${c.trato ? ` · trato: ${c.trato}` : c.cuenta ? ` · LLC: ${c.cuenta}` : ''}${c.telefonoCompletado ? ` · :phone: se le cargo el WhatsApp de Calendly (${c.telefono})` : c.sinTelefono ? ' · :warning: el contacto no tiene telefono y no dejo WhatsApp en Calendly' : c.telefonoDistinto ? ` · :warning: dejo otro WhatsApp en Calendly (${c.telefono}), el CRM tiene ${c.contacto.Mobile}` : ''}${c.zohoId ? ` · <${ZOHO_UI}/Events/${c.zohoId}|ver reunion>` : ''}`);
    }
    for (const c of r.canceladas) lineas.push(`:no_entry_sign: ${c.nombre} cancelo su reunion de cliente del ${String(c.inicio).slice(0, 16).replace('T', ' ')} UTC · <${ZOHO_UI}/Events/${c.zohoId}|ver reunion>`);
    for (const c of r.sinMatch) lineas.push(`:question: *Sin ficha en el CRM:* ${c.nombre} (${c.email}) reservo en agendaclientes para el ${c.horaLocal} · motivo ${c.motivo}${c.llc ? ` · dice que su LLC es "${c.llc}"` : ''}${c.telefono ? ` · WhatsApp ${c.telefono}` : ''} · no se creo nada: buscarlo a mano`);
    for (const c of r.fallidas) lineas.push(`:rotating_light: No pude crear/marcar la reunion de cliente de ${c.nombre}: ${c.error}`);
    if (lineas.length) await aSlack(lineas.join('\n'));

    await store.setJSON('calendly', memoria);
    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    await store.setJSON('bitacora', [{ id: ahora.toISOString(), agente: 'clientes-calendly', segundos: Math.round((Date.now() - inicio) / 1000), vistas: r.vistas, creadas: r.creadas.length, canceladas: r.canceladas.length, sinMatch: r.sinMatch.length, fallidas: r.fallidas.length, seco, estado: 'ok' }, ...previa].slice(0, MAX_BITACORA));
    return new Response('ok');
  } catch (e) {
    console.error(`${sello()}  FALLO: ${e.message}`);
    try { await aSlack(`:rotating_light: El agente de reuniones de clientes (Calendly) fallo: ${e.message}`); } catch {}
    return new Response('fallo', { status: 500 });
  }
};
